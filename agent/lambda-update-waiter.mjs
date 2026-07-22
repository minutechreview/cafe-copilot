const MAX_REASON_CODE_CHARS = 120;

function sanitizedReasonCode(value) {
  if (!value) return null;
  return String(value)
    .replace(/[^a-zA-Z0-9._:-]/g, '_')
    .slice(0, MAX_REASON_CODE_CHARS);
}

function failedUpdateError(configuration) {
  const details = [
    `State=${configuration.State ?? 'unknown'}`,
    `LastUpdateStatus=${configuration.LastUpdateStatus ?? 'unknown'}`,
  ];
  const stateReason = sanitizedReasonCode(configuration.StateReasonCode);
  const updateReason = sanitizedReasonCode(configuration.LastUpdateStatusReasonCode);
  if (stateReason) details.push(`StateReasonCode=${stateReason}`);
  if (updateReason) details.push(`LastUpdateStatusReasonCode=${updateReason}`);
  return new Error(`Lambda update failed (${details.join(', ')})`);
}

function unsuccessfulTerminalStateError(configuration) {
  const details = [
    `State=${configuration.State ?? 'unknown'}`,
    `LastUpdateStatus=${configuration.LastUpdateStatus ?? 'unknown'}`,
  ];
  return new Error(`Lambda update did not reach a successful terminal state (${details.join(', ')})`);
}

/**
 * Wait until Lambda reports a successful terminal configuration state. A terminal
 * failure is never treated as ready: callers must keep their existing concurrency
 * guard in place rather than exposing partially deployed code/configuration.
 */
export async function waitForSuccessfulLambdaUpdate({
  getConfiguration,
  sleep,
  maxAttempts = 30,
  intervalMs = 2_000,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const configuration = await getConfiguration();
    if (configuration.State === 'Failed' || configuration.LastUpdateStatus === 'Failed') {
      throw failedUpdateError(configuration);
    }
    if (configuration.State === 'Active' && configuration.LastUpdateStatus === 'Successful') {
      return configuration;
    }
    if (configuration.State !== 'Pending' && configuration.LastUpdateStatus !== 'InProgress') {
      throw unsuccessfulTerminalStateError(configuration);
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for the Lambda function to finish updating');
}
