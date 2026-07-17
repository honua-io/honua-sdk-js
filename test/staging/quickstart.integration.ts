import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFirstMapConfig } from "../../examples/maplibre-quickstart/src/first-map-config.js";
import { runFirstMapWorkflow } from "../../examples/maplibre-quickstart/src/workflow.js";
import { EvidenceMap } from "../../scripts/lib/evidence-map.mjs";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function layerEndpoint(): { endpoint: string; layerId: number; maxFeatures: number } {
  const base = new URL(required("HONUA_STAGING_BASE_URL"));
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("HONUA_STAGING_BASE_URL must be a credential-free HTTP(S) origin or path.");
  }
  const serviceId = required("HONUA_STAGING_SERVICE_ID");
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(serviceId)) {
    throw new Error("HONUA_STAGING_SERVICE_ID must contain bounded path identifiers.");
  }
  const layerId = Number(required("HONUA_STAGING_LAYER_ID"));
  const maxFeatures = Number(process.env.HONUA_STAGING_RESULT_RECORD_COUNT ?? "25");
  if (!Number.isSafeInteger(layerId) || layerId < 0) throw new Error("HONUA_STAGING_LAYER_ID is invalid.");
  if (!Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10_000) {
    throw new Error("HONUA_STAGING_RESULT_RECORD_COUNT is invalid.");
  }
  const encodedService = serviceId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return {
    endpoint: `${base.href.replace(/\/$/, "")}/rest/services/${encodedService}/FeatureServer/${layerId}`,
    layerId,
    maxFeatures,
  };
}

describe("quickstart staging integration", () => {
  it("executes the anonymous public First Map semantic path", async () => {
    const target = layerEndpoint();
    const result = await runFirstMapWorkflow(
      resolveFirstMapConfig({
        endpoint: target.endpoint,
        mode: "public-live",
        protocol: "auto",
        sourceId: String(target.layerId),
        maxFeatures: target.maxFeatures,
      }),
      { map: new EvidenceMap() },
    );

    expect(result.state).toBe("ready");
    if (result.state !== "ready") {
      throw new Error(
        result.state === "source-selection-required"
          ? `First Map source selection was required: ${result.reason}`
          : `${result.error.code}: ${result.error.message}`,
      );
    }
    try {
      const featureCount = result.mounted.diagnostics.featureCount ?? 0;
      const geometryCount = result.mounted.diagnostics.geometryKinds?.length ? featureCount : 0;
      expect(featureCount).toBeGreaterThan(0);
      expect(geometryCount).toBeGreaterThan(0);

      const summaryFile = process.env.HONUA_QUICKSTART_STAGING_SUMMARY_FILE;
      if (summaryFile) {
        fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
        fs.writeFileSync(
          summaryFile,
          JSON.stringify(
            {
              endpointOrigin: new URL(target.endpoint).origin,
              protocol: result.view.connection.protocol,
              sourceId: result.view.source.id,
              cacheStatus: result.view.connection.cacheStatus,
              strategy: result.view.strategy,
              featureCount,
              geometryCount,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await result.dispose();
    }
  });
});
