#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generatedOutputs,
  migrateCatalogV1ToV2,
  validateCatalog,
  validateEvidenceEnvelope,
} from "./sample-contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleId = "maplibre-quickstart";
const evidencePath = "examples/maplibre-quickstart/evidence/live.v1.json";
const migrationPath = "samples/contract/v2/migrations/catalog.v1-to-v2.json";

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function firstMapQualificationExpiry(observedAt, maxDays) {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || !Number.isInteger(maxDays) || maxDays <= 0 || maxDays > 366) {
    throw new Error("First Map qualification expiry inputs are invalid");
  }
  return new Date(observed + maxDays * 24 * 60 * 60 * 1000).toISOString();
}

export function replaceFirstMapQualificationExpiry(document, expiresAt) {
  const marker = `"${sampleId}": {`;
  const start = document.indexOf(marker);
  if (start < 0 || document.indexOf(marker, start + marker.length) >= 0) {
    throw new Error("First Map migration override is missing or duplicated");
  }
  const bodyStart = start + marker.length;
  const nextOverrideOffset = document.slice(bodyStart).search(/\n    "[a-z0-9]/);
  const end = nextOverrideOffset < 0 ? document.length : bodyStart + nextOverrideOffset;
  const block = document.slice(start, end);
  const expiryMatches = block.match(/"expiresAt": "[^"]+"/g) ?? [];
  if (expiryMatches.length !== 1) throw new Error("First Map migration expiry is missing or duplicated");
  const updated = block.replace(expiryMatches[0], `"expiresAt": "${expiresAt}"`);
  return `${document.slice(0, start)}${updated}${document.slice(end)}`;
}

async function verifyEvidenceArtifacts(evidence) {
  const canonicalRoot = await realpath(projectRoot);
  for (const artifact of evidence.artifacts) {
    const candidate = path.resolve(projectRoot, artifact.path);
    const metadata = await lstat(candidate);
    const canonical = await realpath(candidate);
    if (
      !canonical.startsWith(`${canonicalRoot}${path.sep}`) ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024 * 1024
    ) {
      throw new Error(`First Map live evidence artifact is unsafe: ${artifact.path}`);
    }
    const digest = createHash("sha256").update(await readFile(candidate)).digest("hex");
    if (digest !== artifact.sha256) {
      throw new Error(`First Map live evidence artifact digest drift: ${artifact.path}`);
    }
  }
}

export async function refreshFirstMapQualification() {
  const evidence = validateEvidenceEnvelope(await readJson(evidencePath));
  if (evidence.sampleId !== sampleId || evidence.lane !== "live" || evidence.status !== "executed") {
    throw new Error("First Map canonical live evidence is not an executed live observation");
  }
  await verifyEvidenceArtifacts(evidence);

  const [sourceCatalog, migrationDocument, packageJson] = await Promise.all([
    readJson("samples/catalog.v1.json"),
    readFile(path.join(projectRoot, migrationPath), "utf8"),
    readJson("package.json"),
  ]);
  const migration = JSON.parse(migrationDocument);
  const maxDays = migration.configuration?.evidenceExpiry?.executedMaxDays;
  migration.sampleOverrides[sampleId].live.expiresAt = firstMapQualificationExpiry(evidence.observedAt, maxDays);
  const catalog = await migrateCatalogV1ToV2(sourceCatalog, migration);
  await validateCatalog(catalog, packageJson, {
    now: evidence.observedAt,
    qualificationBootstrapSampleId: sampleId,
    verifyCheckout: false,
  });
  const outputs = await generatedOutputs(catalog, packageJson);
  const writes = new Map([
    [
      migrationPath,
      replaceFirstMapQualificationExpiry(migrationDocument, migration.sampleOverrides[sampleId].live.expiresAt),
    ],
    ["samples/catalog.v2.json", stableJson(catalog)],
    ...outputs,
  ]);
  for (const [relativePath, contents] of writes) {
    const target = path.join(projectRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  process.stdout.write(
    `Refreshed First Map canonical live qualification through ${migration.sampleOverrides[sampleId].live.expiresAt}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  refreshFirstMapQualification().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
