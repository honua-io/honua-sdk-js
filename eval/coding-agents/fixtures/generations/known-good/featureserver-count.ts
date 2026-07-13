import { HonuaClient } from "@honua/sdk-js";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const client = new HonuaClient({ baseUrl });
const count = await client.featureLayer("EvalIncidents", 0).queryFeatureCount({ where: "1=1" });

process.stdout.write(`${JSON.stringify({ count })}\n`);
