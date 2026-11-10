import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8")) as T;
}

describe("@honua/sdk-js/client-compat", () => {
  it("publishes ./client-compat as a stable export", () => {
    const packageJson = readJson<{
      exports: Record<string, { types: string; default: string }>;
      sideEffects: string[];
    }>("package.json");
    expect(packageJson.exports["./client-compat"]).toEqual({
      types: "./dist/src/client-compat-entry.d.ts",
      default: "./dist/src/client-compat-entry.js",
    });
    expect(packageJson.sideEffects).toContain("./dist/src/client-compat-entry.js");
    expect(packageJson.sideEffects).toContain("./src/client-compat-entry.ts");

    const surface = readJson<{
      entrypoints: Array<{ subpath: string; tier: string }>;
    }>("config/public-surface.json");
    expect(surface.entrypoints.find((entry) => entry.subpath === "./client-compat")).toEqual({
      subpath: "./client-compat",
      tier: "stable",
    });
  });

  it("records the export in the stable API report", () => {
    const report = readJson<{
      stableEntrypoints: Array<{ subpath: string; types: string; exportCount: number; exports: string[] }>;
    }>("api-report/stable-api.json");
    const entry = report.stableEntrypoints.find((candidate) => candidate.subpath === "@honua/sdk-js/client-compat");
    expect(entry?.types).toBe("dist/src/client-compat-entry.d.ts");
    expect(entry?.exports).toEqual(expect.arrayContaining(["FeatureLayerCompat — class", "MapViewCompat — class"]));
    expect(entry?.exportCount).toBe(entry?.exports.length);
  });

  it("loads the compatibility entry", async () => {
    const compat = await import("@honua/sdk-js/client-compat");
    expect(Object.keys(compat).length).toBeGreaterThan(100);
    expect(compat.FeatureLayerCompat).toBeTypeOf("function");
    expect(compat.MapViewCompat).toBeTypeOf("function");
  }, 60_000);
});
