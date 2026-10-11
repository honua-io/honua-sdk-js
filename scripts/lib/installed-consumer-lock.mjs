import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function packedSdkFilename(bytes) {
  return `sdk-${createHash("sha256").update(bytes).digest("hex")}.tgz`;
}

export function assertComparisonDependencies(previous, current, sdkCoordinate) {
  const identities = (lock) => Object.entries(lock.packages ?? {})
    .filter(([name]) => name && name !== `node_modules/${sdkCoordinate}`)
    .map(([name, entry]) => [name, entry.version, entry.integrity ?? null])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(identities(current), identities(previous),
    "comparison must preserve every dependency version and integrity except the SDK under test");
}
