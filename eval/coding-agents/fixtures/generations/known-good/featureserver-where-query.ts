import { HonuaClient } from "@honua/sdk-js";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const client = new HonuaClient({ baseUrl });
const response = await client.featureLayer<{ OBJECTID: number; name: string; priority: string }>("EvalIncidents", 0).queryFeatures({
  where: "priority = 'high'",
  outFields: ["OBJECTID", "name", "priority"],
  returnGeometry: false,
});

const features = response.features ?? [];
process.stdout.write(
  `${JSON.stringify({ count: features.length, firstName: features[0]?.attributes.name ?? null })}\n`,
);
