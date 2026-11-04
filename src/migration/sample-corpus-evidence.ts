import path from "node:path";

import {
  type ClientMigrationCodemodResult,
  type CodemodConstructorKind,
  type CodemodTarget,
  type MigrationTodo,
  runClientMigrationCodemod,
} from "./codemod.js";
import {
  type MigrationSample,
  type MigrationSampleCorpusManifest,
  type MigrationSampleFixtureAnalysis,
  type MigrationSampleGuardrailFlag,
  type MigrationSampleLicenseMetadata,
  type MigrationSampleSkipReason,
  type MigrationSampleSourceReference,
  type MigrationSampleTermsMetadata,
  type PortalItemReference,
  type SourceApiServiceReference,
  analyzeEsriSampleFixture,
  loadEsriSampleCorpusManifest,
} from "./sample-corpus.js";

const DEFAULT_CODEMOD_TARGET: CodemodTarget = "honua-maplibre";

// Skip reasons that prevent the codemod from running against a sample. These
// correspond to samples that would require Esri credentials, premium service
// access, or private Portal content to even render — the codemod has nothing
// useful to say about them in a fixture-only lane, so we record them as
// `status: "skipped"` evidence and surface the manifest skip reasons.
const RUN_BLOCKING_SKIP_REASONS: ReadonlySet<MigrationSampleSkipReason> = new Set([
  "requires-api-key",
  "requires-oauth",
  "premium-service",
  "private-content",
  "unclear-content-terms",
  "unsupported-sample-family",
]);

export type MigrationSampleEvidenceStatus = "migrated" | "skipped" | "error";

export interface MigrationSampleEvidenceClassification {
  auto: number;
  manual: number;
  unsupported: number;
}

export interface MigrationSampleManualTodoReason {
  reason: string;
  count: number;
  kinds: CodemodConstructorKind[];
}

export interface MigrationSampleManualTodos {
  total: number;
  reasons: MigrationSampleManualTodoReason[];
}

export interface MigrationSampleUrlRewriteSummary {
  total: number;
  byKind: Record<string, number>;
}

export interface MigrationSampleEvidenceRecord {
  sampleId: string;
  status: MigrationSampleEvidenceStatus;
  reason?: string;
  codemodTarget: CodemodTarget;
  sourceRef: MigrationSampleSourceReference;
  license: MigrationSampleLicenseMetadata;
  terms: MigrationSampleTermsMetadata;
  skipReasons: MigrationSampleSkipReason[];
  classification: MigrationSampleEvidenceClassification;
  manualTodos: MigrationSampleManualTodos;
  referencedServices: SourceApiServiceReference[];
  portalItems: PortalItemReference[];
  guardrailFlags: MigrationSampleGuardrailFlag[];
  urlRewriteSummary: MigrationSampleUrlRewriteSummary;
  unsupportedApis: string[];
  filesScanned: number;
  filesChanged: number;
}

export interface MigrationSampleEvidenceStatusCounts {
  migrated: number;
  skipped: number;
  error: number;
}

export interface MigrationSampleEvidenceAggregate {
  sampleCount: number;
  codemodTarget: CodemodTarget;
  statusCounts: MigrationSampleEvidenceStatusCounts;
  totals: MigrationSampleEvidenceClassification;
  manualTodoTotal: number;
  uniqueUnsupportedApis: string[];
}

export interface MigrationSampleCorpusEvidence {
  manifestPath?: string;
  codemodTarget: CodemodTarget;
  samples: MigrationSampleEvidenceRecord[];
  aggregate: MigrationSampleEvidenceAggregate;
}

export interface EmitEsriSampleCorpusEvidenceOptions {
  manifestPath: string;
  codemodTarget?: CodemodTarget;
}

export interface BuildEsriSampleCorpusEvidenceOptions {
  manifest: MigrationSampleCorpusManifest;
  manifestDir: string;
  codemodTarget?: CodemodTarget;
}

/**
 * Loads the curated manifest from `manifestPath`, runs the migration codemod
 * (default target: `honua-maplibre`) against each runnable fixture, and emits
 * a structured per-sample + aggregate evidence record. Skipped samples are
 * surfaced as `status: "skipped"` with the manifest skip reason; no live Esri
 * services are contacted.
 */
export function emitEsriSampleCorpusEvidence(
  options: EmitEsriSampleCorpusEvidenceOptions,
): MigrationSampleCorpusEvidence {
  const manifest = loadEsriSampleCorpusManifest(options.manifestPath);
  const manifestDir = path.dirname(path.resolve(options.manifestPath));
  const evidence = buildEsriSampleCorpusEvidence({
    manifest,
    manifestDir,
    codemodTarget: options.codemodTarget,
  });
  return {
    ...evidence,
    manifestPath: path.resolve(options.manifestPath),
  };
}

/**
 * Build evidence directly from an already-loaded manifest. Useful when the
 * caller has already parsed the manifest and wants to avoid re-reading from
 * disk. Behaves identically to `emitEsriSampleCorpusEvidence` otherwise.
 */
export function buildEsriSampleCorpusEvidence(
  options: BuildEsriSampleCorpusEvidenceOptions,
): MigrationSampleCorpusEvidence {
  const codemodTarget = options.codemodTarget ?? DEFAULT_CODEMOD_TARGET;
  const samples = options.manifest.samples.map((sample) =>
    buildSampleEvidence(sample, options.manifestDir, codemodTarget),
  );
  const aggregate = summarizeEvidence(samples, codemodTarget);
  return {
    codemodTarget,
    samples,
    aggregate,
  };
}

function buildSampleEvidence(
  sample: MigrationSample,
  manifestDir: string,
  codemodTarget: CodemodTarget,
): MigrationSampleEvidenceRecord {
  const analysis = analyzeEsriSampleFixture(sample, { manifestDir });
  const skipReason = resolveSkipReason(sample);

  if (skipReason) {
    return buildSkippedEvidence(sample, analysis, codemodTarget, skipReason);
  }

  let codemodResult: ClientMigrationCodemodResult;
  try {
    codemodResult = runClientMigrationCodemod({
      rootDir: path.resolve(manifestDir, sample.fixture.root),
      target: codemodTarget,
      write: false,
      annotateTodos: false,
    });
  } catch (error) {
    return buildErrorEvidence(sample, analysis, codemodTarget, error);
  }

  return buildMigratedEvidence(sample, analysis, codemodTarget, codemodResult);
}

function buildMigratedEvidence(
  sample: MigrationSample,
  analysis: MigrationSampleFixtureAnalysis,
  codemodTarget: CodemodTarget,
  codemodResult: ClientMigrationCodemodResult,
): MigrationSampleEvidenceRecord {
  const metrics = codemodResult.metrics;
  const classification: MigrationSampleEvidenceClassification = {
    auto: metrics.autoMigratedCallSites,
    manual: metrics.manualCallSites,
    unsupported: countUnsupportedCallSites(codemodResult.manualTodos),
  };
  const manualTodos = summarizeManualTodos(codemodResult.manualTodos);
  const unsupportedApis = collectUnsupportedApis(codemodResult.manualTodos);
  const urlRewriteSummary = buildUrlRewriteSummary(analysis.serviceUrls);

  return {
    sampleId: sample.id,
    status: "migrated",
    codemodTarget,
    sourceRef: sample.source,
    license: sample.license,
    terms: sample.terms,
    skipReasons: analysis.skipReasons,
    classification,
    manualTodos,
    referencedServices: analysis.serviceUrls,
    portalItems: analysis.portalItems,
    guardrailFlags: analysis.guardrailFlags,
    urlRewriteSummary,
    unsupportedApis,
    filesScanned: codemodResult.filesScanned,
    filesChanged: codemodResult.filesChanged,
  };
}

function buildSkippedEvidence(
  sample: MigrationSample,
  analysis: MigrationSampleFixtureAnalysis,
  codemodTarget: CodemodTarget,
  reason: string,
): MigrationSampleEvidenceRecord {
  return {
    sampleId: sample.id,
    status: "skipped",
    reason,
    codemodTarget,
    sourceRef: sample.source,
    license: sample.license,
    terms: sample.terms,
    skipReasons: analysis.skipReasons,
    classification: { auto: 0, manual: 0, unsupported: 0 },
    manualTodos: { total: 0, reasons: [] },
    referencedServices: analysis.serviceUrls,
    portalItems: analysis.portalItems,
    guardrailFlags: analysis.guardrailFlags,
    urlRewriteSummary: buildUrlRewriteSummary(analysis.serviceUrls),
    unsupportedApis: [],
    filesScanned: analysis.filesScanned,
    filesChanged: 0,
  };
}

function buildErrorEvidence(
  sample: MigrationSample,
  analysis: MigrationSampleFixtureAnalysis,
  codemodTarget: CodemodTarget,
  error: unknown,
): MigrationSampleEvidenceRecord {
  const message = error instanceof Error ? error.message : String(error);
  return {
    sampleId: sample.id,
    status: "error",
    reason: `codemod failed: ${message}`,
    codemodTarget,
    sourceRef: sample.source,
    license: sample.license,
    terms: sample.terms,
    skipReasons: analysis.skipReasons,
    classification: { auto: 0, manual: 0, unsupported: 0 },
    manualTodos: { total: 0, reasons: [] },
    referencedServices: analysis.serviceUrls,
    portalItems: analysis.portalItems,
    guardrailFlags: analysis.guardrailFlags,
    urlRewriteSummary: buildUrlRewriteSummary(analysis.serviceUrls),
    unsupportedApis: [],
    filesScanned: analysis.filesScanned,
    filesChanged: 0,
  };
}

function resolveSkipReason(sample: MigrationSample): string | undefined {
  if (sample.status !== "skipped") {
    return undefined;
  }
  const reasons = sample.skipReasons ?? [];
  const blocking = reasons.filter((reason) => RUN_BLOCKING_SKIP_REASONS.has(reason));
  if (blocking.length === 0) {
    // Sample is marked skipped but doesn't list a run-blocking reason — record
    // the raw manifest reasons (or a generic fallback) so callers can still
    // see why CI elected to skip it.
    return reasons.length > 0 ? reasons.join(", ") : "manifest marks sample as skipped";
  }
  return blocking.join(", ");
}

function countUnsupportedCallSites(todos: readonly MigrationTodo[]): number {
  return todos.filter((todo) => todo.difficulty === "complex").length;
}

function summarizeManualTodos(todos: readonly MigrationTodo[]): MigrationSampleManualTodos {
  const grouped = new Map<string, { count: number; kinds: Set<CodemodConstructorKind> }>();
  for (const todo of todos) {
    let bucket = grouped.get(todo.reason);
    if (!bucket) {
      bucket = { count: 0, kinds: new Set<CodemodConstructorKind>() };
      grouped.set(todo.reason, bucket);
    }
    bucket.count += 1;
    bucket.kinds.add(todo.kind);
  }

  const reasons = Array.from(grouped.entries())
    .map(([reason, bucket]) => ({
      reason,
      count: bucket.count,
      kinds: Array.from(bucket.kinds).sort(),
    }))
    .sort((a, b) => (a.count === b.count ? a.reason.localeCompare(b.reason) : b.count - a.count));

  return { total: todos.length, reasons };
}

function collectUnsupportedApis(todos: readonly MigrationTodo[]): string[] {
  const kinds = new Set<CodemodConstructorKind>();
  for (const todo of todos) {
    kinds.add(todo.kind);
  }
  return Array.from(kinds).sort();
}

function buildUrlRewriteSummary(services: readonly SourceApiServiceReference[]): MigrationSampleUrlRewriteSummary {
  const byKind: Record<string, number> = {};
  for (const service of services) {
    byKind[service.kind] = (byKind[service.kind] ?? 0) + 1;
  }
  return { total: services.length, byKind };
}

function summarizeEvidence(
  samples: readonly MigrationSampleEvidenceRecord[],
  codemodTarget: CodemodTarget,
): MigrationSampleEvidenceAggregate {
  const statusCounts: MigrationSampleEvidenceStatusCounts = { migrated: 0, skipped: 0, error: 0 };
  const totals: MigrationSampleEvidenceClassification = { auto: 0, manual: 0, unsupported: 0 };
  let manualTodoTotal = 0;
  const uniqueUnsupportedApis = new Set<string>();

  for (const sample of samples) {
    statusCounts[sample.status] += 1;
    totals.auto += sample.classification.auto;
    totals.manual += sample.classification.manual;
    totals.unsupported += sample.classification.unsupported;
    manualTodoTotal += sample.manualTodos.total;
    for (const api of sample.unsupportedApis) {
      uniqueUnsupportedApis.add(api);
    }
  }

  return {
    sampleCount: samples.length,
    codemodTarget,
    statusCounts,
    totals,
    manualTodoTotal,
    uniqueUnsupportedApis: Array.from(uniqueUnsupportedApis).sort(),
  };
}
