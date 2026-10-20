#!/usr/bin/env node

/**
 * Run the documented `npx` commands for real, from registry bytes, in a consumer
 * that has never seen this repository.
 *
 * `scripts/docs-executable-commands.mjs` proves resolution against manifests on
 * disk, which is what makes it a per-pull-request gate -- but a manifest on disk
 * is this tree's answer, not the registry's. #1596 was exactly that gap: the
 * `bin` map was correct in the repository and the documented command still could
 * not run for a reader. So this lane installs the pinned 2026.1 candidate from
 * the registry under default dependency resolution -- no `--legacy-peer-deps`,
 * no `--force`, no workspace link -- and runs each documented invocation there.
 *
 * The verdict is about *resolution*, and only resolution: npm decides which
 * executable to run before that executable sees a single argument, so proving
 * resolution does not require running a documented command's arguments -- which
 * would be neither possible nor meaningful, since they name servers that are not
 * up and carry `<placeholder>` words a shell would read as redirections.
 *
 * So each documented invocation is executed as a *probe*: the same npx flags,
 * package spec and command word the page documents, with the arguments replaced
 * by `--help`. The probe passes only on positive evidence -- exit code 0, and
 * the resolved executable naming itself in its own output. Scoring "no npm error
 * appeared" as a pass would have been unsound, and was: a probe the shell itself
 * rejected before npm ever ran produces no npm error at all.
 *
 * Network lane: never in pull-request CI. Exit codes: 0 every documented
 * invocation resolved, 1 at least one did not.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkDocumentedCommands, parseNpxInvocation } from "./docs-executable-commands.mjs";
import { runNpmSync, runNpxSync } from "./lib/npm-cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_PATH = "config/installed-package-certification.v1.json";

// npm reports these before it spawns anything, so seeing one means no executable
// ran. Everything else came out of an executable that npm did resolve and start.
const RESOLUTION_FAILURES = [
  { pattern: /could not determine executable to run/i, reason: "npm could not choose a bin from the package" },
  { pattern: /404 Not Found - GET/i, reason: "the registry has no package by that name" },
  { pattern: /npm error code E404/i, reason: "the registry has no package by that name" },
  { pattern: /could not resolve dependency|ERESOLVE/i, reason: "default dependency resolution refused the install" },
];

function readCandidate(projectRoot) {
  const candidate = JSON.parse(fs.readFileSync(path.join(projectRoot, CANDIDATE_PATH), "utf8"));
  const names = new Set(candidate.packages.map((entry) => entry.coordinate));
  return { ...candidate, names };
}

/**
 * The documented invocations this lane can execute: the ones the offline gate
 * resolved to a bin of a package in the candidate set. A command naming some
 * other package is somebody else's release to certify.
 */
export function candidateInvocations(report, candidate) {
  const seen = new Set();
  return report.results.filter((result) => {
    if (!result.package || !candidate.names.has(result.package)) return false;
    if (seen.has(result.command)) return false;
    seen.add(result.command);
    return true;
  });
}

/**
 * Pin every candidate package named in the command to the candidate version, so
 * the lane certifies the release under test rather than whatever `latest` points
 * at on the day it runs. Nothing else about the command is touched.
 */
export function pinnedCommand(tokens, candidate) {
  const versions = new Map(candidate.packages.map((entry) => [entry.coordinate, entry.version]));
  return tokens.map((token) => (versions.has(token) ? `${token}@${versions.get(token)}` : token));
}

/**
 * The probe for one documented invocation: the npx flags, package spec and
 * command word exactly as documented, with the arguments replaced by `--help`.
 * Everything that decides which executable runs is preserved; everything that
 * only decides what it then does is dropped.
 */
export function probeFor(tokens, candidate) {
  const { packages, positional } = parseNpxInvocation(tokens);
  // `--yes` only answers the install prompt a non-interactive run cannot; every
  // other flag a page might carry (`--registry`, `--loglevel`) changes how npm
  // fetches, never which bin it picks, so the probe states the resolution inputs
  // rather than replaying the page's fetch options.
  const pinned = (spec) => pinnedCommand([spec], candidate)[0];
  const resolution = packages.length > 0 ? [...packages.flatMap((spec) => ["--package", pinned(spec)]), positional[0]] : [pinned(positional[0])];
  const args = ["--yes", ...resolution, "--help"];
  return { args, argumentsElided: positional.length > 1, probe: ["npx", ...args].join(" ") };
}

/**
 * Positive evidence that npm resolved the intended executable and ran it: a
 * clean exit, and the executable naming itself in its own output. The known npm
 * resolution failures are matched first so the diagnostic says which one it was
 * rather than only that the probe produced nothing.
 */
export function classifyProbe({ error, exitCode, stderr, stdout }, executable) {
  const output = `${stdout ?? ""}${stderr ?? ""}`;
  const failure = RESOLUTION_FAILURES.find((entry) => entry.pattern.test(output));
  if (failure) return { reason: failure.reason, resolved: false };
  if (error) return { reason: `the probe did not run: ${error.message}`, resolved: false };
  if (exitCode !== 0) return { reason: `the probe exited ${exitCode} without resolving ${executable}`, resolved: false };
  if (!stdout?.includes(executable)) return { reason: `the probe exited 0 but nothing identified ${executable} in its output`, resolved: false };
  return { resolved: true };
}

/**
 * Run one probe. `runNpxSync` is the repository's shell-free npx launcher and
 * refuses `shell: true` outright, which is the right primitive here as well as
 * the required one: handing a documented line to a shell is how an earlier draft
 * of this lane came to record cmd.exe reading `<command>` as a redirection.
 */
function runProbe(args, { cwd, env, timeoutMs }) {
  const result = runNpxSync(args, { cwd, encoding: "utf8", env, timeout: timeoutMs });
  return { error: result.error, exitCode: result.status, stderr: (result.stderr ?? "").trim(), stdout: (result.stdout ?? "").trim() };
}

/** A consumer with its own npm cache, so a warm cache on the host cannot stand in for the registry. */
function isolatedConsumer() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "honua-docs-commands-registry-"));
  fs.mkdirSync(path.join(work, "cache"));
  fs.mkdirSync(path.join(work, "consumer"));
  fs.writeFileSync(path.join(work, "consumer", "package.json"), JSON.stringify({ name: "honua-documented-command-consumer", private: true, version: "0.0.0" }, null, 2));
  return work;
}

/**
 * Install the candidate into the consumer under default resolution and read the
 * identity npm recorded: version, resolved tarball and integrity. This is the
 * package identity #39's installed-package receipt binds to, recorded here from
 * the same pin so the two receipts describe one artifact.
 */
function installedIdentity(cwd, env, candidate) {
  const spec = `${candidate.package.coordinate}@${candidate.package.version}`;
  const install = runNpmSync(["install", spec, "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${candidate.package.registry}`], { cwd, encoding: "utf8", env });
  if (install.status !== 0) throw new Error(`installing ${spec} failed: ${(install.stderr || install.stdout || "").trim().slice(0, 600)}`);
  const lock = JSON.parse(fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8"));
  const packages = {};
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!key.startsWith("node_modules/")) continue;
    const name = key.slice("node_modules/".length);
    if (candidate.names.has(name)) packages[name] = { integrity: value.integrity, resolved: value.resolved, version: value.version };
  }
  const installed = packages[candidate.package.coordinate];
  if (!installed) throw new Error(`${spec} is absent from the consumer lockfile`);
  if (installed.version !== candidate.package.version) throw new Error(`consumer resolved ${installed.version}, not the pinned ${candidate.package.version}`);
  if (installed.integrity !== candidate.package.integrity) {
    throw new Error(`registry integrity ${installed.integrity} does not match the pinned candidate ${candidate.package.integrity}`);
  }
  return { mode: "default-resolution", packages, registry: candidate.package.registry };
}

export function runDocumentedCommands({ projectRoot = ROOT, timeoutMs = 300_000 } = {}) {
  const candidate = readCandidate(projectRoot);
  const report = checkDocumentedCommands(projectRoot);
  const invocations = candidateInvocations(report, candidate);
  if (invocations.length === 0) throw new Error("no documented command names a candidate package; nothing would be proven");

  const work = isolatedConsumer();
  const cwd = path.join(work, "consumer");
  // An isolated cache and prefix keep a warm host cache and a global install out
  // of the result without editing the command a reader would type.
  const env = { ...process.env, npm_config_cache: path.join(work, "cache"), npm_config_prefix: path.join(work, "prefix"), npm_config_update_notifier: "false" };
  try {
    const install = installedIdentity(cwd, env, candidate);
    const observations = invocations.map((invocation) => {
      const { args, argumentsElided, probe } = probeFor(invocation.tokens, candidate);
      const result = runProbe(args, { cwd, env, timeoutMs });
      const classification = classifyProbe(result, invocation.executable);
      return {
        argumentsElided,
        documented: invocation.command,
        executable: invocation.executable,
        exitCode: result.exitCode,
        location: invocation.location,
        package: invocation.package,
        probe,
        reason: classification.reason,
        resolved: classification.resolved,
        stderr: result.stderr.slice(0, 600),
        stdout: result.stdout.slice(0, 600),
        verdict: classification.resolved ? "pass" : "fail",
      };
    });

    // A lane that reports every command as resolved is worthless if it cannot
    // still recognise an unresolvable one. The form #1596 reported is run as a
    // control and is expected to fail; if npm ever resolves it, this lane's
    // verdicts stop meaning anything and the run says so rather than passing.
    const controlArgs = ["--yes", `${candidate.package.coordinate}@${candidate.package.version}`, "honua", "--help"];
    const controlRun = runProbe(controlArgs, { cwd, env, timeoutMs });
    const controlClassification = classifyProbe(controlRun, "honua");
    const control = {
      discriminates: !controlClassification.resolved,
      executed: ["npx", ...controlArgs].join(" "),
      expectation: "npm cannot choose between the two bins this package publishes",
      issue: "honua-sdk-js#1596",
      reason: controlClassification.reason,
      resolved: controlClassification.resolved,
      stderr: controlRun.stderr.slice(0, 600),
    };

    const failed = observations.filter((entry) => entry.verdict === "fail").length;
    const summary = { fail: failed, pass: observations.length - failed, total: observations.length };
    return {
      candidate: { package: candidate.package, release: candidate.release, source: CANDIDATE_PATH },
      control,
      generatedAt: new Date().toISOString(),
      install,
      observations,
      runtime: { arch: process.arch, node: process.version, npm: (runNpmSync(["--version"], { encoding: "utf8", env }).stdout ?? "").trim(), platform: process.platform },
      schema: "honua.sdk-documented-command-execution/v1",
      summary,
      verdict: summary.fail === 0 && control.discriminates ? "certified" : "not-certified",
    };
  } finally {
    fs.rmSync(work, { force: true, recursive: true });
  }
}

function main() {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "test-results/documented-command-execution.json";
  const receipt = runDocumentedCommands();
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(receipt, null, 2)}\n`);
  for (const observation of receipt.observations) {
    process.stdout.write(`${observation.verdict === "pass" ? "resolved" : "FAILED  "} ${observation.location}: ${observation.documented}${observation.reason ? `\n         ${observation.reason}` : ""}\n`);
  }
  process.stdout.write(`control  ${receipt.control.discriminates ? "still unresolvable" : "RESOLVED -- this lane can no longer tell pass from fail"}: ${receipt.control.executed}\n`);
  process.stdout.write(`${receipt.verdict}: ${receipt.summary.pass}/${receipt.summary.total} documented commands resolved from ${receipt.candidate.package.coordinate}@${receipt.candidate.package.version}; ${output}\n`);
  process.exitCode = receipt.verdict === "certified" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
