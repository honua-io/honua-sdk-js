#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item) ?? "null").join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};

export function buildReceipt({ candidate, denominator, observations = [], generatedAt = new Date().toISOString() }) {
  const byId = new Map();
  for (const row of observations) {
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
      verdict, ...(blocker ? { blockedBy: blocker } : {}), ...(observed?.diagnostic ? { diagnostic: observed.diagnostic } : {}) };
  });
  const summary = { total: operations.length, pass: operations.filter((x) => x.verdict === "pass").length,
    fail: operations.filter((x) => x.verdict === "fail").length, blocked: operations.filter((x) => x.verdict === "blocked").length };
  const receipt = { schema: "honua.sdk-installed-package-certification-receipt/v1", generatedAt,
    release: candidate.release, server: candidate.server, package: candidate.package,
    install: candidate.install, verdict: summary.fail || summary.blocked ? "not-certified" : "certified", summary, operations };
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
  const work = await mkdtemp(path.join(tmpdir(), "honua-sdk-installed-cert-"));
  try {
    await writeFile(path.join(work, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
      [candidate.package.coordinate]: candidate.package.version, ...consumerDependencies,
    } }, null, 2));
    run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${candidate.package.registry}`], { cwd: work });
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${candidate.package.registry}`], { cwd: work });
    const lock = JSON.parse(await readFile(path.join(work, "package-lock.json"), "utf8"));
    const installed = lock.packages[`node_modules/${candidate.package.coordinate}`];
    if (installed?.version !== candidate.package.version || installed?.integrity !== candidate.package.integrity) {
      throw new Error(`registry package identity mismatch: ${installed?.version ?? "missing"} ${installed?.integrity ?? "missing"}`);
    }
    const repoDigests = JSON.parse(run("docker", ["image", "inspect", candidate.server.image, "--format", "{{json .RepoDigests}}"]));
    if (!repoDigests.includes(candidate.server.image)) throw new Error(`local image does not contain pinned digest ${candidate.server.image}`);
    return await callback({ installed, packageRoot: path.join(work, "node_modules", candidate.package.coordinate), work });
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function certify({ output, observationsPath } = {}) {
  const candidate = await readInstalledCandidate();
  const denominator = JSON.parse(await readFile(path.join(root, "config/certification-denominator.v1.json"), "utf8"));
  return withInstalledCandidate(candidate, async ({ installed }) => {
    const observations = observationsPath ? JSON.parse(await readFile(observationsPath, "utf8")) : [];
    const receipt = buildReceipt({ candidate: { ...candidate, install: { mode: "clean-npm-ci", localLinks: false,
      resolved: installed.resolved, integrity: installed.integrity }, defaultBlocker: candidate.defaultBlocker }, denominator, observations });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf("--output");
  const observationsIndex = process.argv.indexOf("--observations");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "test-results/installed-package-certification.json";
  const receipt = await certify({ output, observationsPath: observationsIndex >= 0 ? process.argv[observationsIndex + 1] : undefined });
  console.log(`${receipt.verdict}: ${receipt.summary.pass} pass, ${receipt.summary.fail} fail, ${receipt.summary.blocked} blocked; ${output}`);
  process.exitCode = receipt.verdict === "certified" ? 0 : 1;
}
