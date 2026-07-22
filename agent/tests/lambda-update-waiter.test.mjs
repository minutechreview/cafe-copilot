import { describe, expect, it } from 'vitest';
import { waitForSuccessfulLambdaUpdate } from '../lambda-update-waiter.mjs';

describe('Lambda update waiter', () => {
  it('waits through an in-progress update and returns only a successful terminal response', async () => {
    const responses = [
      { State: 'Pending', LastUpdateStatus: 'InProgress' },
      { State: 'Active', LastUpdateStatus: 'Successful' },
    ];
    const sleep = async () => {};
    await expect(waitForSuccessfulLambdaUpdate({
      getConfiguration: async () => responses.shift(),
      sleep,
    })).resolves.toEqual({ State: 'Active', LastUpdateStatus: 'Successful' });
  });

  it('fails closed on a terminal failed state with a sanitized reason code', async () => {
    await expect(waitForSuccessfulLambdaUpdate({
      getConfiguration: async () => ({
        State: 'Failed',
        LastUpdateStatus: 'Failed',
        StateReasonCode: 'Invalid env value\nshould-not-add-a-line',
      }),
      sleep: async () => {},
    })).rejects.toThrow(
      'Lambda update failed (State=Failed, LastUpdateStatus=Failed, StateReasonCode=Invalid_env_value_should-not-add-a-line)'
    );
  });

  it('does not treat an incomplete or inactive terminal response as ready', async () => {
    await expect(waitForSuccessfulLambdaUpdate({
      getConfiguration: async () => ({ State: 'Inactive', LastUpdateStatus: 'Successful' }),
      sleep: async () => {},
    })).rejects.toThrow('Lambda update did not reach a successful terminal state');
  });
});
