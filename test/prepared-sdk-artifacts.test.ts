import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { getProjectRoot } from "./migration-cli-lock.js";
import {
  getPreparedEsriCompatEntryPath,
  getPreparedHonuaEntryPath,
  getPreparedMigrationCliPath,
} from "./prepared-sdk-artifacts.js";

const ALLOWED_BUILD_FIXTURE_SPECS = new Set(["sample-contract.test.ts", "prepared-sdk-artifacts.test.ts"]);

describe("prepared SDK artifact contract", () => {
  it("resolves the built entrypoints used by migration and runtime specs", () => {
    expect(getPreparedMigrationCliPath()).toBe(path.join(getProjectRoot(), "dist", "src", "migration", "cli.js"));
    expect(getPreparedEsriCompatEntryPath()).toBe(path.join(getProjectRoot(), "dist", "src", "esri-compat-entry.js"));
    expect(getPreparedHonuaEntryPath()).toBe(path.join(getProjectRoot(), "dist", "src", "honua.js"));
  });

  it("keeps full SDK builds outside individual test cases", () => {
    const offenders: string[] = [];
    for (const file of testSourceFiles(path.join(getProjectRoot(), "test"))) {
      if (ALLOWED_BUILD_FIXTURE_SPECS.has(path.basename(file))) {
        continue;
      }
      const source = fs.readFileSync(file, "utf8");
      if (/\bnpm(?:\.cmd)?\s+run\s+build\b/.test(source) || /["']run["']\s*,\s*["']build["']/.test(source)) {
        offenders.push(path.relative(getProjectRoot(), file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("prepares the SDK exactly once for each public unit-test lane", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(getProjectRoot(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.pretest).toBe("npm run build --silent");
    expect(packageJson.scripts["pretest:coverage"]).toBe("npm run build --silent");
    expect(packageJson.scripts["pretest:migration:cli"]).toBe("npm run build --silent");
    expect(packageJson.scripts["pretest:migration:real-samples"]).toBe("npm run build --silent");
    expect(packageJson.scripts.test).not.toContain("build");
    expect(packageJson.scripts["test:coverage"]).not.toContain("build");
    expect(packageJson.scripts["test:migration:cli"]).not.toContain("build");
    expect(packageJson.scripts["test:migration:real-samples"]).not.toContain("build");
  });
});

function testSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...testSourceFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}
