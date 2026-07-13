// Known-bad generation: compiles cleanly but queries a feature type that does
// not exist on the server. Must FAIL the runtime stage.
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
      id: "countries",
      protocol: "wfs",
      locator: { url: `${baseUrl}/geoserver/ows`, typeName: "ne:no_such_feature_type" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
    },
  ],
});

const source = dataset.source<{ name: string }>("countries");
if (!source) throw new Error("source not found");
const result = await source.query({ pagination: { limit: 2 } });

process.stdout.write(
  `${JSON.stringify({ count: result.features.length, firstName: result.features[0]?.attributes.name ?? null })}\n`,
);
