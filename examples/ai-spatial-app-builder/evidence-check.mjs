import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const fixture = validateEvidenceEnvelope(await readJson("evidence/fixture.v1.json"));
const live = validateEvidenceEnvelope(await readJson("evidence/live-skipped.v1.json"));
const presentation = await readJson("presentation.v1.json");

if (fixture.semantics.effectsBeforeApproval !== 0 || fixture.semantics.effectsAfterApproval !== 1) {
  throw new Error("Fixture evidence must prove zero pre-approval effects and one approved effect.");
}
if (live.status !== "skipped" || !live.reason.includes("no fixture data was substituted")) {
  throw new Error("Unavailable live/model evidence must be an honest structured skip.");
}
if (presentation.format !== "honua.sdk.sample-presentation.v1" || presentation.sampleId !== fixture.sampleId) {
  throw new Error("Presentation manifest does not match the sample evidence.");
}
for (const relative of presentation.evidence) await readFile(path.join(root, relative));
process.stdout.write("Safe-agent fixture, live-skip, and presentation evidence verified.\n");
