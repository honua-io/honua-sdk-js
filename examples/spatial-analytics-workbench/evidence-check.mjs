import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const presentation = JSON.parse(fs.readFileSync(path.join(root, "presentation.v1.json"), "utf8"));
if (presentation.schemaVersion !== "honua.spatial-analytics-presentation.v1") {
  throw new Error("Spatial analytics presentation asset must use v1");
}
for (const relativePath of Object.values(presentation.evidence)) {
  const evidencePath = path.join(root, String(relativePath));
  if (!fs.existsSync(evidencePath)) throw new Error(`Missing linked evidence: ${relativePath}`);
  const evidence = validateEvidenceEnvelope(JSON.parse(fs.readFileSync(evidencePath, "utf8")));
  if (evidence.sampleId !== "spatial-analytics-workbench") {
    throw new Error(`${relativePath} belongs to the wrong sample`);
  }
}
process.stdout.write("Spatial analytics presentation and fixture/live evidence are valid.\n");
