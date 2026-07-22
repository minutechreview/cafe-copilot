import { randomUUID } from 'node:crypto';
import {
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';

// Kept in Lambda configuration rather than a local lock file so independent CI/CD
// processes contend on Lambda's RevisionId compare-and-swap primitive.
export const DEPLOYMENT_LOCK_ENV_KEY = 'COPILOT_DEPLOYMENT_LOCK_TOKEN';

export class DeploymentLockUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeploymentLockUnavailableError';
  }
}

function variablesFrom(configuration) {
  return { ...(configuration.Environment?.Variables ?? {}) };
}

function withoutLock(variables) {
  const copy = { ...variables };
  delete copy[DEPLOYMENT_LOCK_ENV_KEY];
  return copy;
}

function lockUnavailable(err) {
  return err?.name === 'PreconditionFailedException' || err?.name === 'ResourceConflictException';
}

/**
 * Acquires a non-expiring, fencing deployment lock for an existing Lambda function.
 *
 * There is deliberately no automatic lock expiry: an expired lease could let an old
 * process resume and restore concurrency after a newer deployment takes ownership.
 * A crashed deploy leaves capacity at zero only if it had already guarded the
 * function, and requires deliberate operator recovery only after confirming the
 * original process has stopped, rather than risking two writers. Normal failures
 * release this lock safely in the caller.
 */
export async function acquireLambdaDeploymentLock({
  lambdaClient,
  functionName,
  waitForReady,
  token = randomUUID(),
}) {
  let configuration = await lambdaClient.send(
    new GetFunctionConfigurationCommand({ FunctionName: functionName })
  );
  const currentLock = configuration.Environment?.Variables?.[DEPLOYMENT_LOCK_ENV_KEY];
  if (currentLock) {
    throw new DeploymentLockUnavailableError(
      `Another deployment holds ${DEPLOYMENT_LOCK_ENV_KEY}; do not run concurrent deploys. ` +
      'If its owner crashed, recover it only after confirming that process has stopped.'
    );
  }

  try {
    await lambdaClient.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: functionName,
        Environment: { Variables: { ...variablesFrom(configuration), [DEPLOYMENT_LOCK_ENV_KEY]: token } },
        RevisionId: configuration.RevisionId,
      })
    );
  } catch (err) {
    if (lockUnavailable(err)) {
      throw new DeploymentLockUnavailableError('Another deployment won the Lambda configuration lock.');
    }
    throw err;
  }

  configuration = await waitForReady();
  if (configuration.Environment?.Variables?.[DEPLOYMENT_LOCK_ENV_KEY] !== token) {
    throw new DeploymentLockUnavailableError('Lambda deployment lock ownership could not be confirmed.');
  }

  async function assertOwnership() {
    const latest = await lambdaClient.send(
      new GetFunctionConfigurationCommand({ FunctionName: functionName })
    );
    if (latest.Environment?.Variables?.[DEPLOYMENT_LOCK_ENV_KEY] !== token) {
      throw new DeploymentLockUnavailableError('Lambda deployment lock ownership was lost.');
    }
    return latest;
  }

  return {
    token,
    assertOwnership,
    async release(finalEnvironmentVariables) {
      const latest = await assertOwnership();
      await lambdaClient.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: functionName,
          Environment: { Variables: withoutLock(finalEnvironmentVariables ?? variablesFrom(latest)) },
          RevisionId: latest.RevisionId,
        })
      );
      const cleared = await waitForReady();
      if (cleared.Environment?.Variables?.[DEPLOYMENT_LOCK_ENV_KEY]) {
        throw new DeploymentLockUnavailableError('Lambda deployment lock could not be released safely.');
      }
    },
  };
}

export function withDeploymentLock(environmentVariables, token) {
  return token
    ? { ...environmentVariables, [DEPLOYMENT_LOCK_ENV_KEY]: token }
    : { ...environmentVariables };
}
