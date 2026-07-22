import { describe, expect, it, vi } from 'vitest';
import { applyGuardedFunctionUpdate } from '../deployment-order.mjs';
import { waitForSuccessfulLambdaUpdate } from '../lambda-update-waiter.mjs';

describe('guarded Lambda deployment ordering', () => {
  it('sets existing public function concurrency to zero before updating, then restores the bound', async () => {
    const calls = [];
    await applyGuardedFunctionUpdate({
      existingRuntime: 'nodejs22.x',
      targetConcurrency: 5,
      setConcurrency: vi.fn(async (value) => calls.push(`concurrency:${value}`)),
      updateExisting: vi.fn(async () => calls.push('update')),
      createNew: vi.fn(),
    });
    expect(calls).toEqual(['concurrency:0', 'update', 'concurrency:5']);
  });

  it('cannot interleave two existing-function deploys so a second deploy restores capacity before the first updates', async () => {
    const calls = [];
    let held = false;
    let letFirstUpdateContinue;
    const firstUpdateBlocked = new Promise((resolve) => { letFirstUpdateContinue = resolve; });
    let firstReachedUpdate;
    const firstReachedUpdatePromise = new Promise((resolve) => { firstReachedUpdate = resolve; });

    const acquireDeploymentLock = async () => {
      if (held) throw new Error('deployment lock unavailable');
      held = true;
      return {
        token: 'owner',
        assertOwnership: vi.fn(),
        release: vi.fn(async () => { held = false; }),
      };
    };

    const first = applyGuardedFunctionUpdate({
      existingRuntime: 'nodejs22.x',
      targetConcurrency: 5,
      acquireDeploymentLock,
      setConcurrency: async (value) => calls.push(`A:concurrency:${value}`),
      updateExisting: async () => {
        calls.push('A:update');
        firstReachedUpdate();
        await firstUpdateBlocked;
      },
      createNew: vi.fn(),
    });

    await firstReachedUpdatePromise;
    await expect(applyGuardedFunctionUpdate({
      existingRuntime: 'nodejs22.x',
      targetConcurrency: 5,
      acquireDeploymentLock,
      setConcurrency: async (value) => calls.push(`B:concurrency:${value}`),
      updateExisting: async () => calls.push('B:update'),
      createNew: vi.fn(),
    })).rejects.toThrow('deployment lock unavailable');

    letFirstUpdateContinue();
    await first;
    expect(calls).toEqual(['A:concurrency:0', 'A:update', 'A:concurrency:5']);
  });

  it('leaves an existing function disabled if update fails', async () => {
    const setConcurrency = vi.fn();
    const release = vi.fn();
    await expect(applyGuardedFunctionUpdate({
      existingRuntime: 'nodejs22.x',
      targetConcurrency: 5,
      setConcurrency,
      updateExisting: vi.fn().mockRejectedValue(new Error('update failed')),
      createNew: vi.fn(),
      acquireDeploymentLock: async () => ({
        token: 'owner',
        assertOwnership: vi.fn(),
        release,
      }),
    })).rejects.toThrow('update failed');
    expect(setConcurrency).toHaveBeenCalledTimes(1);
    expect(setConcurrency).toHaveBeenCalledWith(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  for (const failedStage of ['code', 'configuration']) {
    it(`keeps concurrency at zero and releases the lock when the ${failedStage} update reaches Lambda Failed`, async () => {
      const setConcurrency = vi.fn();
      const release = vi.fn();
      const failedStatus = {
        State: 'Active',
        LastUpdateStatus: 'Failed',
        LastUpdateStatusReasonCode: 'InvalidConfiguration',
      };

      await expect(applyGuardedFunctionUpdate({
        existingRuntime: 'nodejs22.x',
        targetConcurrency: 5,
        setConcurrency,
        acquireDeploymentLock: async () => ({
          token: 'owner',
          assertOwnership: vi.fn(),
          release,
        }),
        updateExisting: async () => {
          const updates = failedStage === 'code'
            ? [[{ State: 'Pending', LastUpdateStatus: 'InProgress' }, failedStatus]]
            : [[
              { State: 'Active', LastUpdateStatus: 'Successful' },
            ], [
              { State: 'Pending', LastUpdateStatus: 'InProgress' },
              failedStatus,
            ]];
          for (const responses of updates) {
            await waitForSuccessfulLambdaUpdate({
              getConfiguration: async () => responses.shift(),
              sleep: async () => {},
            });
          }
        },
        createNew: vi.fn(),
      })).rejects.toThrow('Lambda update failed');

      expect(setConcurrency).toHaveBeenCalledTimes(1);
      expect(setConcurrency).toHaveBeenCalledWith(0);
      expect(release).toHaveBeenCalledTimes(1);
    });
  }

  it('bounds a new function before any later URL exposure step', async () => {
    const calls = [];
    await applyGuardedFunctionUpdate({
      existingRuntime: null,
      targetConcurrency: 4,
      setConcurrency: vi.fn(async (value) => calls.push(`concurrency:${value}`)),
      updateExisting: vi.fn(),
      createNew: vi.fn(async () => calls.push('create')),
    });
    expect(calls).toEqual(['create', 'concurrency:4']);
  });
});
