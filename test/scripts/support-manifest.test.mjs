import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  DISCOVERY_DISPOSITION_VOCABULARY,
  ENVIRONMENT_VOCABULARY,
  EXECUTION_MODE_VOCABULARY,
  MANIFEST_PATH,
  PROJECT_ROOT,
  RASTER_SOURCE_REGISTRY_PATH,
  STATUS_VOCABULARY,
  buildPublicSurface,
  buildSupportProjection,
  capabilityTierByEnvironment,
  checkOutputs,
  generateOutputs,
  loadSupportManifest,
  readBarrelExports,
  renderCapabilityTierSection,
  renderProtocolSection,
  renderSurfaceTierSection,
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

test("the authoritative raster source registry satisfies its versioned schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "config/raster-source-registry.schema.json"), "utf8"),
  );
  const registry = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, RASTER_SOURCE_REGISTRY_PATH), "utf8"),
  );
  const validate = ajv.compile(schema);
  assert.equal(validate(registry), true, JSON.stringify(validate.errors));
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

test("raster source registry drift fails the support-manifest check", () => {
  assert.equal(manifest.rasterSourceRegistry, RASTER_SOURCE_REGISTRY_PATH);
  const wrong = clone(manifest);
  wrong.rasterSourceRegistry = "config/another-raster-registry.json";
  assert.match(validateSupportManifest(wrong).join("\n"), /must reference config\/raster-source-registry\.v1\.json/);
});

test("the discovery inventory covers every protocol and keeps static ownership fail-closed", () => {
  assert.deepEqual(manifest.discoveryInventory.dispositionVocabulary, DISCOVERY_DISPOSITION_VOCABULARY);
  assert.deepEqual(
    manifest.discoveryInventory.protocols.map((entry) => entry.id),
    manifest.protocols.map((entry) => entry.id),
  );
  assert.deepEqual(
    manifest.discoveryInventory.protocols
      .filter((entry) => entry.disposition === "source-backed")
      .map((entry) => entry.id)
      .sort(),
    [...manifest.connectProtocols].sort(),
  );
  assert.deepEqual(
    manifest.discoveryInventory.staticFormats.find((entry) => entry.id === "cog"),
    {
      id: "cog",
      disposition: "stac-classified",
      owner: "@honua/sdk-js/cog",
      autoClassification: "stac-evidence",
    },
  );
});

test("static format inventory drift fails closed against the runtime vocabulary", () => {
  const missing = clone(manifest);
  missing.discoveryInventory.staticFormats = missing.discoveryInventory.staticFormats.slice(1);
  assert.match(validateSupportManifest(missing).join("\n"), /must cover CONNECT_STATIC_FORMATS exactly once/);

  const added = clone(manifest);
  added.discoveryInventory.staticFormats.push({
    id: "invented-static-format",
    disposition: "explicitly-unsupported",
    owner: "connect()",
    autoClassification: "not-applicable",
  });
  assert.match(validateSupportManifest(added).join("\n"), /must cover CONNECT_STATIC_FORMATS exactly once/);

  const duplicate = clone(manifest);
  duplicate.discoveryInventory.staticFormats.push(clone(duplicate.discoveryInventory.staticFormats[0]));
  const duplicateFailures = validateSupportManifest(duplicate).join("\n");
  assert.match(duplicateFailures, /static format ids must be unique/);
  assert.match(duplicateFailures, /must cover CONNECT_STATIC_FORMATS exactly once/);

  const disposition = clone(manifest);
  disposition.discoveryInventory.staticFormats.find((entry) => entry.id === "cog").disposition = "source-backed";
  assert.match(validateSupportManifest(disposition).join("\n"), /COG static discovery must remain STAC-classified/);
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
  // Filter by value, not array position: `connectProtocols` leads with
  // "grpc" (matching the shared canonical `Protocol` union's own ordering),
  // so index 0 is not "ogc-features".
  unregistered.connectProtocols = unregistered.connectProtocols.filter((protocol) => protocol !== "ogc-features");
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

test("capability tiers partition every environment and cannot be authored per claim", () => {
  const tiered = capabilityTierByEnvironment(manifest);
  assert.deepEqual([...tiered.keys()].sort(), [...ENVIRONMENT_VOCABULARY].sort());
  assert.equal(tiered.get("honua-facade").honuaServerRequired, true);
  for (const environment of ENVIRONMENT_VOCABULARY.filter((value) => value !== "honua-facade")) {
    assert.equal(tiered.get(environment).honuaServerRequired, false, environment);
  }

  const unassigned = clone(manifest);
  unassigned.capabilityTiers[0].environments = unassigned.capabilityTiers[0].environments.filter(
    (environment) => environment !== "standalone",
  );
  assert.match(
    validateSupportManifest(unassigned).join("\n"),
    /environment standalone is not assigned to a capability tier/,
  );

  const doubleAssigned = clone(manifest);
  doubleAssigned.capabilityTiers[0].environments.push("honua-facade");
  assert.match(
    validateSupportManifest(doubleAssigned).join("\n"),
    /each environment must belong to exactly one capability tier/,
  );

  const unknownEnvironment = clone(manifest);
  unknownEnvironment.capabilityTiers[1].environments = ["honua-facade", "honua-fascade"];
  assert.match(
    validateSupportManifest(unknownEnvironment).join("\n"),
    /references unknown environment honua-fascade/,
  );
});

test("the Cesium scene surface is beta with an explicit, exhaustive export list", () => {
  const tier = manifest.packageLifecycle.surfaceTiers.find(
    (candidate) => candidate.surface === "@honua/app-platform/scene-workspace",
  );
  assert.ok(tier, "the scene workspace surface must declare a support tier");
  assert.equal(tier.status, "beta");

  const claim = manifest.supportClaims.find((candidate) => candidate.id === tier.claim);
  assert.equal(claim.status, "beta");
  assert.ok(claim.evidence.length > 0, "a beta claim must link evidence");

  // The forwarder's deprecation window is untouched by the promotion.
  const forwarder = manifest.packageLifecycle.entrypoints.find(
    (entrypoint) => entrypoint.subpath === "./scene-workspace",
  );
  assert.equal(forwarder.status, "deprecated");
  assert.equal(forwarder.replacement, "@honua/app-platform/scene-workspace");
  assert.equal(forwarder.replacementStatus, "beta");
  assert.equal(forwarder.removeIn, "0.2.0");

  // Nothing is promoted by proximity: the barrel is partitioned exactly.
  const barrelExports = readBarrelExports(tier.barrel);
  const classified = [...tier.exports, ...tier.heldBack.flatMap((group) => group.exports)];
  assert.deepEqual([...classified].sort(), [...barrelExports].sort());
  for (const group of tier.heldBack) assert.equal(group.status, "experimental");
  assert.ok(
    tier.heldBack.some((group) => group.exports.includes("mountSourceToCesium")),
    "the bounded Source-to-entity slice must stay experimental",
  );
  assert.ok(
    tier.heldBack.some((group) => group.exports.includes("SceneView")),
    "the server-attached SceneView container must stay experimental",
  );
  assert.ok(tier.exports.includes("createCesiumSceneAdapter"));
  assert.ok(tier.exports.includes("createSceneWorkspace"));
});

test("a surface tier fails closed on an unclassified, double-classified, or mistiered export", () => {
  const unclassified = clone(manifest);
  unclassified.packageLifecycle.surfaceTiers[0].exports = unclassified.packageLifecycle.surfaceTiers[0].exports.filter(
    (name) => name !== "createCesiumSceneAdapter",
  );
  assert.match(
    validateSupportManifest(unclassified).join("\n"),
    /does not classify exported symbol createCesiumSceneAdapter/,
  );

  const invented = clone(manifest);
  invented.packageLifecycle.surfaceTiers[0].exports.push("createCesiumSceneAdapterV2");
  assert.match(
    validateSupportManifest(invented).join("\n"),
    /classifies createCesiumSceneAdapterV2, which .* does not export/,
  );

  const doubleClassified = clone(manifest);
  doubleClassified.packageLifecycle.surfaceTiers[0].heldBack[0].exports.push("createCesiumSceneAdapter");
  assert.match(
    validateSupportManifest(doubleClassified).join("\n"),
    /classifies an export more than once/,
  );

  const selfHeld = clone(manifest);
  selfHeld.packageLifecycle.surfaceTiers[0].heldBack[0].status = "beta";
  assert.match(
    validateSupportManifest(selfHeld).join("\n"),
    /cannot hold exports back at its own status beta/,
  );

  const claimDisagrees = clone(manifest);
  claimDisagrees.packageLifecycle.surfaceTiers[0].status = "supported";
  assert.match(
    validateSupportManifest(claimDisagrees).join("\n"),
    /is supported but its claim scene-workspace-cesium is beta/,
  );

  const forwarderDrift = clone(manifest);
  for (const entrypoint of forwarderDrift.packageLifecycle.entrypoints) {
    if (entrypoint.subpath === "./scene-workspace") entrypoint.replacementStatus = undefined;
  }
  assert.match(
    validateSupportManifest(forwarderDrift).join("\n"),
    /must record replacementStatus beta/,
  );
});

test("the generated matrix publishes the surface tier split and its evidence", () => {
  const section = renderSurfaceTierSection(manifest);
  assert.match(section, /## Surface tiers/);
  assert.match(section, /\| `@honua\/app-platform\/scene-workspace` \| `beta` \|/);
  assert.match(section, /`@honua\/sdk-js\/scene-workspace`/);
  assert.match(section, /\[fixture: cesium-scene-adapter-fixtures\]/);
  assert.match(section, /Held back at `experimental`/);
  assert.match(section, /`mountSourceToCesium`/);
});

test("every server-attach claim carries a roadmap issue or an inherency statement", () => {
  const serverAttachTierIds = new Set(
    manifest.capabilityTiers.filter((tier) => tier.honuaServerRequired).map((tier) => tier.id),
  );
  const tiered = capabilityTierByEnvironment(manifest);
  const serverAttachClaims = manifest.supportClaims.filter((claim) =>
    serverAttachTierIds.has(tiered.get(claim.environment).id),
  );
  assert.ok(serverAttachClaims.length > 0);
  const facadeRequired = serverAttachClaims.filter((claim) => claim.status === "facade-required");
  assert.deepEqual(
    facadeRequired.map((claim) => claim.id).sort(),
    // OGC API Processes execution left this list in #1009: standalone execution
    // resolved its roadmap entry, so it is now an open-endpoint claim and must
    // NOT carry `serverAttach` (asserted below). MCP tools left it the same way
    // in #1005/#1018: the protocol-neutral tool contract shipped, so honua-mcp
    // is an open-endpoint claim and the hosted /mcp catalog is the upgrade path.
    ["compatibility-gate-facade", "map-package-facade", "realtime-facade"],
    "every facade-required claim must stay tiered as server-attach",
  );
  for (const claim of serverAttachClaims) {
    assert.ok(claim.serverAttach, `${claim.id} must declare serverAttach`);
    assert.ok(["inherent", "roadmap"].includes(claim.serverAttach.disposition), claim.id);
    assert.ok(claim.serverAttach.rationale.trim().length >= 20, claim.id);
    if (claim.serverAttach.disposition === "roadmap") {
      assert.match(claim.serverAttach.issue, /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[0-9]+$/, claim.id);
    } else {
      assert.equal(claim.serverAttach.issue, undefined, claim.id);
    }
  }
  for (const claim of manifest.supportClaims.filter((candidate) => !serverAttachClaims.includes(candidate))) {
    assert.equal(claim.serverAttach, undefined, `${claim.id} is open-endpoint and must not declare serverAttach`);
  }
});

test("server-attach metadata fails closed on a missing, unlinked, or over-linked rationale", () => {
  const missing = clone(manifest);
  const realtime = missing.supportClaims.find((claim) => claim.id === "realtime-facade");
  realtime.serverAttach = undefined;
  assert.match(
    validateSupportManifest(missing).join("\n"),
    /realtime-facade is server-attach and must declare serverAttach/,
  );

  const unlinked = clone(manifest);
  unlinked.supportClaims.find((claim) => claim.id === "realtime-facade").serverAttach.issue = "issue-393";
  assert.match(
    validateSupportManifest(unlinked).join("\n"),
    /realtime-facade serverAttach roadmap must link a GitHub issue/,
  );

  const overLinked = clone(manifest);
  overLinked.supportClaims.find((claim) => claim.id === "map-package-facade").serverAttach.issue =
    "https://github.com/honua-io/honua-sdk-js/issues/1";
  assert.match(
    validateSupportManifest(overLinked).join("\n"),
    /map-package-facade serverAttach is inherent and must not link a roadmap issue/,
  );

  const placeholder = clone(manifest);
  placeholder.supportClaims.find((claim) => claim.id === "map-package-facade").serverAttach.rationale = "because";
  assert.match(
    validateSupportManifest(placeholder).join("\n"),
    /map-package-facade serverAttach must state a reviewable rationale/,
  );

  const misapplied = clone(manifest);
  misapplied.supportClaims.find((claim) => claim.id === "wfs-standalone").serverAttach = {
    disposition: "inherent",
    rationale: "An open-endpoint claim has no server dependency to justify.",
  };
  assert.match(
    validateSupportManifest(misapplied).join("\n"),
    /wfs-standalone is not a server-attach claim and must not declare serverAttach/,
  );
});

test("the generated tier table projects every server-attach claim and its open-endpoint path", () => {
  const section = renderCapabilityTierSection(manifest);
  const tiered = capabilityTierByEnvironment(manifest);
  assert.match(section, /^## Capability tiers$/m);
  for (const tier of manifest.capabilityTiers) {
    assert.ok(section.includes(`| **${tier.label}** (\`${tier.id}\`) |`), tier.id);
    const claimCount = manifest.supportClaims.filter((claim) => tiered.get(claim.environment).id === tier.id).length;
    assert.ok(section.includes(`| ${claimCount} | ${tier.summary} |`), `${tier.id} claim count`);
  }
  for (const claim of manifest.supportClaims.filter((candidate) => candidate.serverAttach)) {
    assert.ok(section.includes(`| ${claim.label} | \`${claim.status}\` |`), claim.id);
    assert.ok(section.includes(claim.serverAttach.rationale), `${claim.id} rationale`);
    if (claim.serverAttach.disposition === "roadmap") {
      assert.ok(section.includes(`](${claim.serverAttach.issue})`), `${claim.id} roadmap link`);
    }
  }
});

test("the tiered README and matrix stay bound to the manifest counts", () => {
  const outputs = generateOutputs({ manifest, packageJson });
  const tiered = capabilityTierByEnvironment(manifest);
  const openTier = manifest.capabilityTiers.find((tier) => !tier.honuaServerRequired);
  const attachTier = manifest.capabilityTiers.find((tier) => tier.honuaServerRequired);
  const openCount = manifest.supportClaims.filter((claim) => tiered.get(claim.environment).id === openTier.id).length;
  const attachCount = manifest.supportClaims.length - openCount;

  const readme = outputs.get("README.md");
  assert.ok(
    readme.includes(`**Two deployment tiers, named up front.** ${openCount} of the ${manifest.supportClaims.length}`),
  );
  assert.match(readme, new RegExp(`${attachCount} are \`${attachTier.id}\``));
  assert.match(readme, /capability tiers table\]\(\.\/docs\/standalone-capability-matrix\.md#capability-tiers\)/);

  const matrix = outputs.get("docs/standalone-capability-matrix.md");
  assert.match(matrix, /\| Capability \| Tier \| Status \| Environment \|/);
  for (const claim of manifest.supportClaims) {
    assert.ok(matrix.includes(`| ${claim.label} | \`${tiered.get(claim.environment).id}\` |`), claim.id);
  }
  assert.match(outputs.get("docs/protocol-capability-matrix.md"), /Deployment tier is separate from status/);
});

test("the OGC discovery/execution line is represented as separate claims", () => {
  const claims = new Map(manifest.supportClaims.map((claim) => [claim.id, claim]));
  for (const family of ["tiles", "maps", "records"]) {
    const claim = claims.get(`ogc-${family}-standalone`);
    assert.equal(claim.status, "beta");
    assert.equal(claim.environment, "standalone");
    assert.equal(claim.executionMode, "discovery");
  }
  // Processes keeps two claims even though both are now standalone: discovery
  // evidence must never be readable as execution support. #1009 moved execution
  // off the facade, so the split is the only thing keeping the lanes distinct.
  const discovery = claims.get("ogc-processes-discovery-standalone");
  const execution = claims.get("ogc-processes-execution-standalone");
  assert.equal(discovery.status, "supported");
  assert.equal(discovery.environment, "standalone");
  assert.equal(discovery.executionMode, "discovery");
  assert.equal(execution.status, "experimental");
  assert.equal(execution.environment, "standalone");
  assert.equal(execution.executionMode, "native");
  assert.notDeepEqual(discovery.operations, execution.operations);
  // Execution is fixture/contract-proven only; no governed live lane has
  // executed a process yet, so it must remain experimental and must not borrow
  // the discovery lane's live evidence.
  assert.ok(discovery.evidence.includes("live-conformance"));
  assert.ok(!execution.evidence.includes("live-conformance"));
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
  assert.match(fixtureReadme, /guarded <!-- x-release-please-version -->/);
  assert.match(fixtureReadme, /version above is its\s+package baseline, not a claim/);
  assert.match(fixtureReadme, /tagged release documentation/);
  assert.doesNotMatch(fixtureReadme, /\(`0\.1\.0-beta(?:\.0)?`\)/);
});

test("INSTALL root ceilings and development identity are generated from support truth", () => {
  const outputs = generateOutputs({ manifest, packageJson });
  const install = outputs.get("INSTALL.md");
  const { rootRuntimeExports, rootTypeExports } = manifest.packageLifecycle.ceilings;

  assert.match(
    install,
    new RegExp(`package-root ceilings are ${rootRuntimeExports} runtime\\s+exports and ${rootTypeExports} declaration exports`),
  );
  assert.match(install, /package baseline can match the latest release\s+while the branch contains unreleased work/);
  assert.match(install, /config\/root-surface\.json/);
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
