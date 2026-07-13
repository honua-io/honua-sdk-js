// Known-bad generation: hallucinates `result.items` — the Result contract
// exposes `features`. Must FAIL the typecheck stage (TS2339).
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
      protocol: "ogc-features",
      locator: { url: baseUrl, collectionId: "eval-incidents" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    },
  ],
});

const source = dataset.source<{ name: string }>("incidents");
if (!source) throw new Error("source not found");
const result = await source.query({ where: "priority = 'high'", pagination: { limit: 10 } });

process.stdout.write(
  `${JSON.stringify({
    count: result.items.length,
    totalCount: result.totalCount ?? null,
    firstName: result.items[0]?.attributes.name ?? null,
  })}\n`,
);
