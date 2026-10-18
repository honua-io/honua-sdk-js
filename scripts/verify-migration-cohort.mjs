#!/usr/bin/env node

// Prepublication uses a packed SDK plus registry dependencies. Only the
// registry mode is published-consumer evidence. Both retain default npm
// resolution, the actual lock and installed forwarding/CLI observations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runNpmSync } from "./lib/npm-cli.mjs";
import { publicResolverEnv } from "./verify-client-pair-install.mjs";
import { verifyPublishedRelease } from "./verify-published-release.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SDK = "@honua/sdk-js";
const MIGRATE = "@honua/honua-migrate";
const CORE = "@honua/sdk";
const COMPAT = "@honua/sdk-esri-compat";
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// Installed registry code needs an ordinary process environment, not the
// publishing job's OIDC, registry, cloud, or GitHub credentials. Use an
// allowlist so newly introduced credential names cannot silently cross here.
export function migrationConsumerEnv(baseEnv, tempRoot) {
  const runtimeKeys = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  ]);
  const runtime = Object.fromEntries(Object.entries(baseEnv)
    .filter(([key]) => runtimeKeys.has(key.toUpperCase())));
  return publicResolverEnv(runtime, tempRoot);
}

export function migrationNpmEnv(consumerEnv, baseEnv) {
  // Only npm's script-disabled pack/install/list commands receive the shared
  // build lease. Keep admission wrappers authoritative without exposing the
  // lease capability to installed modules or either migration CLI.
  const env = { ...consumerEnv };
  for (const key of ["HONUA_BUILD_RESERVATION", "HONUA_BUILD_RESERVATION_TOKEN"]) {
    if (typeof baseEnv[key] === "string") env[key] = baseEnv[key];
  }
  return env;
}

export function parseArgs(argv) {
  const options = { sdkSource: "packed", receipt: "test-results/migration-cohort.json" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert.ok(["--sdk-source", "--receipt", "--sdk-publish-ref"].includes(flag), `unknown argument ${flag}`);
    assert.ok(!seen.has(flag) && value && !value.startsWith("--"), `invalid or repeated ${flag}`);
    seen.add(flag);
    const key = { "--sdk-source": "sdkSource", "--receipt": "receipt", "--sdk-publish-ref": "sdkPublishRef" }[flag];
    options[key] = value;
  }
  assert.ok(["packed", "registry"].includes(options.sdkSource), "SDK source must be packed or registry");
  if (options.sdkPublishRef) {
    assert.equal(options.sdkSource, "registry", "a publication ref requires registry SDK verification");
    assert.match(options.sdkPublishRef, /^refs\/(?:heads\/[^\s]+|tags\/js-sdk-v[^\s]+)$/, "invalid SDK publication ref");
  }
  return options;
}

export function expectedSdkPublicationRef(item, { sdkVersion, sdkPublishRef }) {
  if (!sdkPublishRef) return undefined;
  assert.ok(sdkPublishRef === `refs/tags/js-sdk-v${sdkVersion}` || /^refs\/heads\/[^\s]+$/.test(sdkPublishRef),
    "SDK publication ref must name this release tag or a recovery branch");
  // A recovered SDK cut cannot change the provenance expectation for an older
  // transitive SDK patch or for the separately published migrator.
  return item.name !== MIGRATE && item.version === sdkVersion ? sdkPublishRef : undefined;
}

export function validateLock(lock, { sdkVersion, migrateVersion, sdkSource }) {
  const expected = { [SDK]: sdkVersion, [MIGRATE]: migrateVersion };
  for (const [name, version] of Object.entries(expected)) {
    assert.match(version, EXACT, `${name} must have an exact version`);
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version, `${name} installed version`);
  }
  const generation = sdkVersion.split(".").slice(0, 2).join(".");
  const participating = [];
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    const name = [SDK, MIGRATE, CORE, COMPAT].find((candidate) => location.endsWith(`node_modules/${candidate}`));
    if (!name) continue;
    assert.ok(!entry.link, `${location} must not be a linked package`);
    if (name !== MIGRATE) {
      assert.equal(entry.version?.split(".").slice(0, 2).join("."), generation, `${location} incompatible SDK generation`);
    } else {
      assert.equal(entry.version, migrateVersion, `${location} contains a second migrator version`);
    }
    const packed = sdkSource === "packed" && location === `node_modules/${SDK}`;
    if (packed) assert.match(entry.resolved ?? "", /^file:/, "packed SDK resolution");
    else {
      const url = new URL(entry.resolved);
      assert.equal(url.origin, "https://registry.npmjs.org", `${location} must resolve publicly`);
      assert.equal(url.username + url.password + url.search + url.hash, "", `${location} registry URL`);
    }
    assert.match(entry.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${location} integrity`);
    participating.push({ name, location, version: entry.version, resolved: entry.resolved, integrity: entry.integrity, packed });
  }
  for (const name of [SDK, MIGRATE, CORE, COMPAT]) {
    assert.ok(participating.some((item) => item.name === name), `missing ${name} resolution`);
  }
  return participating;
}

// This runs inside the isolated consumer, so all imports and createRequire
// resolution begin at installed package paths, never at the source checkout.
const PROBE = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as canonical from '@honua/honua-migrate';
import * as legacy from '@honua/sdk-js/migration';
const require = createRequire(import.meta.url);
assert.deepEqual(Object.keys(legacy).sort(), Object.keys(canonical).sort());
assert.ok(Object.keys(canonical).length > 0);
for (const key of Object.keys(canonical)) assert.equal(legacy[key], canonical[key], key);
function locate(request, name) {
  let directory = path.dirname(request.resolve(name));
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (manifest.name === name) return { directory, manifest };
    }
    directory = path.dirname(directory);
  }
  throw new Error('cannot locate installed ' + name);
}
const migrate = locate(require, '@honua/honua-migrate');
const fromMigrate = createRequire(path.join(migrate.directory, 'package.json'));
const core = locate(fromMigrate, '@honua/sdk');
const compat = locate(fromMigrate, '@honua/sdk-esri-compat');
const peer = locate(createRequire(path.join(compat.directory, 'package.json')), '@honua/sdk');
assert.equal(core.directory, peer.directory, 'compat must consume the same SDK as the migrator');
assert.equal(core.manifest.version, compat.manifest.version, 'SDK and compat pair');
process.stdout.write(JSON.stringify({
  exports: Object.keys(canonical).sort(),
  canonicalCli: require.resolve('@honua/honua-migrate/cli'),
  resolutions: [migrate, core, compat].map(({ directory, manifest }) => ({
    name: manifest.name, version: manifest.version, location: path.relative(process.cwd(), directory),
    dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies
  }))
}));
`;

function run(command, args, { cwd, env }) {
  const options = { cwd, env: command === "npm" ? migrationNpmEnv(env, process.env) : env,
    encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 };
  const result = command === "npm" ? runNpmSync(args, options) : spawnSync(command, args, options);
  assert.ok(!result.error && result.status === 0,
    `${command} ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}

async function publication(item, sdkPublication) {
  const migrate = item.name === MIGRATE;
  const repository = `honua-io/${migrate ? "honua-migrate" : "honua-sdk-js"}`;
  const tag = `${migrate ? "javascript" : "js-sdk"}-v${item.version}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${tag}`, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/vnd.github+json" },
  });
  assert.ok(response.ok, `cannot resolve ${repository} ${tag}: HTTP ${response.status}`);
  const { sha } = await response.json();
  assert.match(sha, /^[a-f0-9]{40}$/);
  const proof = await verifyPublishedRelease({
    targets: [{ id: item.name, npmName: item.name, version: item.version, tag, commit: sha,
      expectedRef: expectedSdkPublicationRef(item, sdkPublication),
      workflow: `.github/workflows/${migrate ? "publish-javascript" : "publish-js-sdk"}.yml` }],
    sealedTag: tag, sealedCommit: sha, repository, selection: "exact-version",
    fetchImpl: (url) => fetch(url, { signal: AbortSignal.timeout(60_000) }),
  });
  return proof;
}

export async function verifyMigrationCohort(argv) {
  const { sdkSource, sdkPublishRef, receipt: receiptPath } = parseArgs(argv);
  const destination = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const manifest = readJson(path.join(ROOT, "package.json"));
  const migrateVersion = manifest.dependencies?.[MIGRATE];
  assert.equal(manifest.name, SDK);
  assert.match(migrateVersion ?? "", EXACT, "migration dependency must be exact");
  const sdkPublication = { sdkVersion: manifest.version, sdkPublishRef };
  expectedSdkPublicationRef({ name: SDK, version: manifest.version }, sdkPublication);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-migration-cohort-"));
  const consumer = path.join(tempRoot, "consumer");
  fs.mkdirSync(consumer);
  const options = { cwd: consumer, env: migrationConsumerEnv(process.env, tempRoot) };
  const receipt = { format: "honua.migration-cohort.v1", status: "failed", sdkSource,
    sdkPublishRef: sdkPublishRef ?? null,
    sdkVersion: manifest.version, migrateVersion, observedAt: new Date().toISOString(),
    nodeVersion: process.version, publications: [] };
  try {
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
      name: "honua-migration-cohort-consumer", version: "0.0.0", private: true, type: "module",
    }));
    let specifier = `${SDK}@${manifest.version}`;
    if (sdkSource === "packed") {
      const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot, ROOT], options).stdout);
      assert.equal(packed.length, 1);
      specifier = path.join(tempRoot, packed[0].filename);
      receipt.packedSdkSha512 = createHash("sha512").update(fs.readFileSync(specifier)).digest("hex");
    }
    // Install only the SDK. The migrator must arrive through its real dependency.
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", specifier], options);
    const lock = readJson(path.join(consumer, "package-lock.json"));
    fs.writeFileSync(`${destination}.lock.json`, `${JSON.stringify(lock, null, 2)}\n`);
    receipt.lockSha256 = createHash("sha256").update(fs.readFileSync(`${destination}.lock.json`)).digest("hex");
    receipt.packages = validateLock(lock, { sdkVersion: manifest.version, migrateVersion, sdkSource });
    receipt.npmTree = JSON.parse(run("npm", ["ls", "--all", "--json"], options).stdout);
    const verified = new Map();
    for (const item of receipt.packages.filter((entry) => !entry.packed)) {
      const key = `${item.name}@${item.version}`;
      if (!verified.has(key)) {
        const proof = await publication(item, sdkPublication);
        receipt.publications.push(proof);
        assert.equal(proof.status, "verified", JSON.stringify(proof.failures));
        assert.equal(proof.artifacts[0].integrity, item.integrity, `${key} installed integrity differs from publication`);
        assert.equal(proof.artifacts[0].tarball, item.resolved, `${key} installed URL differs from publication`);
        verified.set(key, proof.artifacts[0]);
      } else {
        assert.equal(item.integrity, verified.get(key).integrity, `${key} duplicate integrity`);
        assert.equal(item.resolved, verified.get(key).tarball, `${key} duplicate URL`);
      }
    }
    // Authenticate every installed registry artifact before importing its code.
    const probe = path.join(consumer, "probe.mjs");
    fs.writeFileSync(probe, PROBE);
    const identity = run(process.execPath, [probe], options);
    assert.match(identity.stderr, /HONUA_MIGRATION_MOVED/);
    const observed = JSON.parse(identity.stdout);
    receipt.exports = observed.exports;
    receipt.resolutions = observed.resolutions;
    const canonical = run(process.execPath, [observed.canonicalCli, "matrix"], options);
    const legacy = run(process.execPath, [path.join(consumer, "node_modules", SDK, "scripts/run-legacy-migration-cli.mjs"), "matrix"], options);
    assert.ok(canonical.stdout.trim().length > 0, "canonical CLI returned no matrix");
    assert.equal(legacy.stdout, canonical.stdout);
    for (const text of ["Use honua-js-migrate directly", "two consecutive honua-migrate minor releases", "90 days", "1.2"]) {
      assert.ok(legacy.stderr.includes(text), `missing legacy removal policy: ${text}`);
    }
    receipt.cli = { canonicalExit: 0, legacyExit: 0, stdout: canonical.stdout, legacyWarning: legacy.stderr };
    receipt.status = "passed";
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    fs.writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  process.stdout.write(`migration-cohort=passed sdkSource=${sdkSource} receipt=${destination}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyMigrationCohort(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
