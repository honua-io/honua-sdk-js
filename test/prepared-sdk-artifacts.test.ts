import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import {
  PREPARED_SDK_RUN_ID_ENV,
  manifestPathFor,
  prepareSdkArtifact,
  publishPreparedSdkManifest,
  readPreparedSdkManifest,
  verifyManifestArtifact,
  verifyPreparedSdkArtifact,
} from "../scripts/lib/prepared-sdk-artifact.mjs";
import { analyzeTestBuildOwnership, assertTestBuildOwnership } from "../scripts/lib/test-build-ownership.mjs";
import { getProjectRoot } from "./migration-cli-lock.js";
import { setupPreparedSdkArtifact } from "./prepared-sdk-artifacts.global-setup.mjs";
import {
  getPreparedEsriCompatEntryPath,
  getPreparedHonuaEntryPath,
  getPreparedMigrationCliPath,
} from "./prepared-sdk-artifacts.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("prepared SDK artifact contract", () => {
  it("resolves the built entrypoints used by migration and runtime specs", () => {
    expect(getPreparedMigrationCliPath()).toBe(path.join(getProjectRoot(), "dist", "src", "migration", "cli.js"));
    expect(getPreparedEsriCompatEntryPath()).toBe(path.join(getProjectRoot(), "dist", "src", "esri-compat-entry.js"));
    expect(getPreparedHonuaEntryPath()).toBe(path.join(getProjectRoot(), "dist", "src", "honua.js"));
  });

  it("keeps root compilation outside tests and imported test helpers", () => {
    expect(assertTestBuildOwnership({ projectRoot: getProjectRoot() }).filesChecked).toBeGreaterThan(300);
  }, 60_000);

  it("uses one build owner and explicit already-prepared composed lanes", () => {
    const packageJson = readJson<{ scripts: Record<string, string> }>(path.join(getProjectRoot(), "package.json"));
    const scripts = packageJson.scripts;

    expect(scripts.compile).toContain("tsc -p tsconfig.json");
    expect(scripts["build:compile"]).toBeUndefined();
    expect(scripts.build).toBe("node scripts/prepare-sdk-test-artifacts.mjs --force-build");
    expect(scripts["prepare:test-sdk"]).toBe("node scripts/prepare-sdk-test-artifacts.mjs --prepare");
    expect(scripts["prepare:test-sdk:force"]).toBeUndefined();
    expect(scripts["prepare:test-sdk:capture"]).toBeUndefined();
    expect(scripts["prepare:test-sdk:already"]).toBe("node scripts/prepare-sdk-test-artifacts.mjs --already-prepared");
    const preparationOwner = fs.readFileSync(
      path.join(getProjectRoot(), "scripts", "prepare-sdk-test-artifacts.mjs"),
      "utf8",
    );
    expect(preparationOwner).toContain('const buildScript = mode === "build-if-needed" ? "build" : "compile";');

    for (const normal of [
      "pretest",
      "pretest:coverage",
      "pretest:migration:cli",
      "pretest:migration:real-samples",
      "verify:browser",
      "build:split-packages",
      "verify:root-surface",
      "demo:node-backend:build",
      "demo:examples:build",
      "test:playwright",
    ]) {
      expect(scripts[normal], normal).toContain("prepare:test-sdk");
      expect(scripts[normal], normal).not.toContain("npm run build ");
    }

    for (const prepared of [
      "pretest:prepared",
      "pretest:coverage:prepared",
      "pretest:migration:cli:prepared",
      "pretest:migration:real-samples:prepared",
      "verify:browser:prepared",
      "build:split-packages:prepared",
      "verify:root-surface:prepared",
      "demo:node-backend:build:prepared",
      "demo:examples:build:prepared",
      "test:playwright:prepared",
    ]) {
      expect(scripts[prepared], prepared).toContain("prepare:test-sdk:already");
      expect(scripts[prepared], prepared).not.toContain("npm run compile");
      expect(scripts[prepared], prepared).not.toContain("npm run build ");
    }

    for (const gated of [
      "pretest",
      "pretest:prepared",
      "pretest:coverage",
      "pretest:coverage:prepared",
      "pretest:migration:cli",
      "pretest:migration:cli:prepared",
      "pretest:migration:real-samples",
      "pretest:migration:real-samples:prepared",
      "pretest:pr-fast",
      "test:playwright",
      "test:playwright:prepared",
    ]) {
      expect(scripts[gated], gated).toMatch(/^npm run check:test-build-ownership --silent(?: &&|$)/);
    }

    for (const playwright of ["test:playwright", "test:playwright:prepared"]) {
      expect(scripts[playwright], playwright).toContain(
        "node examples/overture-geoparquet/prepare-duckdb-extension.mjs",
      );
    }

    const ci = fs.readFileSync(path.join(getProjectRoot(), ".github", "workflows", "ci.yml"), "utf8");
    const prFastJob = ci.slice(ci.indexOf("  pr-fast:"), ci.indexOf("  benchmark-lab:"));
    const jsSdkJob = ci.slice(ci.indexOf("  js-sdk:"), ci.indexOf("  mcp-sdk:"));
    const fullHistoryCheckout = /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+fetch-depth: 0/;
    expect(prFastJob).toMatch(fullHistoryCheckout);
    expect(jsSdkJob).toMatch(fullHistoryCheckout);
    expect(jsSdkJob.match(/run: npm run build\s*$/gm)).toHaveLength(1);
    expect(jsSdkJob).toContain("npm run test:coverage:prepared");
    expect(jsSdkJob).toContain("npm run test:playwright:prepared");
    expect(jsSdkJob).toContain("npm run demo:examples:build:prepared");
    expect(jsSdkJob).toMatch(
      /node scripts\/sample-contract\.mjs artifacts\n\s+npm run prepare:test-sdk:adopt --silent/,
    );
    expect(jsSdkJob).not.toMatch(/run: npm run (?:test:coverage|test:playwright|demo:examples:build)\s*$/m);

    const publish = fs.readFileSync(path.join(getProjectRoot(), ".github", "workflows", "publish-js-sdk.yml"), "utf8");
    const releasePlease = fs.readFileSync(
      path.join(getProjectRoot(), ".github", "workflows", "release-please.yml"),
      "utf8",
    );
    const docsSite = fs.readFileSync(path.join(getProjectRoot(), ".github", "workflows", "docs-site.yml"), "utf8");
    expect(publish).toMatch(fullHistoryCheckout);
    expect(docsSite).toMatch(fullHistoryCheckout);
    expect(publish).toContain("npm run build:split-packages:prepared");
    expect(publish).toContain("npm run verify:browser:prepared");
    expect(publish).toContain("npm run demo:examples:build:prepared");
    expect(publish).not.toContain("HONUA_DERIVED_ARTIFACTS_RELAX");
    expect(publish).toContain("EXPECTED_SOURCE_REVISION");
    expect(publish).toContain("allow_branch_publish with release_version and source_revision");
    expect(releasePlease).toContain('gh run watch "${reseal_run_id}"');
    expect(releasePlease).toContain("Post-release trunk contains a non-generated path");
    expect(releasePlease).toContain('-f source_revision="${trunk_sha}"');
    expect(releasePlease).not.toContain("dispatch_tag_publish publish-js-sdk.yml");
    expect(publish).not.toMatch(/npm run (?:build:split-packages|verify:browser|demo:examples:build)(?:\s|$)/);
  });
});

describe("prepared SDK manifest", () => {
  it("publishes a complete manifest atomically and verifies every owned artifact", () => {
    const root = createFakeSdkProject();
    const manifest = prepareSdkArtifact({ projectRoot: root, mode: "capture" });

    expect(manifest.inputs.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "package-lock.json",
        "LICENSE",
        "src/index.ts",
        "test/sample.test.ts",
        "bench/run.ts",
        "scripts/build-browser-bundle.mjs",
        "config/public-surface.json",
      ]),
    );
    expect(manifest.dist.entries.map((entry) => entry.path)).toContain("dist/src/core/transitive.js");
    expect(readPreparedSdkManifest(root)).toEqual(manifest);
    expect(verifyPreparedSdkArtifact({ projectRoot: root })).toEqual(manifest);
    expect(verifyManifestArtifact(root, manifest, "dist/src/honua.js")).toBe(
      path.join(root, "dist", "src", "honua.js"),
    );
    expect(fs.readdirSync(path.dirname(manifestPathFor(root))).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects missing and partial artifacts without publishing a manifest", () => {
    const missing = createFakeSdkProject({ dist: false });
    expect(() => verifyPreparedSdkArtifact({ projectRoot: missing })).toThrow(/manifest does not exist/i);

    writeProjectFile(missing, "dist/src/honua.js", "export const honua = true;\n");
    expect(() => prepareSdkArtifact({ projectRoot: missing, mode: "capture" })).toThrow(
      /incomplete: missing dist\/src\/migration\/cli\.js/i,
    );
    expect(fs.existsSync(manifestPathFor(missing))).toBe(false);
  });

  it("detects missing, required-entry, and transitive dist mutations", () => {
    const required = createFakeSdkProject();
    const requiredManifest = prepareSdkArtifact({ projectRoot: required, mode: "capture" });
    writeProjectFile(required, "dist/src/honua.js", "export const replaced = true;\n");
    expect(() => verifyManifestArtifact(required, requiredManifest, "dist/src/honua.js")).toThrow(/artifact changed/i);
    expect(() => verifyPreparedSdkArtifact({ projectRoot: required })).toThrow(/dist tree/i);

    const transitive = createFakeSdkProject();
    const transitiveManifest = prepareSdkArtifact({ projectRoot: transitive, mode: "capture" });
    writeProjectFile(transitive, "dist/src/core/transitive.js", "export const value = 2;\n");
    expect(() =>
      verifyPreparedSdkArtifact({
        projectRoot: transitive,
        expectedRunId: transitiveManifest.runId,
        expectedInputSha256: transitiveManifest.inputs.sha256,
        expectedDistSha256: transitiveManifest.dist.sha256,
      }),
    ).toThrow(/dist tree/i);

    const removed = createFakeSdkProject();
    prepareSdkArtifact({ projectRoot: removed, mode: "capture" });
    fs.rmSync(path.join(removed, "dist", "src", "core", "transitive.js"));
    expect(() => verifyPreparedSdkArtifact({ projectRoot: removed })).toThrow(/dist tree/i);

    const removedEntrypoint = createFakeSdkProject();
    const entrypointManifest = prepareSdkArtifact({ projectRoot: removedEntrypoint, mode: "capture" });
    fs.rmSync(path.join(removedEntrypoint, "dist", "src", "honua.js"));
    expect(() => verifyManifestArtifact(removedEntrypoint, entrypointManifest, "dist/src/honua.js")).toThrow(
      /changed or was removed/i,
    );
  });

  it("hashes all compiler inputs and ignores restored mtimes", () => {
    const mutations: Array<[string, string]> = [
      ["package.json", " \n"],
      ["package-lock.json", " \n"],
      ["tsconfig.json", " \n"],
      [".nvmrc", "# changed\n"],
      ["LICENSE", "license changed\n"],
      ["vitest.config.ts", "// changed\n"],
      ["src/index.ts", "export const changed = true;\n"],
      ["test/sample.test.ts", "export const changed = true;\n"],
      ["bench/run.ts", "export const changed = true;\n"],
      ["scripts/build-browser-bundle.mjs", "// changed\n"],
      ["config/public-surface.json", " \n"],
    ];

    for (const [relativePath, suffix] of mutations) {
      const root = createFakeSdkProject();
      prepareSdkArtifact({ projectRoot: root, mode: "capture" });
      const absolutePath = path.join(root, relativePath);
      const before = fs.statSync(absolutePath);
      fs.appendFileSync(absolutePath, suffix);
      fs.utimesSync(absolutePath, before.atime, before.mtime);
      expect(() => verifyPreparedSdkArtifact({ projectRoot: root }), relativePath).toThrow(/build inputs/i);
    }
  });

  it("binds manifests to a run across isolated consumers", () => {
    const root = createFakeSdkProject();
    const first = prepareSdkArtifact({ projectRoot: root, mode: "capture" });
    const second = prepareSdkArtifact({ projectRoot: root, mode: "already-prepared" });

    expect(second.runId).not.toBe(first.runId);
    expect(() => verifyPreparedSdkArtifact({ projectRoot: root, expectedRunId: first.runId })).toThrow(
      /run changed during Vitest/i,
    );
    expect(
      verifyPreparedSdkArtifact({ projectRoot: root, expectedRunId: second.runId, verifyTrees: false }).runId,
    ).toBe(second.runId);
  });

  it("propagates one run to isolated processes and revalidates it at teardown", () => {
    const root = createFakeSdkProject();
    const manifest = prepareSdkArtifact({ projectRoot: root, mode: "capture" });
    const environment: Record<string, string | undefined> = {};
    const teardown = setupPreparedSdkArtifact(root, environment);
    expect(environment[PREPARED_SDK_RUN_ID_ENV]).toBe(manifest.runId);
    expect(teardown).toBeTypeOf("function");

    const moduleUrl = pathToFileURL(path.join(getProjectRoot(), "scripts", "lib", "prepared-sdk-artifact.mjs")).href;
    const probe = `
      import { verifyPreparedSdkArtifact } from ${JSON.stringify(moduleUrl)};
      const manifest = verifyPreparedSdkArtifact({
        projectRoot: process.env.PROJECT_ROOT,
        expectedRunId: process.env.RUN_ID,
      });
      process.stdout.write(manifest.runId);
    `;
    for (let isolation = 0; isolation < 2; isolation += 1) {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
        encoding: "utf8",
        env: { ...process.env, PROJECT_ROOT: root, RUN_ID: manifest.runId },
      });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toBe(manifest.runId);
    }

    writeProjectFile(root, "dist/src/core/transitive.js", "changed after worker isolation\n");
    expect(() => teardown?.()).toThrow(/dist tree/i);

    const absent = createFakeSdkProject({ dist: false });
    const absentEnvironment: Record<string, string | undefined> = {
      [PREPARED_SDK_RUN_ID_ENV]: "stale",
    };
    expect(setupPreparedSdkArtifact(absent, absentEnvironment)).toBeUndefined();
    expect(absentEnvironment[PREPARED_SDK_RUN_ID_ENV]).toBeUndefined();
  });

  it("does not publish when a build fails or source changes while building", () => {
    const failed = createFakeSdkProject();
    prepareSdkArtifact({ projectRoot: failed, mode: "capture" });
    expect(() =>
      prepareSdkArtifact({
        projectRoot: failed,
        mode: "force-build",
        runBuild: () => {
          writeProjectFile(failed, "dist/src/honua.js", "partial\n");
          throw new Error("compiler exploded");
        },
      }),
    ).toThrow(/build failed.*compiler exploded/i);
    expect(fs.existsSync(manifestPathFor(failed))).toBe(false);

    const changed = createFakeSdkProject({ dist: false });
    expect(() =>
      prepareSdkArtifact({
        projectRoot: changed,
        mode: "build-if-needed",
        runBuild: () => {
          writeCompleteDist(changed);
          fs.appendFileSync(path.join(changed, "src", "index.ts"), "export const raced = true;\n");
        },
      }),
    ).toThrow(/build inputs changed while preparing artifacts/i);
    expect(fs.existsSync(manifestPathFor(changed))).toBe(false);
  });

  it("reuses a valid preparation and rebuilds only after an input change", () => {
    const root = createFakeSdkProject();
    const first = prepareSdkArtifact({ projectRoot: root, mode: "capture" });
    let builds = 0;
    const reused = prepareSdkArtifact({
      projectRoot: root,
      mode: "build-if-needed",
      runBuild: () => {
        builds += 1;
      },
    });
    expect(builds).toBe(0);
    expect(reused.runId).not.toBe(first.runId);

    fs.appendFileSync(path.join(root, "src", "index.ts"), "export const next = true;\n");
    const rebuilt = prepareSdkArtifact({
      projectRoot: root,
      mode: "build-if-needed",
      runBuild: () => {
        builds += 1;
        writeCompleteDist(root, "rebuilt");
      },
    });
    expect(builds).toBe(1);
    expect(verifyPreparedSdkArtifact({ projectRoot: root })).toEqual(rebuilt);
  });

  it("adopts additive outputs but rejects removal or mutation of owned outputs", () => {
    const root = createFakeSdkProject();
    const first = prepareSdkArtifact({ projectRoot: root, mode: "capture" });
    writeProjectFile(root, "dist/browser/sdk.js", "browser\n");
    const adopted = prepareSdkArtifact({ projectRoot: root, mode: "adopt-additions" });
    expect(adopted.dist.fileCount).toBe(first.dist.fileCount + 1);
    expect(adopted.dist.entries.map((entry) => entry.path)).toContain("dist/browser/sdk.js");

    writeProjectFile(root, "dist/src/core/transitive.js", "mutated\n");
    expect(() => prepareSdkArtifact({ projectRoot: root, mode: "adopt-additions" })).toThrow(/removed or mutated/i);

    const removed = createFakeSdkProject();
    prepareSdkArtifact({ projectRoot: removed, mode: "capture" });
    fs.rmSync(path.join(removed, "dist", "src", "core", "transitive.js"));
    expect(() => prepareSdkArtifact({ projectRoot: removed, mode: "adopt-additions" })).toThrow(
      /removed or mutated.*transitive/i,
    );
  });

  it("invalidates adopted additive outputs when their builders or configuration change", () => {
    const root = createFakeSdkProject();
    prepareSdkArtifact({ projectRoot: root, mode: "capture" });
    writeProjectFile(root, "dist/browser/sdk.js", "first browser build\n");
    prepareSdkArtifact({ projectRoot: root, mode: "adopt-additions" });
    fs.appendFileSync(path.join(root, "scripts", "build-browser-bundle.mjs"), "// new builder\n");

    let builds = 0;
    const rebuilt = prepareSdkArtifact({
      projectRoot: root,
      mode: "build-if-needed",
      runBuild: () => {
        builds += 1;
        fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
        writeCompleteDist(root, "new-builder");
      },
    });
    expect(builds).toBe(1);
    expect(rebuilt.dist.entries.map((entry) => entry.path)).not.toContain("dist/browser/sdk.js");
  });

  it("rejects malformed, partial, and stale manifests with actionable errors", () => {
    const malformed = createFakeSdkProject();
    prepareSdkArtifact({ projectRoot: malformed, mode: "capture" });
    fs.writeFileSync(manifestPathFor(malformed), "{not-json\n");
    expect(() => readPreparedSdkManifest(malformed)).toThrow(/not valid JSON/i);

    const partial = createFakeSdkProject();
    const manifest = prepareSdkArtifact({ projectRoot: partial, mode: "capture" });
    const withoutCli = {
      ...manifest,
      dist: {
        ...manifest.dist,
        fileCount: manifest.dist.fileCount - 1,
        entries: manifest.dist.entries.filter((entry) => entry.path !== "dist/src/migration/cli.js"),
      },
    };
    fs.writeFileSync(manifestPathFor(partial), JSON.stringify(withoutCli));
    expect(() => readPreparedSdkManifest(partial)).toThrow(/manifest is partial/i);

    const stale = createFakeSdkProject();
    prepareSdkArtifact({ projectRoot: stale, mode: "capture" });
    fs.appendFileSync(path.join(stale, "package-lock.json"), " \n");
    expect(() => prepareSdkArtifact({ projectRoot: stale, mode: "already-prepared" })).toThrow(/build inputs/i);
  });

  it("refuses to publish a manifest larger than the reader can accept", () => {
    const root = createFakeSdkProject();
    const sha256 = "a".repeat(64);
    const generatedEntries = Array.from({ length: 22_000 }, (_value, index) => ({
      path: `dist/generated/${String(index).padStart(5, "0")}-${"x".repeat(700)}`,
      bytes: 1,
      sha256,
    }));
    const distEntries = [
      ...generatedEntries,
      { path: "dist/src/esri-compat-entry.js", bytes: 1, sha256 },
      { path: "dist/src/honua.js", bytes: 1, sha256 },
      { path: "dist/src/migration/cli.js", bytes: 1, sha256 },
    ];
    expect(() =>
      publishPreparedSdkManifest(
        root,
        { sha256, fileCount: 1, entries: [{ path: "package.json", bytes: 1, sha256 }] },
        { sha256, fileCount: distEntries.length, entries: distEntries },
      ),
    ).toThrow(/manifest exceeds/i);
    expect(fs.existsSync(manifestPathFor(root))).toBe(false);
  });
});

describe("test build ownership analyzer", () => {
  it("finds TSX, CommonJS helper, alternate-manager, run-script, and root-tsc bypasses", () => {
    const root = createOwnershipProject({
      "test/direct.test.tsx": `
        import { spawnSync } from "node:child_process";
        spawnSync("pnpm", ["run", "compile"]);
      `,
      "test/imported.spec.ts": 'import "./support/helper.js";\n',
      "test/support/helper.ts": `
        const { execFileSync: launch } = require("node:child_process");
        launch("yarn", ["run", "nested"]);
      `,
      "test/run-script.test.mjs": `
        const runScript = () => {};
        runScript("alias");
      `,
      "test/root-tsc.spec.ts": `
        import { spawn } from "child_process";
        spawn("tsc", ["-p", "tsconfig.json"]);
      `,
      "test/bun.test.ts": `
        import { execSync } from "node:child_process";
        execSync("bun run compile");
      `,
    });

    const violations = analyzeTestBuildOwnership({ projectRoot: root });
    expect(violations.map((violation) => violation.file)).toEqual([
      "test/bun.test.ts",
      "test/direct.test.tsx",
      "test/root-tsc.spec.ts",
      "test/run-script.test.mjs",
      "test/support/helper.ts",
    ]);
    expect(violations.every((violation) => /compiler|compilation/.test(violation.reason))).toBe(true);
  });

  it("finds npm flags, npm CLI via Node, npm exec tsc, dynamic shells, lifecycle hooks, and node helpers", () => {
    const root = createOwnershipProject({
      "test/flags.test.ts": `
        import { spawnSync } from "node:child_process";
        spawnSync("npm", ["--silent", "run", "--silent", "compile"]);
      `,
      "test/npm-cli.test.ts": `
        import { spawnSync } from "node:child_process";
        spawnSync(process.execPath, [process.env.npm_execpath ?? "npm-cli.js", "run", "compile"]);
      `,
      "test/npm-exec.test.ts": `
        import { spawnSync } from "node:child_process";
        spawnSync("npm", ["exec", "tsc", "--", "-p", "tsconfig.json"]);
      `,
      "test/dynamic-shell.test.ts": `
        import { execSync } from "node:child_process";
        const command = process.env.COMMAND;
        execSync(command);
      `,
      "test/lifecycle.test.ts": `
        const runScript = () => {};
        runScript("safe");
      `,
      "test/node-helper.test.ts": `
        const runScript = () => {};
        runScript("helper-alias");
      `,
      "scripts/compiler-helper.mjs": `
        import { spawnSync } from "node:child_process";
        spawnSync("tsc", ["-p", "tsconfig.json"]);
      `,
    });

    const violations = analyzeTestBuildOwnership({ projectRoot: root });
    expect(new Set(violations.map((violation) => violation.file))).toEqual(
      new Set([
        "test/dynamic-shell.test.ts",
        "test/flags.test.ts",
        "test/lifecycle.test.ts",
        "test/node-helper.test.ts",
        "test/npm-cli.test.ts",
        "test/npm-exec.test.ts",
      ]),
    );
  });

  it("fails closed for dynamic argv and shell/owner bypasses without flagging inert arrays", () => {
    const root = createOwnershipProject({
      "test/dynamic-argv.test.ts": `
        import { spawnSync } from "node:child_process";
        const getArgs = () => ["run", "build"];
        spawnSync("npm", getArgs());
      `,
      "test/direct-owner.test.ts": `
        import { spawnSync } from "node:child_process";
        spawnSync(process.execPath, ["scripts/prepare-sdk-test-artifacts.mjs", "--force-build"]);
      `,
      "test/shell-owner.test.ts": `
        import { spawnSync } from "node:child_process";
        spawnSync("sh", ["-c", "npm run build"]);
      `,
      "test/command-wrapper.test.ts": `
        const supervisor = { run: (_command: string[]) => undefined };
        supervisor.run(["npm", "run", "build"]);
      `,
      "test/inert-array.test.ts": `
        const expect = (_value: unknown) => undefined;
        expect(["npm", "run", "build"]);
      `,
    });

    const violations = analyzeTestBuildOwnership({ projectRoot: root });
    expect(violations.map((violation) => violation.file)).toEqual([
      "test/command-wrapper.test.ts",
      "test/direct-owner.test.ts",
      "test/dynamic-argv.test.ts",
      "test/shell-owner.test.ts",
    ]);
  });

  it("allows fixture-local package and TypeScript compiles", () => {
    const root = createOwnershipProject({
      "test/fixture.test.ts": `
        import { spawnSync } from "node:child_process";
        const workingCopy = "/tmp/sdk-fixture";
        spawnSync("npm", ["--prefix", workingCopy, "run", "build"]);
        spawnSync("tsc", ["-p", "test/fixtures/app/tsconfig.json"]);
      `,
    });
    expect(analyzeTestBuildOwnership({ projectRoot: root })).toEqual([]);
  });

  it("rejects every preparation boundary from direct and imported test code", () => {
    const root = createOwnershipProject({
      "test/prepared.test.ts": `
        const runScript = () => {};
        runScript("prepare:test-sdk");
        runScript("prepare:test-sdk:force");
        runScript("prepare:test-sdk:already");
        runScript("prepare:test-sdk:capture");
        runScript("prepare:test-sdk:adopt");
      `,
      "test/imported-prepared.spec.ts": 'import "./support/prepared-helper.js";\n',
      "test/support/prepared-helper.ts": `
        import { spawnSync } from "node:child_process";
        spawnSync("npm", ["run", "prepare:test-sdk"]);
      `,
    });
    const violations = analyzeTestBuildOwnership({ projectRoot: root });
    expect(violations).toHaveLength(6);
    expect(violations.every((violation) => /owner boundary/.test(violation.reason))).toBe(true);
  });
});

function createFakeSdkProject(options: { dist?: boolean } = {}): string {
  const root = createTempRoot("honua-prepared-sdk-");
  writeProjectFile(root, "package.json", '{"name":"fixture","scripts":{}}\n');
  writeProjectFile(root, "package-lock.json", '{"lockfileVersion":3}\n');
  writeProjectFile(root, "tsconfig.json", '{"include":["src","test","bench"]}\n');
  writeProjectFile(root, "vitest.config.ts", "export default {};\n");
  writeProjectFile(root, ".nvmrc", "20.19.0\n");
  writeProjectFile(root, "LICENSE", "fixture license\n");
  writeProjectFile(root, "src/index.ts", "export const sdk = true;\n");
  writeProjectFile(root, "test/sample.test.ts", "export const test = true;\n");
  writeProjectFile(root, "test/fixtures/ignored.ts", "ignored fixture input\n");
  writeProjectFile(root, "bench/run.ts", "export const bench = true;\n");
  writeProjectFile(root, "scripts/build-browser-bundle.mjs", "export {};\n");
  writeProjectFile(root, "config/public-surface.json", "{}\n");
  writeProjectFile(root, "examples/quickstart/app.ts", "export const example = true;\n");
  if (options.dist !== false) writeCompleteDist(root);
  return root;
}

function writeCompleteDist(root: string, marker = "initial"): void {
  writeProjectFile(root, "dist/src/migration/cli.js", `export const cli = "${marker}";\n`);
  writeProjectFile(root, "dist/src/esri-compat-entry.js", `export const compat = "${marker}";\n`);
  writeProjectFile(root, "dist/src/honua.js", `export const honua = "${marker}";\n`);
  writeProjectFile(root, "dist/src/core/transitive.js", `export const transitive = "${marker}";\n`);
}

function createOwnershipProject(files: Record<string, string>): string {
  const root = createTempRoot("honua-build-ownership-");
  writeProjectFile(
    root,
    "package.json",
    `${JSON.stringify({
      scripts: {
        build: "npm run compile",
        compile: "tsc -p tsconfig.json",
        nested: "npm run compile",
        alias: "npm run nested",
        safe: "node -e \"process.stdout.write('safe')\"",
        presafe: "tsc -p tsconfig.json",
        "helper-alias": "node scripts/compiler-helper.mjs",
        "prepare:test-sdk": "node scripts/prepare-sdk-test-artifacts.mjs --prepare",
        "prepare:test-sdk:force": "node scripts/prepare-sdk-test-artifacts.mjs --force-build",
        "prepare:test-sdk:already": "node scripts/prepare-sdk-test-artifacts.mjs --already-prepared",
        "prepare:test-sdk:capture": "node scripts/prepare-sdk-test-artifacts.mjs --capture",
        "prepare:test-sdk:adopt": "node scripts/prepare-sdk-test-artifacts.mjs --adopt-additions",
      },
    })}\n`,
  );
  for (const [relativePath, source] of Object.entries(files)) writeProjectFile(root, relativePath, source);
  return root;
}

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeProjectFile(root: string, relativePath: string, contents: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
