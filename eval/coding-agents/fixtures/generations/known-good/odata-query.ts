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
      id: "people",
      protocol: "odata",
      locator: { url: `${baseUrl}/odata/TripPin`, entitySet: "People" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
    },
  ],
});

const source = dataset.source<{ UserName: string }>("people");
if (!source) throw new Error("source not found");
const result = await source.query({ pagination: { limit: 2 } });

process.stdout.write(
  `${JSON.stringify({
    count: result.features.length,
    firstUser: result.features[0]?.attributes.UserName ?? null,
    totalCount: result.totalCount ?? null,
  })}\n`,
);
