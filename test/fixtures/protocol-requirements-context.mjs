import { readFileSync } from "node:fs";
const certificationContract = JSON.parse(readFileSync(new URL("../../config/protocol-certification.v1.json", import.meta.url), "utf8"));

export function requirementsContext(execution, licensed = false) {
  return {
    schema: "honua.protocol-producer-context/v1",
    requirements_revision: "requirements-fixture-v2",
    producer: "honua-sdk-js",
    producer_source_sha: execution.producerSourceSha,
    candidate: { source_sha: execution.sourceSha, image_digest: execution.imageDigest, cut_at: execution.cutAt },
    requirements: certificationContract.operations
      .filter(({ surface }) => licensed ? surface === "realtime" : surface !== "realtime")
      .map((operation) => ({
        ...structuredClone(operation),
        canonical_client: "@honua/sdk-js",
        client_version: execution.clientVersion,
        client_lane: "sdk-js-certification",
        deployment_target: execution.deploymentTarget,
        fixture_revision: execution.fixtureRevision,
        contract_revision: `sdk-js-certification@${execution.producerSourceSha}`,
        auth_policy_revision: licensed ? "api-key-protected-v1" : "anonymous-public-v1",
        maturity: "preview",
        required_tier: "nightly",
      })),
  };
}

