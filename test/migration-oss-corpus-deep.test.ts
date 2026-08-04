import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  OSS_ARCGIS_DEEP_BUILD_FORMAT,
  type OssArcGisDeepAppResult,
  type OssArcGisDeepPhase,
  type OssArcGisDeepRun,
  type OssArcGisDeepStep,
  buildOssArcGisDeepAppResult,
  buildOssArcGisDeepRun,
  diffTypecheckDiagnostics,
  formatOssArcGisDeepBuildMarkdown,
  normalizeTypecheckDiagnostics,
} from "../src/migration/oss-corpus-deep.js";
import {
  OSS_ARCGIS_CORPUS_MANIFEST_PATH,
  type OssArcGisCorpusManifest,
  loadOssArcGisCorpusManifest,
  parseOssArcGisCorpusManifest,
  summarizeOssArcGisCorpus,
} from "../src/migration/oss-corpus.js";

const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, OSS_ARCGIS_CORPUS_MANIFEST_PATH);

function manifest(): OssArcGisCorpusManifest {
  return loadOssArcGisCorpusManifest(MANIFEST_PATH);
}

function manifestJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
}

function observation(): OssArcGisDeepRun {
  const deep = manifest().deepValidation;
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, deep.publishedObservationPath), "utf8")) as OssArcGisDeepRun;
}

function step(status: OssArcGisDeepStep["status"], command = "npm run build"): OssArcGisDeepStep {
  return { command, status, exitCode: status === "passed" ? 0 : 1, durationMs: 10, outputTail: "" };
}

function phase(buildStatus: OssArcGisDeepStep["status"], diagnostics: string[]): OssArcGisDeepPhase {
  return {
    typecheck: step(diagnostics.length === 0 ? "passed" : "failed", "npx tsc --noEmit"),
    build: step(buildStatus),
    diagnostics,
  };
}

describe("deep validation manifest", () => {
  it("allowlists only pinned corpus apps and passes every guardrail", () => {
    const parsed = manifest();
    expect(summarizeOssArcGisCorpus(parsed).guardrailFailures).toEqual([]);

    const corpusIds = new Set(parsed.apps.map((app) => app.id));
    expect(parsed.deepValidation.apps.length).toBeGreaterThan(0);
    for (const deepApp of parsed.deepValidation.apps) {
      expect(corpusIds, deepApp.id).toContain(deepApp.id);
    }
  });

  it("keeps deep validation behind a second switch", () => {
    const parsed = manifest();
    expect(parsed.deepValidation.optInEnvVar).not.toBe(parsed.lane.optInEnvVar);
  });

  it("pins the supply-chain posture the runner is held to", () => {
    const { supplyChain } = manifest().deepValidation;
    expect(supplyChain.installScriptsDisabled).toBe(true);
    expect(supplyChain.requiresCommittedLockfile).toBe(true);
    expect(supplyChain.installsAreEphemeral).toBe(true);
    expect(supplyChain.appManifestNeverRewritten).toBe(true);
    expect(supplyChain.honuaPackagesArePackedLocally).toBe(true);
    expect(supplyChain.notes.length).toBeGreaterThan(0);
  });

  it("writes deep checkouts and reports somewhere git refuses to track", () => {
    const deep = manifest().deepValidation;
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    for (const laneDir of [deep.checkoutRoot, deep.reportRoot]) {
      const ignored = gitignore.some((line) => {
        const pattern = line.trim().replace(/\/$/, "");
        return pattern.length > 0 && !pattern.startsWith("#") && `${laneDir}/`.startsWith(`${pattern}/`);
      });
      expect(ignored, `${laneDir} must be git-ignored`).toBe(true);
    }
  });

  it("rejects a build script that is not a plain npm script name", () => {
    const raw = manifestJson();
    (raw.deepValidation as { apps: { buildScript: string }[] }).apps[0].buildScript = "build && curl evil.example";
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/plain npm script name/);
  });

  it("rejects a packageDir that escapes the checkout", () => {
    const raw = manifestJson();
    (raw.deepValidation as { apps: { packageDir: string }[] }).apps[0].packageDir = "../../etc";
    expect(() => parseOssArcGisCorpusManifest(raw)).toThrow(/".." segments/);
  });

  it("fails the guardrail check when the allowlist names an unpinned app", () => {
    const parsed = manifest();
    const tampered = {
      ...parsed,
      deepValidation: {
        ...parsed.deepValidation,
        apps: [{ ...parsed.deepValidation.apps[0], id: "not-in-the-corpus" }],
      },
    };
    expect(summarizeOssArcGisCorpus(tampered).guardrailFailures).toContain(
      "deepValidation.apps: not-in-the-corpus is not a pinned corpus app",
    );
  });

  it("fails the guardrail check when install scripts are re-enabled", () => {
    const parsed = manifest();
    const tampered = {
      ...parsed,
      deepValidation: {
        ...parsed.deepValidation,
        supplyChain: { ...parsed.deepValidation.supplyChain, installScriptsDisabled: false },
      },
    };
    expect(summarizeOssArcGisCorpus(tampered).guardrailFailures).toContain(
      "deepValidation.supplyChain.installScriptsDisabled must remain true",
    );
  });

  it("fails the guardrail check when deep validation reuses the lane switch", () => {
    const parsed = manifest();
    const tampered = {
      ...parsed,
      deepValidation: { ...parsed.deepValidation, optInEnvVar: parsed.lane.optInEnvVar },
    };
    expect(summarizeOssArcGisCorpus(tampered).guardrailFailures).toContain(
      "deepValidation.optInEnvVar must differ from lane.optInEnvVar (it is a second switch)",
    );
  });
});

describe("normalizeTypecheckDiagnostics", () => {
  it("drops line and column so a codemod's line shifts do not read as new errors", () => {
    const before = normalizeTypecheckDiagnostics("src/a.ts(3,10): error TS2322: Type 'A' is not assignable.");
    const after = normalizeTypecheckDiagnostics("src/a.ts(41,2): error TS2322: Type 'A' is not assignable.");
    expect(before).toEqual(after);
  });

  it("keeps the file, code, and message so distinct diagnostics stay distinct", () => {
    expect(
      normalizeTypecheckDiagnostics(
        [
          "src/a.ts(1,1): error TS2322: Type 'A' is not assignable.",
          "src/b.ts(1,1): error TS2322: Type 'A' is not assignable.",
        ].join("\n"),
      ),
    ).toHaveLength(2);
  });

  it("ignores indented continuation lines of a multi-line diagnostic", () => {
    const diagnostics = normalizeTypecheckDiagnostics(
      [
        "src/a.ts(1,1): error TS2322: Type 'X' is not assignable to type 'Y'.",
        "  Types of property 'z' are incompatible.",
        "    The type 'readonly number[]' is 'readonly'.",
      ].join("\n"),
    );
    expect(diagnostics).toEqual(["src/a.ts: error TS2322: Type 'X' is not assignable to type 'Y'."]);
  });

  it("deduplicates the same diagnostic reported at several positions", () => {
    expect(
      normalizeTypecheckDiagnostics(
        [
          "src/a.ts(1,1): error TS2554: Expected 0 arguments.",
          "src/a.ts(9,9): error TS2554: Expected 0 arguments.",
        ].join("\n"),
      ),
    ).toHaveLength(1);
  });

  it("ignores non-diagnostic output", () => {
    expect(normalizeTypecheckDiagnostics("> tsc --noEmit\nDone in 3s\n")).toEqual([]);
  });
});

describe("diffTypecheckDiagnostics", () => {
  it("cancels the app's pre-existing diagnostics and keeps only the delta", () => {
    const result = diffTypecheckDiagnostics(["pre-existing", "also-pre-existing"], ["pre-existing", "brand-new"]);
    expect(result.introduced).toEqual(["brand-new"]);
    expect(result.resolved).toEqual(["also-pre-existing"]);
  });

  it("reports nothing when the phases agree", () => {
    expect(diffTypecheckDiagnostics(["a", "b"], ["b", "a"])).toEqual({ introduced: [], resolved: [] });
  });
});

describe("buildOssArcGisDeepAppResult", () => {
  const parsed = manifest();
  const app = parsed.apps.find((entry) => entry.id === parsed.deepValidation.apps[0].id)!;
  const deepApp = parsed.deepValidation.apps[0];

  function build(overrides: Partial<Parameters<typeof buildOssArcGisDeepAppResult>[0]> = {}) {
    return buildOssArcGisDeepAppResult({
      app,
      deepApp,
      observedAt: "2026-08-04",
      install: step("passed", "npm ci --ignore-scripts"),
      honuaInstall: step("passed", "npm install --no-save"),
      baseline: phase("passed", ["shared"]),
      migrated: phase("passed", ["shared"]),
      ...overrides,
    });
  }

  it("reports builds-clean when the build survives and nothing new appears", () => {
    const record = build();
    expect(record.outcome).toBe("builds-clean");
    expect(record.introducedDiagnostics).toEqual([]);
    expect(record.commit).toBe(app.repo.commit);
  });

  it("reports builds-with-new-diagnostics when the migration adds one", () => {
    const record = build({ migrated: phase("passed", ["shared", "new"]) });
    expect(record.outcome).toBe("builds-with-new-diagnostics");
    expect(record.introducedDiagnostics).toEqual(["new"]);
  });

  it("reports build-regressed when a working build stops working", () => {
    expect(build({ migrated: phase("failed", ["shared"]) }).outcome).toBe("build-regressed");
  });

  it("refuses to credit a pass when the baseline build was already broken", () => {
    const record = build({ baseline: phase("failed", ["shared"]), migrated: phase("passed", ["shared"]) });
    expect(record.outcome).toBe("baseline-unusable");
  });

  it("reports an error record when the app could not be observed", () => {
    const record = build({ baseline: undefined, migrated: undefined, error: "no committed lockfile" });
    expect(record.outcome).toBe("error");
    expect(record.error).toBe("no committed lockfile");
  });
});

describe("buildOssArcGisDeepRun", () => {
  it("aggregates outcomes and names the apps that built", () => {
    const parsed = manifest();
    const app = parsed.apps.find((entry) => entry.id === parsed.deepValidation.apps[0].id)!;
    const deepApp = parsed.deepValidation.apps[0];
    const record = buildOssArcGisDeepAppResult({
      app,
      deepApp,
      observedAt: "2026-08-04",
      install: step("passed"),
      honuaInstall: step("passed"),
      baseline: phase("passed", ["shared"]),
      migrated: phase("passed", ["shared", "new"]),
    });

    const run = buildOssArcGisDeepRun({
      manifest: parsed,
      apps: [record],
      generatedAt: "2026-08-04T00:00:00.000Z",
      honuaVersion: "0.0.0-test",
    });

    expect(run.format).toBe(OSS_ARCGIS_DEEP_BUILD_FORMAT);
    expect(run.summary.buildsPostCodemod).toBe(1);
    expect(run.summary.buildRegressions).toBe(0);
    expect(run.summary.introducedDiagnosticCount).toBe(1);
    expect(run.summary.buildingApps).toEqual([app.id]);
    expect(run.optInEnvVars).toEqual([parsed.lane.optInEnvVar, parsed.deepValidation.optInEnvVar]);
  });
});

describe("published post-codemod build observation", () => {
  it("only reports apps that are on the deep allowlist", () => {
    const parsed = manifest();
    const allowlisted = new Set(parsed.deepValidation.apps.map((app) => app.id));
    for (const app of observation().apps) {
      expect(allowlisted, app.appId).toContain(app.appId);
    }
  });

  it("binds every result to the pinned commit", () => {
    const parsed = manifest();
    for (const result of observation().apps) {
      const pinned = parsed.apps.find((app) => app.id === result.appId);
      expect(result.commit, result.appId).toBe(pinned?.repo.commit);
    }
  });

  it("proves at least one corpus app builds post-codemod against the compat entry", () => {
    const run = observation();
    expect(run.summary.buildsPostCodemod).toBeGreaterThan(0);
    for (const appId of run.summary.buildingApps) {
      const result = run.apps.find((app) => app.appId === appId)!;
      expect(result.baseline?.build.status, appId).toBe("passed");
      expect(result.migrated?.build.status, appId).toBe("passed");
    }
  });

  it("records no unexplained build regression", () => {
    expect(observation().summary.buildRegressions).toBe(0);
  });
});

describe("formatOssArcGisDeepBuildMarkdown", () => {
  it("matches the committed page", () => {
    const parsed = manifest();
    const committed = fs.readFileSync(path.join(REPO_ROOT, "docs", "oss-arcgis-corpus-post-codemod-build.md"), "utf8");
    expect(formatOssArcGisDeepBuildMarkdown(parsed, observation())).toBe(committed.replace(/\r\n/g, "\n"));
  });

  it("lists the introduced diagnostics verbatim rather than summarizing them away", () => {
    const parsed = manifest();
    const run = observation();
    const markdown = formatOssArcGisDeepBuildMarkdown(parsed, run);
    for (const app of run.apps as OssArcGisDeepAppResult[]) {
      for (const diagnostic of app.introducedDiagnostics) {
        expect(markdown).toContain(diagnostic);
      }
    }
  });

  it("shows a switched-off supply-chain guarantee as a failure rather than hiding it", () => {
    const parsed = manifest();
    const run = observation();
    const tampered = {
      ...run,
      supplyChain: { ...run.supplyChain, installScriptsDisabled: false },
    };
    expect(formatOssArcGisDeepBuildMarkdown(parsed, tampered)).toContain(
      "| Lifecycle scripts disabled (`--ignore-scripts`) | **no** |",
    );
  });
});
