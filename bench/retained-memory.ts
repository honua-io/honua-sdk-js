/**
 * Memory primitives shared by the columnar benchmark harnesses.
 *
 * Both columnar scenarios publish a per-row memory ceiling into
 * `bench/budgets.json`, and those two numbers are only comparable if they mean
 * the same thing, so the definition of "retained" lives in one place rather
 * than being spelled out twice.
 */

/**
 * Live JavaScript heap plus live `ArrayBuffer` bytes: the two costs a columnar
 * plane can grow. `rss` is deliberately excluded — it counts pages the
 * allocator has not returned to the OS, which moves for reasons no SDK change
 * can influence.
 */
export function retainedBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/**
 * Force a collection so the next {@link retainedBytes} reading holds live bytes
 * only. Returns false when Node was started without `--expose-gc`, which makes
 * any retained-memory reading unsound; the harnesses fail the scenario in that
 * case rather than publishing a number a mid-run collection could have
 * deflated. `npm run bench:lab` and `vitest.config.ts` both pass the flag.
 */
export function collectGarbage(): boolean {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (typeof collect !== "function") return false;
  collect();
  return true;
}
