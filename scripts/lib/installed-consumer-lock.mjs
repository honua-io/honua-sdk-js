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

export function assertInstalledConsumerModules(moduleIds, consumerRoot) {
  const dependencies = moduleIds.filter((id) => id.includes("/node_modules/"));
  assert.ok(dependencies.every((id) => id.startsWith(`${consumerRoot}/node_modules/`)),
    "installed bundle runtime dependencies must belong to the isolated consumer, never repository node_modules");
}
