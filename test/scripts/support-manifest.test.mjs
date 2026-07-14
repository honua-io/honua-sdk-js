import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  MANIFEST_PATH,
  PROJECT_ROOT,
  STATUS_VOCABULARY,
  buildPublicSurface,
  buildSupportProjection,
  checkOutputs,
  generateOutputs,
  loadSupportManifest,
  validateSupportManifest,
} from "../../scripts/support-manifest.mjs";

const manifest = loadSupportManifest();
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));

function clone(value) {
  return structuredClone(value);
}

test("the support manifest and generic projection satisfy their versioned schemas", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const manifestSchema = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "config/support-manifest.schema.json"), "utf8"),
  );
  const projectionSchema = JSON.parse(
    fs.readFileSync(
      path.join(PROJECT_ROOT, "support/contract/v1/schemas/support-projection.schema.json"),
      "utf8",
    ),
  );
  const validateManifestSchema = ajv.compile(manifestSchema);
  assert.equal(validateManifestSchema(manifest), true, JSON.stringify(validateManifestSchema.errors));
  const projection = buildSupportProjection(manifest, packageJson);
  const validateProjection = ajv.compile(projectionSchema);
  assert.equal(validateProjection(projection), true, JSON.stringify(validateProjection.errors));
});

test("all support statuses are explicit and the repository evidence exists", () => {
  assert.deepEqual(manifest.statusVocabulary, STATUS_VOCABULARY);
  assert.deepEqual(validateSupportManifest(manifest), []);
});

test("positive support claims cannot lose their evidence", () => {
  const changed = clone(manifest);
  changed.supportClaims.find((claim) => claim.id === "ogc-tiles-standalone").evidence = [];
  assert.match(validateSupportManifest(changed).join("\n"), /beta support claim must link evidence/);
});

test("unknown protocol operations and product capabilities fail validation", () => {
  const protocolDrift = clone(manifest);
  protocolDrift.protocols[0].operationClaims[0].operations.push("invented-operation");
  assert.match(validateSupportManifest(protocolDrift).join("\n"), /unknown protocol operation invented-operation/);

  const productDrift = clone(manifest);
  productDrift.supportClaims[0].operations.push("invented-capability");
  assert.match(validateSupportManifest(productDrift).join("\n"), /unknown claim capability invented-capability/);
});

test("support claims cannot reference an undeclared protocol family", () => {
  const changed = clone(manifest);
  changed.supportClaims[0].protocol = "invented-protocol";
  assert.match(validateSupportManifest(changed).join("\n"), /references unknown protocol invented-protocol/);
});

test("the generic projection contracts every sample catalog status and protocol token", () => {
  const projection = buildSupportProjection(manifest, packageJson);
  const catalog = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, projection.consumerContracts.sampleCatalog.source), "utf8"),
  );
  const contract = projection.consumerContracts.sampleCatalog;
  assert.equal(catalog.format, contract.format);
  const canonicalProtocols = new Set([
    ...projection.protocols.map((protocol) => protocol.id),
    ...projection.claimOnlyProtocols,
  ]);
  const claimIds = new Set(projection.supportClaims.map((claim) => claim.id));
  for (const sample of catalog.samples) {
    assert.ok(
      Object.hasOwn(contract.supportStatusMap, sample.supportStatus),
      `${sample.id} has uncontracted supportStatus ${sample.supportStatus}`,
    );
    for (const protocol of sample.protocols) {
      const mapping = contract.protocols[protocol];
      assert.ok(mapping, `${sample.id} has uncontracted protocol ${protocol}`);
      for (const protocolId of mapping.protocolIds) assert.ok(canonicalProtocols.has(protocolId), protocolId);
      for (const claimId of mapping.supportClaimIds) assert.ok(claimIds.has(claimId), claimId);
    }
  }
  assert.equal(contract.versionUpgrade.nextFormat, "honua.sdk.sample-catalog.v2");
  assert.match(contract.versionUpgrade.issue, /issues\/540$/);
});

test("sample consumer mappings reject undeclared protocol and support claim ids", () => {
  const protocolDrift = clone(manifest);
  protocolDrift.consumerContracts.sampleCatalog.protocols.ogc.protocolIds.push("invented-protocol");
  assert.match(validateSupportManifest(protocolDrift).join("\n"), /maps to unknown protocol invented-protocol/);

  const claimDrift = clone(manifest);
  claimDrift.consumerContracts.sampleCatalog.protocols.mcp.supportClaimIds.push("invented-claim");
  assert.match(validateSupportManifest(claimDrift).join("\n"), /maps to unknown support claim invented-claim/);
});

test("the generated public surface preserves package export parity", () => {
  const surface = buildPublicSurface(manifest);
  const projectedSubpaths = surface.entrypoints.map((entrypoint) => entrypoint.subpath).sort();
  assert.deepEqual(projectedSubpaths, Object.keys(packageJson.exports).sort());
  assert.deepEqual(
    surface,
    JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "config/public-surface.json"), "utf8")),
  );
  for (const publishedPath of [
    "config/support-manifest.v1.json",
    "config/support-manifest.schema.json",
    "support/projections",
    "support/contract/v1/schemas",
  ]) {
    assert.ok(packageJson.files.includes(publishedPath), `package.json must publish ${publishedPath}`);
  }
});

test("the OGC raw/facade line is represented as separate claims", () => {
  const claims = new Map(manifest.supportClaims.map((claim) => [claim.id, claim]));
  for (const family of ["tiles", "maps", "records"]) {
    const claim = claims.get(`ogc-${family}-standalone`);
    assert.equal(claim.status, "beta");
    assert.equal(claim.environment, "standalone");
    assert.equal(claim.executionMode, "discovery");
  }
  assert.equal(claims.get("ogc-processes-discovery-standalone").status, "experimental");
  assert.equal(claims.get("ogc-processes-execution-facade").status, "facade-required");
});

test("generated output is deterministic and drift identifies the changed projection", () => {
  const first = generateOutputs({ manifest, packageJson });
  const second = generateOutputs({ manifest, packageJson });
  assert.deepEqual([...first], [...second]);
  assert.deepEqual(checkOutputs(first), []);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-support-manifest-"));
  try {
    for (const [relativePath, content] of first) {
      const filename = path.join(temporaryRoot, relativePath);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }
    fs.appendFileSync(path.join(temporaryRoot, "README.md"), "\nmanual drift\n");
    assert.deepEqual(checkOutputs(first, temporaryRoot), ["README.md"]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the published generic projection identifies its source and consumers", () => {
  const projection = buildSupportProjection(manifest, packageJson);
  assert.equal(projection.format, "honua.sdk.support-projection.v1");
  assert.equal(projection.generatedFrom, MANIFEST_PATH);
  assert.equal(projection.sdk.version, packageJson.version);
  assert.deepEqual(projection.protocolOperations, manifest.protocolOperations);
  assert.deepEqual(projection.claimCapabilities, manifest.claimCapabilities);
  assert.deepEqual(projection.claimOnlyProtocols, manifest.claimOnlyProtocols);
  assert.deepEqual(projection.consumerContracts, manifest.consumerContracts);
});
