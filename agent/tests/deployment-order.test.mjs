import { describe, expect, it, vi } from 'vitest';
import { applyGuardedFunctionUpdate } from '../deployment-order.mjs';

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

  it('leaves an existing function disabled if update fails', async () => {
    const setConcurrency = vi.fn();
    await expect(applyGuardedFunctionUpdate({
      existingRuntime: 'nodejs22.x',
      targetConcurrency: 5,
      setConcurrency,
      updateExisting: vi.fn().mockRejectedValue(new Error('update failed')),
      createNew: vi.fn(),
    })).rejects.toThrow('update failed');
    expect(setConcurrency).toHaveBeenCalledTimes(1);
    expect(setConcurrency).toHaveBeenCalledWith(0);
  });

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
