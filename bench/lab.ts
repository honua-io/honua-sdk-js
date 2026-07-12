import { execFileSync } from "node:child_process";
/** Reproducible, machine-readable benchmark lab for same-SDK regression analysis. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  type OfflineReloadBenchmarkOptions,
  type RealtimeReconnectBenchmarkOptions,
  type ResilienceBenchmarkResult,
  runOfflineReloadBenchmark,
  runRealtimeReconnectBenchmark,
} from "./resilience-bench.js";
import { runStreamBench } from "./stream-bench.js";

type Direction = "lower-is-better" | "higher-is-better";
type EvaluationLevel = "pass" | "warning" | "failure" | "not-compared";

interface StreamCorpusScenario {
  id: string;
  kind: "stream-pagination";
  featureCount: number;
  pageSize: number;
  pageLatencyMs: number;
  returnGeometry: boolean;
  warmupRuns: number;
  measurementRuns: number;
}

interface OfflineReloadCorpusScenario extends Omit<OfflineReloadBenchmarkOptions, "fault"> {
  id: string;
  kind: "offline-reload";
}

interface RealtimeReconnectCorpusScenario extends Omit<RealtimeReconnectBenchmarkOptions, "fault"> {
  id: string;
  kind: "realtime-reconnect";
}

type CorpusScenario = StreamCorpusScenario | OfflineReloadCorpusScenario | RealtimeReconnectCorpusScenario;

interface Corpus {
  schemaVersion: 1;
  id: string;
  description: string;
  scenarios: CorpusScenario[];
}

interface RelativeBudget {
  direction: Direction;
  warningPercent: number;
  failurePercent: number;
}

interface Budgets {
  schemaVersion: 1;
  variability: {
    warningCoefficientOfVariation: number;
    failureCoefficientOfVariation: number;
  };
  relativeRegression: Record<string, RelativeBudget>;
}

export interface SampleMetrics {
  totalDurationMs: number;
  timeToFirstPageMs: number;
  featuresPerSecond: number;
  heapUsedDeltaBytes: number;
  heapUsedPeakBytes: number;
  totalFeatures: number;
  pageCount: number;
}

export interface MetricSummary {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  coefficientOfVariation: number;
}

interface ScenarioResult {
  id: string;
  kind: CorpusScenario["kind"];
  parameters: Record<string, number | boolean>;
  samples: Array<SampleMetrics | { totalDurationMs: number; operationsPerSecond: number }>;
  summary: {
    totalDurationMs: MetricSummary;
    timeToFirstPageMs?: MetricSummary;
    featuresPerSecond?: MetricSummary;
    operationsPerSecond?: MetricSummary;
    heapUsedDeltaBytes?: MetricSummary;
    heapUsedPeakBytes?: MetricSummary;
  };
  invariants: {
    expectedTotalFeatures?: number;
    expectedPageCount?: number;
    checks?: Readonly<Record<string, boolean | number | string | null>>;
    semantics?: ResilienceBenchmarkResult["invariants"]["semantics"];
    passed: boolean;
  };
}

interface EnvironmentMetadata {
  implementation: "honua-sdk-js";
  node: string;
  nodeMajor: number;
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  cpuModel: string;
  logicalCpuCount: number;
  totalMemoryBytes: number;
  ci: boolean;
  githubRunnerImage: string | null;
}

interface EvaluationItem {
  scenarioId: string;
  metric: string;
  level: EvaluationLevel;
  message: string;
  actual?: number;
  baseline?: number;
  regressionPercent?: number;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  gitCommit: string | null;
  corpus: { id: string; sha256: string; description: string };
  methodology: {
    scope: "sdk-overhead";
    transport: "deterministic-in-process-fixture";
    crossSdkComparable: false;
    note: string;
  };
  environment: EnvironmentMetadata;
  scenarios: ScenarioResult[];
  evaluation: {
    level: EvaluationLevel;
    baselineCompatibility: { comparable: boolean; reasons: string[] } | null;
    items: EvaluationItem[];
  };
}

interface CliOptions {
  corpus: string;
  budgets: string;
  baseline?: string;
  output: string;
  check: boolean;
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(percentileValue * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

export function summarizeSamples(values: readonly number[]): MetricSummary {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample set");
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    min: sorted[0],
    max: sorted.at(-1) ?? sorted[0],
    mean,
    median,
    p95: percentile(sorted, 0.95),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / Math.abs(mean),
  };
}

function environmentMetadata(): EnvironmentMetadata {
  const cpus = os.cpus();
  return {
    implementation: "honua-sdk-js",
    node: process.version,
    nodeMajor: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? "unknown",
    logicalCpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    ci: process.env.CI === "true",
    githubRunnerImage: process.env.ImageOS ?? null,
  };
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function validateCorpus(value: unknown): Corpus {
  const corpus = value as Partial<Corpus>;
  if (corpus.schemaVersion !== 1 || !corpus.id || !Array.isArray(corpus.scenarios)) {
    throw new Error("Invalid benchmark corpus: expected schemaVersion 1, id, and scenarios");
  }
  const ids = new Set<string>();
  for (const scenario of corpus.scenarios) {
    if (
      !scenario.id ||
      !Number.isInteger(scenario.measurementRuns) ||
      scenario.measurementRuns < 3 ||
      !validWarmup(scenario)
    ) {
      throw new Error(`Invalid benchmark scenario: ${scenario.id ?? "<missing id>"}`);
    }
    const commonKeys = ["id", "kind", "warmupRuns", "measurementRuns"];
    let allowedKeys: ReadonlySet<string>;
    if (scenario.kind === "stream-pagination") {
      allowedKeys = new Set([...commonKeys, "featureCount", "pageSize", "pageLatencyMs", "returnGeometry"]);
      if (!positive(scenario.featureCount) || !positive(scenario.pageSize)) {
        throw new Error(`Invalid benchmark scenario: ${scenario.id}`);
      }
    } else if (scenario.kind === "offline-reload") {
      allowedKeys = new Set([...commonKeys, "resourceCount", "resourceBytes", "reloadCycles", "maxFreshnessAgeMs"]);
      if (
        !positive(scenario.resourceCount) ||
        !positive(scenario.resourceBytes) ||
        !positive(scenario.reloadCycles) ||
        !positive(scenario.maxFreshnessAgeMs)
      ) {
        throw new Error(`Invalid benchmark scenario: ${scenario.id}`);
      }
    } else if (scenario.kind === "realtime-reconnect") {
      allowedKeys = new Set([...commonKeys, "eventCount", "replayDuplicateCount", "maxFreshnessAgeMs"]);
      if (
        !positive(scenario.eventCount) ||
        !positive(scenario.replayDuplicateCount) ||
        !positive(scenario.maxFreshnessAgeMs)
      ) {
        throw new Error(`Invalid benchmark scenario: ${scenario.id}`);
      }
    } else {
      throw new Error(`Invalid benchmark scenario kind: ${String((scenario as { kind?: unknown }).kind)}`);
    }
    for (const key of Object.keys(scenario)) {
      if (!allowedKeys.has(key)) throw new Error(`Invalid benchmark scenario property: ${scenario.id}.${key}`);
    }
    if (ids.has(scenario.id)) throw new Error(`Duplicate benchmark scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return corpus as Corpus;
}

function positive(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validWarmup(scenario: { warmupRuns: number }): boolean {
  return Number.isInteger(scenario.warmupRuns) && scenario.warmupRuns >= 0;
}

function validateBudgets(value: unknown): Budgets {
  const budgets = value as Partial<Budgets>;
  if (budgets.schemaVersion !== 1 || !budgets.variability || !budgets.relativeRegression) {
    throw new Error("Invalid benchmark budgets: expected schemaVersion 1 and budget definitions");
  }
  return budgets as Budgets;
}

async function runStreamScenario(scenario: StreamCorpusScenario): Promise<ScenarioResult> {
  const runOnce = async (): Promise<SampleMetrics> => {
    const report = await runStreamBench({
      featureCount: scenario.featureCount,
      pageSizes: [scenario.pageSize],
      pageLatencyMs: scenario.pageLatencyMs,
      returnGeometry: scenario.returnGeometry,
    });
    const run = report.runs[0];
    if (!run) throw new Error(`Scenario ${scenario.id} did not produce metrics`);
    return {
      totalDurationMs: run.totalDurationMs,
      timeToFirstPageMs: run.timeToFirstPageMs,
      featuresPerSecond: run.featuresPerSecond,
      heapUsedDeltaBytes: run.heapUsedDeltaBytes,
      heapUsedPeakBytes: run.heapUsedPeakBytes,
      totalFeatures: run.totalFeatures,
      pageCount: run.pageCount,
    };
  };

  for (let run = 0; run < scenario.warmupRuns; run += 1) await runOnce();
  const samples: SampleMetrics[] = [];
  for (let run = 0; run < scenario.measurementRuns; run += 1) samples.push(await runOnce());

  const metricNames: Array<keyof Omit<SampleMetrics, "totalFeatures" | "pageCount">> = [
    "totalDurationMs",
    "timeToFirstPageMs",
    "featuresPerSecond",
    "heapUsedDeltaBytes",
    "heapUsedPeakBytes",
  ];
  const summary = Object.fromEntries(
    metricNames.map((metric) => [metric, summarizeSamples(samples.map((sample) => sample[metric]))]),
  ) as ScenarioResult["summary"];
  const expectedPageCount = Math.ceil(scenario.featureCount / scenario.pageSize);
  const invariantsPassed = samples.every(
    (sample) => sample.totalFeatures === scenario.featureCount && sample.pageCount === expectedPageCount,
  );

  const { id, kind, ...parameters } = scenario;
  return {
    id,
    kind,
    parameters,
    samples,
    summary,
    invariants: {
      expectedTotalFeatures: scenario.featureCount,
      expectedPageCount,
      passed: invariantsPassed,
    },
  };
}

function resilienceResult(
  scenario: OfflineReloadCorpusScenario | RealtimeReconnectCorpusScenario,
  result: ResilienceBenchmarkResult,
): ScenarioResult {
  const parameters: Record<string, number | boolean> = {};
  if (scenario.kind === "offline-reload") {
    Object.assign(parameters, {
      resourceCount: scenario.resourceCount,
      resourceBytes: scenario.resourceBytes,
      reloadCycles: scenario.reloadCycles,
      maxFreshnessAgeMs: scenario.maxFreshnessAgeMs,
      warmupRuns: scenario.warmupRuns,
      measurementRuns: scenario.measurementRuns,
    });
  } else {
    Object.assign(parameters, {
      eventCount: scenario.eventCount,
      replayDuplicateCount: scenario.replayDuplicateCount,
      maxFreshnessAgeMs: scenario.maxFreshnessAgeMs,
      warmupRuns: scenario.warmupRuns,
      measurementRuns: scenario.measurementRuns,
    });
  }
  return {
    id: scenario.id,
    kind: scenario.kind,
    parameters,
    samples: result.samples,
    summary: {
      totalDurationMs: summarizeSamples(result.samples.map((sample) => sample.totalDurationMs)),
      operationsPerSecond: summarizeSamples(result.samples.map((sample) => sample.operationsPerSecond)),
    },
    invariants: result.invariants,
  };
}

async function runScenario(scenario: CorpusScenario): Promise<ScenarioResult> {
  if (scenario.kind === "stream-pagination") return runStreamScenario(scenario);
  if (scenario.kind === "offline-reload") return resilienceResult(scenario, await runOfflineReloadBenchmark(scenario));
  return resilienceResult(scenario, await runRealtimeReconnectBenchmark(scenario));
}

function baselineCompatibility(
  candidate: BenchmarkReport,
  baseline: BenchmarkReport,
): { comparable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (candidate.corpus.sha256 !== baseline.corpus.sha256) reasons.push("corpus hash differs");
  const keys: Array<keyof EnvironmentMetadata> = [
    "implementation",
    "platform",
    "release",
    "arch",
    "nodeMajor",
    "cpuModel",
    "ci",
  ];
  for (const key of keys) {
    if (candidate.environment[key] !== baseline.environment[key]) reasons.push(`${key} differs`);
  }
  const candidateRunnerImage = candidate.environment.githubRunnerImage;
  const baselineRunnerImage = baseline.environment.githubRunnerImage;
  const candidateHasRunnerImage = typeof candidateRunnerImage === "string" && candidateRunnerImage.length > 0;
  const baselineHasRunnerImage = typeof baselineRunnerImage === "string" && baselineRunnerImage.length > 0;
  if (candidateHasRunnerImage !== baselineHasRunnerImage) {
    reasons.push("githubRunnerImage availability differs");
  } else if (candidateHasRunnerImage && candidateRunnerImage !== baselineRunnerImage) {
    reasons.push("githubRunnerImage differs");
  }
  return { comparable: reasons.length === 0, reasons };
}

function regressionPercent(candidate: number, baseline: number, direction: Direction): number {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return direction === "lower-is-better"
    ? ((candidate - baseline) / baseline) * 100
    : ((baseline - candidate) / baseline) * 100;
}

export function evaluateRelativeBudget(
  candidate: number,
  baseline: number,
  budget: RelativeBudget,
): { level: Exclude<EvaluationLevel, "not-compared">; regressionPercent: number } {
  const regression = regressionPercent(candidate, baseline, budget.direction);
  const level =
    regression > budget.failurePercent ? "failure" : regression > budget.warningPercent ? "warning" : "pass";
  return { level, regressionPercent: regression };
}

function overallLevel(
  items: readonly EvaluationItem[],
  compatibility: BenchmarkReport["evaluation"]["baselineCompatibility"],
): EvaluationLevel {
  if (items.some((item) => item.level === "failure")) return "failure";
  if (compatibility && !compatibility.comparable) return "not-compared";
  if (items.some((item) => item.level === "warning")) return "warning";
  if (items.length > 0 && items.every((item) => item.level === "not-compared")) {
    return "not-compared";
  }
  return "pass";
}

export function evaluateReport(
  candidate: BenchmarkReport,
  budgets: Budgets,
  baseline?: BenchmarkReport,
): BenchmarkReport["evaluation"] {
  const items: EvaluationItem[] = [];
  for (const scenario of candidate.scenarios) {
    items.push({
      scenarioId: scenario.id,
      metric: "scenario-invariants",
      level: scenario.invariants.passed ? "pass" : "failure",
      message: scenario.invariants.passed
        ? "Every repetition satisfied the scenario's semantic invariants"
        : "At least one scenario semantic invariant failed",
    });
    const variation = scenario.summary.totalDurationMs.coefficientOfVariation;
    const level =
      variation > budgets.variability.failureCoefficientOfVariation
        ? "failure"
        : variation > budgets.variability.warningCoefficientOfVariation
          ? "warning"
          : "pass";
    items.push({
      scenarioId: scenario.id,
      metric: "totalDurationMs.coefficientOfVariation",
      level,
      actual: variation,
      message: `Repeated-run coefficient of variation is ${(variation * 100).toFixed(2)}%`,
    });
  }

  const compatibility = baseline ? baselineCompatibility(candidate, baseline) : null;
  if (baseline && compatibility?.comparable) {
    for (const scenario of candidate.scenarios) {
      const baselineScenario = baseline.scenarios.find((item) => item.id === scenario.id);
      if (!baselineScenario) {
        items.push({
          scenarioId: scenario.id,
          metric: "baseline",
          level: "failure",
          message: "Compatible baseline is missing this scenario",
        });
        continue;
      }
      for (const [metric, budget] of Object.entries(budgets.relativeRegression)) {
        const summaryKey = metric as keyof ScenarioResult["summary"];
        const actual = scenario.summary[summaryKey]?.median;
        const reference = baselineScenario.summary[summaryKey]?.median;
        if (actual === undefined || reference === undefined) continue;
        const { level, regressionPercent: regression } = evaluateRelativeBudget(actual, reference, budget);
        items.push({
          scenarioId: scenario.id,
          metric,
          level,
          actual,
          baseline: reference,
          regressionPercent: regression,
          message: `${regression.toFixed(2)}% regression versus compatible baseline`,
        });
      }
    }
  } else if (baseline && compatibility) {
    items.push({
      scenarioId: "*",
      metric: "baseline-compatibility",
      level: "not-compared",
      message: `Relative comparison skipped: ${compatibility.reasons.join(", ")}`,
    });
  }

  return { level: overallLevel(items, compatibility), baselineCompatibility: compatibility, items };
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    corpus: "bench/corpus.json",
    budgets: "bench/budgets.json",
    output: "test-results/benchmark-lab.json",
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") options.corpus = argv[++index] ?? "";
    else if (arg === "--budgets") options.budgets = argv[++index] ?? "";
    else if (arg === "--baseline") options.baseline = argv[++index] ?? "";
    else if (arg === "--output") options.output = argv[++index] ?? "";
    else if (arg === "--check") options.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [corpusBytes, budgetsBytes] = await Promise.all([readFile(options.corpus), readFile(options.budgets)]);
  const corpus = validateCorpus(JSON.parse(corpusBytes.toString("utf8")));
  const budgets = validateBudgets(JSON.parse(budgetsBytes.toString("utf8")));
  const scenarios: ScenarioResult[] = [];
  for (const scenario of corpus.scenarios) scenarios.push(await runScenario(scenario));

  const report: BenchmarkReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    corpus: {
      id: corpus.id,
      sha256: createHash("sha256").update(corpusBytes).digest("hex"),
      description: corpus.description,
    },
    methodology: {
      scope: "sdk-overhead",
      transport: "deterministic-in-process-fixture",
      crossSdkComparable: false,
      note: "Timing is suitable for same-corpus regression analysis on compatible hosts; it is not a cross-SDK rendering or service benchmark.",
    },
    environment: environmentMetadata(),
    scenarios,
    evaluation: { level: "not-compared", baselineCompatibility: null, items: [] },
  };
  const baseline = options.baseline
    ? (JSON.parse(await readFile(options.baseline, "utf8")) as BenchmarkReport)
    : undefined;
  report.evaluation = evaluateReport(report, budgets, baseline);

  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Benchmark lab: ${report.scenarios.length} scenarios, evaluation ${report.evaluation.level}, report ${options.output}\n`,
  );
  for (const scenario of report.scenarios) {
    const throughput = scenario.summary.featuresPerSecond
      ? `${Math.round(scenario.summary.featuresPerSecond.median).toLocaleString()} features/s`
      : `${Math.round(scenario.summary.operationsPerSecond?.median ?? 0).toLocaleString()} operations/s`;
    process.stdout.write(
      `  ${scenario.id}: ${scenario.summary.totalDurationMs.median.toFixed(2)}ms median, ${throughput}\n`,
    );
  }
  if (options.check && report.evaluation.level === "failure") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`benchmark-lab failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
