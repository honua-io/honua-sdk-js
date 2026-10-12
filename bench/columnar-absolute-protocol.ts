import { isDeepStrictEqual } from "node:util";

/** Exact million-row recipes shared by covered semantics and fresh-process timing. */
export const COLUMNAR_ABSOLUTE_RECIPES = {
  patch: {
    rowCount: 1_000_000,
    reserveRows: 2_304,
    patchOperations: 1_000,
    patchesPerSample: 8,
    warmupRuns: 1,
    measurementRuns: 5,
  },
  aggregate: { inputRowCount: 1_000_000, groupCount: 1_024, warmupRuns: 1, measurementRuns: 3 },
} as const;

export type ColumnarAbsoluteScenario = keyof typeof COLUMNAR_ABSOLUTE_RECIPES;

export function assertUninstrumentedRuntime(argv: readonly string[], environment: NodeJS.ProcessEnv): void {
  if (!isDeepStrictEqual(argv, ["--expose-gc"]) || environment.NODE_OPTIONS || environment.NODE_V8_COVERAGE) {
    throw new Error("Absolute timing requires a fresh Node process with only --expose-gc and no instrumentation");
  }
}

export function parseColumnarAbsoluteRequest(text: string): ColumnarAbsoluteScenario {
  const request = record(JSON.parse(text));
  if (
    (request.scenario !== "patch" && request.scenario !== "aggregate") ||
    !isDeepStrictEqual(request.recipe, COLUMNAR_ABSOLUTE_RECIPES[request.scenario])
  ) {
    throw new Error("Absolute timing recipe does not match the declared million-row scenario");
  }
  return request.scenario;
}

export function parseColumnarAbsoluteReport(
  text: string,
  scenario: ColumnarAbsoluteScenario,
  runtime: string,
  executable: string,
): { samples: number[]; invariants: { passed: true; checks: Record<string, boolean> } } {
  const report = record(JSON.parse(text));
  if (
    report.schemaVersion !== 1 ||
    report.scenario !== scenario ||
    !isDeepStrictEqual(report.recipe, COLUMNAR_ABSOLUTE_RECIPES[scenario]) ||
    report.runtime !== runtime ||
    report.executable !== executable ||
    report.instrumentation !== "none"
  ) {
    throw new Error("Absolute timing child returned mismatched provenance or recipe");
  }
  const invariants = record(report.invariants);
  const checks = record(invariants.checks);
  if (
    invariants.passed !== true ||
    Object.keys(checks).length === 0 ||
    Object.values(checks).some((value) => value !== true)
  ) {
    throw new Error("Absolute timing child failed its semantic invariants");
  }
  if (
    !Array.isArray(report.samples) ||
    report.samples.length !== COLUMNAR_ABSOLUTE_RECIPES[scenario].measurementRuns ||
    report.samples.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error("Absolute timing child returned missing or invalid measurements");
  }
  return {
    samples: report.samples as number[],
    invariants: { passed: true, checks: checks as Record<string, boolean> },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid timing record");
  return value as Record<string, unknown>;
}
