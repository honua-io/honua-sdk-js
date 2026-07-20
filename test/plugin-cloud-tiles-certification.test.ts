/**
 * Closure evidence for issue #538 REQ-004: runs the independent, out-of-tree-
 * style "cloud tiles" `ProtocolModule` (`test/fixtures/plugins/cloud-tiles/`)
 * through the same #392 certification + behavioral-conformance kit used for
 * the first-party PMTiles protocol plugin
 * (`test/plugin-pmtiles-protocol-certification.test.ts`), proving the
 * protocol seam is portable to a module that shares no implementation with
 * SDK core.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runHonuaPluginConformance } from "../src/plugin/index.js";
import { cloudTilesProtocolConformanceSpec } from "./fixtures/plugins/cloud-tiles/index.js";
import { cloudTilesProtocolManifest } from "./fixtures/plugins/cloud-tiles/manifest.js";

const CLOUD_TILES_HOST = JSON.stringify({
  pluginApi: "1.0",
  sdkVersion: "0.1.0-beta.0",
  environment: "node",
  peers: {},
  grants: {},
});

const GOLDEN_URL = new URL("./fixtures/plugins/golden/cloud-tiles-protocol-conformance-report.json", import.meta.url);
const GOLDEN_PATH = fileURLToPath(GOLDEN_URL);

describe("cloud-tiles independent protocol-module conformance (#538)", () => {
  it("produces the committed golden certification/conformance report", async () => {
    const report = await runHonuaPluginConformance(cloudTilesProtocolConformanceSpec, CLOUD_TILES_HOST);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    if (process.env.WRITE_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, serialized);
    }

    const golden = readFileSync(GOLDEN_PATH, "utf8");
    expect(serialized).toBe(golden);
    expect(report.status).toBe("passed");
    expect(report.plugin).toEqual({ id: cloudTilesProtocolManifest.id, version: "1.0.0", kind: "protocol" });
  });

  it("certifies and passes every behavioral scenario deterministically", async () => {
    const first = await runHonuaPluginConformance(cloudTilesProtocolConformanceSpec, CLOUD_TILES_HOST);
    const second = await runHonuaPluginConformance(cloudTilesProtocolConformanceSpec, CLOUD_TILES_HOST);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.certification.status).toBe("certified");
    for (const scenario of first.scenarios) {
      expect(scenario.status, scenario.scenario).toBe("passed");
      for (const observation of scenario.observations) expect(observation.satisfied, observation.metric).toBe(true);
    }
  });
});
