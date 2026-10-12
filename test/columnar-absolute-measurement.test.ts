import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COLUMNAR_ABSOLUTE_RECIPES,
  assertUninstrumentedRuntime,
  parseColumnarAbsoluteReport,
} from "../bench/columnar-absolute-protocol.js";
import { measureColumnarAbsolute } from "./columnar-absolute-measurement.js";
import { getPreparedColumnarAbsoluteRunnerPath } from "./prepared-sdk-artifacts.js";

afterEach(() => vi.unstubAllEnvs());

describe("absolute benchmark process boundary", () => {
  it("refuses inherited coverage, preloads and unexpected execution flags", () => {
    expect(() => assertUninstrumentedRuntime(["--expose-gc"], {})).not.toThrow();
    for (const environment of [{ NODE_V8_COVERAGE: "/tmp/coverage" }, { NODE_OPTIONS: "--require hook.cjs" }]) {
      expect(() => assertUninstrumentedRuntime(["--expose-gc"], environment)).toThrow("no instrumentation");
    }
    expect(() => assertUninstrumentedRuntime(["--expose-gc", "--inspect"], {})).toThrow("no instrumentation");
  });

  it("rejects a changed million-row recipe in the actual prepared child", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        getPreparedColumnarAbsoluteRunnerPath(),
        JSON.stringify({ scenario: "patch", recipe: { ...COLUMNAR_ABSOLUTE_RECIPES.patch, rowCount: 1 } }),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("recipe does not match");
  });

  it("fails the calling gate when the real child refuses its environment", () => {
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");
    expect(() => measureColumnarAbsolute("patch")).toThrow("Absolute timing child failed");
  });

  it("refuses mismatched provenance, failed invariants and unusable measurements", () => {
    const valid = {
      schemaVersion: 1,
      scenario: "patch",
      recipe: COLUMNAR_ABSOLUTE_RECIPES.patch,
      runtime: process.version,
      executable: process.execPath,
      instrumentation: "none",
      samples: [1, 2, 3, 4, 5],
      invariants: { passed: true, checks: { collectedBaseline: true } },
    };
    const parse = (value: unknown) =>
      parseColumnarAbsoluteReport(JSON.stringify(value), "patch", process.version, process.execPath);
    expect(parse(valid).samples).toEqual([1, 2, 3, 4, 5]);
    for (const override of [
      { recipe: { ...valid.recipe, measurementRuns: 1 } },
      { scenario: "aggregate" },
      { runtime: "v20.19.0" },
      { executable: "/another/node" },
      { instrumentation: "v8" },
      { samples: [] },
      { samples: [1, 2, 3, 4, null] },
      { samples: [1, 2, 3, 4, -1] },
      { invariants: { passed: false, checks: { collectedBaseline: true } } },
      { invariants: { passed: true, checks: { collectedBaseline: false } } },
      { invariants: { passed: true, checks: {} } },
    ]) {
      expect(() => parse({ ...valid, ...override })).toThrow();
    }
  });
});
