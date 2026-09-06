import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateInstalledLock, validatePackageSet, validateObservationEnvelope } from "../../scripts/installed-certification-identity.mjs";

const candidate = JSON.parse(await readFile(new URL("../../config/installed-package-certification.v1.json", import.meta.url)));
const required = candidate.packages.map((p) => p.coordinate);
const lock = { packages: Object.fromEntries(candidate.packages.map((p) => [`node_modules/${p.coordinate}`,
  { version: p.version, integrity: p.integrity, resolved: p.tarball }])) };
const denominator = { rows: [{ id: "query", counts: true, scenarioFacets: ["positive", "pagination"] }, { id: "preview", counts: false }] };
const binding = { candidateDigest: "candidate-a", denominatorDigest: "denominator-a", inputs: { profile: "profile-a", fixture: "fixture-a" } };
const envelope = { schema: "honua.sdk-installed-observations/v1", binding, observations: [{ id: "query", verdict: "pass",
  execution: { mode: "installed-package", assertions: 3, facets: ["positive", "pagination"] } }] };

test("all release packages must be pinned and installed from their declared registry", () => {
  assert.equal(validatePackageSet(candidate, required).length, 8);
  assert.equal(validateInstalledLock(candidate, lock).length, 8);
  for (const p of candidate.packages) {
    const missing = structuredClone(lock);
    delete missing.packages[`node_modules/${p.coordinate}`];
    assert.throws(() => validateInstalledLock(candidate, missing), /installed version mismatch/);
  }
});

test("partial, duplicate, floating, unprovenanced and foreign-registry packages fail closed", () => {
  for (const mutate of [
    (c) => c.packages.pop(), (c) => c.packages.push(c.packages[0]),
    (c) => { c.packages[0].version = "latest"; }, (c) => { delete c.packages[0].sourceRevision; },
    (c) => { c.packages[0].tarball = "https://example.com/package.tgz"; },
  ]) {
    const changed = structuredClone(candidate); mutate(changed);
    assert.throws(() => validatePackageSet(changed, required));
  }
});

test("wrong bytes, alternate registry and nested workspace resolution fail closed", () => {
  for (const patch of [{ version: "9.0.0" }, { integrity: "sha512-wrong" }, { resolved: "https://example.com/sdk.tgz" }, { link: true }]) {
    const changed = structuredClone(lock);
    Object.assign(changed.packages["node_modules/@honua/sdk-js"], patch);
    assert.throws(() => validateInstalledLock(candidate, changed));
  }
  const changed = structuredClone(lock);
  changed.packages["node_modules/nested/node_modules/@honua/sdk-js"] = { resolved: "file:../../source" };
  assert.throws(() => validateInstalledLock(candidate, changed), /local resolution is forbidden/);
});

test("only exact candidate, denominator, profile and fixture observations can join", () => {
  assert.equal(validateObservationEnvelope(envelope, binding, denominator).length, 1);
  assert.throws(() => validateObservationEnvelope(envelope.observations, binding, denominator), /unbound observations/);
  for (const mutate of [
    (e) => { e.binding.candidateDigest = "candidate-b"; },
    (e) => { e.binding.denominatorDigest = "denominator-b"; },
    (e) => { e.binding.inputs.profile = "profile-b"; },
    (e) => { e.binding.inputs.fixture = "fixture-b"; },
  ]) {
    const changed = structuredClone(envelope); mutate(changed);
    assert.throws(() => validateObservationEnvelope(changed, binding, denominator), /identity mismatch/);
  }
});

test("skips, source builds, unknown IDs, previews, missing assertions and missing facets cannot pass", () => {
  for (const mutate of [
    (o) => { o.id = "unknown"; }, (o) => { o.id = "preview"; }, (o) => { o.verdict = "skip"; },
    (o) => { o.execution.mode = "source-build"; }, (o) => { o.execution.assertions = 0; },
    (o) => { o.execution.facets = ["positive"]; },
  ]) {
    const changed = structuredClone(envelope); mutate(changed.observations[0]);
    assert.throws(() => validateObservationEnvelope(changed, binding, denominator));
  }
  const duplicate = structuredClone(envelope);
  duplicate.observations.push(duplicate.observations[0]);
  assert.throws(() => validateObservationEnvelope(duplicate, binding, denominator), /duplicate observation/);
});


test("a migration dependency cannot smuggle an older installed SDK into the candidate", () => {
  const changed = structuredClone(lock);
  changed.packages["node_modules/@honua/honua-migrate/node_modules/@honua/sdk"] = {
    version: "0.1.2-beta.0", resolved: "https://registry.npmjs.org/@honua/sdk/-/sdk-0.1.2-beta.0.tgz",
    integrity: "sha512-oTQioVgdEHjh+OaIg3sUDMHDwqFi9vkcecXGMgEczKf2c5QK+XGnq3SP+UObWW7MTmmH0R+AxEFFA5bucPtN7w==",
  };
  assert.throws(() => validateInstalledLock(candidate, changed), /nested candidate version mismatch/);
});
