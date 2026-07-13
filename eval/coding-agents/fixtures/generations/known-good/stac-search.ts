import { HonuaClient } from "@honua/sdk-js";
import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "@honua/sdk-js/contract";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const stacRoot = `${baseUrl}/stac/v1`;
const client = new HonuaClient({ baseUrl: stacRoot });
const dataset = createDataset({
  id: "eval",
  client,
  skipCompatibilityCheck: true,
  sources: [
    {
      id: "sentinel",
      protocol: "stac",
      locator: { url: stacRoot, collectionId: "sentinel-2-l2a", layout: "stac-api" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
    },
  ],
});

const source = dataset.source("sentinel");
if (!source) throw new Error("source not found");
const result = await source.query({ pagination: { limit: 2 } });

process.stdout.write(
  `${JSON.stringify({
    count: result.features.length,
    hasGeometry: result.features.every((feature) => feature.geometry != null),
  })}\n`,
);
