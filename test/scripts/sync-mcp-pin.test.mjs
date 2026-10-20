import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import os from "node:os";

import {
  applyCreateAppPin,
  applyConfigPin,
  applyPin,
  planPinWrites,
  parseSyncArguments,
  readConfigPin,
  readPin,
  selectCoordinatedRelease,
  writePinPlan,
} from "../../scripts/sync-mcp-pin.mjs";
import {
  CREATE_APP_PIN_SITES,
  ZERO_TO_MAP_CONFIGS,
  readCreateAppSdkPin,
  verifyCreateAppPins,
  verifyZeroToMapConfigPins,
} from "../../scripts/verify-mcp-pin.mjs";

import { mcpArtifact } from "./mcp-peer-artifact-fixture.mjs";
import { MCP_PEER_RECEIPT_PATH } from "../../scripts/lib/mcp-peer-artifact.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pinSource = fs.readFileSync(path.join(projectRoot, "src", "local-install.ts"), "utf8");
const readConfigSource = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const packument = {
  versions: {
    "0.1.4-beta.0": {},
    "0.1.8-beta.0": {},
    "0.1.9-beta.0": {},
    "0.1.9-beta.1": {},
    "0.1.10-beta.0": {},
  },
};

test("selects the published MCP release on the SDK's own tuple", () => {
  assert.equal(selectCoordinatedRelease(packument, "0.1.9-beta.0", "@honua/mcp-server"), "0.1.9-beta.0");
  assert.equal(selectCoordinatedRelease(packument, "0.1.10-beta.0", "@honua/mcp-server"), "0.1.10-beta.0");
  // A stable SDK still pairs with the prerelease cut on its tuple.
  assert.equal(selectCoordinatedRelease(packument, "0.1.4-beta.0", "@honua/mcp-server"), "0.1.4-beta.0");
});

test("never selects a newer tuple just because it is published", () => {
  // Pinning ahead of the SDK is as uninstallable as lagging behind it; the
  // pair only resolves when both halves sit on one tuple.
  const chosen = selectCoordinatedRelease(packument, "0.1.8-beta.0", "@honua/mcp-server");
  assert.equal(chosen, "0.1.8-beta.0");
});

test("refuses to invent a pin when the coordinated half is not published", () => {
  assert.throws(
    () => selectCoordinatedRelease(packument, "0.1.11-beta.0", "@honua/mcp-server"),
    /coordinated cut has not published its MCP half yet/,
  );
});

// Stable 0.x releases: the caret peer range floats across patches.
const stablePackument = {
  versions: {
    "0.1.11-beta.0": { peerDependencies: { "@honua/sdk-js": "^0.1.11-beta.0" } },
    "0.1.12": { peerDependencies: { "@honua/sdk-js": "^0.1.12" } },
    "0.1.13": { peerDependencies: { "@honua/sdk-js": "^0.1.13" } },
    "0.2.0": { peerDependencies: { "@honua/sdk-js": "^0.2.0" } },
  },
};

test("an SDK patch pairs with the MCP release it already co-installs with", () => {
  // The regression this guards: under the prerelease scheme an SDK-only patch
  // could not ship until an MCP release on its exact tuple was republished.
  // With stable 0.x versions, sdk-js 0.1.14 co-installs with mcp-server 0.1.13,
  // and sdk-js 0.1.13 with mcp-server 0.1.12.
  assert.equal(selectCoordinatedRelease(stablePackument, "0.1.14", "@honua/mcp-server"), "0.1.13");
  assert.equal(selectCoordinatedRelease({ versions: { "0.1.12": stablePackument.versions["0.1.12"] } }, "0.1.13", "@honua/mcp-server"), "0.1.12");
});

test("prefers the SDK's own version when that MCP release qualifies", () => {
  assert.equal(selectCoordinatedRelease(stablePackument, "0.1.13", "@honua/mcp-server"), "0.1.13");
  assert.equal(selectCoordinatedRelease(stablePackument, "0.1.12", "@honua/mcp-server"), "0.1.12");
});

test("never selects an MCP release whose peer range excludes the SDK", () => {
  // mcp-server 0.1.13 requires ^0.1.13 and 0.2.0 requires ^0.2.0, so neither can
  // sit beside sdk-js 0.1.12. mcp-server 0.1.11-beta.0 (^0.1.11-beta.0) can.
  assert.equal(selectCoordinatedRelease(stablePackument, "0.1.12", "@honua/mcp-server"), "0.1.12");
  const withoutOwn = { versions: { ...stablePackument.versions } };
  delete withoutOwn.versions["0.1.12"];
  assert.equal(selectCoordinatedRelease(withoutOwn, "0.1.12", "@honua/mcp-server"), "0.1.11-beta.0");
  assert.throws(
    () => selectCoordinatedRelease({ versions: { "0.2.0": stablePackument.versions["0.2.0"] } }, "0.1.15", "@honua/mcp-server"),
    /coordinated cut has not published its MCP half yet/,
  );
});

test("rewrites both pin constants together in the real source file", () => {
  // The version and its recorded tarball integrity must move as a unit; a
  // half-applied edit would leave the live lane comparing a digest that
  // belongs to a different tarball.
  const integrity = `sha512-${"B".repeat(86)}==`;
  const updated = applyPin(pinSource, "9.9.9-beta.0", integrity);
  assert.deepEqual(readPin(updated), { version: "9.9.9-beta.0", integrity });
  const original = readPin(pinSource);
  assert.match(original.version, /^\d+\.\d+\.\d+/);
  assert.match(original.integrity, /^sha512-/);
});

test("fails loudly when the pin constants cannot be located", () => {
  assert.throws(() => applyPin("export const SOMETHING_ELSE = 1;\n", "1.0.0", "sha512-x"), /could not locate/);
});

test("advances every config the pin gate enforces, not just the source constant", () => {
  // The regression this guards: `sync:mcp-pin` used to rewrite only
  // src/local-install.ts, so the first coordinated release after the shipped
  // configs came under `verifyZeroToMapConfigPins` would have left the tree
  // failing its own gate the moment the sync succeeded. Driving the sync's
  // rewrite over the gate's own file list is what keeps the two from drifting
  // apart -- a config added to the gate is a config the sync already covers.
  const nextPin = "@honua/mcp-server@9.9.9-beta.0";
  const advanced = new Map(
    ZERO_TO_MAP_CONFIGS.map((relativePath) => [
      relativePath,
      applyConfigPin(readConfigSource(relativePath), nextPin, relativePath),
    ]),
  );
  assert.equal(advanced.size, ZERO_TO_MAP_CONFIGS.length);
  for (const [relativePath, source] of advanced) {
    assert.equal(readConfigPin(source, relativePath), nextPin);
  }
  // The gate agrees, against exactly the bytes the sync would have written.
  assert.deepEqual(
    verifyZeroToMapConfigPins({
      expectedPin: nextPin,
      readConfig: (relativePath) => JSON.parse(advanced.get(relativePath)),
    }),
    ZERO_TO_MAP_CONFIGS.map((relativePath) => ({ relativePath, pin: nextPin })),
  );
});

test("advances every create-honua-app site enforced by the pin gate", () => {
  const sdkName = "@honua/sdk-js";
  const nextVersion = "9.9.9-beta.0";
  const advanced = new Map(
    CREATE_APP_PIN_SITES.map((relativePath) => [
      relativePath,
      applyCreateAppPin(readConfigSource(relativePath), sdkName, nextVersion, relativePath),
    ]),
  );
  assert.deepEqual(
    verifyCreateAppPins({
      sdkName,
      expectedVersion: nextVersion,
      readConfig: (relativePath) => JSON.parse(advanced.get(relativePath)),
    }),
    CREATE_APP_PIN_SITES.map((relativePath) => ({ relativePath, pin: `${sdkName}@${nextVersion}` })),
  );
  for (const [relativePath, source] of advanced) {
    assert.equal(readCreateAppSdkPin(JSON.parse(source), relativePath, sdkName), nextVersion);
  }
});

test("refuses an ambiguous create-honua-app rewrite", () => {
  const relativePath = CREATE_APP_PIN_SITES.find((site) => site.endsWith("react-ts/package.json"));
  const original = readConfigSource(relativePath);
  const current = readCreateAppSdkPin(JSON.parse(original), relativePath, "@honua/sdk-js");
  const ambiguous = original.replace('"version": "0.0.0"', `"version": "${current}"`);
  assert.throws(
    () => applyCreateAppPin(ambiguous, "@honua/sdk-js", "9.9.9-beta.0", relativePath),
    /exactly once/,
  );
});

test("rewrites a shipped config without reflowing it", () => {
  // These files are hand-formatted (the args array is one line); a
  // parse/serialise round-trip would reflow every one of them into a large
  // spurious diff, so the rewrite has to be a targeted token replacement.
  const [relativePath] = ZERO_TO_MAP_CONFIGS;
  const original = readConfigSource(relativePath);
  const currentPin = readConfigPin(original, relativePath);
  const advanced = applyConfigPin(original, "@honua/mcp-server@9.9.9-beta.0", relativePath);
  assert.equal(advanced, original.replace(`"${currentPin}"`, '"@honua/mcp-server@9.9.9-beta.0"'));
  assert.equal(advanced.split("\n").length, original.split("\n").length);
  // Round-tripping back returns the committed bytes exactly.
  assert.equal(applyConfigPin(advanced, currentPin, relativePath), original);
});

test("is a no-op when a config already names the coordinated pin", () => {
  const [relativePath] = ZERO_TO_MAP_CONFIGS;
  const original = readConfigSource(relativePath);
  const currentPin = readConfigPin(original, relativePath);
  assert.equal(applyConfigPin(original, currentPin, relativePath), original);
});

test("refuses to rewrite a config whose pin is ambiguous or malformed", () => {
  const pin = "@honua/mcp-server@0.1.9-beta.0";
  // The same token twice: a blind replace would update only the first and
  // leave the file internally inconsistent.
  const duplicated = JSON.stringify({
    mcpServers: { honua: { args: ["-y", "--package", pin, pin] } },
  });
  assert.throws(() => applyConfigPin(duplicated, "@honua/mcp-server@9.9.9", "dup.json"), /exactly once/);
  assert.throws(() => readConfigPin("{ not json", "broken.json"), /is not valid JSON/);
  assert.throws(() => readConfigPin(JSON.stringify({ mcpServers: {} }), "empty.json"), /mcpServers\.honua\.args/);
  assert.throws(
    () => readConfigPin(JSON.stringify({ mcpServers: { honua: { args: ["-y"] } } }), "noflag.json"),
    /--package/,
  );
  assert.throws(
    () => readConfigPin(JSON.stringify({ mcpServers: { honua: { args: ["--package"] } } }), "nopin.json"),
    /exact package pin after --package/,
  );
});

/** Stage the real configs in a temp tree so a plan can be proven to touch nothing. */
function stageConfigs(mutate = (source) => source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-pin-plan-"));
  const staleConfigs = ZERO_TO_MAP_CONFIGS.map((relativePath) => {
    const file = path.join(root, path.basename(relativePath));
    let source = readConfigSource(relativePath).replace(
      `"${readConfigPin(readConfigSource(relativePath), relativePath)}"`,
      '"@honua/mcp-server@0.1.4-beta.0"',
    );
    source = mutate(source, relativePath);
    fs.writeFileSync(file, source);
    return { relativePath, file, source, pin: "@honua/mcp-server@0.1.4-beta.0", stale: true };
  });
  return { root, staleConfigs };
}

function stageCreateAppPins(root) {
  return CREATE_APP_PIN_SITES.map((relativePath) => {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const source = applyCreateAppPin(readConfigSource(relativePath), "@honua/sdk-js", "0.1.4-beta.0", relativePath);
    fs.writeFileSync(file, source);
    return { relativePath, file, source, version: "0.1.4-beta.0", stale: true };
  });
}

test("plans every rewrite before writing any of them", (t) => {
  const { root, staleConfigs } = stageConfigs();
  const staleCreateAppPins = stageCreateAppPins(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes = planPinWrites({
    source: pinSource,
    sourceStale: true,
    version: "9.9.9-beta.1",
    sdkVersion: "9.9.9-beta.0",
    integrity: `sha512-${"C".repeat(86)}==`,
    staleConfigs,
    expectedPin: "@honua/mcp-server@9.9.9-beta.1",
    sdkName: "@honua/sdk-js",
    staleCreateAppPins,
  });
  // The source constant, every config, then every scaffold site.
  assert.equal(writes.length, ZERO_TO_MAP_CONFIGS.length + CREATE_APP_PIN_SITES.length + 1);
  assert.equal(writes[0].relativePath, "src/local-install.ts");
  assert.deepEqual(
    writes.slice(1).map((write) => write.relativePath),
    [...ZERO_TO_MAP_CONFIGS, ...CREATE_APP_PIN_SITES],
  );
  assert.equal(readPin(writes[0].contents).version, "9.9.9-beta.1");
  for (const write of writes.slice(1, ZERO_TO_MAP_CONFIGS.length + 1)) {
    assert.equal(readConfigPin(write.contents, write.relativePath), "@honua/mcp-server@9.9.9-beta.1");
  }
  for (const write of writes.slice(ZERO_TO_MAP_CONFIGS.length + 1)) {
    assert.equal(readCreateAppSdkPin(JSON.parse(write.contents), write.relativePath, "@honua/sdk-js"), "9.9.9-beta.0");
  }
});

test("writes every planned scaffold update to real files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-pin-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staleCreateAppPins = stageCreateAppPins(root);
  const writes = planPinWrites({
    source: pinSource,
    sourceStale: false,
    version: "9.9.9-beta.1",
    sdkVersion: "9.9.9-beta.0",
    integrity: readPin(pinSource).integrity,
    staleConfigs: [],
    expectedPin: "@honua/mcp-server@9.9.9-beta.1",
    sdkName: "@honua/sdk-js",
    staleCreateAppPins,
  });

  writePinPlan(writes);

  assert.equal(writes.length, CREATE_APP_PIN_SITES.length);
  for (const site of staleCreateAppPins) {
    const written = JSON.parse(fs.readFileSync(site.file, "utf8"));
    assert.equal(readCreateAppSdkPin(written, site.relativePath, "@honua/sdk-js"), "9.9.9-beta.0");
  }
});

test("a refusal on a later config leaves no file written at all", (t) => {
  // The regression: main() used to write inside the rewrite loop, and
  // applyConfigPin's ambiguity refusal is only reachable there -- readConfigPin
  // takes args[--package + 1] and never counts occurrences. So an ambiguous
  // second config landed *after* the source constant and the first config were
  // already on disk, leaving the half-migrated tree this command exists to
  // prevent. Planning first has to abort with the tree untouched.
  const { root, staleConfigs } = stageConfigs((source, relativePath) =>
    relativePath.endsWith("claude-desktop.json")
      ? source.replace(
          '"HONUA_MCP_REMOTE_URL": "http://localhost:8080/mcp"',
          '"HONUA_MCP_REMOTE_URL": "http://localhost:8080/mcp",\n        "HONUA_MCP_PIN_ECHO": "@honua/mcp-server@0.1.4-beta.0"',
        )
      : source,
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = staleConfigs.map((config) => fs.readFileSync(config.file, "utf8"));
  assert.throws(
    () =>
      planPinWrites({
        source: pinSource,
        sourceStale: true,
        version: "9.9.9-beta.0",
        integrity: `sha512-${"C".repeat(86)}==`,
        staleConfigs,
        expectedPin: "@honua/mcp-server@9.9.9-beta.0",
      }),
    /claude-desktop\.json must name .* exactly once/,
  );
  // Planning is pure: the earlier, perfectly valid configs are untouched.
  staleConfigs.forEach((config, index) => {
    assert.equal(fs.readFileSync(config.file, "utf8"), before[index], `${config.relativePath} must not have been written`);
  });
});

test("explicit selection overrides exact-version preference only for a published compatible peer", () => {
  const published = { versions: {
    "0.1.15": { peerDependencies: { "@honua/sdk-js": "^0.1.15" } },
    "0.1.16": { peerDependencies: { "@honua/sdk-js": "^0.1.15" } },
  } };
  assert.equal(selectCoordinatedRelease(published, "0.1.15", "@honua/mcp-server"), "0.1.15");
  assert.equal(selectCoordinatedRelease(published, "0.1.15", "@honua/mcp-server", "@honua/sdk-js", "0.1.16"), "0.1.16");
  assert.throws(() => selectCoordinatedRelease(published, "0.1.15", "@honua/mcp-server", "@honua/sdk-js", "0.1.17"), /not published/);
  assert.throws(() => selectCoordinatedRelease(stablePackument, "0.1.15", "@honua/mcp-server", "@honua/sdk-js", "0.2.0"), /does NOT consider satisfied/);
  assert.throws(() => selectCoordinatedRelease(packument, "0.1.9-beta.0", "@honua/mcp-server", "@honua/sdk-js", "0.1.9-beta.0"), /must declare/);
});

test("explicit selection accepts --check in either order and refuses ambiguous or floating versions", () => {
  const expected = { check: true, requestedVersion: "0.1.16" };
  assert.deepEqual(parseSyncArguments(["--check", "--mcp-version", "0.1.16"]), expected);
  assert.deepEqual(parseSyncArguments(["--mcp-version", "0.1.16", "--check"]), expected);
  for (const args of [
    ["--mcp-version"], ["--mcp-version", "latest"], ["--mcp-version", "^0.1.16"],
    ["--mcp-version", "--check"], ["--mcp-version", "0.1.16", "--mcp-version", "0.1.17"],
    ["--unknown"],
  ]) assert.throws(() => parseSyncArguments(args));
});

/** Run the actual CLI in an isolated tree with an explicitly mocked registry. */
function withSyncCliFixture(manifest, run, versionOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-sync-cli-"));
  try {
    const sites = ["src/local-install.ts", ...ZERO_TO_MAP_CONFIGS, ...CREATE_APP_PIN_SITES, MCP_PEER_RECEIPT_PATH];
    for (const relativePath of ["scripts/sync-mcp-pin.mjs", "scripts/verify-mcp-pin.mjs", "scripts/lib/mcp-peer-artifact.mjs", ...sites]) {
      const destination = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(projectRoot, relativePath), destination);
    }
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", name: "@honua/sdk-js", version: "0.1.15" }));
    fs.mkdirSync(path.join(root, "dist/src"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist/src/local-install.js"), 'export const LOCAL_INSTALL_MCP_PACKAGE_NAME = "@honua/mcp-server";');
    const preload = path.join(root, "registry-fixture.mjs");
    const response = { versions: {
      "0.1.15": { peerDependencies: { "@honua/sdk-js": "^0.1.15" }, dist: { integrity: mcpArtifact("0.1.15").integrity } },
      ...manifest,
    } };
    const versionResponses = { ...response.versions, ...versionOverrides };
    const tarballs = {};
    for (const [version, item] of Object.entries(versionResponses)) {
      const artifact = mcpArtifact(version, item.peerDependencies?.["@honua/sdk-js"] ?? null);
      if (item.dist) item.dist.tarball = artifact.tarball;
      tarballs[artifact.tarball] = artifact.bytes.toString("base64");
    }
    fs.writeFileSync(preload, `globalThis.fetch = async (url, options) => {
const packument = ${JSON.stringify(response)};
const tarballs = ${JSON.stringify(tarballs)};
const versionResponses = ${JSON.stringify(versionResponses)};
if (tarballs[url]) {
  if (options?.redirect !== "error") throw new Error("Tarball redirect policy missing");
  return new Response(Buffer.from(tarballs[url], "base64"));
}
if (url === "https://registry.npmjs.org/%40honua%2Fmcp-server") return { ok: true, json: async () => packument };
const version = url.split("/").at(-1);
if (versionResponses[version]) return { ok: true, json: async () => ({ name: "@honua/mcp-server", version, ...versionResponses[version] }) };
throw new Error("Unexpected registry URL");
};`);
    const invoke = (args) => spawnSync(process.execPath,
      ["--import", preload, path.join(root, "scripts/sync-mcp-pin.mjs"), ...args], { encoding: "utf8" });
    const snapshot = () => sites.map((site) => fs.readFileSync(path.join(root, site), "utf8"));
    const verify = ({ live = true } = {}) => {
      const integrity = response.versions["0.1.16"].dist.integrity;
      fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
      const peerRange = "^0.1.15 || ^0.2.0";
      fs.mkdirSync(path.join(root, "config"), { recursive: true });
      fs.writeFileSync(path.join(root, "config/mcp-sdk-peer-policy.v1.json"), JSON.stringify({ schema: "honua.mcp-sdk-peer-policy/v1", sdk: "@honua/sdk-js", range: peerRange }));
      fs.writeFileSync(path.join(root, "release-please-config.json"), JSON.stringify({ plugins: [{ type: "node-workspace", updatePeerDependencies: false }] }));
      fs.writeFileSync(path.join(root, "mcp/package.json"), JSON.stringify({ name: "@honua/mcp-server", version: "0.1.16", peerDependencies: { "@honua/sdk-js": peerRange } }));
      fs.writeFileSync(path.join(root, "mcp/package-lock.json"), JSON.stringify({ packages: { "": { peerDependencies: { "@honua/sdk-js": peerRange } } } }));
      fs.writeFileSync(path.join(root, "mcp/CHANGELOG.md"), "## [0.1.16]\n");
      const artifact = mcpArtifact();
      fs.writeFileSync(path.join(root, MCP_PEER_RECEIPT_PATH), JSON.stringify({ schema: "honua.mcp-pinned-peer/v1", pin: "@honua/mcp-server@0.1.16", integrity, tarball: artifact.tarball, packageJsonSha256: artifact.packageJsonSha256, sdkPeerRange: "^0.1.15" }, null, 2) + "\n");
      fs.writeFileSync(path.join(root, "dist/src/local-install.js"),
        `export const LOCAL_INSTALL_MCP_PACKAGE_NAME = "@honua/mcp-server";
export const LOCAL_INSTALL_MCP_PACKAGE = "@honua/mcp-server@0.1.16";
export const LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY = ${JSON.stringify(integrity)};`);
      for (const site of ZERO_TO_MAP_CONFIGS) fs.writeFileSync(path.join(root, site), applyConfigPin(fs.readFileSync(path.join(root, site), "utf8"), "@honua/mcp-server@0.1.16", site));
      return spawnSync(process.execPath, ["--import", preload, path.join(root, "scripts/verify-mcp-pin.mjs")], {
        encoding: "utf8", env: { ...process.env, HONUA_MCP_PIN_LIVE_ENABLED: live ? "true" : "false" },
      });
    };
    run({ root, invoke, snapshot, verify, preload });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("CLI explicit check is read-only and its write advances source, integrity and every shipped config", () => {
  const integrity = mcpArtifact().integrity;
  withSyncCliFixture({ "0.1.16": { peerDependencies: { "@honua/sdk-js": "^0.1.15" }, dist: { integrity } } },
    ({ root, invoke, snapshot }) => {
      const original = snapshot();
      const check = invoke(["--check", "--mcp-version", "0.1.16"]);
      assert.equal(check.status, 1, check.stderr);
      assert.match(check.stderr, /coordinated cut is 0.1.16/);
      assert.match(check.stderr, /sync:mcp-pin -- --mcp-version 0.1.16/);
      assert.deepEqual(snapshot(), original);
      const write = invoke(["--mcp-version", "0.1.16"]);
      assert.equal(write.status, 0, write.stderr);
      assert.deepEqual(readPin(fs.readFileSync(path.join(root, "src/local-install.ts"), "utf8")), { version: "0.1.16", integrity });
      for (const site of ZERO_TO_MAP_CONFIGS) {
        assert.equal(readConfigPin(fs.readFileSync(path.join(root, site), "utf8"), site), "@honua/mcp-server@0.1.16");
      }
      const afterWrite = snapshot();
      assert.deepEqual(afterWrite.slice(1 + ZERO_TO_MAP_CONFIGS.length, -1), original.slice(1 + ZERO_TO_MAP_CONFIGS.length, -1),
        "an independently published MCP patch must not advance the certified scaffold fallback");
      const current = invoke(["--mcp-version", "0.1.16", "--check"]);
      assert.equal(current.status, 0, current.stderr);
      assert.deepEqual(snapshot(), afterWrite);
      for (const args of [["--check"], []]) {
        const retained = invoke(args);
        assert.equal(retained.status, 0, retained.stderr);
        assert.deepEqual(snapshot(), afterWrite);
      }
      const downgrade = invoke(["--mcp-version", "0.1.15"]);
      assert.equal(downgrade.status, 0, downgrade.stderr);
      assert.equal(readPin(fs.readFileSync(path.join(root, "src/local-install.ts"), "utf8")).version, "0.1.15");
    });
});

test("CLI refuses unpublished, incompatible and invalid-integrity explicit selections without any writes", () => {
  const fixtures = [
    [{}, /not published/],
    [{ peerDependencies: { "@honua/sdk-js": "^0.2.0" }, dist: { integrity: mcpArtifact().integrity } }, /does NOT consider satisfied/],
    [{ peerDependencies: { "@honua/sdk-js": "^0.1.15" }, dist: {} }, /valid sha512/],
    [{ peerDependencies: { "@honua/sdk-js": "^0.1.15" }, dist: { integrity: "sha512-not-a-digest" } }, /valid sha512/],
  ];
  for (const [manifest, error] of fixtures) {
    withSyncCliFixture(Object.keys(manifest).length ? { "0.1.16": manifest } : {}, ({ invoke, snapshot }) => {
      const original = snapshot();
      const result = invoke(["--mcp-version", "0.1.16"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, error);
      assert.deepEqual(snapshot(), original);
    });
  }
});

test("CLI rejects missing, duplicate and unknown selection arguments before changing files", () => {
  withSyncCliFixture({}, ({ invoke, snapshot }) => {
    const original = snapshot();
    for (const args of [
      ["--mcp-version"], ["--mcp-version", "latest"], ["--mcp-version", "--check"],
      ["--mcp-version", "0.1.16", "--mcp-version", "0.1.17"], ["--unknown"],
    ]) {
      const result = invoke(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /requires an exact version|must name an exact version|at most once|unrecognised argument/);
      assert.deepEqual(snapshot(), original);
    }
  });
});


test("live verifier accepts an independent MCP patch using its actual older compatible SDK peer", () => {
  withSyncCliFixture({ "0.1.16": { peerDependencies: { "@honua/sdk-js": "^0.1.15" }, dist: { integrity: mcpArtifact().integrity } } },
    ({ verify }) => {
      const result = verify();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /peer="\^0\.1\.15" source=registry/);
      const offline = verify({ live: false });
      assert.equal(offline.status, 0, offline.stderr);
      assert.match(offline.stdout, /registry lane skipped/);
    });
});

test("live verifier refuses an incompatible or missing published peer despite a compatible source manifest", () => {
  for (const peerDependencies of [{ "@honua/sdk-js": "^0.1.16" }, {}]) {
    withSyncCliFixture({ "0.1.16": { peerDependencies, dist: { integrity: mcpArtifact("0.1.16", peerDependencies["@honua/sdk-js"] ?? null).integrity } } },
      ({ verify }) => {
        const result = verify();
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /does NOT consider satisfied|must declare|differs from the verified public tarball/);
        assert.doesNotMatch(result.stdout, /published pair co-installable/);
      });
  }
});

test("default selection retains only a published compatible newer current pin", () => {
  const published = { versions: {
    "0.1.15": { peerDependencies: { "@honua/sdk-js": "^0.1.15" } },
    "0.1.16": { peerDependencies: { "@honua/sdk-js": "^0.1.15" } },
    "0.1.17": { peerDependencies: { "@honua/sdk-js": "^0.2.0" } },
    "0.1.18": {},
  } };
  const choose = (current, explicit) => selectCoordinatedRelease(published, "0.1.15", "@honua/mcp-server", "@honua/sdk-js", explicit, current);
  assert.equal(choose("0.1.16"), "0.1.16");
  assert.equal(choose("0.1.14"), "0.1.15");
  assert.equal(choose("0.1.17"), "0.1.15");
  assert.equal(choose("0.1.18"), "0.1.15");
  assert.equal(choose("0.1.19"), "0.1.15");
  assert.equal(choose("0.1.16", "0.1.15"), "0.1.15");
});


test("CLI repairs template drift to the certified fallback without advancing its manifest", () => {
  const integrity = mcpArtifact().integrity;
  withSyncCliFixture({ "0.1.16": { peerDependencies: { "@honua/sdk-js": "^0.1.15" }, dist: { integrity } } },
    ({ root, invoke }) => {
      const manifestSite = CREATE_APP_PIN_SITES.find((site) => site.endsWith("templates.manifest.json"));
      const manifestPath = path.join(root, manifestSite);
      const originalManifest = fs.readFileSync(manifestPath, "utf8");
      const certifiedVersion = readCreateAppSdkPin(JSON.parse(originalManifest), manifestSite, "@honua/sdk-js");
      const templateSite = CREATE_APP_PIN_SITES.find((site) => site.endsWith("vanilla-ts/package.json"));
      const templatePath = path.join(root, templateSite);
      fs.writeFileSync(templatePath, applyCreateAppPin(fs.readFileSync(templatePath, "utf8"), "@honua/sdk-js", "0.1.12", templateSite));
      const check = invoke(["--mcp-version", "0.1.16", "--check"]);
      assert.equal(check.status, 1);
      assert.match(check.stderr, /certified starter fallback/);
      assert.equal(readCreateAppSdkPin(JSON.parse(fs.readFileSync(templatePath, "utf8")), templateSite, "@honua/sdk-js"), "0.1.12");
      const write = invoke(["--mcp-version", "0.1.16"]);
      assert.equal(write.status, 0, write.stderr);
      assert.equal(fs.readFileSync(manifestPath, "utf8"), originalManifest);
      assert.equal(readCreateAppSdkPin(JSON.parse(fs.readFileSync(templatePath, "utf8")), templateSite, "@honua/sdk-js"), certifiedVersion);
    });
});


test("CLI rejects altered tarball bytes before writing any pin or peer receipt", () => {
  const artifact = mcpArtifact();
  withSyncCliFixture({ "0.1.16": { peerDependencies: { "@honua/sdk-js": "^0.1.15" }, dist: { integrity: artifact.integrity } } },
    ({ preload, invoke, snapshot }) => {
      const original = snapshot();
      const before = fs.readFileSync(preload, "utf8");
      const changed = before.replace(artifact.bytes.toString("base64"), Buffer.from("tampered").toString("base64"));
      assert.notEqual(changed, before);
      fs.writeFileSync(preload, changed);
      const result = invoke(["--mcp-version", "0.1.16"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /bytes do not match/);
      assert.deepEqual(snapshot(), original);
    });
});


test("CLI rejects a verified tarball peer that differs from compatible selection metadata", () => {
  const artifact = mcpArtifact("0.1.16", "^0.2.0");
  const selected = { peerDependencies: { "@honua/sdk-js": "^0.1.15" }, dist: { integrity: artifact.integrity } };
  const actual = { peerDependencies: { "@honua/sdk-js": "^0.2.0" }, dist: { integrity: artifact.integrity } };
  withSyncCliFixture({ "0.1.16": selected }, ({ invoke, snapshot }) => {
    const original = snapshot();
    const result = invoke(["--mcp-version", "0.1.16"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /does NOT consider satisfied/);
    assert.deepEqual(snapshot(), original);
  }, { "0.1.16": actual });
});
