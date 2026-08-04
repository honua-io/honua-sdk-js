import type {
  OssArcGisCorpusApp,
  OssArcGisCorpusManifest,
  OssArcGisDeepApp,
  OssArcGisDeepSupplyChain,
} from "./oss-corpus.js";

/**
 * Post-codemod build validation for the third-party OSS ArcGIS corpus
 * (issue #955: "at least one full app builds and typechecks post-codemod
 * against the compat entry, or the blocking gaps are filed").
 *
 * The measurement is a **paired** one. Running a build over a stranger's app
 * and reporting the failures is not evidence about the codemod — third-party
 * apps have pre-existing type errors, pinned toolchains, and warnings of their
 * own. So every deep run measures the same app twice at the same commit with
 * the same installed dependency tree:
 *
 *   - `baseline` — the pristine checkout, before the codemod touches it.
 *   - `migrated` — after `codemod --write`, with the packed Honua compat
 *     packages installed alongside the app's own dependencies.
 *
 * What the migration owns is the **delta**: diagnostics present after and
 * absent before, and a build that passed before and fails after. Everything
 * else is the app's, and the record says so.
 */
export const OSS_ARCGIS_DEEP_BUILD_FORMAT = "honua.sdk.oss-arcgis-corpus-deep-build.v1";

export type OssArcGisDeepStepStatus = "passed" | "failed" | "skipped";

export interface OssArcGisDeepStep {
  /** Command that ran, with absolute paths reduced to repo/checkout-relative form. */
  command: string;
  status: OssArcGisDeepStepStatus;
  exitCode: number | null;
  durationMs: number;
  /** Bounded tail of the command's output, kept for the published record. */
  outputTail: string;
}

export interface OssArcGisDeepPhase {
  /** `tsc --noEmit` over the app's sources through a generated probe config. */
  typecheck: OssArcGisDeepStep;
  /** The app's own build script. */
  build: OssArcGisDeepStep;
  /** Normalized, deduplicated `tsc` diagnostics (file + code + message, no line/column). */
  diagnostics: string[];
}

export interface OssArcGisDeepCodemodSummary {
  totalCallSites: number;
  autoMigratedCallSites: number;
  manualCallSites: number;
  filesChanged: number;
  compatImportPath: string;
}

export type OssArcGisDeepOutcome =
  | "builds-clean"
  | "builds-with-new-diagnostics"
  | "build-regressed"
  | "baseline-unusable"
  | "error";

export interface OssArcGisDeepAppResult {
  appId: string;
  title: string;
  repoUrl: string;
  commit: string;
  licenseSpdxId: string;
  /** ISO date (YYYY-MM-DD) this observation was taken. */
  observedAt: string;
  outcome: OssArcGisDeepOutcome;
  install: OssArcGisDeepStep;
  honuaInstall: OssArcGisDeepStep;
  codemod?: OssArcGisDeepCodemodSummary;
  baseline?: OssArcGisDeepPhase;
  migrated?: OssArcGisDeepPhase;
  /** Diagnostics the migration introduced: present in `migrated`, absent in `baseline`. */
  introducedDiagnostics: string[];
  /** Diagnostics the migration removed: present in `baseline`, absent in `migrated`. */
  resolvedDiagnostics: string[];
  error?: string;
}

export interface OssArcGisDeepRunSummary {
  appCount: number;
  buildsPostCodemod: number;
  buildRegressions: number;
  errored: number;
  introducedDiagnosticCount: number;
  resolvedDiagnosticCount: number;
  /** App ids that built post-codemod against the compat entry. */
  buildingApps: string[];
}

export interface OssArcGisDeepRun {
  format: typeof OSS_ARCGIS_DEEP_BUILD_FORMAT;
  schemaVersion: 1;
  generatedAt: string;
  manifestRevision: string;
  honuaVersion: string;
  optInEnvVars: string[];
  supplyChain: OssArcGisDeepSupplyChain;
  summary: OssArcGisDeepRunSummary;
  apps: OssArcGisDeepAppResult[];
}

const DIAGNOSTIC_LINE_COLUMN = /\(\d+,\d+\)/;

/**
 * Reduce raw `tsc` output to a comparable diagnostic set.
 *
 * Line and column are dropped deliberately: the codemod rewrites import
 * statements and can shift every line in a file, so keeping positions would
 * report the whole file as "introduced". What stays is the file, the TS error
 * code, and the message — enough to identify a diagnostic, stable under
 * reformatting.
 */
export function normalizeTypecheckDiagnostics(rawOutput: string): string[] {
  const seen = new Set<string>();
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.includes("error TS")) {
      continue;
    }
    // Continuation lines of a multi-line diagnostic are indented; only the
    // first line carries the "<file>(line,col): error TSxxxx:" prefix.
    if (line.startsWith(" ") || line.startsWith("\t")) {
      continue;
    }
    seen.add(trimmed.replace(DIAGNOSTIC_LINE_COLUMN, ""));
  }
  return Array.from(seen).sort();
}

export interface TypecheckDiagnosticDiff {
  introduced: string[];
  resolved: string[];
}

export function diffTypecheckDiagnostics(
  baseline: readonly string[],
  migrated: readonly string[],
): TypecheckDiagnosticDiff {
  const baselineSet = new Set(baseline);
  const migratedSet = new Set(migrated);
  return {
    introduced: migrated.filter((entry) => !baselineSet.has(entry)).sort(),
    resolved: baseline.filter((entry) => !migratedSet.has(entry)).sort(),
  };
}

export interface BuildOssArcGisDeepAppResultOptions {
  app: OssArcGisCorpusApp;
  deepApp: OssArcGisDeepApp;
  observedAt: string;
  install: OssArcGisDeepStep;
  honuaInstall: OssArcGisDeepStep;
  codemod?: OssArcGisDeepCodemodSummary;
  baseline?: OssArcGisDeepPhase;
  migrated?: OssArcGisDeepPhase;
  error?: string;
}

export function buildOssArcGisDeepAppResult(options: BuildOssArcGisDeepAppResultOptions): OssArcGisDeepAppResult {
  const { app, observedAt, install, honuaInstall, codemod, baseline, migrated, error } = options;

  const diff =
    baseline && migrated
      ? diffTypecheckDiagnostics(baseline.diagnostics, migrated.diagnostics)
      : { introduced: [], resolved: [] };

  return {
    appId: app.id,
    title: app.title,
    repoUrl: app.repo.url,
    commit: app.repo.commit,
    licenseSpdxId: app.license.spdxId,
    observedAt,
    outcome: resolveOutcome({ baseline, migrated, error, introduced: diff.introduced }),
    install,
    honuaInstall,
    ...(codemod ? { codemod } : {}),
    ...(baseline ? { baseline } : {}),
    ...(migrated ? { migrated } : {}),
    introducedDiagnostics: diff.introduced,
    resolvedDiagnostics: diff.resolved,
    ...(error ? { error } : {}),
  };
}

function resolveOutcome(input: {
  baseline?: OssArcGisDeepPhase;
  migrated?: OssArcGisDeepPhase;
  error?: string;
  introduced: readonly string[];
}): OssArcGisDeepOutcome {
  if (input.error || !input.baseline || !input.migrated) {
    return "error";
  }
  // A build that was already broken at the pinned commit cannot say anything
  // about the codemod, so it is reported as such rather than as a pass.
  if (input.baseline.build.status !== "passed") {
    return "baseline-unusable";
  }
  if (input.migrated.build.status !== "passed") {
    return "build-regressed";
  }
  return input.introduced.length === 0 ? "builds-clean" : "builds-with-new-diagnostics";
}

export interface BuildOssArcGisDeepRunOptions {
  manifest: OssArcGisCorpusManifest;
  apps: readonly OssArcGisDeepAppResult[];
  generatedAt: string;
  honuaVersion: string;
}

export function buildOssArcGisDeepRun(options: BuildOssArcGisDeepRunOptions): OssArcGisDeepRun {
  const { manifest, apps, generatedAt, honuaVersion } = options;
  const building = apps.filter(
    (app) => app.outcome === "builds-clean" || app.outcome === "builds-with-new-diagnostics",
  );

  return {
    format: OSS_ARCGIS_DEEP_BUILD_FORMAT,
    schemaVersion: 1,
    generatedAt,
    manifestRevision: manifest.revision,
    honuaVersion,
    optInEnvVars: [manifest.lane.optInEnvVar, manifest.deepValidation.optInEnvVar],
    supplyChain: manifest.deepValidation.supplyChain,
    summary: {
      appCount: apps.length,
      buildsPostCodemod: building.length,
      buildRegressions: apps.filter((app) => app.outcome === "build-regressed").length,
      errored: apps.filter((app) => app.outcome === "error" || app.outcome === "baseline-unusable").length,
      introducedDiagnosticCount: apps.reduce((total, app) => total + app.introducedDiagnostics.length, 0),
      resolvedDiagnosticCount: apps.reduce((total, app) => total + app.resolvedDiagnostics.length, 0),
      buildingApps: building.map((app) => app.appId),
    },
    apps: [...apps],
  };
}

const OUTCOME_LABELS: Record<OssArcGisDeepOutcome, string> = {
  "builds-clean": "builds, no new diagnostics",
  "builds-with-new-diagnostics": "builds, new diagnostics",
  "build-regressed": "build regressed",
  "baseline-unusable": "baseline build already failing",
  error: "not observed",
};

/**
 * Render the published post-codemod build page (#955 acceptance criterion 2).
 * Every figure comes from the committed observation.
 */
export function formatOssArcGisDeepBuildMarkdown(manifest: OssArcGisCorpusManifest, run: OssArcGisDeepRun): string {
  const deep = manifest.deepValidation;
  const appById = new Map(manifest.apps.map((app) => [app.id, app]));
  const deepAppById = new Map(deep.apps.map((app) => [app.id, app]));
  const lines: string[] = [];

  lines.push("<!-- GENERATED FILE - DO NOT EDIT.");
  lines.push("     Sources of truth: config/oss-arcgis-corpus.v1.json");
  lines.push(`                       ${deep.publishedObservationPath}`);
  lines.push("     Regenerate with: npm run docs:oss-arcgis-corpus-deep -->");
  lines.push("");
  lines.push("# Post-codemod build validation");
  lines.push("");
  lines.push(
    [
      "The [readiness page](./oss-arcgis-corpus-readiness.md) counts call sites. It cannot tell you whether the",
      "result still *builds*. This page answers that question the only way it can be answered honestly: by",
      "installing a pinned third-party app's real dependency tree, running the codemod over it, installing the",
      "Honua compat packages, and building it.",
    ].join(" "),
  );
  lines.push("");
  lines.push(
    [
      "Every app is measured **twice at the same commit with the same dependency tree** — once pristine",
      "(`baseline`) and once after `codemod --write` (`migrated`). Third-party apps carry their own pre-existing",
      "type errors, so only the *delta* is attributable to the migration. Diagnostics that were already there are",
      "reported as the app's, not as ours.",
    ].join(" "),
  );
  lines.push("");
  lines.push(`- Observation generated: \`${run.generatedAt}\``);
  lines.push(`- Manifest revision: \`${run.manifestRevision}\``);
  lines.push(`- Honua packages under test: \`${run.honuaVersion}\` (packed from \`dist/packages\`, never a registry)`);
  lines.push(`- Opt-in: both \`${run.optInEnvVars.join("=true` and `")}=true\` are required`);
  lines.push("");

  lines.push("## Supply-chain posture");
  lines.push("");
  lines.push(
    [
      "Deep validation is the one place the corpus installs third-party dependencies, so the posture is stated",
      "explicitly and enforced by the manifest guardrails rather than by convention:",
    ].join(" "),
  );
  lines.push("");
  lines.push("| Property | Value |");
  lines.push("| --- | --- |");
  lines.push(
    `| Lifecycle scripts disabled (\`--ignore-scripts\`) | ${boolText(run.supplyChain.installScriptsDisabled)} |`,
  );
  lines.push(
    `| Committed lockfile required and used verbatim | ${boolText(run.supplyChain.requiresCommittedLockfile)} |`,
  );
  lines.push(`| Installed tree is ephemeral | ${boolText(run.supplyChain.installsAreEphemeral)} |`);
  lines.push(`| App manifest/lockfile never rewritten | ${boolText(run.supplyChain.appManifestNeverRewritten)} |`);
  lines.push(`| Honua packages packed locally | ${boolText(run.supplyChain.honuaPackagesArePackedLocally)} |`);
  lines.push("");
  for (const note of run.supplyChain.notes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  lines.push("## Results");
  lines.push("");
  lines.push("| App | Outcome | Baseline build | Migrated build | New diagnostics | Resolved |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const app of run.apps) {
    const cells = [
      `[${app.title}](#${headingAnchor(app.title)})`,
      OUTCOME_LABELS[app.outcome],
      stepText(app.baseline?.build.status),
      stepText(app.migrated?.build.status),
      String(app.introducedDiagnostics.length),
      String(app.resolvedDiagnostics.length),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    [
      `${run.summary.buildsPostCodemod} of ${run.summary.appCount} allowlisted`,
      `${run.summary.appCount === 1 ? "app" : "apps"} built post-codemod against \`@honua/sdk-esri-compat\`.`,
    ].join(" "),
  );
  lines.push("");

  for (const app of run.apps) {
    const corpusApp = appById.get(app.appId);
    const deepApp = deepAppById.get(app.appId);
    lines.push(`## ${app.title}`);
    lines.push("");
    lines.push(`- Repository: <${app.repoUrl}>`);
    lines.push(`- Pinned commit: \`${app.commit}\``);
    lines.push(`- License: \`${app.licenseSpdxId}\``);
    lines.push(`- Observed: ${app.observedAt}`);
    if (deepApp) {
      lines.push(`- Build script: \`npm run ${deepApp.buildScript}\` in \`${deepApp.packageDir}\``);
      lines.push(`- Lockfile: \`${deepApp.lockfile}\``);
    }
    if (corpusApp) {
      lines.push(`- Codemod scan root: \`${corpusApp.scanRoot}\``);
    }
    lines.push("");

    if (app.error) {
      lines.push(`> Not observed: ${app.error}`);
      lines.push("");
      continue;
    }

    if (app.codemod) {
      lines.push(
        [
          `The codemod rewrote ${app.codemod.autoMigratedCallSites} of ${app.codemod.totalCallSites} in-scope call`,
          `sites across ${app.codemod.filesChanged} ${app.codemod.filesChanged === 1 ? "file" : "files"} to`,
          `\`${app.codemod.compatImportPath}\`, leaving ${app.codemod.manualCallSites} annotated manual`,
          `${app.codemod.manualCallSites === 1 ? "TODO" : "TODOs"}. The un-migrated call sites keep importing`,
          "`@arcgis/core`, so the build below exercises a genuinely half-migrated module graph.",
        ].join(" "),
      );
      lines.push("");
    }

    lines.push("| Step | Baseline | Migrated |");
    lines.push("| --- | --- | --- |");
    lines.push(
      `| Typecheck | ${stepText(app.baseline?.typecheck.status)} (${app.baseline?.diagnostics.length ?? 0} diagnostics) | ${stepText(app.migrated?.typecheck.status)} (${app.migrated?.diagnostics.length ?? 0} diagnostics) |`,
    );
    lines.push(`| Build | ${stepText(app.baseline?.build.status)} | ${stepText(app.migrated?.build.status)} |`);
    lines.push("");

    if (app.introducedDiagnostics.length > 0) {
      lines.push("### Diagnostics the migration introduced");
      lines.push("");
      lines.push(
        "These are present after the codemod and absent before it, at the same commit with the same installed " +
          "dependencies. They are the migration's to answer for.",
      );
      lines.push("");
      lines.push('```text doc-test=skip reason="captured tsc output, not a compilable snippet"');
      for (const diagnostic of app.introducedDiagnostics) {
        lines.push(diagnostic);
      }
      lines.push("```");
      lines.push("");
    } else {
      lines.push("The migration introduced no new type diagnostics.");
      lines.push("");
    }

    if (app.resolvedDiagnostics.length > 0) {
      lines.push("### Diagnostics the migration removed");
      lines.push("");
      lines.push(
        "Reported for symmetry, not as a win: most of these disappear because a compat type is looser than the " +
          "ArcGIS type it replaced, which is a fact about the shim, not an improvement to the app.",
      );
      lines.push("");
      lines.push('```text doc-test=skip reason="captured tsc output, not a compilable snippet"');
      for (const diagnostic of app.resolvedDiagnostics) {
        lines.push(diagnostic);
      }
      lines.push("```");
      lines.push("");
    }

    if (deepApp) {
      lines.push(deepApp.notes);
      lines.push("");
    }
  }

  lines.push("## Reproducing this page");
  lines.push("");
  lines.push('```bash doc-test=skip reason="shell commands for the opt-in deep lane, not a compilable snippet"');
  lines.push(`${run.optInEnvVars[0]}=true ${run.optInEnvVars[1]}=true npm run corpus:oss-arcgis:deep:publish`);
  lines.push("npm run docs:oss-arcgis-corpus-deep");
  lines.push("```");
  lines.push("");
  lines.push(
    "See [docs/oss-arcgis-corpus.md](./oss-arcgis-corpus.md) for the corpus manifest, license policy, and the " +
      "standard (static-analysis-only) lane.",
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function boolText(value: boolean): string {
  return value ? "yes" : "**no**";
}

function stepText(status: OssArcGisDeepStepStatus | undefined): string {
  if (status === undefined) {
    return "—";
  }
  return status === "passed" ? "pass" : status === "failed" ? "**fail**" : "skipped";
}

/**
 * Slug for an in-page heading link, matching GitHub's markdown anchors and the
 * docs-site heading-id generator.
 */
function headingAnchor(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}
