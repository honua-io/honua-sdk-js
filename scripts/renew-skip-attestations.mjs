#!/usr/bin/env node

/**
 * Re-observe skip-attested sample live lanes before their observation lapses
 * (honua-io/honua-sdk-js#972).
 *
 * A skip attestation is a dated observation with a 90-day ceiling. Nothing
 * renewed those observations, so every ~90 days one lapsed, validateCatalog's
 * wall-clock check failed the entire catalog, and "Verify sample publication
 * contract" went red on every open PR -- including the regeneration workflow's
 * own reseal passes, which is what made the outage self-sustaining (#810, #971).
 * The heal was always manual and always the same four steps:
 *
 *   1. run the lane's producer with no live configuration (it is `unavailable`
 *      by declaration, so this is the mode the committed attestation describes)
 *   2. copy the producer's run-scoped output onto the lane's committed
 *      evidencePath, fixing the `$schema` relative depth
 *   3. `samples:refresh-live-expiry` to reproject the catalog expiry literal
 *   4. `samples:migrate:v1` to project the overlay into samples/catalog.v2.json
 *
 * This command owns steps 1 and 2 and runs them on a schedule; the regeneration
 * workflow already owns 3 and 4 immediately after. Its authority is narrow by
 * construction: it can only re-date an attestation whose lane is still declared
 * `unavailable`/`skipped`, and only if the freshly produced envelope makes the
 * same claim (same sample, lane, status, degradation state, and journey) as the
 * one already committed. Anything else is a change of claim and fails loudly
 * for a human instead of being committed by a scheduled job.
 *
 * The producer runs with a rebuilt, allowlisted environment rather than an
 * inherited-and-scrubbed one. A denylist would have to enumerate every
 * lane-specific configuration variable and stay correct as lanes are added; an
 * allowlist makes it structurally impossible for live configuration to leak in
 * and turn a renewal into an unreviewed live probe.
 *
 * Usage:
 *   node scripts/renew-skip-attestations.mjs [--dry-run] [--now <rfc3339>]
 *        [--renew-within-days N] [--alert-within-days N]
 *        [--migration <path>] [--catalog-v1 <path>] [--json] [--fail-on-alert]
 */

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertRenewedAttestation,
  canonicalAttestation,
  formatRenewalPlan,
  MIGRATION_PATH,
  planSkipAttestationRenewal,
  renewalAlertMessage,
  serializeAttestation,
  SKIP_ATTESTATION_RENEWAL_POLICY,
  V1_CATALOG_PATH,
} from "./lib/skip-attestation-renewal.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const PRODUCER_TIMEOUT_MS = 120_000;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    json: false,
    failOnAlert: false,
    now: undefined,
    migrationPath: MIGRATION_PATH,
    catalogV1Path: V1_CATALOG_PATH,
    policy: { ...SKIP_ATTESTATION_RENEWAL_POLICY },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--fail-on-alert") options.failOnAlert = true;
    else if (arg === "--now") options.now = argv[++index];
    else if (arg === "--migration") options.migrationPath = argv[++index];
    else if (arg === "--catalog-v1") options.catalogV1Path = argv[++index];
    else if (arg === "--renew-within-days") options.policy.renewWithinDays = Number(argv[++index]);
    else if (arg === "--alert-within-days") options.policy.alertWithinDays = Number(argv[++index]);
    else fail(`Unknown argument: ${arg}`);
  }
  // Renewal writes committed evidence, so it may only ever be planned from the
  // repository's real contract inputs. The fixture overrides exist so the
  // renewal decision can be exercised (and time-travelled) in tests without
  // touching real attestations, and a fixture must never be able to steer what
  // a scheduled job commits.
  if (!options.dryRun && (options.migrationPath !== MIGRATION_PATH || options.catalogV1Path !== V1_CATALOG_PATH)) {
    fail("--migration and --catalog-v1 override the reviewed contract inputs and are only honoured with --dry-run");
  }
  return options;
}

const readJson = async (relativePath) => JSON.parse(await readFile(path.join(PROJECT_ROOT, relativePath), "utf8"));

/**
 * Resolve the lane's reviewed producer command to the generator this process
 * should execute. Only the generator runs -- not the npm script -- because the
 * wrapper's build steps exist solely for the *executed* branch these lanes never
 * take, so a renewal needs no dist/ and no build lock.
 */
async function resolveProducer(command) {
  const { reviewedLiveProducer } = await import("./sample-contract.mjs");
  const producer = reviewedLiveProducer(command);
  if (!producer) fail(`${command} is not in the reviewed live-producer registry`);
  return producer;
}

/**
 * Build the producer environment from scratch. Only the variables a producer
 * needs to write its output where we asked, plus the minimum a Node process
 * needs to start and to resolve `git`, survive. Nothing that could enable a
 * live probe or supply a lane endpoint is reachable from here.
 */
function producerEnvironment({ sampleId, outputPath }) {
  const allowed = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "NODE_PATH"];
  const inherited = Object.fromEntries(
    allowed.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
  );
  return {
    ...inherited,
    HONUA_SAMPLE_LIVE_OUTPUT: outputPath,
    HONUA_SAMPLE_LIVE_SAMPLE_ID: sampleId,
  };
}

async function runProducer(lane, producer) {
  const scratch = await mkdtemp(path.join(tmpdir(), "honua-skip-attestation-"));
  const outputPath = path.join(scratch, `${lane.sampleId}.json`);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [producer.generatorPath], {
      cwd: PROJECT_ROOT,
      env: producerEnvironment({ sampleId: lane.sampleId, outputPath }),
      timeout: PRODUCER_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    let produced;
    try {
      produced = JSON.parse(await readFile(outputPath, "utf8"));
    } catch {
      fail(
        `${lane.sampleId}: ${producer.generatorPath} wrote no attestation to its requested output path.\n` +
          `stdout: ${stdout}\nstderr: ${stderr}`,
      );
    }
    return produced;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function renewLane(lane) {
  const producer = await resolveProducer(lane.command);
  const previous = await readJson(lane.evidencePath);
  const produced = await runProducer(lane, producer);
  // Validate as an evidence envelope before anything else looks at it: a
  // renewal must clear the very gate whose failure it exists to prevent.
  const { validateEvidenceEnvelope } = await import("./sample-contract.mjs");
  validateEvidenceEnvelope(produced);
  assertRenewedAttestation(produced, { lane, previous });
  const canonical = canonicalAttestation(produced, lane.evidencePath);
  const destination = path.join(PROJECT_ROOT, lane.evidencePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, serializeAttestation(canonical), "utf8");
  return { previous, renewed: canonical, generatorPath: producer.generatorPath };
}

function emitGitHubOutput(entries) {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) return;
  appendFileSync(target, `${Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, "utf8");
}

function emitJobSummary(lines) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target || lines.length === 0) return;
  appendFileSync(target, `${lines.join("\n")}\n`, "utf8");
}

async function main(argv) {
  const options = parseArgs(argv);
  const migration = await readJson(options.migrationPath);
  const catalogV1 = await readJson(options.catalogV1Path);
  const plan = await planSkipAttestationRenewal({
    migration,
    catalogV1,
    now: options.now,
    policy: options.policy,
    projectRoot: PROJECT_ROOT,
  });

  const due = plan.lanes.filter((lane) => lane.action === "renew");
  const renewals = [];
  if (!options.dryRun) {
    for (const lane of due) {
      const result = await renewLane(lane);
      renewals.push({
        sampleId: lane.sampleId,
        evidencePath: lane.evidencePath,
        generatorPath: result.generatorPath,
        previousObservedAt: result.previous.observedAt,
        observedAt: result.renewed.observedAt,
        previousReason: result.previous.reason ?? null,
        reason: result.renewed.reason ?? null,
      });
    }
  }

  const renewedIds = new Set(renewals.map((entry) => entry.sampleId));
  // A lane that was renewed in this run is, by construction, a full policy
  // window away from its horizon, so it can no longer be alerting. Anything
  // still inside the alert window here is a lane renewal did not fix -- which
  // is precisely the condition the early warning exists to surface.
  const alerting = plan.lanes.filter((lane) => lane.alert && !renewedIds.has(lane.sampleId));

  const report = formatRenewalPlan(plan, { renewed: [...renewedIds] });
  const summaryLines = [];
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...plan, dryRun: options.dryRun, renewals }, null, 2)}\n`);
  } else {
    process.stdout.write(`${report}\n`);
    for (const renewal of renewals) {
      process.stdout.write(
        `  re-observed ${renewal.sampleId}: ${renewal.previousObservedAt} -> ${renewal.observedAt} ` +
          `via ${renewal.generatorPath} -> ${renewal.evidencePath}\n`,
      );
      if (renewal.previousReason !== renewal.reason) {
        process.stdout.write(
          `    reason changed: ${JSON.stringify(renewal.previousReason)} -> ${JSON.stringify(renewal.reason)}\n`,
        );
      }
    }
    if (options.dryRun && due.length > 0) {
      process.stdout.write(`  dry run: would re-observe ${due.map((lane) => lane.sampleId).join(", ")}\n`);
    }
  }

  if (alerting.length > 0) {
    summaryLines.push("### Skip-attestation expiry alert (honua-io/honua-sdk-js#972)", "");
  }
  for (const lane of alerting) {
    const message = renewalAlertMessage(lane, plan.policy);
    summaryLines.push(`- ${message}`);
    // A GitHub annotation, not a job failure: failing here would stop the
    // regeneration workflow -- the very thing that renews these lanes -- for the
    // whole alert window. `--fail-on-alert` is available for lanes that want the
    // stricter behaviour.
    process.stderr.write(process.env.GITHUB_ACTIONS === "true" ? `::warning::${message}\n` : `WARNING: ${message}\n`);
  }
  emitJobSummary(summaryLines);
  emitGitHubOutput({
    renewal_due: due.length > 0 ? "true" : "false",
    renewed: renewals.map((entry) => entry.sampleId).join(","),
    alert: alerting.length > 0 ? "true" : "false",
    alerted: alerting.map((lane) => lane.sampleId).join(","),
  });

  if (options.failOnAlert && alerting.length > 0) {
    fail(`${alerting.length} skip attestation(s) are inside the alert window and were not renewed`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`skip-attestation renewal failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
