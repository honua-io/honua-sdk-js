import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";

const observedAt = new Date().toISOString();
const proposalEndpoint = process.env.HONUA_AGENT_HOST_URL;
const dataEndpoint = process.env.HONUA_LIVE_DATA_URL;
let evidence;
if (!proposalEndpoint || !dataEndpoint) {
  evidence = {
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "ai-spatial-app-builder",
    lane: "live",
    status: "skipped",
    observedAt,
    authMode: "host-mediated",
    provenance: null,
    reason: "HONUA_AGENT_HOST_URL and HONUA_LIVE_DATA_URL are not configured; no fixture data was substituted.",
  };
} else {
  const endpoints = [proposalEndpoint, dataEndpoint].map((value) => new URL(value));
  if (
    endpoints.some(
      (endpoint) =>
        endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash,
    )
  ) {
    throw new Error("Configured host endpoints must be credential-free HTTPS URLs without query strings or fragments.");
  }
  evidence = {
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "ai-spatial-app-builder",
    lane: "live",
    status: "skipped",
    observedAt,
    authMode: "host-mediated",
    provenance: null,
    reason:
      "Credential-free host endpoints were configured, but the external proposal/data adapter and scheduled-run authorization are not available in this repository; no request was sent and no fixture data was substituted.",
  };
}
const output = path.resolve("test-results/ai-spatial-app-builder-live-evidence.json");
evidence = validateEvidenceEnvelope(evidence);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
