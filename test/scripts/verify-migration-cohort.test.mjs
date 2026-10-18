import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { expectedSdkPublicationRef, migrationConsumerEnv, migrationNpmEnv, parseArgs, validateLock } from "../../scripts/verify-migration-cohort.mjs";

test("installed consumer processes receive runtime settings without publishing credentials or hooks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-consumer-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sensitiveKeys = [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_RUNTIME_TOKEN",
    "GH_TOKEN", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS",
    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "HONUA_BUILD_RESERVATION", "HONUA_BUILD_RESERVATION_TOKEN", "FUTURE_PUBLISH_CREDENTIAL",
    "npm_config_registry", "NPM_CONFIG_LEGACY_PEER_DEPS", "PUBLISH_REF",
  ];
  // All credential values are invented sentinels; never copy the real test
  // process's environment into this probe or its retained assertion output.
  const supplied = {
    Path: path.dirname(process.execPath), SystemRoot: root, ComSpec: path.join(root, "cmd.exe"),
    TEMP: root, LANG: "C", TZ: "UTC",
    ...Object.fromEntries(sensitiveKeys.map((key) => [key, `fake-secret-${key}`])),
  };
  const env = migrationConsumerEnv(supplied, root);
  for (const key of ["Path", "SystemRoot", "ComSpec", "TEMP", "LANG", "TZ"]) {
    assert.equal(env[key], supplied[key]);
  }
  assert.equal(env.npm_config_registry, "https://registry.npmjs.org");
  assert.equal(fs.readFileSync(env.npm_config_userconfig, "utf8"), "");
  assert.equal(fs.readFileSync(env.npm_config_globalconfig, "utf8"), "");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", "process.stdout.write(JSON.stringify(process.env))"], {
    env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  for (const key of sensitiveKeys) {
    assert.notEqual(observed[key], supplied[key], `credential or hook crossed consumer boundary: ${key}`);
  }
  assert.equal(child.stdout.includes("fake-secret-"), false);
});

test("only script-disabled npm commands retain the existing build admission lease", () => {
  const consumer = { PATH: "/runtime/bin", npm_config_registry: "https://registry.npmjs.org" };
  const base = { HONUA_BUILD_RESERVATION: "/fake/lease", HONUA_BUILD_RESERVATION_TOKEN: "fake-lease-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-oidc", NODE_AUTH_TOKEN: "fake-registry-token" };
  assert.deepEqual(migrationNpmEnv(consumer, base), {
    ...consumer, HONUA_BUILD_RESERVATION: "/fake/lease", HONUA_BUILD_RESERVATION_TOKEN: "fake-lease-token",
  });
  assert.equal(consumer.HONUA_BUILD_RESERVATION, undefined);
  assert.equal(consumer.HONUA_BUILD_RESERVATION_TOKEN, undefined);
});

const options = { sdkVersion: "0.2.4", migrateVersion: "0.3.0-beta.0", sdkSource: "registry" };
function fixture() {
  return { packages: Object.fromEntries([
    ["@honua/sdk-js", "0.2.4"], ["@honua/honua-migrate", "0.3.0-beta.0"],
    ["@honua/sdk", "0.2.3"], ["@honua/sdk-esri-compat", "0.2.3"],
  ].map(([name, version]) => [`node_modules/${name}`, {
    version, resolved: `https://registry.npmjs.org/${name}/-/package-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  }])) };
}

test("accepts compatible patch releases without requiring every component to publish together", () => {
  assert.equal(validateLock(fixture(), options).length, 4);
});

test("rejects an incompatible nested SDK even when the top-level SDK is correct", () => {
  const lock = fixture();
  lock.packages["node_modules/@honua/honua-migrate/node_modules/@honua/sdk"] = {
    ...lock.packages["node_modules/@honua/sdk"], version: "0.1.15",
  };
  assert.throws(() => validateLock(lock, options), /incompatible SDK generation/);
});

test("rejects a second migrator version hidden inside the SDK", () => {
  const lock = fixture();
  lock.packages["node_modules/@honua/sdk-js/node_modules/@honua/honua-migrate"] = {
    ...lock.packages["node_modules/@honua/honua-migrate"], version: "0.2.0-beta.0",
  };
  assert.throws(() => validateLock(lock, options), /second migrator version/);
});

for (const resolved of ["file:../migrate", "https://private.example/package.tgz", "https://registry.npmjs.org/package.tgz?token=private"]) {
  test(`rejects registry evidence with a noncanonical resolution: ${resolved.split("?")[0]}`, () => {
    const lock = fixture();
    lock.packages["node_modules/@honua/honua-migrate"].resolved = resolved;
    assert.throws(() => validateLock(lock, options));
  });
}

test("allows only the top-level packed SDK to use a local tarball", () => {
  const lock = fixture();
  lock.packages["node_modules/@honua/sdk-js"].resolved = "file:../sdk.tgz";
  assert.equal(validateLock(lock, { ...options, sdkSource: "packed" })[0].packed, true);
  assert.throws(() => validateLock(lock, options), /resolve publicly/);
  lock.packages["node_modules/@honua/honua-migrate"].resolved = "file:../migrate.tgz";
  assert.throws(() => validateLock(lock, { ...options, sdkSource: "packed" }), /resolve publicly/);
});

test("refuses missing, linked and unhashed participating modules", () => {
  for (const mutation of [
    (lock) => delete lock.packages["node_modules/@honua/sdk-esri-compat"],
    (lock) => { lock.packages["node_modules/@honua/sdk"].link = true; },
    (lock) => delete lock.packages["node_modules/@honua/sdk"].integrity,
    (lock) => { lock.packages["node_modules/@honua/honua-migrate"].version = "0.2.0-beta.0"; },
  ]) {
    const lock = fixture();
    mutation(lock);
    assert.throws(() => validateLock(lock, options));
  }
});

test("rejects relaxations, arbitrary versions and ambiguous command options", () => {
  for (const argv of [
    ["--force"], ["--legacy-peer-deps"], ["--registry", "https://private.example"],
    ["--sdk-source", "workspace"], ["--sdk-source"], ["--receipt"],
    ["--sdk-source", "registry", "--sdk-source", "packed"],
    ["--sdk-publish-ref", "refs/heads/recovery"],
    ["--sdk-source", "registry", "--sdk-publish-ref", "refs/pull/123/head"],
    ["--sdk-source", "registry", "--sdk-publish-ref", "HEAD"],
  ]) assert.throws(() => parseArgs(argv));
  assert.deepEqual(parseArgs(["--sdk-source", "registry", "--receipt", "proof.json"]), {
    sdkSource: "registry", receipt: "proof.json",
  });
  const recovery = parseArgs(["--sdk-source", "registry", "--sdk-publish-ref", "refs/heads/recovery"]);
  assert.equal(recovery.sdkPublishRef, "refs/heads/recovery");
  for (const sdkPublishRef of ["refs/heads/recovery", "refs/tags/js-sdk-v0.2.4"]) {
    const cut = { sdkVersion: "0.2.4", sdkPublishRef };
    for (const name of ["@honua/sdk-js", "@honua/sdk", "@honua/sdk-esri-compat"]) {
      assert.equal(expectedSdkPublicationRef({ name, version: "0.2.4" }, cut), sdkPublishRef);
      assert.equal(expectedSdkPublicationRef({ name, version: "0.2.3" }, cut), undefined);
    }
    assert.equal(expectedSdkPublicationRef({ name: "@honua/honua-migrate", version: "0.2.4" }, cut), undefined);
  }
  for (const sdkPublishRef of ["refs/tags/js-sdk-v0.2.3", "refs/pull/123/head", "HEAD"]) {
    assert.throws(() => expectedSdkPublicationRef({ name: "@honua/sdk-js", version: "0.2.4" }, {
      sdkVersion: "0.2.4", sdkPublishRef,
    }), /this release tag or a recovery branch/);
  }
});
