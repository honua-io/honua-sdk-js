#!/usr/bin/env node

// Impure shell for scripts/lib/sdk-build-evidence.mjs (honua-io/honua-sdk-js#1286).
//
//   fingerprint            print the exact validated input fingerprint for this
//                          checkout. The producer job names its build artifact
//                          with it; every consumer recomputes it and refuses a
//                          build that answers to a different one.
//   emit --output <path>   after `npm run build`: snapshot the source inputs and
//                          the emitted dist tree and write the evidence manifest.
//   verify --evidence <p>  in a consumer: recompute the fingerprint from this
//                          checkout and the dist digest from the downloaded
//                          tree, then admit or reject the build.
//
// `verify` deliberately recomputes both halves rather than trusting the
// manifest's own numbers. A manifest is self-consistent by construction; the
// question a consumer has to answer is whether it describes *this* checkout and
// *these* downloaded bytes.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotBuildInputs, snapshotDistTree } from "./lib/prepared-sdk-artifact.mjs";
import {
  computeBuildFingerprint,
  createSdkBuildEvidence,
  digestPackageScripts,
  serializeSdkBuildEvidence,
  sha256Hex,
  SDK_VERIFICATION_CONTRACT,
  verifySdkBuildEvidence,
} from "./lib/sdk-build-evidence.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_EVIDENCE_BYTES = 256 * 1024;

function readNpmVersion() {
  const override = process.env.HONUA_NPM_VERSION;
  if (typeof override === "string" && override.length > 0) return override;
  // Running under an npm script already tells us, without spawning anything:
  // "npm/10.8.2 node/v20.19.0 linux x64 workspaces/false".
  const userAgent = process.env.npm_config_user_agent ?? "";
  const matched = /(?:^|\s)npm\/([^\s]+)/.exec(userAgent);
  if (matched) return matched[1];
  return execFileSync("npm", ["--version"], { encoding: "utf8", timeout: 60_000 }).trim();
}

function readBuildEnvironment(projectRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  return {
    nodeVersion: process.version,
    npmVersion: readNpmVersion(),
    platform: process.platform,
    arch: process.arch,
    runnerImage: process.env.ImageOS ?? "",
    lockfileSha256: sha256Hex(fs.readFileSync(path.join(projectRoot, "package-lock.json"))),
    tsconfigSha256: sha256Hex(fs.readFileSync(path.join(projectRoot, "tsconfig.json"))),
    scriptsSha256: digestPackageScripts(packageJson.scripts ?? {}),
  };
}

function fingerprintFor(projectRoot, environment) {
  return computeBuildFingerprint({
    contract: SDK_VERIFICATION_CONTRACT,
    sourceSha256: snapshotBuildInputs(projectRoot).sha256,
    lockfileSha256: environment.lockfileSha256,
    tsconfigSha256: environment.tsconfigSha256,
    scriptsSha256: environment.scriptsSha256,
    nodeVersion: environment.nodeVersion,
    npmVersion: environment.npmVersion,
    platform: environment.platform,
    arch: environment.arch,
  });
}

function readProducer() {
  return {
    repository: process.env.GITHUB_REPOSITORY || "local",
    runId: process.env.GITHUB_RUN_ID || "local",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
    headSha: process.env.HONUA_SOURCE_REVISION || process.env.GITHUB_SHA || "local",
    workflowRef: process.env.GITHUB_WORKFLOW_REF || "local",
    eventName: process.env.GITHUB_EVENT_NAME || "local",
  };
}

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function writeGithubOutput(entries) {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) return;
  const lines = Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fs.appendFileSync(target, `${lines}\n`);
}

function commandFingerprint() {
  const environment = readBuildEnvironment(PROJECT_ROOT);
  const fingerprint = fingerprintFor(PROJECT_ROOT, environment);
  writeGithubOutput({ fingerprint, "artifact-name": `sdk-build-${fingerprint}` });
  process.stdout.write(`${fingerprint}\n`);
}

function commandEmit(argv) {
  const output = optionValue(argv, "--output") ?? ".artifacts/sdk-build/evidence.v1.json";
  const environment = readBuildEnvironment(PROJECT_ROOT);
  const inputs = snapshotBuildInputs(PROJECT_ROOT);
  const dist = snapshotDistTree(PROJECT_ROOT);
  const evidence = createSdkBuildEvidence({
    inputs,
    dist: { ...dist, byteLength: dist.entries.reduce((total, entry) => total + entry.bytes, 0) },
    environment: { ...environment, lockfileSha256: environment.lockfileSha256 },
    producer: readProducer(),
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });

  const expected = fingerprintFor(PROJECT_ROOT, environment);
  if (evidence.fingerprint !== expected) {
    throw new Error("Build inputs changed while emitting build evidence; the build is not reusable");
  }

  const serialized = serializeSdkBuildEvidence(evidence);
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_BYTES) {
    throw new Error(`SDK build evidence exceeds its ${MAX_EVIDENCE_BYTES}-byte transfer budget`);
  }
  const absolute = path.resolve(PROJECT_ROOT, output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, serialized);
  writeGithubOutput({ fingerprint: evidence.fingerprint, "artifact-name": evidence.artifactName });
  process.stdout.write(
    `sdk build evidence: fingerprint=${evidence.fingerprint} dist=${evidence.artifact.distSha256} ` +
      `files=${evidence.artifact.fileCount} expires=${evidence.expiresAt}\n`,
  );
}

function commandVerify(argv) {
  const evidencePath = optionValue(argv, "--evidence") ?? ".artifacts/sdk-build/evidence.v1.json";
  const absolute = path.resolve(PROJECT_ROOT, evidencePath);
  let raw;
  try {
    raw = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `SDK build evidence does not exist at ${evidencePath}. The reusable build was not produced or not ` +
          "downloaded; rebuild from source rather than continuing without it.",
      );
    }
    throw error;
  }
  if (raw.length > MAX_EVIDENCE_BYTES) throw new Error("SDK build evidence is implausibly large");

  const environment = readBuildEnvironment(PROJECT_ROOT);
  const evidence = verifySdkBuildEvidence({
    evidence: JSON.parse(raw),
    expectedFingerprint: fingerprintFor(PROJECT_ROOT, environment),
    observedDistSha256: snapshotDistTree(PROJECT_ROOT).sha256,
    now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    // Same fallback readProducer() stamps, so a local build verifies against a
    // local producer and a CI build against its repository. Never `undefined`:
    // the verifier requires a value rather than skipping the comparison.
    expectedRepository: readProducer().repository,
  });
  process.stdout.write(
    `sdk build evidence admitted: fingerprint=${evidence.fingerprint} produced by run ` +
      `${evidence.producer.runId} attempt ${evidence.producer.runAttempt} at ${evidence.createdAt}\n`,
  );
}

function main(argv) {
  const command = argv[0] ?? "fingerprint";
  if (command === "fingerprint") return commandFingerprint();
  if (command === "emit") return commandEmit(argv);
  if (command === "verify") return commandVerify(argv);
  throw new Error("Usage: node scripts/sdk-build-evidence.mjs [fingerprint|emit --output <path>|verify --evidence <path>]");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
