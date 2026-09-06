import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item) ?? "null").join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function validatePackageSet(candidate, required) {
  const packages = candidate.packages;
  assert.ok(Array.isArray(packages) && packages.length > 0, "candidate package set is missing");
  const names = packages.map((p) => p.coordinate);
  assert.equal(new Set(names).size, names.length, "duplicate candidate package");
  assert.deepEqual([...names].sort(), [...required].sort(), "candidate package set differs from release denominator");
  for (const p of packages) {
    assert.match(p.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, "candidate version must be exact");
    assert.match(p.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, "missing SHA-512 integrity");
    assert.match(p.sourceRevision, /^[a-f0-9]{40}$/, "missing package source revision");
    const registry = new URL(p.registry);
    const tarball = new URL(p.tarball);
    assert.ok(registry.protocol === "https:" && !registry.username && !registry.password, "invalid registry");
    assert.ok(tarball.origin === registry.origin && !tarball.username && !tarball.password, "tarball is outside declared registry");
  }
  const sdk = packages.find((p) => p.coordinate === candidate.package.coordinate);
  for (const key of ["version", "integrity", "registry"]) assert.equal(sdk?.[key], candidate.package[key], `root package ${key} drift`);
  return packages;
}

export function validateInstalledLock(candidate, lock) {
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!location) continue;
    assert.ok(!entry.link && !/^(?:file:|link:|workspace:)/.test(entry.resolved ?? ""), `${location}: local resolution is forbidden`);
  }
  return candidate.packages.map((p) => {
    const entry = lock.packages?.[`node_modules/${p.coordinate}`];
    assert.equal(entry?.version, p.version, `${p.coordinate}: installed version mismatch`);
    assert.equal(entry?.integrity, p.integrity, `${p.coordinate}: installed integrity mismatch`);
    assert.equal(entry?.resolved, p.tarball, `${p.coordinate}: installed registry URL mismatch`);
    return { ...p, dependencies: entry.dependencies ?? {}, peerDependencies: entry.peerDependencies ?? {} };
  });
}

// Frozen before installation/execution; these are content identities, not timestamps
// asserted after a run. The complete denominator includes non-counting rows too.
export async function freezeCertification(candidate, denominator, root) {
  validatePackageSet(candidate, denominator.candidatePackages);
  assert.ok(denominator.rows.some((row) => row.counts), "empty supported denominator");
  assert.equal(new Set(denominator.rows.map((r) => r.id)).size, denominator.rows.length, "duplicate denominator ID");
  const inputs = {};
  for (const relative of ["config/support-manifest.v1.json", "mcp/release/zero-to-map/journey.v1.json",
    "test/integration/seed/places-roads-v1.sql", "scripts/fixtures/installed-features.mjs"]) {
    inputs[relative] = sha256(await readFile(path.join(root, relative)));
  }
  return { candidateDigest: sha256(canonical({ release: candidate.release, packages: candidate.packages, server: candidate.server })),
    denominatorDigest: sha256(canonical(denominator)), inputs };
}

export function validateObservationEnvelope(envelope, frozen, denominator) {
  assert.equal(envelope?.schema, "honua.sdk-installed-observations/v1", "unbound observations are forbidden");
  assert.deepEqual(envelope.binding, frozen, "observation candidate/denominator/profile/fixture identity mismatch");
  assert.ok(Array.isArray(envelope.observations), "observations must be an array");
  const rows = new Map(denominator.rows.map((row) => [row.id, row]));
  const seen = new Set();
  for (const observed of envelope.observations) {
    assert.ok(!seen.has(observed.id), `duplicate observation id ${observed.id}`);
    seen.add(observed.id);
    const row = rows.get(observed.id);
    assert.ok(row, `unknown observation id ${observed.id}`);
    assert.ok(["pass", "fail", "blocked"].includes(observed.verdict), `${observed.id}: invalid verdict ${observed.verdict}`);
    if (observed.verdict !== "pass") continue;
    assert.ok(row.counts, `${observed.id}: non-supported row cannot pass`);
    assert.equal(observed.execution?.mode, "installed-package", `${observed.id}: installed execution required`);
    assert.ok(observed.execution?.assertions > 0, `${observed.id}: value assertions required`);
    for (const facet of row.scenarioFacets ?? []) {
      assert.ok(observed.execution.facets?.includes(facet), `${observed.id}: missing ${facet} facet`);
    }
  }
  return envelope.observations;
}
