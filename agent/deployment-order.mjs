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
}) {
  if (existingRuntime) {
    await setConcurrency(0);
    await updateExisting(existingRuntime);
  } else {
    await createNew();
  }
  await setConcurrency(targetConcurrency);
}
