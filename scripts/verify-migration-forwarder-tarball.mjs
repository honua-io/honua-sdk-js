#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sdkRoot = path.resolve(import.meta.dirname, "..");
const migratePackageRoot = path.resolve(
  process.argv[2] ?? process.env.HONUA_MIGRATE_PACKAGE_ROOT ?? "../honua-migrate/packages/javascript",
);
const expectedMigrateVersion = "0.1.3-beta.0";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const rendered = [command, ...args].join(" ");
    throw new Error(
      `${rendered} failed (${result.status ?? "spawn error"})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
      { cause: result.error },
    );
  }
  return result;
}

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function onlyTarball(directory, label) {
  const tarballs = fs.readdirSync(directory).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `${label} pack should produce exactly one tarball`);
  return path.join(directory, tarballs[0]);
}

const sdkManifest = readJson(path.join(sdkRoot, "package.json"));
const migrateManifest = readJson(path.join(migratePackageRoot, "package.json"));
assert.equal(sdkManifest.dependencies?.["@honua/honua-migrate"], expectedMigrateVersion);
assert.equal(migrateManifest.name, "@honua/honua-migrate");
assert.equal(migrateManifest.version, expectedMigrateVersion);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-migration-forwarder-"));
try {
  const migrateArtifacts = path.join(temporaryRoot, "migrate-artifacts");
  const sdkArtifacts = path.join(temporaryRoot, "sdk-artifacts");
  const consumerRoot = path.join(temporaryRoot, "consumer");
  fs.mkdirSync(migrateArtifacts);
  fs.mkdirSync(sdkArtifacts);
  fs.mkdirSync(consumerRoot);

  runNpm(["run", "build", "--silent"], { cwd: migratePackageRoot });
  run(process.execPath, [path.join(sdkRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
    cwd: sdkRoot,
  });
  runNpm(["pack", "--ignore-scripts", "--pack-destination", migrateArtifacts], { cwd: migratePackageRoot });
  runNpm(["pack", "--ignore-scripts", "--pack-destination", sdkArtifacts], { cwd: sdkRoot });

  const migrateTarball = onlyTarball(migrateArtifacts, "honua-migrate");
  const sdkTarball = onlyTarball(sdkArtifacts, "honua-sdk-js");
  fs.writeFileSync(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "honua-migration-forwarder-integration",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@honua/honua-migrate": pathToFileURL(migrateTarball).href,
          "@honua/sdk-js": pathToFileURL(sdkTarball).href,
        },
      },
      null,
      2,
    )}\n`,
  );

  runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumerRoot });

  const installedMigrateRoot = path.join(consumerRoot, "node_modules", "@honua", "honua-migrate");
  const installedSdkRoot = path.join(consumerRoot, "node_modules", "@honua", "sdk-js");
  const installedMigrate = readJson(path.join(installedMigrateRoot, "package.json"));
  assert.equal(installedMigrate.version, expectedMigrateVersion);
  assert.equal(installedMigrate.repository?.url, "git+https://github.com/honua-io/honua-migrate.git");
  assert.equal(installedMigrate.repository?.directory, "packages/javascript");
  assert.equal(installedMigrate.homepage, "https://github.com/honua-io/honua-migrate#readme");
  assert.equal(installedMigrate.bugs?.url, "https://github.com/honua-io/honua-migrate/issues");
  assert.ok(fs.existsSync(path.join(installedSdkRoot, "scripts", "run-legacy-migration-cli.mjs")));

  const lock = readJson(path.join(consumerRoot, "package-lock.json"));
  const migrateResolution = lock.packages?.["node_modules/@honua/honua-migrate"]?.resolved ?? "";
  assert.match(migrateResolution, /^file:/);
  assert.doesNotMatch(migrateResolution, /registry\.npmjs\.org/);

  const identityProbe = path.join(consumerRoot, "identity-probe.mjs");
  fs.writeFileSync(
    identityProbe,
    `import * as canonical from "@honua/honua-migrate";\n` +
      `import * as legacy from "@honua/sdk-js/migration";\n` +
      `const canonicalKeys = Object.keys(canonical).sort();\n` +
      `const legacyKeys = Object.keys(legacy).sort();\n` +
      `if (JSON.stringify(canonicalKeys) !== JSON.stringify(legacyKeys)) process.exit(2);\n` +
      `for (const key of canonicalKeys) if (canonical[key] !== legacy[key]) process.exit(3);\n` +
      `process.stdout.write("forwarder=ok\\n");\n`,
  );
  const identity = run(process.execPath, [identityProbe], { cwd: consumerRoot });
  assert.equal(identity.stdout, "forwarder=ok\n");
  assert.match(identity.stderr, /HONUA_MIGRATION_MOVED/);

  const canonical = run(
    process.execPath,
    [path.join(installedMigrateRoot, "dist", "migration", "cli.js"), "matrix"],
    { cwd: consumerRoot },
  );
  const legacy = run(
    process.execPath,
    [path.join(installedSdkRoot, "scripts", "run-legacy-migration-cli.mjs"), "matrix"],
    { cwd: consumerRoot },
  );
  assert.equal(legacy.stdout, canonical.stdout);
  assert.match(legacy.stderr, /Use honua-js-migrate directly/);
  assert.match(legacy.stderr, /two consecutive honua-migrate minor releases/);
  assert.match(legacy.stderr, /90 days/);
  assert.match(legacy.stderr, /honua-migrate 1\.2/);

  process.stdout.write(
    `migration-forwarder-tarball=ok version=${expectedMigrateVersion} install=offline resolution=${migrateResolution}\n`,
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
