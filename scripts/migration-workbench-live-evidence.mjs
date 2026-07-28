#!/usr/bin/env node

// Live-evidence producer for the ArcGIS Migration Workbench golden journey
// (honua-io/honua-sdk-js#549). Unlike maplibre-quickstart's live lane, this
// sample's own requirements forbid any non-loopback network request (REQ-007)
// and treat arcgis-source-app strictly as an internal fixture (REQ-004), so
// there is no public endpoint this producer can call. Its "live" proof is
// instead that the real honua-migrate CLI -- the same
// scripts/lib/migration-workbench-artifacts.mjs supply chain the browser
// workbench renders -- reproduces the committed artifacts byte-for-byte when
// run right now, from the current source, with no shortcuts: mode
// "demo-live" per samples/contract/v2/schemas/sample-catalog.schema.json's
// evidenceLane, distinguishing this from the "fixture" lane (the browser
// mock server just serving those pre-built artifacts).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { materializeMigrationWorkbenchArtifacts } from "./lib/migration-workbench-artifacts.mjs";
import { validateEvidenceEnvelope } from "./sample-contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const producerRepositoryPath = "scripts/migration-workbench-live-evidence.mjs";
const sampleId = "migration-workbench";
const operation = "migration-workbench-deterministic-cli-replay";
const reportRepositoryPath = "examples/migration-workbench/public/artifacts/v1/migration-report.v1.json";

function outputPath(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new Error("usage: migration-workbench-live-evidence.mjs --output <repository-relative-path>");
  }
  const configured = process.env.HONUA_SAMPLE_LIVE_OUTPUT ?? argv[1];
  const absolute = path.resolve(projectRoot, configured);
  if (!absolute.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("live evidence output must stay in the repository");
  }
  return absolute;
}

function sourceRevision() {
  const injected = process.env.HONUA_SAMPLE_SOURCE_REVISION;
  if (/^[a-f0-9]{40}$/.test(injected ?? "")) return injected;
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

function assertEnabled() {
  if (process.env.HONUA_SAMPLE_LIVE_ENABLED !== "true") {
    throw new Error("Migration workbench live evidence is scheduled-only; set HONUA_SAMPLE_LIVE_ENABLED=true explicitly.");
  }
  const requestedSample = process.env.HONUA_SAMPLE_LIVE_SAMPLE_ID;
  if (requestedSample && requestedSample !== sampleId) {
    throw new Error(`Migration workbench live evidence cannot satisfy ${requestedSample}`);
  }
}

async function writeEnvelope(target, values) {
  const producerBytes = await readFile(path.join(projectRoot, producerRepositoryPath));
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const evidence = validateEvidenceEnvelope({
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId,
    lane: "live",
    status: values.status,
    reason: values.reason,
    observedAt: values.observedAt,
    authMode: "none",
    sdk: { package: packageJson.name, version: packageJson.version, gitCommit: sourceRevision() },
    source: {
      provider: "honua-migrate-cli",
      identity: "arcgis-source-app:v1",
      endpoint: null,
      deploymentVersion: null,
      dataVersion: null,
    },
    provenance: {
      sourceId: "arcgis-source-app:v1",
      observedAt: values.observedAt,
      validAt: null,
      state: "live",
      attribution: "Honua-authored arcgis-source-app repository fixture; no third-party sample source is reproduced.",
    },
    semantics: values.semantics,
    timing: values.timing,
    degradation: { state: "none", reasons: [] },
    artifacts: [
      {
        kind: "producer-generator",
        path: producerRepositoryPath,
        sha256: createHash("sha256").update(producerBytes).digest("hex"),
      },
    ],
  });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function main() {
  assertEnabled();
  const target = outputPath(process.argv.slice(2));
  const observedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const result = await materializeMigrationWorkbenchArtifacts({ mode: "check" });
    const totalMs = Date.now() - startedAt;
    const report = JSON.parse(await readFile(path.join(projectRoot, reportRepositoryPath), "utf8"));
    const migration = report.demo.migration;
    const metrics = migration.codemodResult.metrics;
    const patchProof = report.patchProof;
    const behaviorProof = report.behaviorProof;
    if (
      report.demo.passed !== true ||
      behaviorProof.passed !== true ||
      patchProof.applyCheckPassed !== true ||
      patchProof.targetTreeEqual !== true ||
      patchProof.directEntryComparisonPassed !== true
    ) {
      throw new Error("migration workbench demo, behavior, or patch proof did not pass");
    }
    await writeEnvelope(target, {
      status: "executed",
      reason: null,
      observedAt,
      semantics: {
        operation,
        outcome: `codemod:auto=${metrics.autoMigratedCallSites},manual=${metrics.manualCallSites},total=${metrics.totalCodemodScopedCallSites}`,
        itemCount: metrics.totalCodemodScopedCallSites,
        assertions: [
          `readiness=${JSON.stringify(migration.readiness)}`,
          `autoMigratedCallSites=${metrics.autoMigratedCallSites}`,
          `manualCallSites=${metrics.manualCallSites}`,
          `totalCodemodScopedCallSites=${metrics.totalCodemodScopedCallSites}`,
          `manualInterventionRatio=${migration.manualInterventionMetric.ratio}`,
          `behaviorProofPassed=${behaviorProof.passed}`,
          `behaviorAssertionCount=${behaviorProof.assertions.length}`,
          `patchApplyCheckPassed=${patchProof.applyCheckPassed}`,
          `patchTargetTreeEqual=${patchProof.targetTreeEqual}`,
          `artifactCount=${result.artifactCount}`,
          "sourceUpload=false",
          "credentialsRequired=false",
        ],
      },
      timing: { totalMs, firstSuccessfulInteractionMs: totalMs },
    });
    process.stdout.write(
      `migrationWorkbenchLiveEvidence=ok readiness=${migration.readiness} auto=${metrics.autoMigratedCallSites} manual=${metrics.manualCallSites}\n`,
    );
  } catch (error) {
    await writeEnvelope(target, {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      observedAt,
      semantics: { operation, outcome: null, itemCount: null, assertions: [] },
      timing: { totalMs: null, firstSuccessfulInteractionMs: null },
    });
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
