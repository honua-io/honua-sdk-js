import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import * as canonicalMigration from "@honua/honua-migrate";
import { describe, expect, it } from "vitest";

import * as sdkMigration from "../src/migration-entry.js";

const projectRoot = process.cwd();

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
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      files?: string[];
      scripts?: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8")) as {
      packages?: Record<
        string,
        {
          dependencies?: Record<string, string>;
          version?: string;
          bin?: Record<string, string>;
          engines?: { node?: string };
        }
      >;
    };

    expect(manifest.dependencies?.["@honua/honua-migrate"]).toBe("0.1.3-beta.0");
    expect(manifest.files).toContain("scripts/run-legacy-migration-cli.mjs");
    expect(manifest.scripts?.["verify:migration-forwarder-tarball"]).toContain(
      "verify-migration-forwarder-tarball.mjs",
    );
    expect(lock.packages?.[""]?.dependencies?.["@honua/honua-migrate"]).toBe("0.1.3-beta.0");
    expect(lock.packages?.["node_modules/@honua/honua-migrate"]?.version).toBe("0.1.3-beta.0");
    expect(lock.packages?.["node_modules/@honua/honua-migrate"]?.bin).toEqual({
      "honua-js-migrate": "dist/migration/cli.js",
    });
    expect(lock.packages?.["node_modules/@honua/honua-migrate"]?.engines?.node).toBe(">=20.19.0");
    expect(lock.packages?.["node_modules/@honua/sdk"]?.version).toBe("0.1.2-beta.0");
    expect(lock.packages?.["node_modules/@honua/sdk-esri-compat"]?.version).toBe("0.1.2-beta.0");
    for (const script of ["scan:arcgis", "scan:arcgis:widgets", "migrate:arcgis"]) {
      expect(manifest.scripts?.[script]).toContain("run-legacy-migration-cli.mjs");
    }
  });
});
