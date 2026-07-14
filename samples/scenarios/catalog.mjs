export const SCENARIO_NAMES = Object.freeze([
  "happy",
  "empty",
  "unsupported",
  "paginated",
  "throttled",
  "abort",
  "schema-drift",
  "reconnect",
  "duplicate-event",
  "stale-cursor",
  "range",
  "edit-conflict",
  "cache-hit",
  "cache-stale",
  "cache-revalidate",
  "auth-scope",
]);

export const SCENARIOS = Object.freeze(
  Object.fromEntries(
    [
      ["happy", "Deterministic baseline response and realtime snapshot."],
      ["empty", "Valid schema with no feature records."],
      ["unsupported", "Explicit protocol/capability-not-supported response."],
      ["paginated", "Bounded pages with a run-scoped continuation cursor."],
      ["throttled", "Immediate 429 on the first request; retry succeeds without a sleep."],
      ["abort", "Immediate deterministic client-abort contract without a timer."],
      ["schema-drift", "A deterministic incompatible field/schema projection."],
      ["reconnect", "Realtime reconnect status followed by resumable state."],
      ["duplicate-event", "The previous realtime event is replayed with the same identity."],
      ["stale-cursor", "A stale or foreign continuation cursor is rejected."],
      ["range", "A valid byte-range response and deterministic 416 handling."],
      ["edit-conflict", "An optimistic-concurrency revision conflict."],
      ["cache-hit", "Fresh metadata/result cache response."],
      ["cache-stale", "Stale cache response retained for explicit inspection."],
      ["cache-revalidate", "Deterministic conditional revalidation response."],
      ["auth-scope", "Run-scoped authorization and cache partition evidence."],
    ].map(([name, description]) => [name, Object.freeze({ name, description })]),
  ),
);

export function assertScenarioName(value) {
  if (typeof value !== "string" || !Object.hasOwn(SCENARIOS, value)) {
    throw Object.assign(new Error(`Unknown fixture scenario: ${String(value)}`), { status: 400 });
  }
  return value;
}
