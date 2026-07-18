/**
 * REQ-006 / closure evidence for issue #566: runs the OpenLayers renderer
 * plugin through the independent #392 certification + behavioral-conformance
 * kit and publishes a deterministic, machine-readable, committed golden
 * report — the same pattern the reference plugins use for every other
 * declared plugin kind (see `test/plugin-conformance.test.ts`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runHonuaPluginConformance } from "../src/plugin/index.js";
import { openLayersRendererConformanceSpec, openLayersRendererManifest } from "./fixtures/plugins/openlayers/index.js";

const OPENLAYERS_HOST = JSON.stringify({
  pluginApi: "1.0",
  sdkVersion: "0.1.0-beta.0",
  environment: "browser",
  peers: {},
  grants: {},
});

const GOLDEN_URL = new URL("./fixtures/plugins/golden/openlayers-renderer-conformance-report.json", import.meta.url);
const GOLDEN_PATH = fileURLToPath(GOLDEN_URL);

describe("OpenLayers renderer-plugin behavioral conformance (#566)", () => {
  it("produces the committed golden certification/conformance report", async () => {
    const report = await runHonuaPluginConformance(openLayersRendererConformanceSpec, OPENLAYERS_HOST);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    if (process.env.WRITE_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, serialized);
    }

    const golden = readFileSync(GOLDEN_PATH, "utf8");
    expect(serialized).toBe(golden);
    expect(report.status).toBe("passed");
    expect(report.plugin).toEqual({ id: openLayersRendererManifest.id, version: "1.0.0", kind: "renderer" });
  });

  it("certifies and passes every behavioral scenario deterministically", async () => {
    const first = await runHonuaPluginConformance(openLayersRendererConformanceSpec, OPENLAYERS_HOST);
    const second = await runHonuaPluginConformance(openLayersRendererConformanceSpec, OPENLAYERS_HOST);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.certification.status).toBe("certified");
    expect(first.certification.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.scenarios.map((scenario) => scenario.scenario)).toEqual(["retries", "performance", "bundle-metadata"]);
    for (const scenario of first.scenarios) {
      expect(scenario.status, scenario.scenario).toBe("passed");
      for (const observation of scenario.observations) expect(observation.satisfied, observation.metric).toBe(true);
    }
  });
});
