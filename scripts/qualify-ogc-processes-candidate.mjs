#!/usr/bin/env node
// Qualifies governed OGC API Processes execution (honua-io/honua-sdk-js#1328) from the
// INSTALLED SDK against an exact honua-server image.
//
// Everything under test is real: the published `@honua/sdk-js` registry bytes pinned in
// config/installed-package-certification.v1.json, clean-installed with `npm ci` and
// checked against the pinned SHA-512 integrity and sealed release provenance; and the
// digest-addressed server image under its Production startup policy with PostGIS, Redis
// and a per-run operation key-ring certificate. The SDK drives discovery, describe,
// sync and async execution with an independent geometry oracle, fail-closed mode gates,
// cancellation as declared, server-side refusal of an unauthenticated execution, and
// invalid-input and unknown-process errors (scripts/ogc-processes-candidate-qualification.mjs).
//
//   node scripts/qualify-ogc-processes-candidate.mjs \
//     --image ghcr.io/honua-io/honua-server@sha256:<index digest> --server-ref <40-char sha> \
//     [--server-evidence <name>=https://github.com/honua-io/honua-server/actions/runs/<id> ...] \
//     [--out <file name>]
//
// The receipt is written to test-results/ beside the other candidate receipts and joined
// to the #39 installed-package receipt by digest; that receipt is never rewritten here.
// The command exits 1 unless the qualification passes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonical, sha256 } from "./installed-certification-identity.mjs";
import { runNpmSync } from "./lib/npm-cli.mjs";
import {
  OGC_PROCESSES_QUALIFICATION_FORMAT,
  assertCandidateEvidenceRedacted,
  collectOgcProcessesCandidateQualification,
} from "./ogc-processes-candidate-qualification.mjs";
import { verifyPublishedRelease } from "./verify-published-release.mjs";

export const OGC_PROCESSES_REPLAY_SCHEMA = "honua.ogc-processes-candidate-replay/v1";

/**
 * The #39 denominator rows this lane exercises, and what it observed for each. The
 * observation is recorded beside #39's own verdict and never written into its receipt:
 * that receipt binds a different server image, so nothing here promotes one of its cells.
 */
export const OGC_PROCESSES_DENOMINATOR_ROWS = Object.freeze([
  { id: "protocol-certification:ogc-processes:landing", evidence: "discovery.landingLinkCount" },
  { id: "protocol-certification:ogc-processes:conformance", evidence: "discovery.conformanceClasses" },
  { id: "protocol-certification:ogc-processes:list", evidence: "discovery.processCount" },
  { id: "protocol-certification:ogc-processes:describe", evidence: "discovery.jobControlOptions" },
  { id: "sdk-operation:ogc-processes-discovery-standalone:discovery", evidence: "discovery" },
  { id: "sdk-operation:ogc-processes-execution-standalone:processes", evidence: "executions" },
]);

const RUN_URL = /^https:\/\/github\.com\/honua-io\/honua-server\/actions\/runs\/(\d+)$/;

/** Join this lane's evidence to the committed #39 receipt without re-deciding any of its cells. */
export function joinInstalledPackageReceipt({ installedReceipt, installedReceiptPath, installedPackage, denominator, qualification }) {
  assert.equal(installedReceipt.schema, "honua.sdk-installed-package-certification-receipt/v1", "unexpected #39 receipt schema");
  assert.equal(installedReceipt.package.coordinate, installedPackage.coordinate, "#39 receipt names a different package");
  assert.equal(installedReceipt.package.version, installedPackage.version, "#39 receipt names a different package version");
  assert.equal(installedReceipt.package.integrity, installedPackage.integrity, "#39 receipt binds different package bytes");
  const { receiptDigest, ...body } = installedReceipt;
  assert.equal(sha256(canonical(body)), receiptDigest, "#39 receipt digest does not match its content");
  const rows = OGC_PROCESSES_DENOMINATOR_ROWS.map(({ id, evidence }) => {
    const row = denominator.rows.find((entry) => entry.id === id);
    assert.ok(row, `denominator row ${id} is missing`);
    const installed = installedReceipt.operations.find((entry) => entry.id === id);
    return {
      id,
      tier: row.tier,
      counts: row.counts,
      installedReceiptVerdict: installed?.verdict ?? "not-counted",
      ...(installed?.blockedBy ? { installedReceiptBlockedBy: installed.blockedBy } : {}),
      thisReceipt: qualification.result === "passed" ? "observed-passing" : "not-observed",
      evidence,
    };
  });
  return {
    issue: "honua-io/honua-sdk-js#39",
    path: installedReceiptPath,
    receiptDigest,
    bindingCandidateDigest: installedReceipt.binding?.candidateDigest ?? null,
    serverDigest: installedReceipt.server.digest,
    verdict: installedReceipt.verdict,
    summary: installedReceipt.summary,
    samePackageBytes: true,
    rows,
    promotion: "none: #39's receipt and verdicts are unchanged; the observations above bind this receipt's server image only",
  };
}

export function renderMarkdown(receipt) {
  const q = receipt.qualification;
  const lines = [
    "# OGC API Processes candidate replay (honua-io/honua-sdk-js#1328)",
    "",
    `Status: **${receipt.status}**. Generated ${receipt.generatedAt}.`,
    "",
    "## Identity",
    "",
    `- SDK: installed \`${receipt.sdk.coordinate}@${receipt.sdk.version}\` (\`${receipt.sdk.integrity}\`), sealed source \`${receipt.sdk.sourceRevision}\`, provenance ${receipt.sdk.provenance}; harness \`${receipt.harnessSourceSha}\``,
    `- Server: \`${receipt.server.image}\`, revision \`${receipt.server.revision}\`, running image id matches: ${receipt.server.runningImageMatches}`,
  ];
  if (q) {
    const gate = (entry) => `${entry.id} (${entry.declaration}): ${entry.outcome}${entry.capability ? ` \`${entry.capability}\`` : ""}`;
    lines.push(
      "",
      "## Result",
      "",
      "| Criterion | Observation |",
      "| --- | --- |",
      `| No non-standard \`Prefer\` token | ${q.wire.requestCount} requests; Prefer values sent: ${q.wire.preferValues.map((v) => `\`${v}\``).join(", ") || "none"} |`,
      `| Mode gates fail closed | ${q.gates.map(gate).join("; ")} |`,
      `| Governed process reaches a terminal result | sync ${q.executions.sync.status}; async ${q.executions.async.status} via ${q.executions.async.transitions?.join(" → ")}; buffer oracle radius ${q.executions.async.oracle?.expectedRadius} |`,
      `| Cancel as declared | dismiss declared: ${q.discovery.dismissDeclared}; cancel ${q.executions.async.cancellation?.outcome}, DELETE issued: ${q.executions.async.cancellation?.deleteIssued ?? true} |`,
      `| Errors | unauthenticated execute → HTTP ${q.governance.serverStatus}; invalid WKB → ${q.failure.kind} HTTP ${q.failure.error.statusCode}; unknown process → HTTP ${q.unknownProcess.error.statusCode} |`,
    );
  }
  if (receipt.joins?.installedPackageCertification) {
    const join = receipt.joins.installedPackageCertification;
    lines.push("", "## Joins", "", `- #39 receipt \`${join.path}\` \`${join.receiptDigest}\` (server \`${join.serverDigest}\`, ${join.verdict}); same package bytes. No cell promoted.`);
    for (const row of join.rows) lines.push(`  - \`${row.id}\` (${row.tier}${row.counts ? "" : ", non-counting"}): #39 ${row.installedReceiptVerdict}${row.installedReceiptBlockedBy ? ` by ${row.installedReceiptBlockedBy}` : ""}; this receipt ${row.thisReceipt}`);
    for (const run of receipt.joins.server ?? []) lines.push(`- server ${run.name}: ${run.url} (${run.workflow}, ${run.conclusion}, head \`${run.headSha}\`)`);
  }
  if (receipt.diagnostic) lines.push("", "## Diagnostic", "", "```", receipt.diagnostic, "```");
  return `${lines.join("\n")}\n`;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function options(argv, name) {
  return argv.flatMap((value, index) => (value === name ? [argv[index + 1]] : []));
}

async function main(argv) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const image = option(argv, "--image");
  const serverRef = option(argv, "--server-ref");
  assert.match(image ?? "", /^ghcr\.io\/honua-io\/honua-server@sha256:[0-9a-f]{64}$/, "--image must be a digest-addressed honua-server image");
  assert.match(serverRef ?? "", /^[0-9a-f]{40}$/, "--server-ref must be a full source SHA");
  const outFile = join(root, "test-results", option(argv, "--out") ?? "ogc-processes-candidate-replay.json");

  const secrets = {
    admin: `Aa1!${randomBytes(18).toString("hex")}`,
    postgres: randomBytes(18).toString("hex"),
    keyring: randomBytes(18).toString("hex"),
    master: randomBytes(32).toString("base64"),
    salt: randomBytes(16).toString("base64"),
  };
  const redact = (value) => Object.values(secrets).reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
  const exec = (command, args, { allowFailure = false, timeout = 300_000, cwd, input } = {}) => {
    const settings = { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(cwd ? { cwd } : {}), ...(input ? { input } : {}) };
    const result = command === "npm" ? runNpmSync(args, settings) : spawnSync(command, args, settings);
    if (!allowFailure) assert.equal(result.status, 0, redact(`${command} ${args.slice(0, 2).join(" ")}: ${result.stderr || result.error}`));
    return result;
  };
  const docker = (...args) => exec("docker", args).stdout.trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const candidate = JSON.parse(await readFile(join(root, "config/installed-package-certification.v1.json"), "utf8"));
  const pinned = candidate.packages.find((entry) => entry.coordinate === candidate.package.coordinate);
  const prefix = `sdk1328-${randomBytes(4).toString("hex")}`;
  const work = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const containers = [];
  const receipt = {
    schema: OGC_PROCESSES_REPLAY_SCHEMA,
    issue: "honua-io/honua-sdk-js#1328",
    generatedAt: new Date().toISOString(),
    scope: "installed registry @honua/sdk-js bytes against a digest-addressed honua-server image; governed geometry.buffer",
    harnessSourceSha: exec("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim(),
    sdk: { coordinate: pinned.coordinate, version: pinned.version, integrity: pinned.integrity, sourceRevision: pinned.sourceRevision },
    server: { image, revision: serverRef },
    status: "failed",
  };

  try {
    // ── Installed SDK ─────────────────────────────────────────
    const manifest = JSON.parse(await readFile(join(root, "config/release-artifacts.v1.json"), "utf8"));
    const artifact = manifest.included.find((entry) => entry.npmName === pinned.coordinate);
    const tag = `${artifact.publish.releaseTagPrefix}v${pinned.version}`;
    const provenance = await verifyPublishedRelease({
      targets: [{ id: artifact.id, npmName: pinned.coordinate, version: pinned.version, distTag: "latest", tag, commit: pinned.sourceRevision,
        expectedRef: `refs/tags/${tag}`, workflow: artifact.publish.workflow, sourceBinding: artifact.sourceBinding }],
      sealedTag: tag, sealedCommit: pinned.sourceRevision, registry: pinned.registry, repository: manifest.repository,
    });
    assert.equal(provenance.status, "verified", `published provenance failed: ${provenance.failures.join("; ")}`);
    receipt.sdk.provenance = provenance.status;
    receipt.sdk.provenanceChecks = provenance.artifacts.flatMap((entry) => entry.checks.map(({ description, status }) => ({ description, status })));
    const consumer = join(work, "consumer");
    await mkdir(consumer, { recursive: true });
    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { [pinned.coordinate]: pinned.version } }, null, 2));
    exec("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${pinned.registry}`], { cwd: consumer });
    exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${pinned.registry}`], { cwd: consumer });
    const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
    const installed = lock.packages[`node_modules/${pinned.coordinate}`];
    assert.equal(installed?.version, pinned.version, "installed version differs from the pin");
    assert.equal(installed?.integrity, pinned.integrity, "installed integrity differs from the pinned registry bytes");
    assert.equal(installed?.resolved, pinned.tarball, "installed tarball was not resolved from the pinned registry URL");
    for (const [location, entry] of Object.entries(lock.packages)) {
      assert.ok(!location || (!entry.link && !/^(?:file:|link:|workspace:)/.test(entry.resolved ?? "")), `${location}: local resolution is forbidden`);
    }
    const packageRoot = join(consumer, "node_modules", pinned.coordinate);
    const installedManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(installedManifest.version, pinned.version, "installed package.json version differs from the pin");
    receipt.sdk.install = { mode: "clean-npm-ci", localLinks: false, resolved: installed.resolved, lockDigest: sha256(canonical(lock)),
      runtime: { node: process.version, npm: exec("npm", ["--version"]).stdout.trim(), platform: process.platform, arch: process.arch } };
    const sdk = await import(pathToFileURL(join(packageRoot, "dist/src/index.js")).href);

    // ── Candidate ─────────────────────────────────────────────
    assert.ok(JSON.parse(docker("image", "inspect", image, "--format", "{{json .RepoDigests}}")).includes(image), `local image lacks ${image}; pull it by digest first`);
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port: chosen } = server.address();
        server.close(() => resolve(chosen));
      });
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    docker("network", "create", prefix);
    docker("volume", "create", `${prefix}-keyring`);
    // honua-server#4722: a Redis-backed operation secret channel requires a key-ring certificate.
    exec("docker", ["run", "--rm", "-v", `${prefix}-keyring:/keyring`, "-e", `KEYRING_PASSWORD=${secrets.keyring}`,
      "--entrypoint", "/bin/sh", "alpine/openssl:latest", "-c",
      "set -e; openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout /tmp/k.key -out /tmp/k.crt -subj /CN=sdk1328 >/dev/null 2>&1; " +
        "openssl pkcs12 -export -out /keyring/operation-keyring.pfx -inkey /tmp/k.key -in /tmp/k.crt -passout env:KEYRING_PASSWORD; " +
        "chmod 444 /keyring/operation-keyring.pfx"]);
    const pg = `${prefix}-pg`;
    const redis = `${prefix}-redis`;
    const server = `${prefix}-server`;
    docker("run", "-d", "--name", pg, "--network", prefix, "-e", "POSTGRES_USER=honua", "-e", `POSTGRES_PASSWORD=${secrets.postgres}`,
      "-e", "POSTGRES_DB=honua", "postgis/postgis:16-3.4");
    containers.push(pg);
    docker("run", "-d", "--name", redis, "--network", prefix, "redis:7.4-alpine");
    containers.push(redis);
    const waitFor = async (predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await sleep(500);
      }
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    };
    const logsOf = (name) => {
      const logs = exec("docker", ["logs", name], { allowFailure: true, timeout: 30_000 });
      return redact(`${logs.stdout ?? ""}\n${logs.stderr ?? ""}`);
    };
    await waitFor(() => logsOf(pg).includes("PostgreSQL init process complete"), 120_000, "PostGIS init");
    await waitFor(() => exec("docker", ["exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "honua", "-d", "honua"], { allowFailure: true }).status === 0, 60_000, "PostGIS TCP");
    exec("docker", ["exec", pg, "psql", "-U", "honua", "-d", "honua", "-v", "ON_ERROR_STOP=1", "-c",
      "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS postgis_raster;"]);
    const connection = `Server=${pg};Port=5432;Database=honua;User Id=honua;Password=${secrets.postgres};`;
    const env = {
      ASPNETCORE_ENVIRONMENT: "Production",
      Kestrel__Endpoints__Http__Url: "http://+:8080",
      AllowedHosts: "localhost;127.0.0.1",
      HostValidation__AllowedHosts__0: "localhost",
      HostValidation__AllowedHosts__1: "127.0.0.1",
      PUBLIC_BASE_URL: baseUrl,
      HONUA_ADMIN_PASSWORD: secrets.admin,
      Licensing__Mode: "Disabled",
      Operations__SecretChannel__KeyRingCertificatePath: "/keyring/operation-keyring.pfx",
      Operations__SecretChannel__KeyRingCertificatePassword: secrets.keyring,
      ConnectionStrings__DefaultConnection: connection,
      ConnectionStrings__honua: connection,
      ConnectionStrings__Redis: `${redis}:6379`,
      FileStorage__Provider: "Local",
      FileStorage__LocalStorage__BasePath: "/tmp/honua-storage",
      Security__ConnectionEncryption__MasterKey: secrets.master,
      Security__ConnectionEncryption__Salt: secrets.salt,
    };
    const envFile = join(work, "server.env");
    await writeFile(envFile, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
    docker("run", "-d", "--name", server, "--network", prefix, "-p", `127.0.0.1:${port}:8080`, "--env-file", envFile,
      "-v", `${prefix}-keyring:/keyring:ro`, image);
    containers.push(server);
    await waitFor(async () => {
      assert.ok(JSON.parse(docker("inspect", server, "--format", "{{json .State.Running}}")), `candidate exited:\n${logsOf(server).slice(-6_000)}`);
      return (await fetch(`${baseUrl}/healthz/ready`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined))?.ok === true;
    }, 240_000, "candidate readiness");
    receipt.server.runningImageMatches = docker("inspect", server, "--format", "{{.Image}}") === docker("image", "inspect", image, "--format", "{{.Id}}");
    receipt.server.labelRevision = docker("inspect", server, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}');
    assert.ok(receipt.server.runningImageMatches, "running container is not the digest-addressed image");
    assert.equal(receipt.server.labelRevision, serverRef, "image revision label differs from --server-ref");
    receipt.server.startupPolicy = "Production; PostGIS 16-3.4; Redis 7.4; per-run key-ring PKCS#12; Licensing Disabled; admin API key";

    // ── Qualification ─────────────────────────────────────────
    receipt.qualification = await collectOgcProcessesCandidateQualification({
      sdk,
      baseUrl,
      apiKey: secrets.admin,
      identities: {
        sdk: { package: pinned.coordinate, version: pinned.version, integrity: pinned.integrity, sourceSha: pinned.sourceRevision },
        server: { sourceSha: serverRef, imageDigest: image.split("@")[1] },
        manifestRevision: serverRef,
        evidenceUri: `repo://honua-io/honua-sdk-js/test-results/${outFile.split("/").at(-1)}`,
      },
    });
    assert.equal(receipt.qualification.format, OGC_PROCESSES_QUALIFICATION_FORMAT);
    receipt.qualificationDigest = sha256(canonical(receipt.qualification));

    // ── Joins ─────────────────────────────────────────────────
    const installedReceiptPath = "test-results/installed-package-certification.json";
    receipt.joins = {
      installedPackageCertification: joinInstalledPackageReceipt({
        installedReceipt: JSON.parse(await readFile(join(root, installedReceiptPath), "utf8")),
        installedReceiptPath,
        installedPackage: pinned,
        denominator: JSON.parse(await readFile(join(root, "config/certification-denominator.v1.json"), "utf8")),
        qualification: receipt.qualification,
      }),
      server: options(argv, "--server-evidence").map((entry) => {
        const [name, url] = entry.split(/=(.*)/s);
        const id = RUN_URL.exec(url ?? "")?.[1];
        assert.ok(id, `--server-evidence ${entry} is not a honua-server Actions run URL`);
        const run = JSON.parse(exec("gh", ["api", `repos/honua-io/honua-server/actions/runs/${id}`]).stdout);
        assert.equal(run.head_sha, serverRef, `${name}: run ${id} is not for ${serverRef}`);
        assert.equal(run.conclusion, "success", `${name}: run ${id} concluded ${run.conclusion}`);
        return { name, url, workflow: run.name, event: run.event, conclusion: run.conclusion, headSha: run.head_sha };
      }),
    };
    receipt.status = "passed";
  } catch (error) {
    receipt.diagnostic = redact(error?.stack ?? error);
    for (const name of containers.filter((entry) => entry.endsWith("-server"))) {
      receipt.serverLogs = redact(exec("docker", ["logs", "--tail", "80", name], { allowFailure: true }).stdout ?? "").slice(-8_000);
    }
  } finally {
    for (const name of containers) exec("docker", ["rm", "-f", name], { allowFailure: true, timeout: 60_000 });
    exec("docker", ["network", "rm", prefix], { allowFailure: true });
    exec("docker", ["volume", "rm", `${prefix}-keyring`], { allowFailure: true });
    await rm(work, { recursive: true, force: true });
  }
  const serialized = redact(`${JSON.stringify(receipt, null, 2)}\n`);
  assertCandidateEvidenceRedacted(JSON.parse(serialized).qualification ?? {});
  await writeFile(outFile, serialized);
  await writeFile(outFile.replace(/\.json$/, ".md"), redact(renderMarkdown(receipt)));
  console.log(JSON.stringify({ status: receipt.status, receipt: outFile, diagnostic: receipt.diagnostic?.split("\n").slice(0, 8).join("\n") }, null, 2));
  process.exitCode = receipt.status === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
