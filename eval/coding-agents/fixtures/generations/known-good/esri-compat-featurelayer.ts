import { FeatureLayerCompat } from "@honua/sdk-js/esri-compat";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const layer = new FeatureLayerCompat({ url: `${baseUrl}/rest/services/EvalIncidents/FeatureServer/0` });
const result = await layer.queryFeatures({
  where: "priority = 'high'",
  outFields: ["OBJECTID", "name"],
  returnGeometry: false,
});

const features = result.features ?? [];
const first = features[0]?.attributes as { name?: string } | undefined;
process.stdout.write(`${JSON.stringify({ count: features.length, firstName: first?.name ?? null })}\n`);
