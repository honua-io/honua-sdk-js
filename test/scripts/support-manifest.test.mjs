import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ENVIRONMENT_VOCABULARY,
  EXECUTION_MODE_VOCABULARY,
  MANIFEST_PATH,
  PROJECT_ROOT,
  STATUS_VOCABULARY,
  buildPublicSurface,
  buildSupportProjection,
  checkOutputs,
  generateOutputs,
  loadSupportManifest,
  renderProtocolSection,
  validateSupportManifest,
} from "../../scripts/support-manifest.mjs";

const manifest = loadSupportManifest();
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));

function clone(value) {
  return structuredClone(value);
}

test("the support manifest satisfies its versioned schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const manifestSchema = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "config/support-manifest.schema.json"), "utf8"),
  );
  const validateManifestSchema = ajv.compile(manifestSchema);
  assert.equal(validateManifestSchema(manifest), true, JSON.stringify(validateManifestSchema.errors));
});

test("the generic projection schema compiles and validates in an isolated offline Ajv", () => {
  const projectionSchema = JSON.parse(
    fs.readFileSync(
      path.join(PROJECT_ROOT, "support/contract/v1/schemas/support-projection.schema.json"),
      "utf8",
    ),
  );
  assert.doesNotMatch(JSON.stringify(projectionSchema), /support-manifest\.v1\.schema\.json/);
  const isolatedAjv = new Ajv2020({ allErrors: true, strict: false });
  const validateProjection = isolatedAjv.compile(projectionSchema);
  const projection = buildSupportProjection(manifest, packageJson);
  assert.equal(validateProjection(projection), true, JSON.stringify(validateProjection.errors));
});

test("all support statuses are explicit and the repository evidence exists", () => {
  assert.deepEqual(manifest.statusVocabulary, STATUS_VOCABULARY);
  assert.deepEqual(manifest.environmentVocabulary, ENVIRONMENT_VOCABULARY);
  assert.deepEqual(manifest.executionModeVocabulary, EXECUTION_MODE_VOCABULARY);
  assert.deepEqual(validateSupportManifest(manifest), []);
});

test("the protocol matrix distinguishes native defaults from opt-in client fallbacks", () => {
  const section = renderProtocolSection(manifest);
  assert.match(section, /Native \(`✓`\) claims mirror the default capability set/);
  assert.match(section, /Client-fallback \(`◐`\) claims are explicit\s+opt-in paths and are not protocol defaults/);
});

test("unknown environments and execution modes fail closed", () => {
  const environmentDrift = clone(manifest);
  environmentDrift.protocols[0].operationClaims[0].environment = "standlone";
  assert.match(validateSupportManifest(environmentDrift).join("\n"), /invalid environment standlone/);

  const modeDrift = clone(manifest);
  modeDrift.supportClaims[0].executionMode = "nativ";
  assert.match(validateSupportManifest(modeDrift).join("\n"), /invalid executionMode nativ/);

  const vocabularyDrift = clone(manifest);
  vocabularyDrift.environmentVocabulary.reverse();
  assert.match(validateSupportManifest(vocabularyDrift).join("\n"), /environmentVocabulary must be exactly/);
});

test("positive support claims cannot lose their evidence", () => {
  const changed = clone(manifest);
  changed.supportClaims.find((claim) => claim.id === "ogc-tiles-standalone").evidence = [];
  assert.match(validateSupportManifest(changed).join("\n"), /beta support claim must link evidence/);
});

test("every GeoServices operation group cites a release-gated fixture or pinned conformance suite", () => {
  const evidenceById = new Map(manifest.evidence.map((evidence) => [evidence.id, evidence]));
  for (const protocol of manifest.protocols.filter((candidate) => candidate.id.startsWith("geoservices-"))) {
    for (const claim of protocol.operationClaims) {
      assert.ok(
        claim.evidence.some((id) => {
          const evidence = evidenceById.get(id);
          return (
            evidence &&
            ["fixture", "conformance"].includes(evidence.kind) &&
            ["release-gated", "version-pinned"].includes(evidence.freshnessPolicy)
          );
        }),
        `${protocol.id} ${claim.operations.join(",")} lacks release-gated fixture or pinned conformance evidence`,
      );
    }
  }
  assert.equal(manifest.supportClaims.some((claim) => claim.id === "geoservices-map-image-standalone"), false);
  for (const claimId of ["geoservices-map-standalone", "geoservices-image-standalone"]) {
    const readClaim = manifest.supportClaims.find((claim) => claim.id === claimId);
    assert.ok(readClaim, `${claimId} is missing`);
    assert.ok(
      readClaim.evidence.some(
        (id) => evidenceById.get(id)?.kind === "fixture" && evidenceById.get(id)?.freshnessPolicy === "release-gated",
      ),
      `${claimId} needs release-gated fixture evidence`,
    );
  }
});

test("unknown protocol operations and product capabilities fail validation", () => {
  const protocolDrift = clone(manifest);
  protocolDrift.protocols[0].operationClaims[0].operations.push("invented-operation");
  assert.match(validateSupportManifest(protocolDrift).join("\n"), /unknown protocol operation invented-operation/);

  const productDrift = clone(manifest);
  productDrift.supportClaims[0].operations.push("invented-capability");
  assert.match(validateSupportManifest(productDrift).join("\n"), /unknown claim capability invented-capability/);
});

test("every protocol operation is bound to one reviewed, evidenced surface", () => {
  const missing = clone(manifest);
  missing.operationSurfaces = missing.operationSurfaces.slice(1);
  assert.match(validateSupportManifest(missing).join("\n"), /protocol operation query has no reviewed operation surface/);

  const unknown = clone(manifest);
  unknown.operationSurfaces[0].operation = "invented-operation";
  assert.match(
    validateSupportManifest(unknown).join("\n"),
    /operation surface references unknown protocol operation invented-operation/,
  );

  const noEvidence = clone(manifest);
  noEvidence.operationSurfaces[0].evidence = [];
  assert.match(validateSupportManifest(noEvidence).join("\n"), /operation surface query must link evidence/);
});

test("connect() coverage stays separate from Source capabilities and discovery claims cannot drift", () => {
  const unregistered = clone(manifest);
  unregistered.connectProtocols = unregistered.connectProtocols.slice(1);
  assert.match(
    validateSupportManifest(unregistered).join("\n"),
    /ogc-features-standalone claims connect\(\) discovery for unregistered protocol ogc-features/,
  );

  const missingClaim = clone(manifest);
  missingClaim.supportClaims.find((claim) => claim.id === "wfs-standalone").operations = ["query"];
  assert.match(
    validateSupportManifest(missingClaim).join("\n"),
    /connect\(\) protocol wfs must have exactly one positive discovery support claim/,
  );
});

test("support claims cannot reference an undeclared protocol family", () => {
  const changed = clone(manifest);
  changed.supportClaims[0].protocol = "invented-protocol";
  assert.match(validateSupportManifest(changed).join("\n"), /references unknown protocol invented-protocol/);
});

test("protocol-bound support claims cannot promote unsupported protocol operations", () => {
  const changed = clone(manifest);
  changed.supportClaims.find((claim) => claim.id === "geoservices-image-standalone").operations.push("applyEdits");
  assert.match(
    validateSupportManifest(changed).join("\n"),
    /geoservices-image-standalone positively claims applyEdits for geoservices-image-service/,
  );
});

test("the generic projection contracts every v2 sample catalog tier and protocol token", () => {
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
      Object.hasOwn(contract.supportTierMap, sample.supportTier),
      `${sample.id} has uncontracted supportTier ${sample.supportTier}`,
    );
    for (const protocol of sample.protocols) {
      const mapping = contract.protocols[protocol];
      assert.ok(mapping, `${sample.id} has uncontracted protocol ${protocol}`);
      for (const protocolId of mapping.protocolIds) assert.ok(canonicalProtocols.has(protocolId), protocolId);
      for (const claimId of mapping.supportClaimIds) assert.ok(claimIds.has(claimId), claimId);
    }
  }
  assert.equal(contract.format, "honua.sdk.sample-catalog.v2");
  assert.equal(contract.source, "samples/catalog.v2.json");
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

test("README release display is derived from package.json", () => {
  const fixturePackage = { ...packageJson, version: "9.8.7-rc.3" };
  const outputs = generateOutputs({ manifest, packageJson: fixturePackage });
  const fixtureReadme = outputs.get("README.md");
  assert.match(fixtureReadme, /\*\*Release status: beta\*\* \(`9\.8\.7-rc\.3`\)/);
  assert.doesNotMatch(fixtureReadme, /\(`0\.1\.0-beta(?:\.0)?`\)/);
});

test("the published generic projection identifies its source and consumers", () => {
  const projection = buildSupportProjection(manifest, packageJson);
  assert.equal(projection.format, "honua.sdk.support-projection.v1");
  assert.equal(projection.generatedFrom, MANIFEST_PATH);
  assert.equal(projection.sdk.version, packageJson.version);
  assert.deepEqual(projection.protocolOperations, manifest.protocolOperations);
  assert.deepEqual(projection.claimCapabilities, manifest.claimCapabilities);
  assert.deepEqual(projection.claimOnlyProtocols, manifest.claimOnlyProtocols);
  assert.deepEqual(projection.environmentVocabulary, manifest.environmentVocabulary);
  assert.deepEqual(projection.executionModeVocabulary, manifest.executionModeVocabulary);
  assert.deepEqual(projection.consumerContracts, manifest.consumerContracts);
});
