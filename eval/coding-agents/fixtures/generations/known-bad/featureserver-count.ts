// Known-bad generation: treats the numeric queryFeatureCount() result as an
// envelope object. Must FAIL the typecheck stage (TS2339).
import { HonuaClient } from "@honua/sdk-js";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const client = new HonuaClient({ baseUrl });
const response = await client.featureLayer("EvalIncidents", 0).queryFeatureCount({ where: "1=1" });

process.stdout.write(`${JSON.stringify({ count: response.count })}\n`);
