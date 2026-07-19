/**
 * Closure evidence for issue #538: runs the first-party PMTiles protocol
 * plugin through the independent #392 certification + behavioral-conformance
 * kit and publishes a deterministic, machine-readable, committed golden
 * report — the same pattern used for the OpenLayers renderer plugin (#566,
 * `test/plugin-openlayers-certification.test.ts`) and every reference plugin
 * kind (`test/plugin-conformance.test.ts`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runHonuaPluginConformance } from "../src/plugin/index.js";
import { pmtilesProtocolManifest } from "../src/plugin/index.js";
import { pmtilesProtocolConformanceSpec } from "./fixtures/plugins/pmtiles-protocol/index.js";

const PMTILES_PROTOCOL_HOST = JSON.stringify({
  pluginApi: "1.0",
  sdkVersion: "0.1.0-beta.0",
  environment: "node",
  peers: {},
  grants: {},
});

const GOLDEN_URL = new URL("./fixtures/plugins/golden/pmtiles-protocol-conformance-report.json", import.meta.url);
const GOLDEN_PATH = fileURLToPath(GOLDEN_URL);

describe("PMTiles protocol-plugin behavioral conformance (#538)", () => {
  it("produces the committed golden certification/conformance report", async () => {
    const report = await runHonuaPluginConformance(pmtilesProtocolConformanceSpec, PMTILES_PROTOCOL_HOST);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    if (process.env.WRITE_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, serialized);
    }

    const golden = readFileSync(GOLDEN_PATH, "utf8");
    expect(serialized).toBe(golden);
    expect(report.status).toBe("passed");
    expect(report.plugin).toEqual({ id: pmtilesProtocolManifest.id, version: "1.0.0", kind: "protocol" });
  });

  it("certifies and passes every behavioral scenario deterministically", async () => {
    const first = await runHonuaPluginConformance(pmtilesProtocolConformanceSpec, PMTILES_PROTOCOL_HOST);
    const second = await runHonuaPluginConformance(pmtilesProtocolConformanceSpec, PMTILES_PROTOCOL_HOST);
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
