import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { validatePackageSet } from "./installed-certification-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Read existing release data after the upstream candidate-input action admits it. */
export async function readInstalledCandidateInput({ repositoryRoot = root, env = process.env } = {}) {
  const legacy = JSON.parse(await readFile(path.join(repositoryRoot, "config/installed-package-certification.v1.json"), "utf8"));
  const mode = env.HONUA_INSTALLED_CANDIDATE_MODE ?? "legacy-regression";
  if (mode === "legacy-regression") return legacy;
  assert.equal(mode, "release-snapshot", "unknown installed candidate input mode");
  for (const key of ["HONUA_RELEASE_REVIEWED_SHA", "HONUA_RELEASE_CANDIDATE_SHA"]) {
    assert.match(env[key] ?? "", /^[a-f0-9]{40}$/, `${key} must name an immutable release commit`);
  }
  assert.ok(env.HONUA_RELEASE_INPUT_DIRECTORY, "release-snapshot requires HONUA_RELEASE_INPUT_DIRECTORY");
  const directory = path.resolve(env.HONUA_RELEASE_INPUT_DIRECTORY);
  const readInput = async (name, digestKey) => {
    assert.match(env[digestKey] ?? "", /^[a-f0-9]{64}$/, `${digestKey} must bind the upstream-adopted bytes`);
    const bytes = await readFile(path.join(directory, name));
    const digest = sha256(bytes);
    assert.equal(digest, env[digestKey], `${name} differs from upstream-adopted bytes`);
    return { document: parse(bytes.toString("utf8")), digest: `sha256:${digest}` };
  };
  const manifest = await readInput("platform-manifest.yaml", "HONUA_RELEASE_MANIFEST_SHA256");
  const matrix = await readInput("compatibility-matrix.yaml", "HONUA_RELEASE_MATRIX_SHA256");
  assert.ok(matrix.document && typeof matrix.document === "object", "compatibility matrix must be a mapping");
  const artifacts = JSON.parse(await readFile(path.join(repositoryRoot, "config/release-artifacts.v1.json"), "utf8"));
  const required = artifacts.included.map((artifact) => artifact.npmName);
  assert.ok(typeof manifest.document.platformRelease === "string" && manifest.document.platformRelease.trim(),
    "release snapshot requires a nonempty platformRelease");
  const rows = Object.values(manifest.document.clientArtifacts ?? {}).filter((row) => row?.ecosystem === "npm");
  const packages = required.map((coordinate) => {
    const matching = rows.filter((row) => row.package === coordinate);
    assert.equal(matching.length, 1, `${coordinate}: release snapshot must declare exactly one npm artifact`);
    const row = matching[0];
    assert.notEqual(row.required, false, `${coordinate}: SDK artifact cannot be optional in upstream verification`);
    assert.equal(row.publicationState, "published", `${coordinate}: candidate artifact is not published`);
    assert.match(row.sourceSha ?? "", /^[a-f0-9]{40}$/, `${coordinate}: missing package source revision`);
    assert.equal(row.repository, artifacts.repository, `${coordinate}: unexpected publication repository`);
    assert.match(row.filename ?? "", /^[A-Za-z0-9._-]+\.tgz$/, `${coordinate}: missing exact npm tarball filename`);
    const registry = row.registry ?? artifacts.registry;
    return { coordinate, version: row.version, integrity: row.integrity, registry,
      tarball: `${registry.replace(/\/$/, "")}/${coordinate}/-/${row.filename}`,
      sourceRevision: row.sourceSha, ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}) };
  });
  const main = packages.find((entry) => entry.coordinate === legacy.package.coordinate);
  assert.ok(main, "release snapshot omits the coordinated SDK package");
  for (const artifact of artifacts.included.filter((entry) => entry.sourceBinding === "sealed-js-sdk-tag")) {
    const selected = packages.find((entry) => entry.coordinate === artifact.npmName);
    assert.equal(selected.version, main.version, `${artifact.npmName}: split package differs from the coordinated SDK version`);
    assert.equal(selected.sourceRevision, main.sourceRevision, `${artifact.npmName}: split package differs from the sealed SDK source`);
  }
  const server = manifest.document.components?.["honua-server"];
  assert.match(server?.digest ?? "", /^sha256:[a-f0-9]{64}$/, "release snapshot requires the exact server digest");
  assert.match(server?.sha ?? "", /^[a-f0-9]{40}$/, "release snapshot requires the server source revision");
  assert.match(server?.image ?? "", /^ghcr\.io\/honua-io\/honua-server(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/,
    "release snapshot requires the canonical server image");
  if (server.image.includes("@")) assert.equal(server.image.split("@")[1], server.digest, "server image digest drift");
  const image = `${server.image.split("@")[0].replace(/:[^/]+$/, "")}@${server.digest}`;
  const candidate = { ...legacy, release: manifest.document.platformRelease,
    package: { coordinate: main.coordinate, version: main.version, integrity: main.integrity, registry: main.registry,
      sourceRevision: main.sourceRevision, tarball: main.tarball },
    packages, server: { image, digest: server.digest, sourceRevision: server.sha },
    releaseInput: { kind: "honua-release-snapshot", repository: "honua-io/honua-release",
      reviewedRevision: env.HONUA_RELEASE_REVIEWED_SHA, candidateRevision: env.HONUA_RELEASE_CANDIDATE_SHA,
      manifest: { path: "platform-manifest.yaml", digest: manifest.digest },
      matrix: { path: "compatibility-matrix.yaml", digest: matrix.digest } } };
  validatePackageSet(candidate, required);
  return candidate;
}
