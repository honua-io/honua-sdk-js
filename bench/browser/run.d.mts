export interface BrowserMetricSummary {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  coefficientOfVariation: number;
}

export interface BrowserScenarioEvaluationInput {
  id: string;
  summary: {
    firstVisibleMs: BrowserMetricSummary;
    interactionLatencyMs: BrowserMetricSummary;
  };
  /** Per-stage medians (issue #562, REQ-003): conversion, transfer, GPU upload, steady frame rate, picking, disposal. */
  stagesSummary?: Record<string, BrowserMetricSummary>;
  invariants: { passed: boolean };
}

export interface BrowserStageBudget {
  warning: number;
  failure: number;
  /** `"at-least"` for metrics where smaller is worse, e.g. `steadyFrameRateFps`. Omitted/other means an upper bound. */
  direction?: "at-least" | "at-most";
}

export interface BrowserBenchmarkBudgets {
  schemaVersion: 2;
  variability: {
    warningCoefficientOfVariation: number;
    failureCoefficientOfVariation: number;
  };
  scenarios: Record<
    string,
    {
      firstVisibleMs: { warning: number; failure: number };
      interactionLatencyMs: { warning: number; failure: number };
      stages?: Record<string, BrowserStageBudget>;
    }
  >;
  lifecycle?: {
    repeatedMountUnmount?: { cycles: number; warmupCycles: number; maxHeapGrowthBytes: { warning: number; failure: number } };
    contextLossRecovery?: { maxRecoveryMs: { warning: number; failure: number } };
  };
}

export interface BrowserEvaluationItem {
  scenarioId: string;
  metric: string;
  level: "pass" | "warning" | "failure" | "not-measured";
  actual?: number;
  warning?: number;
  failure?: number;
  message?: string;
}

export interface BrowserEvaluationResult {
  level: "pass" | "warning" | "failure";
  items: BrowserEvaluationItem[];
}

export const BROWSER_CORPUS_SOURCE_FILES: readonly string[];
/** Code under test (issue #562 review), hashed separately from the corpus — see `codeUnderTestFingerprint`. */
export const CODE_UNDER_TEST_SOURCE_FILES: readonly string[];
export function summarize(values: readonly number[]): BrowserMetricSummary;
export function browserCorpusFingerprint(options?: {
  repoRoot?: string;
  fixtureRoot?: string;
}): Promise<{ files: string[]; sha256: string }>;
export function codeUnderTestFingerprint(options?: {
  repoRoot?: string;
}): Promise<{ files: string[]; sha256: string }>;
export function evaluateScenarios(
  scenarios: readonly BrowserScenarioEvaluationInput[],
  budgets: BrowserBenchmarkBudgets,
): BrowserEvaluationResult;
export function evaluateOperationalScenarios(
  results: ReadonlyArray<{ id: string; passed: boolean; evidence?: Record<string, unknown> }>,
  budgets: BrowserBenchmarkBudgets,
): BrowserEvaluationResult;
export function runRepeatedScenario(
  id: string,
  runSample: (screenshotPath: string) => Promise<{
    firstVisibleMs: number;
    interactionLatencyMs: number;
    stages?: Record<string, number>;
    passed: boolean;
  }>,
  outputDirectory: string,
): Promise<{
  id: string;
  warmupFailures: string[];
  samples: Array<{
    firstVisibleMs: number;
    interactionLatencyMs: number;
    stages?: Record<string, number>;
    passed: boolean;
    errors?: { runner?: string[] };
  }>;
  summary: {
    firstVisibleMs: BrowserMetricSummary;
    interactionLatencyMs: BrowserMetricSummary;
  };
  stagesSummary?: Record<string, BrowserMetricSummary>;
  invariants: { passed: boolean };
}>;
