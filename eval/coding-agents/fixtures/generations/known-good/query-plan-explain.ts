import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { explainQuery } from "@honua/sdk-js/query-planner";

const plan = explainQuery({
  descriptor: {
    id: "parcels",
    protocol: "ogc-features",
    locator: { url: "https://example.test/ogc", collectionId: "parcels" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
  },
  query: {
    where: "status = 'active'",
    outFields: ["parcel_id", "owner"],
    pagination: { limit: 100 },
  },
});

const step = plan.steps[0];
process.stdout.write(
  `${JSON.stringify({
    engine: step?.engine ?? null,
    compiler: step !== undefined && step.engine === "remote" ? step.compiled.compiler : null,
    hasFingerprint: typeof plan.fingerprint === "string" && plan.fingerprint.length > 0,
  })}\n`,
);
