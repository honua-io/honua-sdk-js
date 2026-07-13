import { HonuaCapabilityNotSupportedError, HonuaClient } from "@honua/sdk-js";
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
      id: "countries",
      protocol: "wfs",
      locator: { url: `${baseUrl}/geoserver/ows`, typeName: "ne:ne_10m_admin_0_countries" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
    },
  ],
});

const source = dataset.source("countries");
if (!source) throw new Error("source not found");

let caught = false;
let capability: string | null = null;
let errorName: string | null = null;
try {
  await source.queryAggregate({
    aggregation: { groupBy: [], metrics: [{ fn: "count", field: "OBJECTID", alias: "n" }] },
  });
} catch (error) {
  caught = error instanceof HonuaCapabilityNotSupportedError;
  if (error instanceof HonuaCapabilityNotSupportedError) {
    capability = error.capability;
    errorName = error.name;
  }
}

process.stdout.write(`${JSON.stringify({ caught, capability, errorName })}\n`);
