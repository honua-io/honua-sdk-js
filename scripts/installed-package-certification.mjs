#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { canonical, sha256, freezeCertification, validateInstalledLock, validateObservationEnvelope, validatePackageSet } from "./installed-certification-identity.mjs";
import { executeCandidateFixture } from "./installed-candidate-fixture.mjs";
import { verifyPublishedRelease } from "./verify-published-release.mjs";

const root = path.resolve(import.meta.dirname, "..");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};

export function buildReceipt({ candidate, denominator, observations = [], binding, generatedAt = new Date().toISOString() }) {
  if (!denominator.rows.some((row) => row.counts)) throw new Error("empty supported denominator");
  const known = new Set(denominator.rows.map((row) => row.id));
  if (known.size !== denominator.rows.length) throw new Error("duplicate denominator ID");
  const byId = new Map();
  for (const row of observations) {
    if (!known.has(row.id)) throw new Error(`unknown observation id ${row.id}`);
    if (byId.has(row.id)) throw new Error(`duplicate observation id ${row.id}`);
    byId.set(row.id, row);
  }
  const operations = denominator.rows.filter((row) => row.counts).map((row) => {
    const observed = byId.get(row.id);
    const verdict = observed?.verdict ?? "blocked";
    if (!observed?.verdict && !candidate.defaultBlocker) throw new Error(`${row.id}: missing verdict and blocked-by coordinate`);
    if (!["pass", "fail", "blocked"].includes(verdict)) throw new Error(`${row.id}: invalid verdict ${verdict}`);
    const journeyStage = row.family === "terminal-journey" ? row.id.split(":")[1] : undefined;
    const journeyBlockers = { admin: "honua-sdk-js#1424", style: "honua-sdk-js#1426", geoprocessing: "honua-sdk-js#1426",
      studio: "honua-sdk-js#1397", proposal: "honua-sdk-js#1398", console: "honua-sdk-js#1401", artifact: "honua-sdk-js#1401" };
    const blocker = verdict === "blocked" ? observed?.blockedBy ?? journeyBlockers[journeyStage] ?? candidate.defaultBlocker : undefined;
    if (verdict === "blocked" && !blocker) throw new Error(`${row.id}: blocked verdict requires blockedBy`);
    return { id: row.id, family: row.family, operation: row.operation, capabilityKey: row.capabilityKey,
      verdict, ...(blocker ? { blockedBy: blocker } : {}), ...(observed?.diagnostic ? { diagnostic: observed.diagnostic } : {}), ...(observed?.execution ? { execution: observed.execution } : {}) };
  });
  const summary = { total: operations.length, pass: operations.filter((x) => x.verdict === "pass").length,
    fail: operations.filter((x) => x.verdict === "fail").length, blocked: operations.filter((x) => x.verdict === "blocked").length };
  const receipt = { schema: "honua.sdk-installed-package-certification-receipt/v1", generatedAt,
    release: candidate.release, server: candidate.server, package: candidate.package,
    install: candidate.install, binding, nonCounting: denominator.rows.filter((row) => !row.counts).map((row) => ({ id: row.id, tier: row.tier, verdict: "not-counted" })), verdict: summary.fail || summary.blocked ? "not-certified" : "certified", summary, operations };
  return { ...receipt, receiptDigest: sha256(canonical(receipt)) };
}

export async function readInstalledCandidate() {
  return JSON.parse(await readFile(path.join(root, "config/installed-package-certification.v1.json"), "utf8"));
}

export async function withInstalledCandidate(candidate, callback, { consumerDependencies = {} } = {}) {
  const imageDigest = candidate.server?.image?.split("@").at(-1);
  if (!imageDigest || imageDigest !== candidate.server?.digest) {
    throw new Error(`server image digest mismatch: ${imageDigest ?? "missing"} vs ${candidate.server?.digest ?? "missing"}`);
  }
  const manifest = JSON.parse(await readFile(path.join(root, "config/release-artifacts.v1.json"), "utf8"));
  validatePackageSet(candidate, manifest.included.map((p) => p.npmName));
  for (const p of candidate.packages) {
    if (p.coordinate in consumerDependencies && consumerDependencies[p.coordinate] !== p.version) {
      throw new Error(`${p.coordinate}: consumer dependency cannot override candidate`);
    }
  }
  const targets = candidate.packages.map((p) => {
    const artifact = manifest.included.find((a) => a.npmName === p.coordinate);
    const tag = `${artifact.publish.releaseTagPrefix}v${p.version}`;
    return { id: artifact.id, npmName: p.coordinate, version: p.version, distTag: "latest", tag,
      commit: p.sourceRevision, expectedRef: `refs/tags/${tag}`, workflow: artifact.publish.workflow,
      sourceBinding: artifact.sourceBinding };
  });
  const provenance = await verifyPublishedRelease({ targets, sealedTag: `js-sdk-v${candidate.package.version}`,
    sealedCommit: candidate.packages.find((p) => p.coordinate === candidate.package.coordinate).sourceRevision,
    registry: candidate.package.registry, repository: manifest.repository });
  if (provenance.status !== "verified") throw new Error(`package provenance failed: ${provenance.failures.join("; ")}`);
  const work = await mkdtemp(path.join(tmpdir(), "honua-sdk-installed-cert-"));
  try {
    await writeFile(path.join(work, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
      ...consumerDependencies, ...Object.fromEntries(candidate.packages.map((p) => [p.coordinate, p.version])),
    } }, null, 2));
    run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${candidate.package.registry}`], { cwd: work });
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${candidate.package.registry}`], { cwd: work });
    const lock = JSON.parse(await readFile(path.join(work, "package-lock.json"), "utf8"));
    const installed = lock.packages[`node_modules/${candidate.package.coordinate}`];
    const resolution = Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key).map(([key, value]) =>
      [key, { version: value.version, resolved: value.resolved, integrity: value.integrity, peer: value.peer ?? false }]));
    const install = { mode: "clean-npm-ci", localLinks: false, provenance, resolution,
      lockDigest: sha256(canonical(lock)), runtime: { node: process.version, npm: run("npm", ["--version"]),
        platform: process.platform, arch: process.arch } };
    try {
      install.packages = validateInstalledLock(candidate, lock);
    } catch (error) {
      error.install = install;
      throw error;
    }
    const repoDigests = JSON.parse(run("docker", ["image", "inspect", candidate.server.image, "--format", "{{json .RepoDigests}}"]));
    if (!repoDigests.includes(candidate.server.image)) throw new Error(`local image does not contain pinned digest ${candidate.server.image}`);
    return await callback({ installed, install, packageRoot: path.join(work, "node_modules", candidate.package.coordinate), work });
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function certify({ output, observationsPath, executeFixture = false, admit = withInstalledCandidate, freeze = freezeCertification } = {}) {
  const candidate = await readInstalledCandidate();
  const denominator = JSON.parse(await readFile(path.join(root, "config/certification-denominator.v1.json"), "utf8"));
  // The committed receipt is a prior candidate's evidence; drop it first so an aborted or
  // rejected run cannot publish it as this candidate's result.
  await rm(path.resolve(output), { force: true });
  let binding;
  try {
    binding = await freeze(candidate, denominator, root);
    return await admit(candidate, async ({ install, work }) => {
    if (executeFixture && observationsPath) throw new Error("choose fixture execution or an observation envelope");
    const execution = executeFixture ? await executeCandidateFixture({ candidate, work, root }) : undefined;
    const observations = execution ? validateObservationEnvelope({ schema: "honua.sdk-installed-observations/v1", binding, observations: execution.observations }, binding, denominator) : observationsPath ? validateObservationEnvelope(JSON.parse(await readFile(observationsPath, "utf8")), binding, denominator) : [];
    const receipt = buildReceipt({ candidate: { ...candidate, install: { ...install, serverRuntime: execution?.serverRuntime } }, denominator, observations, binding });
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
    });
  } catch (error) {
    const receipt = buildReceipt({ candidate: { ...candidate, defaultBlocker: "honua-sdk-js#39",
      install: { ...error.install, status: "failed", diagnostic: String(error?.message ?? error).slice(0, 2_000) } }, denominator, binding });
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf("--output");
  const observationsIndex = process.argv.indexOf("--observations");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "test-results/installed-package-certification.json";
  const receipt = await certify({ output, executeFixture: process.argv.includes("--execute-fixture"), observationsPath: observationsIndex >= 0 ? process.argv[observationsIndex + 1] : undefined });
  console.log(`${receipt.verdict}: ${receipt.summary.pass} pass, ${receipt.summary.fail} fail, ${receipt.summary.blocked} blocked; ${output}`);
  process.exitCode = receipt.verdict === "certified" ? 0 : 1;
}
