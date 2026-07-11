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
  invariants: { passed: boolean };
}

export interface BrowserBenchmarkBudgets {
  variability: {
    warningCoefficientOfVariation: number;
    failureCoefficientOfVariation: number;
  };
  scenarios: Record<
    string,
    {
      firstVisibleMs: { warning: number; failure: number };
      interactionLatencyMs: { warning: number; failure: number };
    }
  >;
}

export function summarize(values: readonly number[]): BrowserMetricSummary;
export function evaluateScenarios(
  scenarios: readonly BrowserScenarioEvaluationInput[],
  budgets: BrowserBenchmarkBudgets,
): {
  level: "pass" | "warning" | "failure";
  items: Array<{ scenarioId: string; metric: string; level: "pass" | "warning" | "failure" }>;
};
export function runRepeatedScenario(
  id: string,
  runSample: (screenshotPath: string) => Promise<{
    firstVisibleMs: number;
    interactionLatencyMs: number;
    passed: boolean;
  }>,
  outputDirectory: string,
): Promise<{
  id: string;
  warmupFailures: string[];
  samples: Array<{
    firstVisibleMs: number;
    interactionLatencyMs: number;
    passed: boolean;
    errors?: { runner?: string[] };
  }>;
  summary: {
    firstVisibleMs: BrowserMetricSummary;
    interactionLatencyMs: BrowserMetricSummary;
  };
  invariants: { passed: boolean };
}>;
