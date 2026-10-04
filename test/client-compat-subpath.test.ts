import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { emitDeprecationNoticeOnce } from "../src/core/deprecation-notice.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const WARNING_CODE = "HONUA_ESRI_COMPAT_SUBPATH_RENAMED";
const WARNED_KEY = Symbol.for(`@honua/sdk-js:deprecation:${WARNING_CODE}`);
// Each test re-imports the full compatibility module graph after vi.resetModules().
const COLD_IMPORT_TIMEOUT_MS = 60_000;

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8")) as T;
}

function clearWarnedFlag(): void {
  delete (globalThis as Record<symbol, unknown>)[WARNED_KEY];
}

function subpathWarnings(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter(([, options]) => (options as { code?: string } | undefined)?.code === WARNING_CODE);
}

describe("@honua/sdk-js/client-compat and the deprecated @honua/sdk-js/esri-compat alias", () => {
  beforeEach(() => {
    clearWarnedFlag();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearWarnedFlag();
  });

  it("publishes ./client-compat as a stable export and ./esri-compat as a deprecated shim over it", () => {
    const packageJson = readJson<{
      exports: Record<string, { types: string; default: string }>;
      sideEffects: string[];
    }>("package.json");
    expect(packageJson.exports["./client-compat"]).toEqual({
      types: "./dist/src/client-compat-entry.d.ts",
      default: "./dist/src/client-compat-entry.js",
    });
    expect(packageJson.exports["./esri-compat"]).toEqual({
      types: "./dist/src/esri-compat-entry.d.ts",
      default: "./dist/src/esri-compat-entry.js",
    });
    // The shim's warning is a module side effect; bundlers must not drop it.
    expect(packageJson.sideEffects).toContain("./dist/src/esri-compat-entry.js");

    const surface = readJson<{
      entrypoints: Array<{
        subpath: string;
        tier: string;
        replacement?: string;
        introducedIn?: string;
        removeIn?: string;
      }>;
    }>("config/public-surface.json");
    expect(surface.entrypoints.find((entry) => entry.subpath === "./client-compat")).toEqual({
      subpath: "./client-compat",
      tier: "stable",
    });
    expect(surface.entrypoints.find((entry) => entry.subpath === "./esri-compat")).toEqual({
      subpath: "./esri-compat",
      tier: "deprecated",
      replacement: "@honua/sdk-js/client-compat",
      introducedIn: "0.1.13",
      removeIn: "2026.2",
    });

    // The shim adds no symbol of its own: everything it exports comes from the renamed entry.
    const shim = fs.readFileSync(path.join(projectRoot, "src", "esri-compat-entry.ts"), "utf8");
    expect(shim.match(/^export\b.*$/gm)).toEqual(['export * from "./client-compat-entry.js";']);
  });

  it("records the new export in the stable API report with the full compatibility surface", () => {
    const report = readJson<{
      stableEntrypoints: Array<{ subpath: string; types: string; exportCount: number; exports: string[] }>;
    }>("api-report/stable-api.json");
    const entry = report.stableEntrypoints.find((candidate) => candidate.subpath === "@honua/sdk-js/client-compat");
    expect(entry?.types).toBe("dist/src/client-compat-entry.d.ts");
    expect(entry?.exports).toEqual(expect.arrayContaining(["FeatureLayerCompat — class", "MapViewCompat — class"]));
    expect(entry?.exportCount).toBe(entry?.exports.length);
    // Deprecated shims are not part of the stable report.
    expect(report.stableEntrypoints.some((candidate) => candidate.subpath === "@honua/sdk-js/esri-compat")).toBe(false);
  });

  it(
    "resolves both subpaths to the same symbols",
    async () => {
      vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
      const renamed = await import("@honua/sdk-js/client-compat");
      const legacy = await import("@honua/sdk-js/esri-compat");

      expectTypeOf(legacy).toEqualTypeOf(renamed);
      const renamedNames = Object.keys(renamed).sort();
      expect(renamedNames.length).toBeGreaterThan(100);
      expect(Object.keys(legacy).sort()).toEqual(renamedNames);
      for (const name of renamedNames) {
        expect(legacy[name as keyof typeof legacy], name).toBe(renamed[name as keyof typeof renamed]);
      }
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it(
    "warns exactly once per process, naming the replacement and the removal version",
    async () => {
      const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

      await import("@honua/sdk-js/esri-compat");
      await import("@honua/sdk-js/esri-compat");
      // A second evaluation of the shim (a fresh module graph, a duplicate copy
      // in node_modules) must not warn again.
      vi.resetModules();
      await import("@honua/sdk-js/esri-compat");
      await import("../src/esri-compat-entry.js");

      const warnings = subpathWarnings(emitWarning);
      expect(warnings).toHaveLength(1);
      const [message, options] = warnings[0]!;
      expect(options).toEqual({ code: WARNING_CODE, type: "DeprecationWarning" });
      expect(message).toContain("@honua/sdk-js/esri-compat is deprecated");
      expect(message).toContain("@honua/sdk-js/client-compat");
      expect(message).toContain("2026.2");
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it(
    "does not warn when only the new subpath is imported",
    async () => {
      const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

      await import("@honua/sdk-js/client-compat");

      expect(subpathWarnings(emitWarning)).toHaveLength(0);
    },
    COLD_IMPORT_TIMEOUT_MS,
  );
});

describe("emitDeprecationNoticeOnce", () => {
  const notice = { code: "HONUA_TEST_NOTICE", message: "old is deprecated; use new" };

  it("routes through process.emitWarning once per runtime", () => {
    const emitWarning = vi.fn();
    const runtime = { process: { emitWarning }, console: { warn: vi.fn() } };

    expect(emitDeprecationNoticeOnce(notice, runtime)).toBe(true);
    expect(emitDeprecationNoticeOnce(notice, runtime)).toBe(false);

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(notice.message, { code: notice.code, type: "DeprecationWarning" });
    expect(runtime.console.warn).not.toHaveBeenCalled();
  });

  it("falls back to console.warn once where there is no process (browsers)", () => {
    const warn = vi.fn();
    const runtime = { console: { warn } };

    emitDeprecationNoticeOnce(notice, runtime);
    emitDeprecationNoticeOnce(notice, runtime);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`DeprecationWarning [${notice.code}]: ${notice.message}`);
  });

  it("tracks each notice code separately", () => {
    const emitWarning = vi.fn();
    const runtime = { process: { emitWarning } };

    emitDeprecationNoticeOnce(notice, runtime);
    emitDeprecationNoticeOnce({ code: "HONUA_OTHER_NOTICE", message: "other" }, runtime);

    expect(emitWarning).toHaveBeenCalledTimes(2);
  });
});
