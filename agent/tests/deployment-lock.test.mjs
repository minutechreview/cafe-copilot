import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_LOCK_ENV_KEY,
  DeploymentLockUnavailableError,
  acquireLambdaDeploymentLock,
  withDeploymentLock,
} from '../deployment-lock.mjs';

function fakeLambda({ configuration }) {
  const commands = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      if (command.input.Environment?.Variables) {
        configuration.Environment = { Variables: { ...command.input.Environment.Variables } };
        configuration.RevisionId = `${configuration.RevisionId}-next`;
      }
      return configuration;
    },
  };
}

describe('Lambda deployment lock', () => {
  it('uses the configuration revision as a fencing compare-and-swap and removes the token only on release', async () => {
    const configuration = {
      RevisionId: 'r1',
      Environment: { Variables: { SAFE: 'yes' } },
    };
    const lambdaClient = fakeLambda({ configuration });
    const lock = await acquireLambdaDeploymentLock({
      lambdaClient,
      functionName: 'copilot',
      waitForReady: async () => configuration,
      token: 'owner',
    });

    expect(lambdaClient.commands[1].input).toMatchObject({
      FunctionName: 'copilot',
      RevisionId: 'r1',
      Environment: { Variables: { SAFE: 'yes', [DEPLOYMENT_LOCK_ENV_KEY]: 'owner' } },
    });
    expect(withDeploymentLock({ NEXT: 'yes' }, lock.token)).toEqual({
      NEXT: 'yes', [DEPLOYMENT_LOCK_ENV_KEY]: 'owner',
    });

    await lock.release({ NEXT: 'yes' });
    expect(lambdaClient.commands.at(-1).input).toMatchObject({
      RevisionId: 'r1-next',
      Environment: { Variables: { NEXT: 'yes' } },
    });
  });

  it('treats a stale/crashed deploy lock as unavailable rather than risking two writers', async () => {
    const lambdaClient = fakeLambda({
      configuration: {
        RevisionId: 'r2',
        Environment: { Variables: { [DEPLOYMENT_LOCK_ENV_KEY]: 'other-owner' } },
      },
    });
    await expect(acquireLambdaDeploymentLock({
      lambdaClient,
      functionName: 'copilot',
      waitForReady: async () => ({}),
      token: 'owner',
    })).rejects.toBeInstanceOf(DeploymentLockUnavailableError);
    expect(lambdaClient.commands).toHaveLength(1);
  });

  it('turns a RevisionId compare-and-swap conflict into a no-mutation deploy rejection', async () => {
    const configuration = {
      RevisionId: 'r3',
      Environment: { Variables: { SAFE: 'yes' } },
    };
    const commands = [];
    const lambdaClient = {
      async send(command) {
        commands.push(command);
        if (commands.length === 2) {
          const err = new Error('revision changed');
          err.name = 'PreconditionFailedException';
          throw err;
        }
        return configuration;
      },
    };

    await expect(acquireLambdaDeploymentLock({
      lambdaClient,
      functionName: 'copilot',
      waitForReady: async () => configuration,
      token: 'owner',
    })).rejects.toBeInstanceOf(DeploymentLockUnavailableError);
    expect(commands).toHaveLength(2);
  });
});
