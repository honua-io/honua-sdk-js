// Packed-artifact SDK pin tests for `create-honua-app` (#1824).
//
// Scaffolds from the tarball `npm pack` produces — the bytes a user's
// `npm create honua-app` runs — against a loopback registry, once per channel
// state, and asserts the `@honua/sdk-js` version the scaffolded package.json
// pins. The default path must always land on a stable version; only an
// explicit --sdk-version may choose a prerelease.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { isStableVersion, parseVersion } from "../../packages/create-honua-app/lib/sdk-version.mjs";
import { loadTemplateManifest } from "../../packages/create-honua-app/lib/templates.mjs";
import { runNpmSync } from "../../scripts/lib/npm-cli.mjs";
import { packument, startStubRegistry } from "../../scripts/lib/stub-npm-registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_ROOT = path.join(ROOT, "packages/create-honua-app");
const manifest = loadTemplateManifest(PACKAGE_ROOT);
const SDK = manifest.sdk.package;
const CERTIFIED = manifest.sdk.version;
const CHANNEL = manifest.sdk.channel;
const pin = parseVersion(CERTIFIED);
const NEXT_PATCH = `${pin.major}.${pin.minor}.${pin.patch + 1}`;
const NEXT_LINE = pin.major === 0 ? `0.${pin.minor + 1}.0` : `${pin.major + 1}.0.0`;
const BETA = `${pin.major}.${pin.minor}.${pin.patch + 1}-beta.0`;
const PUBLISHED = [BETA, CERTIFIED, NEXT_PATCH, NEXT_LINE];

let workspace;
let installedBin;

function npm(args, cwd) {
  const result = runNpmSync(args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} exited ${result.status}: ${result.error?.message ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function runNode(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: workspace, env, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

let scaffoldCount = 0;

/** Scaffold `templateId` from the installed tarball against a registry serving `distTags`. */
async function scaffold({ templateId = "vanilla-ts", distTags, extraArgs = [], registryUrl } = {}) {
  const registry = registryUrl ? undefined : await startStubRegistry({ [SDK]: packument(distTags, PUBLISHED) });
  try {
    scaffoldCount += 1;
    const target = path.join(workspace, `app-${scaffoldCount}`);
    const result = await runNode([installedBin, target, "--template", templateId, ...extraArgs], {
      ...process.env,
      npm_config_registry: registryUrl ?? registry.url,
    });
    const packageJson = path.join(target, "package.json");
    const dependencies = fs.existsSync(packageJson)
      ? JSON.parse(fs.readFileSync(packageJson, "utf8")).dependencies
      : undefined;
    return { ...result, target, dependencies, requests: registry?.requests ?? [] };
  } finally {
    await registry?.close();
  }
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "create-honua-app-packed-"));
  const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", workspace], PACKAGE_ROOT));
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "create-honua-app-consumer", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", path.join(workspace, packed.filename)], workspace);
  installedBin = path.join(workspace, "node_modules/create-honua-app/bin/create-honua-app.mjs");
});

after(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

describe("packed create-honua-app SDK pin", () => {
  it("ships a stable certified fallback and a channel npm can tag", () => {
    assert.ok(isStableVersion(CERTIFIED), `${CERTIFIED} must not be a prerelease`);
    assert.ok(!/^\d/.test(CHANNEL), `${CHANNEL} must not read as a semver range`);
  });

  for (const template of manifest.templates) {
    it(`pins the certified ${SDK} in ${template.id} while ${CHANNEL} is unpromoted`, async () => {
      const result = await scaffold({ templateId: template.id, distTags: { latest: NEXT_PATCH } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.dependencies[SDK], CERTIFIED);
      assert.ok(isStableVersion(result.dependencies[SDK]));
      assert.deepEqual(result.requests, [SDK]);
      assert.match(result.stdout, new RegExp(`Pinned ${SDK}@${CERTIFIED.replaceAll(".", "\\.")}, the certified version`));
    });

    it(`follows a promotion of ${CHANNEL} in ${template.id} without a republish`, async () => {
      const result = await scaffold({ templateId: template.id, distTags: { latest: CERTIFIED, [CHANNEL]: NEXT_PATCH } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.dependencies[SDK], NEXT_PATCH);
      assert.match(result.stdout, new RegExp(`from the promoted ${CHANNEL.replaceAll(".", "\\.")} channel`));
    });
  }

  it("never scaffolds a prerelease the channel names", async () => {
    const result = await scaffold({ distTags: { [CHANNEL]: BETA } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.dependencies[SDK], CERTIFIED);
    assert.ok(!result.dependencies[SDK].includes("-"));
  });

  it("stays on the starter's SDK line when the channel moves past it", async () => {
    const result = await scaffold({ distTags: { [CHANNEL]: NEXT_LINE } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.dependencies[SDK], CERTIFIED);
  });

  it("falls back to the certified pin when the registry is unreachable", async () => {
    const closed = await startStubRegistry({});
    const url = closed.url;
    await closed.close();
    const result = await scaffold({ registryUrl: url });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.dependencies[SDK], CERTIFIED);
  });

  it("fails when the configured registry has no SDK package", async () => {
    const empty = await startStubRegistry({});
    try {
      const result = await scaffold({ registryUrl: empty.url });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /is not on the configured npm registry/);
      assert.ok(!fs.existsSync(result.target));
    } finally {
      await empty.close();
    }
  });

  it("pins a prerelease only when --sdk-version asks for it", async () => {
    const result = await scaffold({ distTags: { [CHANNEL]: NEXT_PATCH }, extraArgs: ["--sdk-version", BETA] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.dependencies[SDK], BETA);
    assert.match(result.stdout, /as requested by --sdk-version/);
  });

  it("refuses an --sdk-version the registry has not published", async () => {
    const result = await scaffold({ distTags: { [CHANNEL]: NEXT_PATCH }, extraArgs: ["--sdk-version=9.9.9"] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not published/);
    assert.equal(result.dependencies, undefined);
    assert.ok(!fs.existsSync(result.target));
  });
});
