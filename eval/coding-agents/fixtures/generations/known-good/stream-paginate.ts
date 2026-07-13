import { HonuaClient } from "@honua/sdk-js";
import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "@honua/sdk-js/contract";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const client = new HonuaClient({ baseUrl });
const dataset = createDataset({
  id: "eval",
  client,
  skipCompatibilityCheck: true,
  sources: [
    {
      id: "incidents",
      protocol: "geoservices-feature-service",
      locator: { url: baseUrl, serviceId: "EvalIncidents", layerId: 0 },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    },
  ],
});

const source = dataset.source("incidents");
if (!source) throw new Error("source not found");

let pages = 0;
let total = 0;
for await (const page of source.stream({ where: "1=1", pagination: { limit: 2 } })) {
  pages += 1;
  total += page.features.length;
}

process.stdout.write(`${JSON.stringify({ pages, total })}\n`);
