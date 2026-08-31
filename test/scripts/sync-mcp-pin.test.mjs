import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyPin, readPin, selectCoordinatedRelease } from "../../scripts/sync-mcp-pin.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pinSource = fs.readFileSync(path.join(projectRoot, "src", "local-install.ts"), "utf8");

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
