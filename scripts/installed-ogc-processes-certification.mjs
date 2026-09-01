#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { certify } from "./installed-package-certification.mjs";
import {
  assertCandidateEvidenceRedacted,
  collectOgcProcessesCandidateQualification,
  qualificationEnabled,
} from "./ogc-processes-candidate-qualification.mjs";

const OGC_OPERATION_IDS = Object.freeze({
  landing: "protocol-certification:ogc-processes:landing",
  conformance: "protocol-certification:ogc-processes:conformance",
  list: "protocol-certification:ogc-processes:list",
  describe: "protocol-certification:ogc-processes:describe",
  discovery: "sdk-operation:ogc-processes-discovery-standalone:discovery",
  execution: "sdk-operation:ogc-processes-execution-standalone:processes",
});

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

export function observationsFromQualification(evidence, evidenceUri) {
  if (evidence.result !== "passed") throw new Error("OGC Processes qualification did not pass");
  const diagnostic = {
    evidenceUri,
    evidenceSha256: `sha256:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`,
    qualificationFormat: evidence.format,
    fixtureSha256: evidence.fixture.sha256,
  };
  return Object.values(OGC_OPERATION_IDS).map((id) => ({ id, verdict: "pass", diagnostic }));
}

export async function certifyInstalledOgcProcesses({
  receiptOutput,
  qualificationOutput,
  baseUrl,
  apiKey,
  evidenceUri,
  observedAt,
  qualificationInput,
} = {}) {
  let qualification;
  const receipt = await certify({
    output: required(receiptOutput, "receiptOutput"),
    collectObservations: async ({ candidate, packageRoot }) => {
      const identities = {
        sdk: {
          package: candidate.package.coordinate,
          version: candidate.package.version,
          integrity: candidate.package.integrity,
          sourceSha: candidate.package.sourceSha,
        },
        server: { sourceSha: candidate.server.sourceSha, imageDigest: candidate.server.digest },
        manifestRevision: candidate.server.manifestRevision,
        evidenceUri: required(evidenceUri, "evidenceUri"),
      };
      if (qualificationInput) {
        qualification = JSON.parse(await readFile(qualificationInput, "utf8"));
        if (JSON.stringify(qualification.candidate) !== JSON.stringify(identities)) {
          throw new Error("qualification input does not match the installed candidate identities");
        }
      } else {
        const sdk = await import(pathToFileURL(path.join(packageRoot, "dist/src/index.js")));
        qualification = await collectOgcProcessesCandidateQualification({
          sdk,
          baseUrl: required(baseUrl, "baseUrl"),
          apiKey: required(apiKey, "apiKey"),
          observedAt,
          identities,
        });
      }
      assertCandidateEvidenceRedacted(qualification);
      await writeFile(required(qualificationOutput, "qualificationOutput"), `${JSON.stringify(qualification, null, 2)}\n`);
      return observationsFromQualification(qualification, evidenceUri);
    },
  });
  return { qualification, receipt };
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(new URL(import.meta.url).pathname)) {
  if (!qualificationEnabled()) throw new Error("set HONUA_OGC_PROCESSES_QUALIFICATION_ENABLED=true to run the live candidate lane");
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
  };
  const result = await certifyInstalledOgcProcesses({
    receiptOutput: option("--receipt-output", "test-results/installed-package-certification.json"),
    qualificationOutput: option("--qualification-output", "test-results/ogc-processes-candidate-qualification.json"),
    baseUrl: process.env.HONUA_INTEGRATION_BASE_URL,
    apiKey: process.env.HONUA_API_KEY,
    evidenceUri: process.env.HONUA_EVIDENCE_URI,
    qualificationInput: option("--qualification-input"),
  });
  process.stdout.write(
    `OGC Processes ${result.qualification.result}; installed certification ${result.receipt.verdict}: ` +
      `${result.receipt.summary.pass} pass, ${result.receipt.summary.fail} fail, ${result.receipt.summary.blocked} blocked\n`,
  );
  process.exitCode = result.receipt.summary.fail > 0 ? 1 : 0;
}
