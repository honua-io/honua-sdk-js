import fs from "node:fs";

import type { CodemodConstructorKind, CodemodTarget } from "./codemod.js";
import type { JsMigrationReport, MigrationReadiness } from "./report.js";
import type { WidgetReadinessReport } from "./widget-scanner.js";

/**
 * Third-party open-source ArcGIS JS app corpus (issue #955).
 *
 * The corpus is a *manifest of pointers*: every entry names a public GitHub
 * repository, the exact commit the lane checks out, and the reviewed license
 * that permits that checkout. No third-party source is vendored into this
 * repository — the opt-in lane clones into an ignored scratch directory,
 * runs the scanner/codemod over the working copy, and keeps only the
 * structured readiness records.
 */
export const OSS_ARCGIS_CORPUS_MANIFEST_FORMAT = "honua.sdk.oss-arcgis-corpus.v1";
export const OSS_ARCGIS_CORPUS_READINESS_FORMAT = "honua.sdk.oss-arcgis-corpus-readiness.v1";

/** Default manifest location, relative to the repository root. */
export const OSS_ARCGIS_CORPUS_MANIFEST_PATH = "config/oss-arcgis-corpus.v1.json";

/** Minimum corpus size required by #955 REQ-001. */
export const OSS_ARCGIS_CORPUS_MIN_APPS = 5;

/**
 * Authoring styles the corpus must span (#955 REQ-001). A single app may carry
 * more than one style; the corpus as a whole must cover all three.
 */
export const OSS_ARCGIS_APP_STYLES = ["widget-heavy", "amd-require", "featurelayer-centric"] as const;

export type OssArcGisAppStyle = (typeof OSS_ARCGIS_APP_STYLES)[number];

export const OSS_ARCGIS_AUTHOR_KINDS = [
  "government",
  "university",
  "ngo",
  "civic-tech",
  "individual",
  "vendor",
] as const;

export type OssArcGisAuthorKind = (typeof OSS_ARCGIS_AUTHOR_KINDS)[number];

export interface OssArcGisCorpusManifest {
  format: typeof OSS_ARCGIS_CORPUS_MANIFEST_FORMAT;
  schemaVersion: 1;
  /** ISO date (YYYY-MM-DD) the manifest itself was last reviewed. */
  revision: string;
  guardrails: OssArcGisCorpusGuardrails;
  licensePolicy: OssArcGisLicensePolicy;
  lane: OssArcGisLaneSettings;
  apps: OssArcGisCorpusApp[];
}

export interface OssArcGisCorpusGuardrails {
  /** Third-party source is never committed to this repository. */
  noVendoredThirdPartyCode: boolean;
  /** The lane never runs as part of pull-request CI. */
  excludedFromPrCi: boolean;
  /** The lane refuses to run unless its opt-in env var is set. */
  requiresOptIn: boolean;
  /** The lane performs static analysis only — it never contacts Esri services. */
  noLiveEsriServiceContact: boolean;
  /** The lane never installs dependencies declared by a cloned third-party app. */
  noThirdPartyDependencyInstall: boolean;
  notes: string[];
}

export interface OssArcGisLicensePolicy {
  /** SPDX ids accepted for corpus membership. */
  allowedSpdxIds: string[];
  /** How license review is performed and recorded. */
  review: string;
}

export interface OssArcGisLaneSettings {
  /** Env var that must equal "true" for the lane to do any work. */
  optInEnvVar: string;
  /** Ignored scratch directory clones are written to, relative to the repo root. */
  checkoutRoot: string;
  /** Directory the lane writes per-app reports into, relative to the repo root. */
  reportRoot: string;
  /** Committed observation the published summary page is generated from. */
  publishedObservationPath: string;
  codemodTarget: CodemodTarget;
  /** Minimum automated widget-disposition share passed to `widgets --gate`. */
  widgetGatePct: number;
}

export interface OssArcGisCorpusApp {
  id: string;
  title: string;
  repo: OssArcGisRepoReference;
  license: OssArcGisLicenseRecord;
  provenance: OssArcGisProvenance;
  styles: OssArcGisAppStyle[];
  /**
   * Repo-relative directory the scanner/codemod is pointed at. Use "." to scan
   * the whole checkout. Must stay inside the checkout.
   */
  scanRoot: string;
  /** Repo-relative files that were read during review to confirm ArcGIS usage. */
  evidencePaths: string[];
  notes: string;
}

export interface OssArcGisRepoReference {
  host: "github";
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
  /** Full 40-character lowercase commit SHA the lane checks out. */
  commit: string;
  /** ISO date (YYYY-MM-DD) the commit and license were observed. */
  observedAt: string;
}

export interface OssArcGisLicenseRecord {
  spdxId: string;
  /** Permalink to the license file at the pinned commit. */
  url: string;
  holder: string;
}

export interface OssArcGisProvenance {
  authorKind: OssArcGisAuthorKind;
  author: string;
  description: string;
}

export interface OssArcGisCorpusSummary {
  appCount: number;
  styleCoverage: Record<OssArcGisAppStyle, number>;
  licenseCounts: Record<string, number>;
  authorKindCounts: Record<string, number>;
  /** Empty when the corpus satisfies every REQ-001/NFR-001 guardrail. */
  guardrailFailures: string[];
}

export type OssArcGisAppObservationStatus = "observed" | "error";

export interface OssArcGisKindCount {
  kind: string;
  count: number;
}

export interface OssArcGisModuleCount {
  modulePath: string;
  usageStyle: string;
  count: number;
}

export interface OssArcGisWidgetSummary {
  totalSites: number;
  automatedSites: number;
  assistedSites: number;
  manualSites: number;
  automatedPct: number;
  gatePct: number;
  gatePassed: boolean;
  topManualWidgets: OssArcGisKindCount[];
}

export interface OssArcGisAppReadiness {
  appId: string;
  title: string;
  repoUrl: string;
  commit: string;
  licenseSpdxId: string;
  authorKind: OssArcGisAuthorKind;
  styles: OssArcGisAppStyle[];
  /** ISO date (YYYY-MM-DD) this observation was taken. */
  observedAt: string;
  status: OssArcGisAppObservationStatus;
  codemodTarget: CodemodTarget;
  readiness: MigrationReadiness | "unknown";
  scanSummary: string;
  filesScanned: number;
  filesWithArcGisImports: number;
  /**
   * Mirrors `JsMigrationReport.usageDetected`: false when the scanner walked
   * source files but found no ArcGIS module usage at all. For a corpus app —
   * every one of which was reviewed and recorded with evidence paths proving
   * it uses the ArcGIS JS API — this is a *detection gap*, not a clean bill of
   * health, and the readiness value next to it must not be read as "nothing to
   * migrate". The report now says so itself (`readiness: "no-usage-detected"`);
   * this field stays so the published observation keeps a stable shape.
   */
  usageDetected: boolean;
  totalCallSites: number;
  autoMigratedCallSites: number;
  manualCallSites: number;
  /** Share of codemod-scoped call sites the codemod rewrote without a TODO, 0..1. */
  autoMigratedRatio: number;
  manualRewriteRatio: number;
  manualInterventionRatio: number;
  unhandledUsageHits: number;
  topManualTodoKinds: OssArcGisKindCount[];
  topUnhandledModules: OssArcGisModuleCount[];
  blockingFlags: string[];
  scanFlags: string[];
  widgets?: OssArcGisWidgetSummary;
  error?: string;
}

export interface OssArcGisCorpusRunSummary {
  appCount: number;
  observed: number;
  errored: number;
  ready: number;
  assisted: number;
  blocked: number;
  totalCallSites: number;
  autoMigratedCallSites: number;
  manualCallSites: number;
  /** Corpus-wide auto-migrated call-site ratio, 0..1. */
  autoMigratedRatio: number;
  unhandledUsageHits: number;
  topManualTodoKinds: OssArcGisKindCount[];
  blockedApps: string[];
  /** Apps whose ArcGIS usage the scanner failed to see at all (detection gap). */
  undetectedApps: string[];
  styleCoverage: Record<OssArcGisAppStyle, number>;
}

export interface OssArcGisCorpusRun {
  format: typeof OSS_ARCGIS_CORPUS_READINESS_FORMAT;
  schemaVersion: 1;
  /** ISO timestamp the run was produced. */
  generatedAt: string;
  manifestRevision: string;
  codemodTarget: CodemodTarget;
  lane: {
    optInEnvVar: string;
    excludedFromPrCi: boolean;
    noLiveEsriServiceContact: boolean;
  };
  summary: OssArcGisCorpusRunSummary;
  apps: OssArcGisAppReadiness[];
}

const BLOCKING_SCAN_FLAGS = new Set(["scene-3d-detected", "advanced-widget-or-networking-detected"]);
const COMMIT_SHA_LENGTH = 40;
const ISO_DATE_LENGTH = 10;
const TOP_N = 5;

export function loadOssArcGisCorpusManifest(manifestPath: string): OssArcGisCorpusManifest {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  return parseOssArcGisCorpusManifest(parsed, manifestPath);
}

export function parseOssArcGisCorpusManifest(value: unknown, sourceName = "manifest"): OssArcGisCorpusManifest {
  const record = expectRecord(value, sourceName);
  if (record.format !== OSS_ARCGIS_CORPUS_MANIFEST_FORMAT) {
    throw new Error(`${sourceName}.format must be ${OSS_ARCGIS_CORPUS_MANIFEST_FORMAT}.`);
  }
  if (record.schemaVersion !== 1) {
    throw new Error(`${sourceName}.schemaVersion must be 1.`);
  }

  const guardrailsRecord = expectRecord(record.guardrails, `${sourceName}.guardrails`);
  const licenseRecord = expectRecord(record.licensePolicy, `${sourceName}.licensePolicy`);
  const laneRecord = expectRecord(record.lane, `${sourceName}.lane`);

  const licensePolicy: OssArcGisLicensePolicy = {
    allowedSpdxIds: expectStringArray(licenseRecord.allowedSpdxIds, `${sourceName}.licensePolicy.allowedSpdxIds`),
    review: expectString(licenseRecord.review, `${sourceName}.licensePolicy.review`),
  };

  const apps = expectArray(record.apps, `${sourceName}.apps`).map((app, index) =>
    parseApp(app, `${sourceName}.apps[${index}]`, licensePolicy),
  );

  return {
    format: OSS_ARCGIS_CORPUS_MANIFEST_FORMAT,
    schemaVersion: 1,
    revision: expectIsoDate(record.revision, `${sourceName}.revision`),
    guardrails: {
      noVendoredThirdPartyCode: expectBoolean(
        guardrailsRecord.noVendoredThirdPartyCode,
        `${sourceName}.guardrails.noVendoredThirdPartyCode`,
      ),
      excludedFromPrCi: expectBoolean(guardrailsRecord.excludedFromPrCi, `${sourceName}.guardrails.excludedFromPrCi`),
      requiresOptIn: expectBoolean(guardrailsRecord.requiresOptIn, `${sourceName}.guardrails.requiresOptIn`),
      noLiveEsriServiceContact: expectBoolean(
        guardrailsRecord.noLiveEsriServiceContact,
        `${sourceName}.guardrails.noLiveEsriServiceContact`,
      ),
      noThirdPartyDependencyInstall: expectBoolean(
        guardrailsRecord.noThirdPartyDependencyInstall,
        `${sourceName}.guardrails.noThirdPartyDependencyInstall`,
      ),
      notes: expectStringArray(guardrailsRecord.notes, `${sourceName}.guardrails.notes`),
    },
    licensePolicy,
    lane: {
      optInEnvVar: expectString(laneRecord.optInEnvVar, `${sourceName}.lane.optInEnvVar`),
      checkoutRoot: expectRelativePath(laneRecord.checkoutRoot, `${sourceName}.lane.checkoutRoot`),
      reportRoot: expectRelativePath(laneRecord.reportRoot, `${sourceName}.lane.reportRoot`),
      publishedObservationPath: expectRelativePath(
        laneRecord.publishedObservationPath,
        `${sourceName}.lane.publishedObservationPath`,
      ),
      codemodTarget: expectString(laneRecord.codemodTarget, `${sourceName}.lane.codemodTarget`) as CodemodTarget,
      widgetGatePct: expectNumber(laneRecord.widgetGatePct, `${sourceName}.lane.widgetGatePct`),
    },
    apps,
  };
}

/**
 * Validate corpus-level guardrails (#955 REQ-001, NFR-001): the corpus must be
 * large enough, span all three authoring styles, and keep every "no vendored
 * code / opt-in only" promise switched on.
 */
export function summarizeOssArcGisCorpus(manifest: OssArcGisCorpusManifest): OssArcGisCorpusSummary {
  const guardrailFailures: string[] = [];

  if (!manifest.guardrails.noVendoredThirdPartyCode) {
    guardrailFailures.push("guardrails.noVendoredThirdPartyCode must remain true");
  }
  if (!manifest.guardrails.excludedFromPrCi) {
    guardrailFailures.push("guardrails.excludedFromPrCi must remain true");
  }
  if (!manifest.guardrails.requiresOptIn) {
    guardrailFailures.push("guardrails.requiresOptIn must remain true");
  }
  if (!manifest.guardrails.noLiveEsriServiceContact) {
    guardrailFailures.push("guardrails.noLiveEsriServiceContact must remain true");
  }
  if (!manifest.guardrails.noThirdPartyDependencyInstall) {
    guardrailFailures.push("guardrails.noThirdPartyDependencyInstall must remain true");
  }

  if (manifest.apps.length < OSS_ARCGIS_CORPUS_MIN_APPS) {
    guardrailFailures.push(
      `corpus must pin at least ${OSS_ARCGIS_CORPUS_MIN_APPS} apps (found ${manifest.apps.length})`,
    );
  }

  const styleCoverage = {} as Record<OssArcGisAppStyle, number>;
  for (const style of OSS_ARCGIS_APP_STYLES) {
    styleCoverage[style] = 0;
  }
  const licenseCounts: Record<string, number> = {};
  const authorKindCounts: Record<string, number> = {};
  const seenIds = new Set<string>();
  const seenRepos = new Set<string>();

  for (const app of manifest.apps) {
    if (seenIds.has(app.id)) {
      guardrailFailures.push(`${app.id}: duplicate app id`);
    }
    seenIds.add(app.id);

    const repoKey = `${app.repo.owner}/${app.repo.name}`.toLowerCase();
    if (seenRepos.has(repoKey)) {
      guardrailFailures.push(`${app.id}: duplicate repository ${repoKey}`);
    }
    seenRepos.add(repoKey);

    if (!manifest.licensePolicy.allowedSpdxIds.includes(app.license.spdxId)) {
      guardrailFailures.push(`${app.id}: license ${app.license.spdxId} is not in licensePolicy.allowedSpdxIds`);
    }

    for (const style of app.styles) {
      styleCoverage[style] += 1;
    }
    licenseCounts[app.license.spdxId] = (licenseCounts[app.license.spdxId] ?? 0) + 1;
    authorKindCounts[app.provenance.authorKind] = (authorKindCounts[app.provenance.authorKind] ?? 0) + 1;
  }

  for (const style of OSS_ARCGIS_APP_STYLES) {
    if (styleCoverage[style] === 0) {
      guardrailFailures.push(`corpus must include at least one "${style}" app`);
    }
  }

  return {
    appCount: manifest.apps.length,
    styleCoverage,
    licenseCounts,
    authorKindCounts,
    guardrailFailures,
  };
}

export interface BuildOssArcGisAppReadinessOptions {
  app: OssArcGisCorpusApp;
  observedAt: string;
  codemodTarget: CodemodTarget;
  report?: JsMigrationReport;
  widgetReport?: WidgetReadinessReport;
  widgetGatePct?: number;
  error?: string;
}

/**
 * Project a `JsMigrationReport` (the existing report schema emitted by
 * `honua-migrate codemod --report`) plus the widget readiness report onto the
 * per-app corpus record published by the lane (#955 REQ-002).
 */
export function buildOssArcGisAppReadiness(options: BuildOssArcGisAppReadinessOptions): OssArcGisAppReadiness {
  const { app, observedAt, codemodTarget, report, widgetReport, error } = options;

  const base: OssArcGisAppReadiness = {
    appId: app.id,
    title: app.title,
    repoUrl: app.repo.url,
    commit: app.repo.commit,
    licenseSpdxId: app.license.spdxId,
    authorKind: app.provenance.authorKind,
    styles: [...app.styles],
    observedAt,
    status: report ? "observed" : "error",
    codemodTarget,
    readiness: report?.readiness ?? "unknown",
    scanSummary: report?.scanSummary ?? "",
    filesScanned: report?.codemodResult.filesScanned ?? 0,
    filesWithArcGisImports: report?.scanReport.filesWithArcGisImports ?? 0,
    // The report carries this signal itself (#982); the lane no longer derives
    // it. A report from an older CLI that predates the field reads as a
    // detection gap, which is the safe direction to fail.
    usageDetected: report?.usageDetected === true,
    totalCallSites: report?.codemodResult.metrics.totalCodemodScopedCallSites ?? 0,
    autoMigratedCallSites: report?.codemodResult.metrics.autoMigratedCallSites ?? 0,
    manualCallSites: report?.codemodResult.metrics.manualCallSites ?? 0,
    autoMigratedRatio: 0,
    manualRewriteRatio: report?.manualRewriteMetric.ratio ?? 0,
    manualInterventionRatio: report?.manualInterventionMetric.ratio ?? 0,
    unhandledUsageHits: report?.manualInterventionMetric.unhandledUsageHits ?? 0,
    topManualTodoKinds: [],
    topUnhandledModules: [],
    blockingFlags: [],
    scanFlags: report ? [...report.scanReport.flags].sort() : [],
  };

  if (error) {
    base.error = error;
  }

  if (!report) {
    return base;
  }

  base.autoMigratedRatio = base.totalCallSites === 0 ? 0 : round4(base.autoMigratedCallSites / base.totalCallSites);
  base.manualRewriteRatio = round4(base.manualRewriteRatio);
  base.manualInterventionRatio = round4(base.manualInterventionRatio);
  base.topManualTodoKinds = topManualTodoKinds(report.manualTodosByKind);
  base.topUnhandledModules = report.unhandledArcGisModules.slice(0, TOP_N).map((moduleItem) => ({
    modulePath: moduleItem.modulePath,
    usageStyle: moduleItem.usageStyle,
    count: moduleItem.count,
  }));
  base.blockingFlags = report.scanReport.flags.filter((flag) => BLOCKING_SCAN_FLAGS.has(flag)).sort();

  if (widgetReport) {
    const gatePct = options.widgetGatePct ?? 0;
    base.widgets = {
      totalSites: widgetReport.summary.totalSites,
      automatedSites: widgetReport.summary.automatedSites,
      assistedSites: widgetReport.summary.assistedSites,
      manualSites: widgetReport.summary.manualSites,
      automatedPct: round4(widgetReport.summary.automatedPct),
      gatePct,
      gatePassed: widgetReport.summary.automatedPct >= gatePct,
      topManualWidgets: widgetReport.widgets
        .filter((row) => row.bucket === "manual")
        .sort((a, b) => (a.count === b.count ? a.widget.localeCompare(b.widget) : b.count - a.count))
        .slice(0, TOP_N)
        .map((row) => ({ kind: row.widget, count: row.count })),
    };
  }

  return base;
}

export interface BuildOssArcGisCorpusRunOptions {
  manifest: OssArcGisCorpusManifest;
  apps: readonly OssArcGisAppReadiness[];
  generatedAt: string;
}

export function buildOssArcGisCorpusRun(options: BuildOssArcGisCorpusRunOptions): OssArcGisCorpusRun {
  const { manifest, apps, generatedAt } = options;

  const totalCallSites = apps.reduce((total, app) => total + app.totalCallSites, 0);
  const autoMigratedCallSites = apps.reduce((total, app) => total + app.autoMigratedCallSites, 0);
  const manualCallSites = apps.reduce((total, app) => total + app.manualCallSites, 0);
  const unhandledUsageHits = apps.reduce((total, app) => total + app.unhandledUsageHits, 0);

  const kindTotals = new Map<string, number>();
  for (const app of apps) {
    for (const entry of app.topManualTodoKinds) {
      kindTotals.set(entry.kind, (kindTotals.get(entry.kind) ?? 0) + entry.count);
    }
  }

  const styleCoverage = {} as Record<OssArcGisAppStyle, number>;
  for (const style of OSS_ARCGIS_APP_STYLES) {
    styleCoverage[style] = apps.filter((app) => app.styles.includes(style)).length;
  }

  return {
    format: OSS_ARCGIS_CORPUS_READINESS_FORMAT,
    schemaVersion: 1,
    generatedAt,
    manifestRevision: manifest.revision,
    codemodTarget: manifest.lane.codemodTarget,
    lane: {
      optInEnvVar: manifest.lane.optInEnvVar,
      excludedFromPrCi: manifest.guardrails.excludedFromPrCi,
      noLiveEsriServiceContact: manifest.guardrails.noLiveEsriServiceContact,
    },
    summary: {
      appCount: apps.length,
      observed: apps.filter((app) => app.status === "observed").length,
      errored: apps.filter((app) => app.status === "error").length,
      ready: apps.filter((app) => app.readiness === "ready").length,
      assisted: apps.filter((app) => app.readiness === "assisted").length,
      blocked: apps.filter((app) => app.readiness === "blocked").length,
      totalCallSites,
      autoMigratedCallSites,
      manualCallSites,
      autoMigratedRatio: totalCallSites === 0 ? 0 : round4(autoMigratedCallSites / totalCallSites),
      unhandledUsageHits,
      topManualTodoKinds: sortKindCounts(kindTotals).slice(0, TOP_N),
      blockedApps: apps.filter((app) => app.readiness === "blocked").map((app) => app.appId),
      undetectedApps: apps.filter((app) => app.status === "observed" && !app.usageDetected).map((app) => app.appId),
      styleCoverage,
    },
    apps: [...apps],
  };
}

/**
 * Regression gate for the opt-in lane: an app may not fall below the
 * auto-migrated call-site ratio recorded in the published observation, and a
 * pinned app that previously produced a report may not start erroring.
 */
export interface OssArcGisRegressionOptions {
  /** Allowed downward drift in the auto-migrated ratio before failing. */
  tolerance?: number;
}

export interface OssArcGisRegressionResult {
  passed: boolean;
  failures: string[];
}

export function evaluateOssArcGisCorpusRegression(
  baseline: OssArcGisCorpusRun,
  current: OssArcGisCorpusRun,
  options: OssArcGisRegressionOptions = {},
): OssArcGisRegressionResult {
  const tolerance = options.tolerance ?? 0;
  const failures: string[] = [];
  const currentById = new Map(current.apps.map((app) => [app.appId, app]));

  for (const baselineApp of baseline.apps) {
    const currentApp = currentById.get(baselineApp.appId);
    if (!currentApp) {
      failures.push(`${baselineApp.appId}: present in the published observation but missing from this run`);
      continue;
    }
    if (baselineApp.status === "observed" && currentApp.status !== "observed") {
      failures.push(`${baselineApp.appId}: previously observed, now ${currentApp.status}`);
      continue;
    }
    if (baselineApp.usageDetected && !currentApp.usageDetected) {
      failures.push(
        `${baselineApp.appId}: ArcGIS usage was previously detected and is no longer visible to the scanner`,
      );
    }
    if (currentApp.autoMigratedRatio + tolerance < baselineApp.autoMigratedRatio) {
      failures.push(
        `${baselineApp.appId}: auto-migrated ratio regressed ${baselineApp.autoMigratedRatio.toFixed(3)} -> ${currentApp.autoMigratedRatio.toFixed(3)}`,
      );
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Render the published summary page body (#955 REQ-003). Every figure comes
 * from the committed observation, so the page can never carry a hand-edited
 * number.
 */
export function formatOssArcGisCorpusMarkdown(manifest: OssArcGisCorpusManifest, run: OssArcGisCorpusRun): string {
  const lines: string[] = [];
  const summary = summarizeOssArcGisCorpus(manifest);
  const appById = new Map(manifest.apps.map((app) => [app.id, app]));

  lines.push("<!-- GENERATED FILE - DO NOT EDIT.");
  lines.push(`     Sources of truth: ${OSS_ARCGIS_CORPUS_MANIFEST_PATH}`);
  lines.push(`                       ${manifest.lane.publishedObservationPath}`);
  lines.push("     Regenerate with: npm run docs:oss-arcgis-corpus -->");
  lines.push("");
  lines.push("# Third-party open-source ArcGIS app readiness");
  lines.push("");
  lines.push(
    "Every other migration number Honua publishes comes from Honua-authored fixtures. This page does not: " +
      "it reports what `honua-migrate` does to **real, third-party, open-source ArcGIS JS applications** that " +
      "were written by other people, for their own purposes, with no knowledge of the codemod.",
  );
  lines.push("");
  lines.push(
    [
      `The corpus pins ${summary.appCount} public GitHub repositories at an exact commit with a reviewed`,
      "permissive license. No third-party source is vendored here — the lane clones into an ignored scratch",
      "directory, analyzes the working copy, and keeps only the structured records below.",
    ].join(" "),
  );
  lines.push("");
  lines.push(`- Observation generated: \`${run.generatedAt}\``);
  lines.push(`- Manifest revision: \`${manifest.revision}\``);
  lines.push(`- Codemod target: \`${run.codemodTarget}\``);
  lines.push(
    [
      `- Lane: opt-in only (\`${run.lane.optInEnvVar}=true\`), never part of pull-request CI, static analysis`,
      "only (no live Esri service contact).",
    ].join(" "),
  );
  lines.push("");
  lines.push("## Corpus totals");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Apps pinned | ${run.summary.appCount} |`);
  lines.push(`| Apps observed | ${run.summary.observed} |`);
  lines.push(`| Apps errored | ${run.summary.errored} |`);
  lines.push(
    `| Readiness \`ready\` / \`assisted\` / \`blocked\` | ${run.summary.ready} / ${run.summary.assisted} / ${run.summary.blocked} |`,
  );
  lines.push(`| Codemod-scoped call sites | ${run.summary.totalCallSites} |`);
  lines.push(`| Auto-migrated call sites | ${run.summary.autoMigratedCallSites} |`);
  lines.push(`| Auto-migrated call-site ratio | ${formatRatio(run.summary.autoMigratedRatio)} |`);
  lines.push(`| ArcGIS module hits outside codemod scope | ${run.summary.unhandledUsageHits} |`);
  lines.push(`| Apps with no ArcGIS usage detected | ${run.summary.undetectedApps.length} |`);
  lines.push("");

  if (run.summary.undetectedApps.length > 0) {
    lines.push("### Detection gaps");
    lines.push("");
    lines.push(
      "The scanner found **no ArcGIS usage at all** in the apps below, even though each one was reviewed and " +
        "recorded with evidence paths proving it uses the ArcGIS JS API. Nothing about these apps was measured: " +
        'the report says so with `readiness: "no-usage-detected"`, and every metric next to it is a measurement ' +
        "of the scanner's blind spot, not of the app.",
    );
    lines.push("");
    for (const appId of run.summary.undetectedApps) {
      const app = run.apps.find((candidate) => candidate.appId === appId);
      const manifestApp = appById.get(appId);
      if (!app || !manifestApp) {
        continue;
      }
      lines.push(
        [
          `- **${app.title}** — ${app.filesScanned} source ${app.filesScanned === 1 ? "file" : "files"} scanned,`,
          "0 with a recognized ArcGIS import.",
          `Reviewed evidence: ${manifestApp.evidencePaths.map((entry) => `\`${entry}\``).join(", ")}.`,
        ].join(" "),
      );
    }
    lines.push("");
  }

  if (run.summary.topManualTodoKinds.length > 0) {
    lines.push("### Top manual-TODO kinds across the corpus");
    lines.push("");
    lines.push("| Kind | Manual TODOs |");
    lines.push("| --- | --- |");
    for (const entry of run.summary.topManualTodoKinds) {
      lines.push(`| \`${entry.kind}\` | ${entry.count} |`);
    }
    lines.push("");
  }

  lines.push("## Per-app readiness");
  lines.push("");
  lines.push("| App | Styles | Readiness | Auto-migrated | Manual TODOs | Unhandled hits | Blocking flags |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const app of run.apps) {
    const styles = app.styles.map((style) => `\`${style}\``).join(", ");
    const blocking = app.blockingFlags.length === 0 ? "—" : app.blockingFlags.map((f) => `\`${f}\``).join(", ");
    const autoMigrated =
      app.status !== "observed"
        ? "—"
        : !app.usageDetected
          ? "no usage detected"
          : `${formatRatio(app.autoMigratedRatio)} (${app.autoMigratedCallSites}/${app.totalCallSites})`;
    // `no-usage-detected` already says it; only an older-shaped verdict needs
    // the qualifier spelled out next to it.
    const readiness =
      app.status === "observed" && !app.usageDetected && app.readiness !== "no-usage-detected"
        ? `\`${app.readiness}\` (not meaningful)`
        : `\`${app.readiness}\``;
    lines.push(
      `| [${app.title}](#${headingAnchor(app.title)}) | ${styles} | ${readiness} | ${autoMigrated} | ${app.manualCallSites} | ${app.unhandledUsageHits} | ${blocking} |`,
    );
  }
  lines.push("");

  lines.push("## App detail");
  lines.push("");
  for (const app of run.apps) {
    const manifestApp = appById.get(app.appId);
    lines.push(`### ${app.title}`);
    lines.push("");
    if (manifestApp) {
      lines.push(`${manifestApp.provenance.description}`);
      lines.push("");
      lines.push(`- Author: ${manifestApp.provenance.author} (\`${manifestApp.provenance.authorKind}\`)`);
    }
    lines.push(`- Repository: <${app.repoUrl}>`);
    lines.push(`- Pinned commit: \`${app.commit}\``);
    lines.push(`- License: \`${app.licenseSpdxId}\`${manifestApp ? ` — ${manifestApp.license.url}` : ""}`);
    lines.push(`- Observed: ${app.observedAt}`);
    if (manifestApp) {
      lines.push(`- Scan root: \`${manifestApp.scanRoot}\``);
    }
    lines.push("");

    if (app.status !== "observed") {
      lines.push(`> Not observed in this run: ${app.error ?? "unknown error"}`);
      lines.push("");
      continue;
    }

    lines.push('```text doc-test=skip reason="captured honua-migrate scanner output, not a compilable snippet"');
    lines.push(app.scanSummary);
    lines.push("```");
    lines.push("");
    if (!app.usageDetected) {
      lines.push(
        [
          `> **Detection gap.** ${app.filesScanned} source ${app.filesScanned === 1 ? "file was" : "files were"}`,
          "scanned and none produced a recognized ArcGIS import, so no codemod-scoped call site exists to",
          "migrate or count. Every metric below is a measurement of the scanner's blind spot, not of this app.",
        ].join(" "),
      );
      lines.push("");
    }

    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    const readinessNote =
      app.usageDetected || app.readiness === "no-usage-detected" ? "" : " (not meaningful — see above)";
    lines.push(`| Readiness | \`${app.readiness}\`${readinessNote} |`);
    lines.push(`| Files scanned | ${app.filesScanned} |`);
    lines.push(`| Files importing ArcGIS modules | ${app.filesWithArcGisImports} |`);
    lines.push(`| Codemod-scoped call sites | ${app.totalCallSites} |`);
    lines.push(`| Auto-migrated call-site ratio | ${formatRatio(app.autoMigratedRatio)} |`);
    lines.push(`| Manual-rewrite ratio | ${formatRatio(app.manualRewriteRatio)} |`);
    lines.push(`| Manual-intervention ratio | ${formatRatio(app.manualInterventionRatio)} |`);
    if (app.widgets) {
      lines.push(
        `| Widget sites (automated / assisted / manual) | ${app.widgets.automatedSites} / ${app.widgets.assistedSites} / ${app.widgets.manualSites} |`,
      );
      lines.push(
        `| Widget gate (\`--gate ${app.widgets.gatePct}\`) | ${app.widgets.gatePassed ? "pass" : "fail"} at ${app.widgets.automatedPct.toFixed(1)}% automated |`,
      );
    }
    lines.push("");

    if (app.topManualTodoKinds.length > 0) {
      lines.push("Top manual-TODO kinds:");
      lines.push("");
      for (const entry of app.topManualTodoKinds) {
        lines.push(`- \`${entry.kind}\` — ${entry.count}`);
      }
      lines.push("");
    }

    if (app.topUnhandledModules.length > 0) {
      lines.push("Top ArcGIS modules outside codemod scope:");
      lines.push("");
      for (const entry of app.topUnhandledModules) {
        lines.push(`- \`${entry.modulePath}\` (\`${entry.usageStyle}\`) — ${entry.count}`);
      }
      lines.push("");
    }

    if (app.blockingFlags.length > 0) {
      lines.push(`Blocking flags: ${app.blockingFlags.map((flag) => `\`${flag}\``).join(", ")}`);
      lines.push("");
    }
  }

  lines.push("## Reproducing this page");
  lines.push("");
  lines.push('```bash doc-test=skip reason="shell commands for the opt-in lane, not a compilable snippet"');
  lines.push(`${manifest.lane.optInEnvVar}=true npm run corpus:oss-arcgis`);
  lines.push("npm run docs:oss-arcgis-corpus");
  lines.push("```");
  lines.push("");
  lines.push(
    "See [docs/oss-arcgis-corpus.md](./oss-arcgis-corpus.md) for the manifest shape, license policy, and lane " +
      "guardrails.",
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
}

/**
 * Slug for an in-page heading link. Mirrors both GitHub's markdown anchor
 * algorithm and the docs-site heading-id generator (`scripts/build-docs-site.mjs`)
 * so the per-app table links resolve in the repository view and on the site.
 */
function headingAnchor(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function topManualTodoKinds(byKind: Record<CodemodConstructorKind, number>): OssArcGisKindCount[] {
  const counts = new Map<string, number>();
  for (const [kind, count] of Object.entries(byKind)) {
    if (count > 0) {
      counts.set(kind, count);
    }
  }
  return sortKindCounts(counts).slice(0, TOP_N);
}

function sortKindCounts(counts: Map<string, number>): OssArcGisKindCount[] {
  return Array.from(counts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (a.count === b.count ? a.kind.localeCompare(b.kind) : b.count - a.count));
}

function parseApp(value: unknown, sourceName: string, licensePolicy: OssArcGisLicensePolicy): OssArcGisCorpusApp {
  const record = expectRecord(value, sourceName);
  const repoRecord = expectRecord(record.repo, `${sourceName}.repo`);
  const licenseRecord = expectRecord(record.license, `${sourceName}.license`);
  const provenanceRecord = expectRecord(record.provenance, `${sourceName}.provenance`);

  if (repoRecord.host !== "github") {
    throw new Error(`${sourceName}.repo.host must be "github".`);
  }

  const owner = expectString(repoRecord.owner, `${sourceName}.repo.owner`);
  const name = expectString(repoRecord.name, `${sourceName}.repo.name`);
  const url = expectString(repoRecord.url, `${sourceName}.repo.url`);
  const expectedUrl = `https://github.com/${owner}/${name}`;
  if (url !== expectedUrl) {
    throw new Error(`${sourceName}.repo.url must be ${expectedUrl}.`);
  }

  const spdxId = expectString(licenseRecord.spdxId, `${sourceName}.license.spdxId`);
  if (!licensePolicy.allowedSpdxIds.includes(spdxId)) {
    throw new Error(
      `${sourceName}.license.spdxId ${spdxId} is not permitted (allowed: ${licensePolicy.allowedSpdxIds.join(", ")}).`,
    );
  }

  const styles = expectStringArray(record.styles, `${sourceName}.styles`);
  if (styles.length === 0) {
    throw new Error(`${sourceName}.styles must list at least one style.`);
  }
  for (const style of styles) {
    if (!OSS_ARCGIS_APP_STYLES.includes(style as OssArcGisAppStyle)) {
      throw new Error(`${sourceName}.styles contains unknown style ${style}.`);
    }
  }

  const authorKind = expectString(provenanceRecord.authorKind, `${sourceName}.provenance.authorKind`);
  if (!OSS_ARCGIS_AUTHOR_KINDS.includes(authorKind as OssArcGisAuthorKind)) {
    throw new Error(`${sourceName}.provenance.authorKind contains unknown kind ${authorKind}.`);
  }

  return {
    id: expectString(record.id, `${sourceName}.id`),
    title: expectString(record.title, `${sourceName}.title`),
    repo: {
      host: "github",
      owner,
      name,
      url,
      defaultBranch: expectString(repoRecord.defaultBranch, `${sourceName}.repo.defaultBranch`),
      commit: expectCommitSha(repoRecord.commit, `${sourceName}.repo.commit`),
      observedAt: expectIsoDate(repoRecord.observedAt, `${sourceName}.repo.observedAt`),
    },
    license: {
      spdxId,
      url: expectString(licenseRecord.url, `${sourceName}.license.url`),
      holder: expectString(licenseRecord.holder, `${sourceName}.license.holder`),
    },
    provenance: {
      authorKind: authorKind as OssArcGisAuthorKind,
      author: expectString(provenanceRecord.author, `${sourceName}.provenance.author`),
      description: expectString(provenanceRecord.description, `${sourceName}.provenance.description`),
    },
    styles: styles as OssArcGisAppStyle[],
    scanRoot: expectRelativePath(record.scanRoot, `${sourceName}.scanRoot`),
    evidencePaths: expectStringArray(record.evidencePaths, `${sourceName}.evidencePaths`),
    notes: expectString(record.notes, `${sourceName}.notes`),
  };
}

function expectRecord(value: unknown, sourceName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, sourceName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${sourceName} must be an array.`);
  }
  return value;
}

function expectString(value: unknown, sourceName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${sourceName} must be a non-empty string.`);
  }
  return value;
}

function expectNumber(value: unknown, sourceName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${sourceName} must be a finite number.`);
  }
  return value;
}

function expectBoolean(value: unknown, sourceName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${sourceName} must be a boolean.`);
  }
  return value;
}

function expectStringArray(value: unknown, sourceName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${sourceName} must be an array of non-empty strings.`);
  }
  return value as string[];
}

function expectCommitSha(value: unknown, sourceName: string): string {
  const text = expectString(value, sourceName);
  if (text.length !== COMMIT_SHA_LENGTH || !isLowercaseHex(text)) {
    throw new Error(`${sourceName} must be a full 40-character lowercase commit SHA.`);
  }
  return text;
}

function isLowercaseHex(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isDigit = code >= 48 && code <= 57;
    const isLowerAf = code >= 97 && code <= 102;
    if (!isDigit && !isLowerAf) {
      return false;
    }
  }
  return true;
}

function expectIsoDate(value: unknown, sourceName: string): string {
  const text = expectString(value, sourceName);
  if (text.length !== ISO_DATE_LENGTH || Number.isNaN(Date.parse(text))) {
    throw new Error(`${sourceName} must be an ISO date (YYYY-MM-DD).`);
  }
  return text;
}

/**
 * Accept only repo-relative paths. Absolute paths, Windows drive letters, and
 * any `..` segment are rejected so a manifest entry can never point the lane
 * (or a clone) outside the checkout it owns.
 */
function expectRelativePath(value: unknown, sourceName: string): string {
  const text = expectString(value, sourceName);
  if (text.startsWith("/") || text.startsWith("\\") || /^[A-Za-z]:/.test(text)) {
    throw new Error(`${sourceName} must be a repository-relative path.`);
  }
  for (const segment of text.split(/[\\/]/)) {
    if (segment === "..") {
      throw new Error(`${sourceName} must not contain ".." segments.`);
    }
  }
  return text;
}
