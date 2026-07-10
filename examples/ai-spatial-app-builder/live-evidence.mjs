import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
  evidence = {
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "ai-spatial-app-builder",
    lane: "live",
    status: "skipped",
    observedAt,
    authMode: "host-mediated",
    provenance: null,
    reason: "Host endpoints were configured, but automated model execution requires an explicit scheduled-run authorization; no browser credential was used.",
  };
}
const output = path.resolve("test-results/ai-spatial-app-builder-live-evidence.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
