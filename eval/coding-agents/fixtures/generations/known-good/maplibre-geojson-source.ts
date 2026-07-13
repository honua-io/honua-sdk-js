import { HonuaClient } from "@honua/sdk-js";
import { loadHonuaFeatureServiceGeoJson } from "@honua/sdk-js/map";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const client = new HonuaClient({ baseUrl });
const spec = await loadHonuaFeatureServiceGeoJson(client, `${baseUrl}/rest/services/EvalIncidents/FeatureServer/0`, {
  outFields: ["OBJECTID", "name"],
});

const data = spec.data as { type: string; features: unknown[] };
process.stdout.write(`${JSON.stringify({ type: spec.type, featureCount: data.features.length })}\n`);
