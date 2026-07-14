export const FIXTURE_RUN_ID_PATTERN_SOURCE = "^[a-z0-9][a-z0-9-]{0,63}$";
export const FIXTURE_RUN_ID_PATTERN = new RegExp(FIXTURE_RUN_ID_PATTERN_SOURCE);

export function isFixtureRunId(value) {
  return typeof value === "string" && FIXTURE_RUN_ID_PATTERN.test(value);
}
