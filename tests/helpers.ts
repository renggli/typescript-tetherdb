/**
 * Asynchronously pauses execution for the given duration in milliseconds.
 *
 * @param ms - Duration to wait in milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Periodically evaluates a predicate function until it returns true or times out.
 *
 * @param predicate - Condition callback function returning a boolean or Promise<boolean>.
 * @param timeoutMs - Maximum total time to wait before throwing an error (default: 5000ms).
 * @param intervalMs - Polling interval between predicate checks (default: 5ms).
 * @throws {Error} If the predicate does not return true within the timeout window.
 */
export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
  intervalMs = 5,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}
