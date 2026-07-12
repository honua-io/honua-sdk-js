import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type HonuaPluginConformanceSpec,
  type HonuaPluginFactory,
  runHonuaPluginConformance,
} from "../src/plugin/index.js";
import {
  REFERENCE_HOST,
  referenceConformanceManifest,
  referenceConformanceSpec,
} from "./fixtures/plugins/reference/index.js";

const GOLDEN_URL = new URL("./fixtures/plugins/golden/conformance-report.json", import.meta.url);
const GOLDEN_PATH = fileURLToPath(GOLDEN_URL);

/**
 * Behavioral-conformance golden report. The harness output is deterministic
 * (integer counters only), so it is asserted byte-for-byte against a committed
 * golden. Regenerate intentionally with `WRITE_GOLDEN=1 vitest run
 * test/plugin-conformance.test.ts` after a deliberate behavior change.
 */
describe("plugin behavioral conformance", () => {
  it("produces the committed golden report for the reference plugin", async () => {
    const report = await runHonuaPluginConformance(referenceConformanceSpec, REFERENCE_HOST);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    if (process.env.WRITE_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, serialized);
    }

    const golden = readFileSync(GOLDEN_PATH, "utf8");
    expect(serialized).toBe(golden);
    expect(report.status).toBe("passed");
  });

  it("covers retries, performance bounds, and bundle metadata", async () => {
    const report = await runHonuaPluginConformance(referenceConformanceSpec, REFERENCE_HOST);
    expect(report.scenarios.map((scenario) => scenario.scenario)).toEqual([
      "retries",
      "performance",
      "bundle-metadata",
    ]);
    for (const scenario of report.scenarios) {
      expect(scenario.status, scenario.scenario).toBe("passed");
      for (const observation of scenario.observations) expect(observation.satisfied, observation.metric).toBe(true);
    }
    // The retry scenario proves the plugin recovered after two injected
    // transient failures within its declared three-attempt budget.
    const retries = report.scenarios.find((scenario) => scenario.scenario === "retries");
    expect(retries?.observations.find((o) => o.metric === "hostAttempts")?.observed).toBe(3);
    expect(retries?.observations.find((o) => o.metric === "recovered")?.observed).toBe(1);
  });

  it("is deterministic and binds the certification digest", async () => {
    const first = await runHonuaPluginConformance(referenceConformanceSpec, REFERENCE_HOST);
    const second = await runHonuaPluginConformance(referenceConformanceSpec, REFERENCE_HOST);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.certification.status).toBe("certified");
    expect(first.certification.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails when only the second performance run throws (leaked state)", async () => {
    // A nondeterministic plugin whose first run succeeds but whose second run
    // throws must NOT receive a passed performance scenario. `run` throws on
    // its third invocation: retries(#1) and the first performance run(#2)
    // succeed, the second performance run(#3) throws.
    let invocations = 0;
    const factory: HonuaPluginFactory<"protocol"> = {
      manifest: JSON.stringify(referenceConformanceManifest),
      initialize(context) {
        return {
          extension: Object.freeze({
            id: context.manifest.id,
            kind: "protocol" as const,
            run: async () => {
              invocations += 1;
              if (invocations === 3) throw new Error("second performance run failure");
            },
          }),
          dispose() {},
        };
      },
    };
    const spec: HonuaPluginConformanceSpec = {
      factory,
      probe: async (registry) => {
        const extension = registry.get("protocol", referenceConformanceManifest.id) as
          | { run: () => Promise<void> }
          | undefined;
        if (!extension) throw new Error("extension missing");
        await extension.run();
      },
      retries: { injectedFailures: 0, maxAttempts: 4 },
      performance: { maxServiceCalls: 4 },
      bundle: { minifiedBytes: 100, gzipBytes: 50, maxMinifiedBytes: 200, maxGzipBytes: 100 },
    };

    const report = await runHonuaPluginConformance(spec, REFERENCE_HOST);
    const performance = report.scenarios.find((scenario) => scenario.scenario === "performance");
    expect(performance?.status).toBe("failed");
    expect(performance?.observations.find((o) => o.metric === "completed")?.satisfied).toBe(false);
    expect(report.status).toBe("failed");
  });

  it("fails closed when a scenario bound is exceeded", async () => {
    const strict = {
      ...referenceConformanceSpec,
      retries: { ...referenceConformanceSpec.retries, maxAttempts: 1 },
    };
    const report = await runHonuaPluginConformance(strict, REFERENCE_HOST);
    expect(report.status).toBe("failed");
    const retries = report.scenarios.find((scenario) => scenario.scenario === "retries");
    expect(retries?.status).toBe("failed");
  });
});
