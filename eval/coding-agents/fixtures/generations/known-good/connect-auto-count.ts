import { connect } from "@honua/sdk-js";

const baseUrl = process.env.HONUA_EVAL_BASE_URL;
if (!baseUrl) throw new Error("HONUA_EVAL_BASE_URL is required");

const connection = await connect({
  endpoint: `${baseUrl}/rest/services/EvalIncidents/FeatureServer/0`,
  protocol: "auto",
  authorizationScopeFingerprint: "anonymous",
});

const source = connection.source();
const result = await source.query({ where: "1=1" });

process.stdout.write(`${JSON.stringify({ count: result.features.length })}\n`);
