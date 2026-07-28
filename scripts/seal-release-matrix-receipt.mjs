#!/usr/bin/env node

// Seal the First Map release-matrix browser receipt (honua-io/honua-sdk-js#766).
//
//   node scripts/seal-release-matrix-receipt.mjs \
//     --sample maplibre-quickstart \
//     --report .tmp/release-matrix/playwright-report.json
//
// Runs inside .github/workflows/first-map-release-smoke.yml immediately after
// the three-engine Playwright run, whether that run passed or failed. The
// receipt it writes is the ONLY durable record of Firefox/WebKit outcomes; the
// workflow then hands it to regenerate-derived-artifacts.yml, which commits it
// through the existing evidence-reseal automation.
//
// This script transcribes; it never asserts. The receipt's status is derived
// from the Playwright report alone, and the source binding is the same
// evidence-neutral whole-tree digest that gate receipts use, verified against
// the checkout before anything is written.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildReleaseMatrixReceipt,
  RELEASE_MATRIX_ARTIFACT_NAME,
  RELEASE_MATRIX_ENV_NAME,
  releaseMatrixEnginesFromPlaywrightReport,
  releaseMatrixReceiptRelativePath,
  releaseMatrixRunIdentity,
} from "./lib/release-matrix-receipt.mjs";
import {
  evidenceNeutralSourceDigest,
  readCanonicalBoundedFile,
  verifyEvidenceNeutralCheckout,
} from "./sample-gate-receipt.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = { sampleId: undefined, report: undefined, output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--sample") options.sampleId = argv[++index];
    else if (flag === "--report") options.report = argv[++index];
    else if (flag === "--output") options.output = argv[++index];
    else throw new Error(`Unknown seal-release-matrix-receipt argument: ${flag}`);
  }
  invariant(options.sampleId, "seal-release-matrix-receipt requires --sample <id>");
  invariant(options.report, "seal-release-matrix-receipt requires --report <playwright-json>");
  return options;
}

export async function sealReleaseMatrixReceipt(options) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const env = options.env ?? process.env;
  invariant(
    env[RELEASE_MATRIX_ENV_NAME] === "true",
    `release-matrix receipts can only be sealed with ${RELEASE_MATRIX_ENV_NAME}=true`,
  );
  const run = releaseMatrixRunIdentity(env);
  const reportRelative = path.relative(projectRoot, path.resolve(projectRoot, options.report)).replaceAll(path.sep, "/");
  const reportBytes = await readCanonicalBoundedFile(projectRoot, reportRelative, {
    label: "release-matrix Playwright report",
    maxBytes: MAX_REPORT_BYTES,
  });
  let report;
  try {
    report = JSON.parse(reportBytes.toString("utf8"));
  } catch {
    throw new Error("release-matrix Playwright report is not valid JSON");
  }
  const kitManifest = JSON.parse(
    (
      await readCanonicalBoundedFile(projectRoot, "examples/_kit/manifest.v1.json", {
        label: "sample kit manifest",
        maxBytes: 1024 * 1024,
      })
    ).toString("utf8"),
  );
  const contract = kitManifest.samples.find((sample) => sample.id === options.sampleId);
  invariant(contract, `${options.sampleId} has no declared sample kit contract`);
  const engines = releaseMatrixEnginesFromPlaywrightReport(report, {
    playwrightFile: contract.playwrightFile,
  });
  const sourceRevision =
    options.sourceRevision ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const sourceDigest = evidenceNeutralSourceDigest(projectRoot);
  // Same whole-tree integrity model gate receipts use: the digest must describe
  // both the checked-out index and the named revision's tree (NFR-001).
  verifyEvidenceNeutralCheckout(sourceDigest, projectRoot, sourceRevision);
  const receipt = await buildReleaseMatrixReceipt({
    projectRoot,
    sampleId: options.sampleId,
    sourceRevision,
    sourceDigest,
    matrixEnvValue: env[RELEASE_MATRIX_ENV_NAME],
    playwrightVersion: options.playwrightVersion ?? require("@playwright/test/package.json").version,
    command: options.command ?? ["npm", "run", contract.playwrightScript],
    run,
    engines,
    report: {
      bytes: reportBytes.byteLength,
      sha256: createHash("sha256").update(reportBytes).digest("hex"),
      workflowArtifactName: options.workflowArtifactName ?? RELEASE_MATRIX_ARTIFACT_NAME,
    },
    observedAt: options.observedAt,
  });
  const outputRelative = options.output ?? releaseMatrixReceiptRelativePath(options.sampleId);
  const outputAbsolute = path.resolve(projectRoot, outputRelative);
  await mkdir(path.dirname(outputAbsolute), { recursive: true });
  await writeFile(outputAbsolute, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { receipt, path: outputRelative };
}

async function main(argv) {
  const options = parseArguments(argv);
  const { receipt, path: outputPath } = await sealReleaseMatrixReceipt(options);
  const engines = receipt.matrix.engines.map((engine) => `${engine.name}=${engine.status}`).join(" ");
  process.stdout.write(
    `Sealed ${receipt.sampleId} release-matrix receipt (${receipt.status}: ${engines}) to ${outputPath}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `release-matrix receipt sealing failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
