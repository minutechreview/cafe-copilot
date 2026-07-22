/**
 * Applies function code/config behind a reserved-concurrency guard. Existing public
 * functions are disabled before mutation; new functions are bounded before URL exposure.
 */
export async function applyGuardedFunctionUpdate({
  existingRuntime,
  targetConcurrency,
  setConcurrency,
  updateExisting,
  createNew,
  acquireDeploymentLock = null,
}) {
  if (!existingRuntime) {
    await createNew();
    await setConcurrency(targetConcurrency);
    return;
  }

  // Function-level reserved concurrency cannot be conditionally updated. Hold an
  // external, fencing lock for the *whole* zero -> update -> restore sequence so
  // another deploy cannot restore capacity while this deployment is still changing
  // code or configuration.
  const lock = await acquireDeploymentLock?.();
  try {
    await lock?.assertOwnership?.();
    await setConcurrency(0);
    await lock?.assertOwnership?.();
    await updateExisting(existingRuntime, lock?.token);
    await lock?.assertOwnership?.();
    await setConcurrency(targetConcurrency);
  } finally {
    // Releasing a lock never restores concurrency. If code/config update failed,
    // the function intentionally remains at zero, preserving the original guardrail.
    await lock?.release?.();
  }
}
