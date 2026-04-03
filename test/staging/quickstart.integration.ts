import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveQuickstartStagingConfig } from "../../examples/maplibre-quickstart/src/config.js";
import { loadQuickstartDataset } from "../../examples/maplibre-quickstart/src/data.js";

describe("quickstart staging integration", () => {
  it("loads the staging quickstart path through compatibility plus one feature query", async () => {
    const config = resolveQuickstartStagingConfig(process.env as Record<string, string | undefined>);
    const dataset = await loadQuickstartDataset(config);

    expect(dataset.compatibility.serverVersion).not.toBe("unknown");
    expect(dataset.featureCount).toBeGreaterThan(0);
    expect(dataset.renderableFeatureCount).toBeGreaterThan(0);
    expect(dataset.geometryTypes.length).toBeGreaterThan(0);
    expect(dataset.featureSummaries[0]).toBeDefined();

    const summaryFile = process.env.HONUA_QUICKSTART_STAGING_SUMMARY_FILE;
    if (summaryFile) {
      fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
      fs.writeFileSync(
        summaryFile,
        JSON.stringify(
          {
            baseUrl: config.honuaBaseUrl,
            serviceId: config.serviceId,
            layerId: config.layerId,
            serverVersion: dataset.compatibility.serverVersion,
            releaseChannel: dataset.compatibility.releaseChannel,
            featureCount: dataset.featureCount,
            renderableFeatureCount: dataset.renderableFeatureCount,
            geometryTypes: dataset.geometryTypes,
            queryDurationMs: dataset.queryDurationMs,
          },
          null,
          2,
        ),
      );
    }
  });
});
