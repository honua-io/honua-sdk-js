import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyConfigPin,
  applyPin,
  readConfigPin,
  readPin,
  selectCoordinatedRelease,
} from "../../scripts/sync-mcp-pin.mjs";
import { ZERO_TO_MAP_CONFIGS, verifyZeroToMapConfigPins } from "../../scripts/verify-mcp-pin.mjs";

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
