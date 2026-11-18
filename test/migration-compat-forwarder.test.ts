import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import * as canonicalMigration from "@honua/honua-migrate";
import { describe, expect, it } from "vitest";

import { migratorCompatPackageName } from "../scripts/verify-migration-cohort.mjs";
import * as sdkMigration from "../src/migration-entry.js";

const projectRoot = process.cwd();

type ManifestFields = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  files?: string[];
  scripts?: Record<string, string>;
};

type LockPackageFields = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  version?: string;
  bin?: Record<string, string>;
  engines?: { node?: string };
};

type LockFileFields = {
  packages?: Record<string, LockPackageFields>;
};

function readProjectJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, fileName), "utf8")) as T;
}

function expectMigratorAbsentFromRuntime(manifest: ManifestFields, lock: LockFileFields): void {
  expect(manifest.dependencies?.["@honua/honua-migrate"]).toBeUndefined();
  expect(manifest.devDependencies?.["@honua/honua-migrate"]).toBe("0.3.0-beta.0");
  expect(manifest.peerDependencies?.["@honua/honua-migrate"]).toBe("0.3.0-beta.0");
  expect(manifest.peerDependenciesMeta?.["@honua/honua-migrate"]?.optional).toBe(true);
  expect(lock.packages?.[""]?.dependencies?.["@honua/honua-migrate"]).toBeUndefined();
  expect(lock.packages?.[""]?.devDependencies?.["@honua/honua-migrate"]).toBe("0.3.0-beta.0");
}

function readOptionalMigratorPin(): { manifest: ManifestFields; lock: LockFileFields } {
  const manifest = readProjectJson<ManifestFields>("package.json");
  const lock = readProjectJson<LockFileFields>("package-lock.json");
  expectMigratorAbsentFromRuntime(manifest, lock);
  return { manifest, lock };
}

describe("legacy JavaScript migration forwarders", () => {
  it("re-exports the canonical package without retaining an SDK-owned implementation boundary", () => {
    expect(Object.keys(sdkMigration).sort()).toEqual(Object.keys(canonicalMigration).sort());
    for (const name of Object.keys(canonicalMigration) as Array<keyof typeof canonicalMigration>) {
      expect(sdkMigration[name]).toBe(canonicalMigration[name]);
    }

    const source = fs.readFileSync(path.join(projectRoot, "src", "migration-entry.ts"), "utf8");
    expect(source).toContain('export * from "@honua/honua-migrate"');
    expect(source).not.toContain('from "./migration/');
  });

  it("preserves CLI stdout and exit status while warning with the complete removal policy", () => {
    const require_ = createRequire(import.meta.url);
    const canonicalCli = require_.resolve("@honua/honua-migrate/cli");
    const legacyCli = path.join(projectRoot, "scripts", "run-legacy-migration-cli.mjs");
    const canonical = spawnSync(process.execPath, [canonicalCli, "matrix"], { encoding: "utf8" });
    const legacy = spawnSync(process.execPath, [legacyCli, "matrix"], { encoding: "utf8" });

    expect(legacy.status).toBe(canonical.status);
    expect(legacy.stdout).toBe(canonical.stdout);
    expect(legacy.stderr).toContain("Use honua-js-migrate directly");
    expect(legacy.stderr).toContain("two consecutive honua-migrate minor releases");
    expect(legacy.stderr).toContain("90 days");
    expect(legacy.stderr).toContain("1.2");
  });

  it("keeps all SDK migration npm scripts on the compatibility runner", () => {
    const { manifest, lock } = readOptionalMigratorPin();
    expect(manifest.files).toContain("scripts/run-legacy-migration-cli.mjs");
    expect(manifest.scripts?.["verify:migration-forwarder-tarball"]).toContain(
      "verify-migration-forwarder-tarball.mjs",
    );
    expect(lock.packages?.["node_modules/@honua/honua-migrate"]?.version).toBe("0.3.0-beta.0");
    expect(lock.packages?.["node_modules/@honua/honua-migrate"]?.bin).toEqual({
      "honua-js-migrate": "dist/migration/cli.js",
    });
    expect(lock.packages?.["node_modules/@honua/honua-migrate"]?.engines?.node).toBe(">=22.12.0");
    expect(lock.packages?.["node_modules/@honua/sdk"]?.version).toBe("0.2.3");
    expect(lock.packages?.[`node_modules/${migratorCompatPackageName(lock)}`]?.version).toBe("0.2.3");
    for (const script of ["scan:arcgis", "scan:arcgis:widgets", "migrate:arcgis"]) {
      expect(manifest.scripts?.[script]).toContain("run-legacy-migration-cli.mjs");
    }
  });
});
