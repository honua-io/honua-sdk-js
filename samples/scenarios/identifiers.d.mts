export const FIXTURE_RUN_ID_PATTERN_SOURCE: "^[a-z0-9][a-z0-9-]{0,63}$";
export const FIXTURE_RUN_ID_PATTERN: RegExp;
export function isFixtureRunId(value: unknown): value is string;
