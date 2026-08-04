import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  OSS_ARCGIS_APP_STYLES,
  OSS_ARCGIS_CORPUS_MANIFEST_PATH,
  OSS_ARCGIS_CORPUS_MIN_APPS,
  type OssArcGisAppReadiness,
  type OssArcGisCorpusManifest,
  buildOssArcGisAppReadiness,
  buildOssArcGisCorpusRun,
  evaluateOssArcGisCorpusRegression,
  formatOssArcGisCorpusMarkdown,
  loadOssArcGisCorpusManifest,
  parseOssArcGisCorpusManifest,
  summarizeOssArcGisCorpus,
} from "../src/migration/oss-corpus.js";
import type { JsMigrationReport } from "../src/migration/report.js";
import type { WidgetReadinessReport } from "../src/migration/widget-scanner.js";

const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, OSS_ARCGIS_CORPUS_MANIFEST_PATH);

function loadCommittedManifest(): OssArcGisCorpusManifest {
  return loadOssArcGisCorpusManifest(MANIFEST_PATH);
}

function manifestJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
}

function createReport(overrides: Partial<JsMigrationReport> = {}): JsMigrationReport {
  const base = {
    rootDir: "/tmp/app",
    codemodTarget: "honua-compat",
    scanSummary: "filesScanned=10 filesWithArcGisImports=3 importCount=8",
    scanReport: {
      rootDir: "/tmp/app",
      filesScanned: 10,
      filesWithArcGisImports: 3,
      imports: [],
      symbolUsageCounts: {},
      flags: ["auth-or-request-customization-detected"],
    },
    codemodResult: {
      rootDir: "/tmp/app",
      target: "honua-compat",
      filesScanned: 10,
      filesChanged: 3,
      metrics: {
        totalCodemodScopedCallSites: 8,
        autoMigratedCallSites: 6,
        manualCallSites: 2,
        byKind: {},
      },
      manualTodos: [],
    },
    manualRewriteMetric: { numerator: 2, denominator: 8, ratio: 0.25, scope: "scope" },
    manualInterventionMetric: {
      numerator: 3,
      denominator: 9,
      ratio: 1 / 3,
      scope: "scope",
      manualCodemodCallSites: 2,
      unhandledUsageHits: 1,
    },
    readiness: "assisted",
    gates: [],
    manualTodosByKind: { "feature-layer": 2, "map-view": 1, graphic: 0 },
    manualTodoReasons: [],
    unhandledArcGisModules: [{ modulePath: "@arcgis/core/widgets/Sketch", usageStyle: "static-import", count: 1 }],
    manualTodos: [],
  };
  return { ...base, ...overrides } as unknown as JsMigrationReport;
}

function createWidgetReport(): WidgetReadinessReport {
  return {
    rootDir: "/tmp/app",
    dispositionDataVersion: "1.0.0",
    deprecationRelease: "5.0",
    removalRelease: "6.0",
    removalTimeframe: "as early as Q1 2027",
    filesScanned: 10,
    filesWithWidgetUsage: 2,
    widgets: [
      {
        widget: "Daylight",
        supportModule: false,
        disposition: "no-equivalent",
        bucket: "manual",
        target: "None",
        guideLink: "docs/widget-survival-guide.md#daylight",
        count: 3,
        sites: [],
      },
      {
        widget: "Legend",
        supportModule: false,
        disposition: "automated",
        bucket: "automated",
        target: "LegendCompat",
        guideLink: "docs/widget-survival-guide.md#legend",
        count: 4,
        sites: [],
      },
    ],
    summary: {
      totalSites: 7,
      automatedSites: 4,
      assistedSites: 0,
      manualSites: 3,
      automatedWidgets: 1,
      assistedWidgets: 0,
      manualWidgets: 1,
      automatedPct: 57.142857,
    },
    summaryLine: "widgets",
  } as unknown as WidgetReadinessReport;
}

describe("committed OSS ArcGIS corpus manifest", () => {
  it("parses and satisfies every corpus guardrail", () => {
    const manifest = loadCommittedManifest();
    const summary = summarizeOssArcGisCorpus(manifest);

    expect(summary.guardrailFailures).toEqual([]);
    expect(summary.appCount).toBeGreaterThanOrEqual(OSS_ARCGIS_CORPUS_MIN_APPS);
  });

  it("spans every authoring style the migration cliff shows up as", () => {
    const summary = summarizeOssArcGisCorpus(loadCommittedManifest());
    for (const style of OSS_ARCGIS_APP_STYLES) {
      expect(summary.styleCoverage[style], `style ${style}`).toBeGreaterThan(0);
    }
  });

  it("pins every app to a full commit SHA with a reviewed permissive license", () => {
    const manifest = loadCommittedManifest();
    for (const app of manifest.apps) {
      expect(app.repo.commit, app.id).toMatch(/^[0-9a-f]{40}$/);
      expect(manifest.licensePolicy.allowedSpdxIds, app.id).toContain(app.license.spdxId);
      expect(app.license.url, app.id).toContain(app.repo.commit);
      expect(app.evidencePaths.length, app.id).toBeGreaterThan(0);
    }
  });

  it("keeps the corpus a pointer list — no vendored third-party checkout is committed", () => {
    const manifest = loadCommittedManifest();
    expect(manifest.guardrails.noVendoredThirdPartyCode).toBe(true);
    expect(manifest.guardrails.excludedFromPrCi).toBe(true);
    expect(manifest.guardrails.requiresOptIn).toBe(true);
    expect(manifest.guardrails.noLiveEsriServiceContact).toBe(true);

    // Clones and raw run output must land somewhere git refuses to track, so a
    // lane run can never turn into a vendored third-party checkout.
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    for (const laneDir of [manifest.lane.checkoutRoot, manifest.lane.reportRoot]) {
      const ignored = gitignore.some((line) => {
        const pattern = line.trim().replace(/\/$/, "");
        return pattern.length > 0 && !pattern.startsWith("#") && `${laneDir}/`.startsWith(`${pattern}/`);
      });
      expect(ignored, `${laneDir} must be git-ignored`).toBe(true);
    }
  });

  it("validates against the committed JSON schema", () => {
    const ajv = new Ajv2020.default({ strict: false, allErrors: true });
    const validate = ajv.compile(
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config", "oss-arcgis-corpus.schema.json"), "utf8")),
    );
    const valid = validate(manifestJson());
    if (!valid) {
      throw new Error(`schema validation failed: ${JSON.stringify(validate.errors?.slice(0, 4))}`);
    }
    expect(valid).toBe(true);
  });

  it("matches the published observation the summary page is generated from", () => {
    const manifest = loadCommittedManifest();
    const observationPath = path.join(REPO_ROOT, manifest.lane.publishedObservationPath);
    const observation = JSON.parse(fs.readFileSync(observationPath, "utf8")) as {
      apps: { appId: string; commit: string }[];
    };

    expect(observation.apps.map((app) => app.appId).sort()).toEqual(manifest.apps.map((app) => app.id).sort());
    for (const app of manifest.apps) {
      const observed = observation.apps.find((candidate) => candidate.appId === app.id);
      expect(observed?.commit, app.id).toBe(app.repo.commit);
    }
  });
});

describe("parseOssArcGisCorpusManifest", () => {
  it("rejects a branch-name pin instead of a commit SHA", () => {
    const raw = manifestJson();
    (raw.apps as { repo: { commit: string } }[])[0].repo.commit = "main";
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/full 40-character lowercase commit SHA/);
  });

  it("rejects an abbreviated commit SHA", () => {
    const raw = manifestJson();
    (raw.apps as { repo: { commit: string } }[])[0].repo.commit = "8b42b23";
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/commit SHA/);
  });

  it("rejects a license outside the reviewed policy", () => {
    const raw = manifestJson();
    (raw.apps as { license: { spdxId: string } }[])[0].license.spdxId = "GPL-3.0-only";
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/is not permitted/);
  });

  it("rejects an unknown authoring style", () => {
    const raw = manifestJson();
    (raw.apps as { styles: string[] }[])[0].styles = ["dojo-magic"];
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/unknown style/);
  });

  it("rejects a scanRoot that escapes the checkout", () => {
    const raw = manifestJson();
    (raw.apps as { scanRoot: string }[])[0].scanRoot = "../../etc";
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/".." segments/);
  });

  it("rejects a repo url that disagrees with owner/name", () => {
    const raw = manifestJson();
    (raw.apps as { repo: { url: string } }[])[0].repo.url = "https://github.com/someone/else";
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/repo.url must be/);
  });

  it("rejects an unknown manifest format", () => {
    const raw = manifestJson();
    raw.format = "honua.sdk.oss-arcgis-corpus.v2";
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/format must be/);
  });
});

describe("summarizeOssArcGisCorpus", () => {
  it("reports a guardrail failure when the corpus drops below the required size", () => {
    const manifest = loadCommittedManifest();
    const shrunk = { ...manifest, apps: manifest.apps.slice(0, 2) };
    const summary = summarizeOssArcGisCorpus(shrunk);
    expect(summary.guardrailFailures.some((failure) => failure.includes("at least"))).toBe(true);
  });

  it("reports a guardrail failure when a style is no longer covered", () => {
    const manifest = loadCommittedManifest();
    const stripped = {
      ...manifest,
      apps: manifest.apps.map((app) => ({ ...app, styles: ["featurelayer-centric" as const] })),
    };
    const summary = summarizeOssArcGisCorpus(stripped);
    expect(summary.guardrailFailures).toContain('corpus must include at least one "amd-require" app');
    expect(summary.guardrailFailures).toContain('corpus must include at least one "widget-heavy" app');
  });

  it("reports a guardrail failure when the no-vendoring promise is switched off", () => {
    const manifest = loadCommittedManifest();
    const relaxed = {
      ...manifest,
      guardrails: { ...manifest.guardrails, noVendoredThirdPartyCode: false },
    };
    expect(summarizeOssArcGisCorpus(relaxed).guardrailFailures).toContain(
      "guardrails.noVendoredThirdPartyCode must remain true",
    );
  });

  it("reports a guardrail failure when the same repository is pinned twice", () => {
    const manifest = loadCommittedManifest();
    const duplicated = {
      ...manifest,
      apps: [...manifest.apps, { ...manifest.apps[0], id: `${manifest.apps[0].id}-copy` }],
    };
    expect(summarizeOssArcGisCorpus(duplicated).guardrailFailures.some((f) => f.includes("duplicate repository"))).toBe(
      true,
    );
  });
});

describe("buildOssArcGisAppReadiness", () => {
  const app = loadCommittedManifest().apps[0];

  it("projects the existing JsMigrationReport schema onto a corpus record", () => {
    const record = buildOssArcGisAppReadiness({
      app,
      observedAt: "2026-08-03",
      codemodTarget: "honua-compat",
      report: createReport(),
      widgetReport: createWidgetReport(),
      widgetGatePct: 50,
    });

    expect(record.status).toBe("observed");
    expect(record.appId).toBe(app.id);
    expect(record.commit).toBe(app.repo.commit);
    expect(record.totalCallSites).toBe(8);
    expect(record.autoMigratedCallSites).toBe(6);
    expect(record.autoMigratedRatio).toBe(0.75);
    expect(record.manualRewriteRatio).toBe(0.25);
    expect(record.usageDetected).toBe(true);
    expect(record.topManualTodoKinds).toEqual([
      { kind: "feature-layer", count: 2 },
      { kind: "map-view", count: 1 },
    ]);
    expect(record.topUnhandledModules).toEqual([
      { modulePath: "@arcgis/core/widgets/Sketch", usageStyle: "static-import", count: 1 },
    ]);
    expect(record.widgets?.gatePassed).toBe(true);
    expect(record.widgets?.topManualWidgets).toEqual([{ kind: "Daylight", count: 3 }]);
  });

  it("surfaces blocking scan flags", () => {
    const record = buildOssArcGisAppReadiness({
      app,
      observedAt: "2026-08-03",
      codemodTarget: "honua-compat",
      report: createReport({
        readiness: "blocked",
        scanReport: {
          rootDir: "/tmp/app",
          filesScanned: 10,
          filesWithArcGisImports: 3,
          imports: [],
          symbolUsageCounts: {},
          flags: ["scene-3d-detected", "webmap-detected"],
        } as unknown as JsMigrationReport["scanReport"],
      }),
    });

    expect(record.readiness).toBe("blocked");
    expect(record.blockingFlags).toEqual(["scene-3d-detected"]);
    expect(record.scanFlags).toEqual(["scene-3d-detected", "webmap-detected"]);
  });

  it("marks an app the scanner could not see at all as a detection gap", () => {
    const record = buildOssArcGisAppReadiness({
      app,
      observedAt: "2026-08-03",
      codemodTarget: "honua-compat",
      report: createReport({
        readiness: "ready",
        scanReport: {
          rootDir: "/tmp/app",
          filesScanned: 136,
          filesWithArcGisImports: 0,
          imports: [],
          symbolUsageCounts: {},
          flags: [],
        } as unknown as JsMigrationReport["scanReport"],
      }),
    });

    expect(record.readiness).toBe("ready");
    expect(record.usageDetected).toBe(false);
  });

  it("records an error record when the app could not be observed", () => {
    const record = buildOssArcGisAppReadiness({
      app,
      observedAt: "2026-08-03",
      codemodTarget: "honua-compat",
      error: "checkout SHA mismatch",
    });

    expect(record.status).toBe("error");
    expect(record.readiness).toBe("unknown");
    expect(record.error).toBe("checkout SHA mismatch");
    expect(record.usageDetected).toBe(false);
  });
});

describe("buildOssArcGisCorpusRun", () => {
  it("aggregates per-app records and names the undetected apps", () => {
    const manifest = loadCommittedManifest();
    const observed = buildOssArcGisAppReadiness({
      app: manifest.apps[0],
      observedAt: "2026-08-03",
      codemodTarget: "honua-compat",
      report: createReport(),
    });
    const undetected = buildOssArcGisAppReadiness({
      app: manifest.apps[1],
      observedAt: "2026-08-03",
      codemodTarget: "honua-compat",
      report: createReport({
        readiness: "ready",
        scanReport: {
          rootDir: "/tmp/app",
          filesScanned: 12,
          filesWithArcGisImports: 0,
          imports: [],
          symbolUsageCounts: {},
          flags: [],
        } as unknown as JsMigrationReport["scanReport"],
        codemodResult: {
          rootDir: "/tmp/app",
          target: "honua-compat",
          filesScanned: 12,
          filesChanged: 0,
          metrics: { totalCodemodScopedCallSites: 0, autoMigratedCallSites: 0, manualCallSites: 0, byKind: {} },
          manualTodos: [],
        } as unknown as JsMigrationReport["codemodResult"],
      }),
    });

    const run = buildOssArcGisCorpusRun({
      manifest,
      apps: [observed, undetected],
      generatedAt: "2026-08-03T00:00:00.000Z",
    });

    expect(run.format).toBe("honua.sdk.oss-arcgis-corpus-readiness.v1");
    expect(run.summary.appCount).toBe(2);
    expect(run.summary.totalCallSites).toBe(8);
    expect(run.summary.autoMigratedCallSites).toBe(6);
    expect(run.summary.autoMigratedRatio).toBe(0.75);
    expect(run.summary.undetectedApps).toEqual([manifest.apps[1].id]);
    expect(run.lane.optInEnvVar).toBe(manifest.lane.optInEnvVar);
    expect(run.lane.excludedFromPrCi).toBe(true);
  });
});

describe("evaluateOssArcGisCorpusRegression", () => {
  const manifest = loadCommittedManifest();

  function runWith(apps: OssArcGisAppReadiness[]) {
    return buildOssArcGisCorpusRun({ manifest, apps, generatedAt: "2026-08-03T00:00:00.000Z" });
  }

  const baselineApp = buildOssArcGisAppReadiness({
    app: manifest.apps[0],
    observedAt: "2026-08-03",
    codemodTarget: "honua-compat",
    report: createReport(),
  });

  it("passes when nothing regressed", () => {
    const result = evaluateOssArcGisCorpusRegression(runWith([baselineApp]), runWith([baselineApp]));
    expect(result).toEqual({ passed: true, failures: [] });
  });

  it("fails when the auto-migrated ratio drops", () => {
    const worse = { ...baselineApp, autoMigratedRatio: 0.5 };
    const result = evaluateOssArcGisCorpusRegression(runWith([baselineApp]), runWith([worse]));
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("auto-migrated ratio regressed");
  });

  it("fails when previously visible ArcGIS usage stops being detected", () => {
    const blind = { ...baselineApp, usageDetected: false };
    const result = evaluateOssArcGisCorpusRegression(runWith([baselineApp]), runWith([blind]));
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("no longer visible to the scanner");
  });

  it("fails when a pinned app disappears from the run", () => {
    const other = buildOssArcGisAppReadiness({
      app: manifest.apps[1],
      observedAt: "2026-08-03",
      codemodTarget: "honua-compat",
      report: createReport(),
    });
    const result = evaluateOssArcGisCorpusRegression(runWith([baselineApp]), runWith([other]));
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("missing from this run");
  });
});

describe("formatOssArcGisCorpusMarkdown", () => {
  it("renders the published observation without any hand-editable figure", () => {
    const manifest = loadCommittedManifest();
    const observation = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, manifest.lane.publishedObservationPath), "utf8"),
    );
    const markdown = formatOssArcGisCorpusMarkdown(manifest, observation);

    expect(markdown).toContain("GENERATED FILE - DO NOT EDIT");
    expect(markdown).toContain("# Third-party open-source ArcGIS app readiness");
    for (const app of manifest.apps) {
      expect(markdown, app.id).toContain(app.repo.commit);
      expect(markdown, app.id).toContain(app.title);
    }
  });

  it("calls out detection gaps instead of publishing a misleading readiness verdict", () => {
    const manifest = loadCommittedManifest();
    const undetected = buildOssArcGisAppReadiness({
      app: manifest.apps[0],
      observedAt: "2026-08-03",
      codemodTarget: "honua-compat",
      report: createReport({
        readiness: "ready",
        scanReport: {
          rootDir: "/tmp/app",
          filesScanned: 136,
          filesWithArcGisImports: 0,
          imports: [],
          symbolUsageCounts: {},
          flags: [],
        } as unknown as JsMigrationReport["scanReport"],
      }),
    });
    const run = buildOssArcGisCorpusRun({
      manifest,
      apps: [undetected],
      generatedAt: "2026-08-03T00:00:00.000Z",
    });

    const markdown = formatOssArcGisCorpusMarkdown(manifest, run);
    expect(markdown).toContain("### Detection gaps");
    expect(markdown).toContain("(not meaningful)");
    expect(markdown).toContain("**Detection gap.**");
  });

  it("matches the committed summary page", () => {
    const manifest = loadCommittedManifest();
    const observation = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, manifest.lane.publishedObservationPath), "utf8"),
    );
    const committed = fs.readFileSync(path.join(REPO_ROOT, "docs", "oss-arcgis-corpus-readiness.md"), "utf8");
    expect(formatOssArcGisCorpusMarkdown(manifest, observation)).toBe(committed.replace(/\r\n/g, "\n"));
  });
});
