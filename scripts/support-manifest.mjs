#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "config/support-manifest.v1.json";
export const RASTER_SOURCE_REGISTRY_PATH = "config/raster-source-registry.v1.json";
export const STATUS_VOCABULARY = [
  "supported",
  "beta",
  "experimental",
  "deprecated",
  "unsupported",
  "facade-required",
];
export const ENVIRONMENT_VOCABULARY = [
  "build-time",
  "client-only",
  "honua-facade",
  "protocol-adapter",
  "standalone",
];
export const EXECUTION_MODE_VOCABULARY = [
  "client-fallback",
  "discovery",
  "facade",
  "native",
  "static",
  "transport",
];
export const SERVER_ATTACH_DISPOSITION_VOCABULARY = ["inherent", "roadmap"];
export const DISCOVERY_DISPOSITION_VOCABULARY = [
  "source-backed",
  "operation-only",
  "stac-classified",
  "renderer-native",
  "explicitly-unsupported",
];
const DISCOVERY_AUTO_CLASSIFICATIONS = [
  "structural",
  "structural-marker",
  "explicit-only",
  "stac-evidence",
  "not-applicable",
];

const GENERATED_PATHS = {
  publicSurface: "config/public-surface.json",
  supportProjectionSchema: "support/contract/v1/schemas/support-projection.schema.json",
  supportProjection: "support/projections/sdk-support.v1.json",
  discoveryInventory: "support/projections/connect-discovery-inventory.v1.json",
  rasterSourceRegistry: "support/projections/raster-source-registry.v1.json",
};

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

export function loadSupportManifest(projectRoot = PROJECT_ROOT) {
  return readJson(path.join(projectRoot, MANIFEST_PATH));
}

function unique(values) {
  return new Set(values).size === values.length;
}

function positiveStatus(status) {
  return ["supported", "beta", "experimental", "facade-required"].includes(status);
}

/**
 * Names re-exported by a barrel entrypoint, in declaration order.
 *
 * Surface tiers (issue #931) are enumerated symbol by symbol so a tier cannot be
 * acquired by proximity: a new export in a promoted directory has to be
 * classified in the manifest before the barrel will validate.
 */
export function readBarrelExports(relativePath, projectRoot = PROJECT_ROOT) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n]*\/\/[^\n]*$/gm, "");
  if (/^\s*export\s+\*/m.test(withoutComments)) {
    throw new Error(`${relativePath} re-exports a whole module; a tiered barrel must name every export`);
  }
  const names = [];
  const blocks = withoutComments.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]+"\s*;/g);
  for (const block of blocks) {
    for (const clause of block[1].split(",")) {
      const name = clause.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
      if (name) names.push(name);
    }
  }
  return names;
}

function validateSurfaceTiers(manifest, projectRoot, checkSourceFiles, fail) {
  const tiers = manifest.packageLifecycle?.surfaceTiers ?? [];
  if (!unique(tiers.map((tier) => tier.surface))) fail("surface tier names must be unique");
  const claimIds = new Set((manifest.supportClaims ?? []).map((claim) => claim.id));
  const entrypointBySubpath = new Map(
    (manifest.packageLifecycle?.entrypoints ?? []).map((entrypoint) => [entrypoint.subpath, entrypoint]),
  );
  for (const tier of tiers) {
    if (!STATUS_VOCABULARY.includes(tier.status)) {
      fail(`surface tier ${tier.surface} has invalid status ${tier.status ?? "missing"}`);
    }
    if (!claimIds.has(tier.claim)) {
      fail(`surface tier ${tier.surface} references unknown support claim ${tier.claim}`);
    } else {
      const claim = manifest.supportClaims.find((candidate) => candidate.id === tier.claim);
      if (claim.status !== tier.status) {
        fail(`surface tier ${tier.surface} is ${tier.status} but its claim ${claim.id} is ${claim.status}`);
      }
    }
    if (tier.sdkForwarder !== undefined) {
      const entrypoint = entrypointBySubpath.get(tier.sdkForwarder);
      if (!entrypoint) {
        fail(`surface tier ${tier.surface} names unknown SDK forwarder ${tier.sdkForwarder}`);
      } else if (entrypoint.replacement !== tier.surface) {
        fail(`SDK forwarder ${tier.sdkForwarder} does not replace with ${tier.surface}`);
      } else if (entrypoint.replacementStatus !== tier.status) {
        fail(`SDK forwarder ${tier.sdkForwarder} must record replacementStatus ${tier.status}`);
      }
    }
    const classified = [...tier.exports, ...(tier.heldBack ?? []).flatMap((group) => group.exports)];
    if (!unique(classified)) fail(`surface tier ${tier.surface} classifies an export more than once`);
    for (const group of tier.heldBack ?? []) {
      if (!STATUS_VOCABULARY.includes(group.status)) {
        fail(`surface tier ${tier.surface} holds exports back at invalid status ${group.status ?? "missing"}`);
      }
      if (group.status === tier.status) {
        fail(`surface tier ${tier.surface} cannot hold exports back at its own status ${group.status}`);
      }
    }
    if (!checkSourceFiles) continue;
    let barrelExports;
    try {
      barrelExports = readBarrelExports(tier.barrel, projectRoot);
    } catch (error) {
      fail(`surface tier ${tier.surface}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const classifiedSet = new Set(classified);
    for (const name of barrelExports) {
      if (!classifiedSet.has(name)) {
        fail(`surface tier ${tier.surface} does not classify exported symbol ${name} from ${tier.barrel}`);
      }
    }
    const barrelSet = new Set(barrelExports);
    for (const name of classified) {
      if (!barrelSet.has(name)) {
        fail(`surface tier ${tier.surface} classifies ${name}, which ${tier.barrel} does not export`);
      }
    }
  }
}

const ROADMAP_ISSUE_PATTERN = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/[0-9]+$/;

/**
 * Deployment tiering (issue #1006): which capabilities work against any
 * standards-speaking endpoint, and which only execute after attaching to a
 * Honua Server facade. The tier is never authored per claim — it is the claim's
 * `environment` read through the manifest's own `capabilityTiers` partition, so
 * a new environment cannot enter the vocabulary without being tiered.
 */
export function capabilityTierByEnvironment(manifest) {
  const byEnvironment = new Map();
  for (const tier of manifest.capabilityTiers ?? []) {
    for (const environment of tier.environments ?? []) byEnvironment.set(environment, tier);
  }
  return byEnvironment;
}

export function capabilityTierFor(manifest, environment) {
  return capabilityTierByEnvironment(manifest).get(environment);
}

function validateCapabilityTiers(manifest, fail) {
  const tiers = manifest.capabilityTiers ?? [];
  if (tiers.length === 0) {
    fail("capabilityTiers must partition the environment vocabulary");
    return;
  }
  if (!unique(tiers.map((tier) => tier.id))) fail("capability tier ids must be unique");
  if (!tiers.some((tier) => tier.honuaServerRequired === true)) {
    fail("capabilityTiers must declare one tier that requires Honua Server");
  }
  if (!tiers.some((tier) => tier.honuaServerRequired === false)) {
    fail("capabilityTiers must declare one tier that requires no Honua infrastructure");
  }
  const assigned = [];
  for (const tier of tiers) {
    if (typeof tier.summary !== "string" || tier.summary.length === 0) {
      fail(`capability tier ${tier.id} must summarise what the tier means`);
    }
    for (const environment of tier.environments ?? []) {
      if (!ENVIRONMENT_VOCABULARY.includes(environment)) {
        fail(`capability tier ${tier.id} references unknown environment ${environment}`);
      }
      assigned.push(environment);
    }
  }
  if (!unique(assigned)) fail("each environment must belong to exactly one capability tier");
  for (const environment of ENVIRONMENT_VOCABULARY) {
    if (!assigned.includes(environment)) fail(`environment ${environment} is not assigned to a capability tier`);
  }
}

function validateServerAttach(claim, tier, fail) {
  const serverAttach = claim.serverAttach;
  if (!tier?.honuaServerRequired) {
    if (serverAttach) fail(`${claim.id} is not a server-attach claim and must not declare serverAttach`);
    return;
  }
  if (!serverAttach) {
    fail(`${claim.id} is server-attach and must declare serverAttach with a roadmap issue or an inherency rationale`);
    return;
  }
  if (!SERVER_ATTACH_DISPOSITION_VOCABULARY.includes(serverAttach.disposition)) {
    fail(`${claim.id} has invalid serverAttach disposition ${serverAttach.disposition ?? "missing"}`);
  }
  if (typeof serverAttach.rationale !== "string" || serverAttach.rationale.trim().length < 20) {
    fail(`${claim.id} serverAttach must state a reviewable rationale`);
  }
  if (serverAttach.disposition === "roadmap") {
    if (!ROADMAP_ISSUE_PATTERN.test(serverAttach.issue ?? "")) {
      fail(`${claim.id} serverAttach roadmap must link a GitHub issue for the open-endpoint path`);
    }
  } else if (serverAttach.issue !== undefined) {
    fail(`${claim.id} serverAttach is inherent and must not link a roadmap issue`);
  }
}

export function validateSupportManifest(manifest, { projectRoot = PROJECT_ROOT, checkEvidencePaths = true } = {}) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (manifest.format !== "honua.sdk.support-manifest.v1" || manifest.schemaVersion !== 1) {
    fail("manifest must use honua.sdk.support-manifest.v1 schema version 1");
  }
  if (manifest.rasterSourceRegistry !== RASTER_SOURCE_REGISTRY_PATH) {
    fail(`rasterSourceRegistry must reference ${RASTER_SOURCE_REGISTRY_PATH}`);
  } else {
    try {
      const registry = readJson(path.join(projectRoot, manifest.rasterSourceRegistry));
      if (registry.format !== "honua.sdk.raster-source-registry.v1" || registry.schemaVersion !== 1) {
        fail("raster source registry must use honua.sdk.raster-source-registry.v1 schema version 1");
      }
      const ids = (registry.sources ?? []).map((entry) => entry.id);
      if (!unique(ids)) fail("raster source registry ids must be unique");
      for (const entry of registry.sources ?? []) {
        if (!unique(entry.operations ?? []) || !unique(entry.discoveryOperations ?? [])) {
          fail(`raster source registry ${entry.id} operations must be unique`);
        }
      }
    } catch (error) {
      fail(`could not read raster source registry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (JSON.stringify(manifest.statusVocabulary) !== JSON.stringify(STATUS_VOCABULARY)) {
    fail(`statusVocabulary must be exactly: ${STATUS_VOCABULARY.join(", ")}`);
  }
  if (JSON.stringify(manifest.environmentVocabulary) !== JSON.stringify(ENVIRONMENT_VOCABULARY)) {
    fail(`environmentVocabulary must be exactly: ${ENVIRONMENT_VOCABULARY.join(", ")}`);
  }
  if (JSON.stringify(manifest.executionModeVocabulary) !== JSON.stringify(EXECUTION_MODE_VOCABULARY)) {
    fail(`executionModeVocabulary must be exactly: ${EXECUTION_MODE_VOCABULARY.join(", ")}`);
  }
  if (!STATUS_VOCABULARY.includes(manifest.sdk?.releaseStatus)) {
    fail(`SDK release status is invalid: ${manifest.sdk?.releaseStatus ?? "missing"}`);
  }
  validateCapabilityTiers(manifest, fail);

  const freshnessPolicies = new Set(Object.keys(manifest.freshnessPolicies ?? {}));
  const evidenceIds = (manifest.evidence ?? []).map((item) => item.id);
  if (!unique(evidenceIds)) fail("evidence ids must be unique");
  const evidenceById = new Map((manifest.evidence ?? []).map((item) => [item.id, item]));
  for (const evidence of manifest.evidence ?? []) {
    if (!evidence.id || !["fixture", "integration", "live", "conformance"].includes(evidence.kind)) {
      fail(`evidence ${evidence.id ?? "<missing>"} has an invalid kind`);
    }
    if (!freshnessPolicies.has(evidence.freshnessPolicy)) {
      fail(`evidence ${evidence.id} references unknown freshness policy ${evidence.freshnessPolicy}`);
    }
    if (path.isAbsolute(evidence.path) || evidence.path.includes("..")) {
      fail(`evidence ${evidence.id} path must be repository-relative`);
    } else if (checkEvidencePaths && !fs.existsSync(path.join(projectRoot, evidence.path))) {
      fail(`evidence ${evidence.id} path does not exist: ${evidence.path}`);
    }
  }

  const protocolOperationSet = new Set(manifest.protocolOperations ?? []);
  const claimCapabilitySet = new Set([...(manifest.protocolOperations ?? []), ...(manifest.claimCapabilities ?? [])]);
  if (!unique(manifest.protocolOperations ?? [])) fail("protocolOperations must be unique");
  if (!unique(manifest.claimCapabilities ?? [])) fail("claimCapabilities must be unique");
  if (claimCapabilitySet.size !== (manifest.protocolOperations?.length ?? 0) + (manifest.claimCapabilities?.length ?? 0)) {
    fail("protocolOperations and claimCapabilities must not overlap");
  }
  const operationSurfaceOperations = (manifest.operationSurfaces ?? []).map((entry) => entry.operation);
  if (!unique(operationSurfaceOperations)) fail("operation surfaces must assign each operation exactly once");
  for (const surface of manifest.operationSurfaces ?? []) {
    if (!protocolOperationSet.has(surface.operation)) {
      fail(`operation surface references unknown protocol operation ${surface.operation}`);
    }
    if (!["canonical-source", "typed-adapter"].includes(surface.kind)) {
      fail(`operation surface ${surface.operation} has invalid kind ${surface.kind ?? "missing"}`);
    }
    if (typeof surface.surface !== "string" || surface.surface.length === 0) {
      fail(`operation surface ${surface.operation} must name a concrete surface`);
    }
    if ((surface.evidence ?? []).length === 0) {
      fail(`operation surface ${surface.operation} must link evidence`);
    }
    for (const evidenceId of surface.evidence ?? []) {
      if (!evidenceById.has(evidenceId)) {
        fail(`operation surface ${surface.operation} references unknown evidence ${evidenceId}`);
      }
    }
  }
  for (const operation of manifest.protocolOperations ?? []) {
    if (!operationSurfaceOperations.includes(operation)) {
      fail(`protocol operation ${operation} has no reviewed operation surface`);
    }
  }
  const protocolIds = (manifest.protocols ?? []).map((protocol) => protocol.id);
  if (!unique(protocolIds)) fail("protocol ids must be unique");
  if (!unique(manifest.connectProtocols ?? [])) fail("connectProtocols must be unique");
  for (const protocolId of manifest.connectProtocols ?? []) {
    if (!protocolIds.includes(protocolId)) fail(`connect() references unknown protocol ${protocolId}`);
  }
  validateDiscoveryInventory(manifest, protocolIds, projectRoot, fail);
  if (!unique(manifest.claimOnlyProtocols ?? [])) fail("claimOnlyProtocols must be unique");
  for (const protocolId of manifest.claimOnlyProtocols ?? []) {
    if (protocolIds.includes(protocolId)) fail(`claim-only protocol duplicates a canonical protocol: ${protocolId}`);
  }
  const usedStatuses = new Set([manifest.sdk?.releaseStatus]);
  const positiveOperationsByProtocol = new Map();

  for (const protocol of manifest.protocols ?? []) {
    if (protocol.defaultOperationStatus !== "unsupported") {
      fail(`${protocol.id} defaultOperationStatus must be unsupported`);
    }
    usedStatuses.add(protocol.defaultOperationStatus);
    const claimedOperations = [];
    const positiveOperations = new Set();
    for (const claim of protocol.operationClaims ?? []) {
      usedStatuses.add(claim.status);
      if (!STATUS_VOCABULARY.includes(claim.status)) fail(`${protocol.id} has invalid status ${claim.status}`);
      if (!ENVIRONMENT_VOCABULARY.includes(claim.environment)) {
        fail(`${protocol.id} has invalid environment ${claim.environment ?? "missing"}`);
      }
      if (!EXECUTION_MODE_VOCABULARY.includes(claim.executionMode)) {
        fail(`${protocol.id} has invalid executionMode ${claim.executionMode ?? "missing"}`);
      }
      if (positiveStatus(claim.status) && (claim.evidence ?? []).length === 0) {
        fail(`${protocol.id} ${claim.status} operation claim must link evidence`);
      }
      for (const operation of claim.operations ?? []) {
        if (!protocolOperationSet.has(operation)) fail(`${protocol.id} references unknown protocol operation ${operation}`);
        claimedOperations.push(operation);
        if (positiveStatus(claim.status)) positiveOperations.add(operation);
      }
      for (const evidenceId of claim.evidence ?? []) {
        if (!evidenceById.has(evidenceId)) fail(`${protocol.id} references unknown evidence ${evidenceId}`);
      }
    }
    if (!unique(claimedOperations)) fail(`${protocol.id} assigns an operation more than once`);
    positiveOperationsByProtocol.set(protocol.id, positiveOperations);
  }

  const claimIds = (manifest.supportClaims ?? []).map((claim) => claim.id);
  if (!unique(claimIds)) fail("support claim ids must be unique");
  const knownProtocolReferences = new Set([...protocolIds, ...(manifest.claimOnlyProtocols ?? [])]);
  const tierByEnvironment = capabilityTierByEnvironment(manifest);
  for (const claim of manifest.supportClaims ?? []) {
    usedStatuses.add(claim.status);
    validateServerAttach(claim, tierByEnvironment.get(claim.environment), fail);
    if (!STATUS_VOCABULARY.includes(claim.status)) fail(`${claim.id} has invalid status ${claim.status}`);
    if (claim.protocol && !knownProtocolReferences.has(claim.protocol)) {
      fail(`${claim.id} references unknown protocol ${claim.protocol}`);
    }
    if (!ENVIRONMENT_VOCABULARY.includes(claim.environment)) {
      fail(`${claim.id} has invalid environment ${claim.environment ?? "missing"}`);
    }
    if (!EXECUTION_MODE_VOCABULARY.includes(claim.executionMode)) {
      fail(`${claim.id} has invalid executionMode ${claim.executionMode ?? "missing"}`);
    }
    for (const operation of claim.operations ?? []) {
      if (!claimCapabilitySet.has(operation)) fail(`${claim.id} references unknown claim capability ${operation}`);
      const protocolOperations = positiveOperationsByProtocol.get(claim.protocol);
      if (
        positiveStatus(claim.status) &&
        protocolOperationSet.has(operation) &&
        protocolOperations &&
        !protocolOperations.has(operation)
      ) {
        fail(
          `${claim.id} positively claims ${operation} for ${claim.protocol}, but that protocol has no positive operation claim`,
        );
      }
    }
    if (positiveStatus(claim.status) && (claim.evidence ?? []).length === 0) {
      fail(`${claim.id} ${claim.status} support claim must link evidence`);
    }
    for (const evidenceId of claim.evidence ?? []) {
      if (!evidenceById.has(evidenceId)) fail(`${claim.id} references unknown evidence ${evidenceId}`);
    }
  }
  const connectProtocolSet = new Set(manifest.connectProtocols ?? []);
  const connectClaims = (manifest.supportClaims ?? []).filter(
    (claim) =>
      positiveStatus(claim.status) &&
      claim.protocol &&
      (claim.operations ?? []).includes("discovery") &&
      /\bconnect\s*\(/.test(claim.api ?? ""),
  );
  for (const protocolId of connectProtocolSet) {
    const matchingClaims = connectClaims.filter((claim) => claim.protocol === protocolId);
    if (matchingClaims.length !== 1) {
      fail(`connect() protocol ${protocolId} must have exactly one positive discovery support claim`);
    }
  }
  for (const claim of connectClaims) {
    if (!connectProtocolSet.has(claim.protocol)) {
      fail(`${claim.id} claims connect() discovery for unregistered protocol ${claim.protocol}`);
    }
  }

  const sampleContract = manifest.consumerContracts?.sampleCatalog;
  for (const [sampleTier, supportStatus] of Object.entries(sampleContract?.supportTierMap ?? {})) {
    if (supportStatus !== null && !STATUS_VOCABULARY.includes(supportStatus)) {
      fail(`sample tier ${sampleTier} maps to unknown support status ${supportStatus}`);
    }
  }
  const knownClaimIds = new Set(claimIds);
  for (const [sampleProtocol, mapping] of Object.entries(sampleContract?.protocols ?? {})) {
    for (const protocolId of mapping.protocolIds ?? []) {
      if (!knownProtocolReferences.has(protocolId)) {
        fail(`sample protocol ${sampleProtocol} maps to unknown protocol ${protocolId}`);
      }
    }
    for (const claimId of mapping.supportClaimIds ?? []) {
      if (!knownClaimIds.has(claimId)) fail(`sample protocol ${sampleProtocol} maps to unknown support claim ${claimId}`);
    }
    const targetCount = (mapping.protocolIds?.length ?? 0) + (mapping.supportClaimIds?.length ?? 0);
    if (mapping.external && targetCount > 0) fail(`external sample protocol ${sampleProtocol} must not name SDK targets`);
    if (!mapping.external && targetCount === 0) fail(`sample protocol ${sampleProtocol} needs an SDK target or external=true`);
  }

  const entrypoints = manifest.packageLifecycle?.entrypoints ?? [];
  const subpaths = entrypoints.map((entrypoint) => entrypoint.subpath);
  if (!unique(subpaths)) fail("package lifecycle subpaths must be unique");
  for (const entrypoint of entrypoints) {
    usedStatuses.add(entrypoint.status);
    if (!["supported", "experimental", "deprecated"].includes(entrypoint.status)) {
      fail(`${entrypoint.subpath} has invalid package lifecycle status ${entrypoint.status}`);
    }
    if (entrypoint.status === "deprecated" && (!entrypoint.replacement || !entrypoint.introducedIn || !entrypoint.removeIn)) {
      fail(`${entrypoint.subpath} deprecated lifecycle must name replacement, introducedIn, and removeIn`);
    }
    if (entrypoint.replacementStatus !== undefined) {
      usedStatuses.add(entrypoint.replacementStatus);
      if (!entrypoint.replacement) {
        fail(`${entrypoint.subpath} records a replacementStatus without naming a replacement`);
      }
      if (!STATUS_VOCABULARY.includes(entrypoint.replacementStatus)) {
        fail(`${entrypoint.subpath} has invalid replacementStatus ${entrypoint.replacementStatus}`);
      }
    }
  }
  for (const tier of manifest.packageLifecycle?.surfaceTiers ?? []) usedStatuses.add(tier.status);
  validateSurfaceTiers(manifest, projectRoot, checkEvidencePaths, fail);
  const stableCount = entrypoints.filter((entrypoint) => entrypoint.status === "supported").length;
  if (stableCount !== manifest.packageLifecycle?.ceilings?.stableEntrypoints) {
    fail(`supported entrypoint count ${stableCount} disagrees with stableEntrypoints ceiling`);
  }

  for (const status of STATUS_VOCABULARY) {
    if (!usedStatuses.has(status)) fail(`status vocabulary value is not represented by a claim: ${status}`);
  }
  return failures;
}

export function loadCanonicalStaticFormatIds(projectRoot = PROJECT_ROOT) {
  const source = fs.readFileSync(path.join(projectRoot, "src/connect.ts"), "utf8");
  const declaration = /export const CONNECT_STATIC_FORMATS = \[([\s\S]*?)\]\s+as const;/.exec(source);
  if (!declaration) throw new Error("src/connect.ts does not declare CONNECT_STATIC_FORMATS");
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function validateDiscoveryInventory(manifest, protocolIds, projectRoot, fail) {
  const inventory = manifest.discoveryInventory;
  if (
    inventory?.format !== "honua.sdk.connect-discovery-inventory.v1" ||
    inventory?.schemaVersion !== 1
  ) {
    fail("discoveryInventory must use honua.sdk.connect-discovery-inventory.v1 schema version 1");
    return;
  }
  if (JSON.stringify(inventory.dispositionVocabulary) !== JSON.stringify(DISCOVERY_DISPOSITION_VOCABULARY)) {
    fail(`discoveryInventory dispositionVocabulary must be exactly: ${DISCOVERY_DISPOSITION_VOCABULARY.join(", ")}`);
  }
  const entries = inventory.protocols ?? [];
  const ids = entries.map((entry) => entry.id);
  if (!unique(ids)) fail("discoveryInventory protocol ids must be unique");
  if (JSON.stringify(ids) !== JSON.stringify(protocolIds)) {
    fail("discoveryInventory protocols must cover every canonical protocol exactly once in declaration order");
  }
  const connectProtocols = new Set(manifest.connectProtocols ?? []);
  const sourceBacked = new Set(entries.filter((entry) => entry.disposition === "source-backed").map((entry) => entry.id));
  for (const protocolId of connectProtocols) {
    if (!sourceBacked.has(protocolId)) fail(`connect() protocol ${protocolId} must be source-backed in discoveryInventory`);
  }
  for (const protocolId of sourceBacked) {
    if (!connectProtocols.has(protocolId)) {
      fail(`source-backed discoveryInventory protocol ${protocolId} is absent from connectProtocols`);
    }
  }
  for (const entry of entries) validateDiscoveryEntry(entry, `protocol ${entry.id}`, fail);

  const formats = inventory.staticFormats ?? [];
  const formatIds = formats.map((entry) => entry.id);
  if (!unique(formatIds)) fail("discoveryInventory static format ids must be unique");
  try {
    const canonicalFormatIds = loadCanonicalStaticFormatIds(projectRoot);
    if (JSON.stringify(formatIds) !== JSON.stringify(canonicalFormatIds)) {
      fail("discoveryInventory static formats must cover CONNECT_STATIC_FORMATS exactly once in declaration order");
    }
  } catch (error) {
    fail(`could not read canonical CONNECT_STATIC_FORMATS: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const entry of formats) validateDiscoveryEntry(entry, `static format ${entry.id}`, fail);
  const pmtiles = formats.find((entry) => entry.id === "pmtiles");
  if (
    pmtiles?.disposition !== "source-backed" ||
    pmtiles?.owner !== "connect({ protocol: 'pmtiles' })" ||
    pmtiles?.autoClassification !== "structural-marker"
  ) {
    fail("PMTiles static discovery must be source-backed by connect() with structural-marker auto classification");
  }
  const cog = formats.find((entry) => entry.id === "cog");
  if (
    cog?.disposition !== "stac-classified" ||
    cog?.owner !== "@honua/sdk-js/cog" ||
    cog?.autoClassification !== "stac-evidence"
  ) {
    fail("COG static discovery must remain STAC-classified and owned by @honua/sdk-js/cog");
  }
}

function validateDiscoveryEntry(entry, label, fail) {
  if (!DISCOVERY_DISPOSITION_VOCABULARY.includes(entry.disposition)) {
    fail(`discoveryInventory ${label} has invalid disposition ${entry.disposition ?? "missing"}`);
  }
  if (!DISCOVERY_AUTO_CLASSIFICATIONS.includes(entry.autoClassification)) {
    fail(`discoveryInventory ${label} has invalid autoClassification ${entry.autoClassification ?? "missing"}`);
  }
  if (typeof entry.owner !== "string" || entry.owner.length === 0) {
    fail(`discoveryInventory ${label} must name an owner`);
  }
}

function tierForStatus(status) {
  return status === "supported" ? "stable" : status;
}

export function buildPublicSurface(manifest) {
  return {
    $comment:
      "Generated from config/support-manifest.v1.json. package.json exports, INSTALL.md, TypeDoc, the stable API report, and the app-platform split are verified against this projection.",
    schemaVersion: 1,
    ceilings: manifest.packageLifecycle.ceilings,
    downstreamProjection: manifest.packageLifecycle.downstreamProjection,
    surfaceTiers: manifest.packageLifecycle.surfaceTiers ?? [],
    entrypoints: manifest.packageLifecycle.entrypoints.map(({ subpath, status, ...entrypoint }) => ({
      subpath,
      tier: tierForStatus(status),
      ...entrypoint,
    })),
  };
}

export function renderPublicSurface(manifest) {
  const surface = buildPublicSurface(manifest);
  const { entrypoints, ...metadata } = surface;
  const prefix = JSON.stringify(metadata, null, 2).replace(/\n}$/, "");
  const groups = ["stable", "experimental", "deprecated"].map((tier) =>
    entrypoints.filter((entrypoint) => entrypoint.tier === tier),
  );
  const entryLines = [];
  let emitted = 0;
  for (const group of groups) {
    if (entryLines.length > 0) entryLines.push("");
    for (const entrypoint of group) {
      emitted++;
      const compact = JSON.stringify(entrypoint)
        .replace(/^\{/, "{ ")
        .replace(/}$/, " }")
        .replace(/":/g, '": ')
        .replace(/,"/g, ', "');
      entryLines.push(`    ${compact}${emitted === entrypoints.length ? "" : ","}`);
    }
  }
  return `${prefix},\n  "entrypoints": [\n${entryLines.join("\n")}\n  ]\n}\n`;
}

function markdownEvidence(manifest, evidenceIds, prefix) {
  const evidenceById = new Map(manifest.evidence.map((item) => [item.id, item]));
  return evidenceIds
    .map((id) => {
      const evidence = evidenceById.get(id);
      return `[${evidence.kind}: ${id}](${prefix}${evidence.path})`;
    })
    .join("<br>");
}

function statusGlyph(status, executionMode) {
  if (status === "unsupported") return "—";
  if (status === "beta") return "β";
  if (status === "experimental") return "◇";
  if (status === "deprecated") return "†";
  if (status === "facade-required") return "F";
  return executionMode === "client-fallback" ? "◐" : "✓";
}

function protocolOperationClaim(protocol, operation) {
  return protocol.operationClaims.find((claim) => claim.operations.includes(operation));
}

function serverAttachTierIds(manifest) {
  return new Set(manifest.capabilityTiers.filter((tier) => tier.honuaServerRequired).map((tier) => tier.id));
}

function serverAttachProtocols(manifest) {
  const serverAttachTiers = serverAttachTierIds(manifest);
  const byEnvironment = capabilityTierByEnvironment(manifest);
  return manifest.protocols.filter((protocol) => {
    const tierIds = new Set(
      protocol.operationClaims
        .filter((claim) => positiveStatus(claim.status))
        .map((claim) => byEnvironment.get(claim.environment)?.id),
    );
    return tierIds.size > 0 && [...tierIds].every((id) => serverAttachTiers.has(id));
  });
}

function renderProtocolTierNote(manifest) {
  const attached = serverAttachProtocols(manifest);
  const link = "[capability tiers](./standalone-capability-matrix.md#capability-tiers)";
  if (attached.length === 0) {
    return `Deployment tier is separate from status: no protocol below needs a Honua
Server attach. The per-capability line lives in the generated
${link} table.`;
  }
  const list = attached.map((protocol) => `\`${protocol.id}\``).join(", ");
  const verb = attached.length === 1 ? "is the only protocol that needs" : "are the only protocols that need";
  return `Deployment tier is separate from status: ${list} ${verb}
a Honua Server attach; every other protocol below answers against an endpoint you
already run. The per-capability line lives in the generated
${link} table.`;
}

export function renderProtocolSection(manifest) {
  const headers = ["Capability", ...manifest.protocols.map((protocol) => protocol.label)];
  const align = ["---", ...manifest.protocols.map(() => ":-:")];
  const rows = manifest.protocolOperations.map((operation) => [
    `\`${operation}\``,
    ...manifest.protocols.map((protocol) => {
      const claim = protocolOperationClaim(protocol, operation);
      return claim ? statusGlyph(claim.status, claim.executionMode) : "—";
    }),
  ]);
  const table = [headers, align, ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n");
  const evidenceRows = manifest.protocols.flatMap((protocol) =>
    protocol.operationClaims.map((claim) =>
      `| \`${protocol.id}\` | ${claim.operations.map((operation) => `\`${operation}\``).join(", ")} | \`${claim.status}\` | \`${claim.environment}\` | \`${claim.executionMode}\` | ${markdownEvidence(manifest, claim.evidence, "../")} |`,
    ),
  );
  const discoveryRows = [
    ...manifest.discoveryInventory.protocols.map((entry) => [
      "Protocol",
      `\`${entry.id}\``,
      `\`${entry.disposition}\``,
      `\`${entry.autoClassification}\``,
      `\`${entry.owner}\``,
    ]),
    ...manifest.discoveryInventory.staticFormats.map((entry) => [
      "Static format",
      `\`${entry.id}\``,
      `\`${entry.disposition}\``,
      `\`${entry.autoClassification}\``,
      `\`${entry.owner}\``,
    ]),
  ]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
  return `Status: generated from [\`${MANIFEST_PATH}\`](../${MANIFEST_PATH}); do not edit this section by hand.

Native (\`✓\`) claims mirror the default capability set per protocol; per-source
metadata may narrow them at runtime. Client-fallback (\`◐\`) claims are explicit
opt-in paths and are not protocol defaults. An absent operation is explicitly
\`unsupported\`; capability misses throw \`HonuaCapabilityNotSupportedError\`
rather than returning empty data.

- \`✓\` supported with native execution
- \`◐\` supported through an explicit client fallback
- \`β\` beta
- \`◇\` experimental
- \`†\` deprecated
- \`F\` facade-required
- \`—\` unsupported

${renderProtocolTierNote(manifest)}

${table}

### Generated claim evidence

Every non-unsupported operation claim maps to executable evidence and a freshness
policy in the manifest.

| Protocol | Operations | Status | Environment | Execution mode | Evidence |
| --- | --- | --- | --- | --- | --- |
${evidenceRows.join("\n")}

### Generated discovery disposition inventory

Every canonical protocol and supported static format has exactly one owner and
discovery boundary. \`explicit-only\` never probes competing protocols;
\`structural-marker\` currently means the explicit \`pmtiles://\` asset marker.
The standalone machine projection is
[\`support/projections/connect-discovery-inventory.v1.json\`](../support/projections/connect-discovery-inventory.v1.json).

| Kind | Identifier | Disposition | Auto classification | Owner |
| --- | --- | --- | --- | --- |
${discoveryRows}`;
}

const FILTER_GLYPH = {
  native: "✓",
  "attributes-only": "◐",
  unsupported: "—",
};

/**
 * Per-protocol truth for the typed `Query.filter` / `Query.temporalFilter`
 * members (issue #947): which wire dialect each adapter compiles them to, and
 * which temporal forms it can express exactly.
 */
export function renderFilterSection(manifest) {
  const rows = manifest.protocols.map((protocol) => {
    const support = protocol.queryFilter;
    const temporal =
      support.temporal.length === 0 ? "—" : support.temporal.map((form) => `\`${form}\``).join(", ");
    const dialect = support.dialect === "none" ? "—" : `\`${support.dialect}\``;
    return `| \`${protocol.id}\` | ${FILTER_GLYPH[support.filter]} | ${dialect} | ${temporal} | ${support.notes} |`;
  });
  return `Status: generated from [\`${MANIFEST_PATH}\`](../${MANIFEST_PATH}); do not edit this section by hand.

\`Query.filter\` is the typed, protocol-neutral semantic filter and
\`Query.temporalFilter\` is the canonical time constraint. A construct the target
cannot express exactly throws \`HonuaCapabilityNotSupportedError\` naming the
construct and the protocol; a documented widening (the GeoParquet bbox
reduction) is reported through \`Result.degraded\`.

This table is the **protocol default**: what each adapter can lower without
widening the result. A source's evaluated capability profile narrows it further —
the \`query\` capability's \`filterOperators\`, \`spatialPredicates\`, and
\`temporalPredicates\` constraints are bound into the same gate, so an endpoint
whose evidence omits a construct refuses it by name even where the protocol
column below says \`✓\`. Discovery attaches these defaults as \`protocol-default\`
evidence; observed evidence only ever narrows them.

- \`✓\` full attribute, spatial, and temporal predicate compilation
- \`◐\` attribute and temporal predicates only (a spatial node is refused)
- \`—\` no filterable query surface
- \`source-dimension\` — a temporal filter without a field uses the protocol's own
  time parameter (\`time=\`, \`datetime=\`)
- \`field-predicate\` — a temporal filter that names its field compiles to an
  exact predicate on that field

| Protocol | Typed filter | Dialect | Temporal forms | Notes |
| --- | :-: | --- | --- | --- |
${rows.join("\n")}`;
}

function claimTier(manifest, claim) {
  const tier = capabilityTierFor(manifest, claim.environment);
  if (!tier) throw new Error(`Support claim ${claim.id} has an untiered environment ${claim.environment}`);
  return tier;
}

function claimsInTier(manifest, tier) {
  return manifest.supportClaims.filter((claim) => claimTier(manifest, claim).id === tier.id);
}

function openEndpointPathCell(claim) {
  const { disposition, issue } = claim.serverAttach;
  if (disposition !== "roadmap") return "Inherent — none possible";
  const number = issue.slice(issue.lastIndexOf("/") + 1);
  return `Roadmap: [#${number}](${issue})`;
}

/**
 * Issue #1006: the open-endpoint vs server-attach tier table. Both the tiering
 * and every rationale are projected from the manifest, so a capability cannot
 * quietly acquire a Honua Server dependency without stating the reason here.
 */
export function renderCapabilityTierSection(manifest) {
  const tierRows = manifest.capabilityTiers.map((tier) => {
    const claims = claimsInTier(manifest, tier);
    const environments = tier.environments.map((environment) => `\`${environment}\``).join(", ");
    return `| **${tier.label}** (\`${tier.id}\`) | ${tier.honuaServerRequired ? "required" : "not required"} | ${environments} | ${claims.length} | ${tier.summary} |`;
  });
  const attachedRows = manifest.capabilityTiers
    .filter((tier) => tier.honuaServerRequired)
    .flatMap((tier) =>
      claimsInTier(manifest, tier).map(
        (claim) =>
          `| ${claim.label} | \`${claim.status}\` | ${openEndpointPathCell(claim)} | ${claim.serverAttach.rationale} |`,
      ),
    );
  return `## Capability tiers

Tier answers the one question a matrix of statuses does not: what do you have to
run yourself before this works? It is not authored per capability — it is each
claim's \`environment\` read through the manifest's own tier partition, so a new
environment cannot enter the vocabulary untiered.

| Tier | Honua Server | Environments | Claims | What it means |
| --- | :-: | --- | :-: | --- |
${tierRows.join("\n")}

### Server-attach capabilities and their open-endpoint path

Every server-attach claim names either a roadmap issue for an open-endpoint path
or the reason the dependency is inherent. \`Inherent\` is a product statement, not
a scheduling excuse: it means no third-party endpoint can answer that surface at
all, so there is nothing to implement against.

| Capability | Status | Open-endpoint path | Why it attaches to a server |
| --- | --- | --- | --- |
${attachedRows.join("\n")}`;
}

/**
 * Issue #931: a package entrypoint is one lifecycle row, but a barrel can carry
 * more than one support tier. This section publishes the enumerated split — how
 * many exports carry the promoted tier, which ones are deliberately held back,
 * and the evidence behind the promotion — so a reader never has to infer a
 * symbol's tier from the directory it happens to live in.
 */
export function renderSurfaceTierSection(manifest) {
  const tiers = manifest.packageLifecycle?.surfaceTiers ?? [];
  if (tiers.length === 0) {
    return `## Surface tiers

No package surface splits its entrypoint's lifecycle status today.`;
  }
  const rows = tiers.map((tier) => {
    const claim = supportClaim(manifest, tier.claim);
    const heldBackByStatus = new Map();
    for (const group of tier.heldBack ?? []) {
      heldBackByStatus.set(group.status, (heldBackByStatus.get(group.status) ?? 0) + group.exports.length);
    }
    const heldBack =
      heldBackByStatus.size === 0
        ? "None"
        : [...heldBackByStatus].map(([status, count]) => `${count} \`${status}\``).join(", ");
    const forwarder = tier.sdkForwarder ? `\`@honua/sdk-js${tier.sdkForwarder.slice(1)}\`` : "—";
    return `| \`${tier.surface}\` | \`${tier.status}\` | ${tier.exports.length} | ${heldBack} | ${forwarder} | ${markdownEvidence(manifest, claim.evidence, "../")} |`;
  });
  const detail = tiers.flatMap((tier) => [
    "",
    `### \`${tier.surface}\``,
    "",
    tier.commitment ?? "",
    ...((tier.mayStillChange ?? []).length === 0
      ? []
      : ["", "What may still change inside the tier:", "", ...tier.mayStillChange.map((item) => `- ${item}`)]),
    ...(tier.heldBack ?? []).flatMap((group) => [
      "",
      `Held back at \`${group.status}\` — ${group.reason}`,
      "",
      group.exports.map((name) => `\`${name}\``).join(", "),
    ]),
  ]);
  return `## Surface tiers

A subpath is one lifecycle row, but a barrel can mix tiers. Every export below is
classified explicitly in [\`${MANIFEST_PATH}\`](../${MANIFEST_PATH}) and the
generated [\`config/public-surface.json\`](../config/public-surface.json)
projection; an unclassified export fails the support gate rather than inheriting
a tier from the directory it lives in.

| Surface | Status | Tier exports | Held back | SDK forwarder | Evidence |
| --- | --- | :-: | --- | --- | --- |
${rows.join("\n")}
${detail.join("\n")}`;
}

export function renderStandaloneSection(manifest) {
  const rows = manifest.supportClaims.map(
    (claim) =>
      `| ${claim.label} | \`${claimTier(manifest, claim).id}\` | \`${claim.status}\` | \`${claim.environment}\` | \`${claim.executionMode}\` | ${claim.backendNeeded} | ${claim.api} | ${markdownEvidence(manifest, claim.evidence, "../") || "Lifecycle-only claim"} | ${claim.notes} |`,
  );
  return `This is the generated, evidence-linked line between capabilities that work
against raw standards-speaking endpoints and capabilities that require the Honua
facade. The source of truth is [\`${MANIFEST_PATH}\`](../${MANIFEST_PATH}).
See the [standalone quickstart](./standalone-quickstart.md) for the runnable path.

${renderCapabilityTierSection(manifest)}

${renderSurfaceTierSection(manifest)}

## Status vocabulary

- \`supported\` — release-gated implementation with linked evidence
- \`beta\` — implemented and evidenced, but still in pre-GA hardening
- \`experimental\` — usable evidence-backed preview whose shape may change
- \`deprecated\` — compatibility-only surface with a named replacement
- \`unsupported\` — no implementation claim
- \`facade-required\` — typed capability exists but execution requires Honua Server

Environment and execution mode are separate from status: \`standalone\` tells you
where a claim works, while \`discovery\`, \`native\`, \`client-fallback\`, and
\`facade\` tell you how it works.

## Matrix

| Capability | Tier | Status | Environment | Execution | Backend needed | API | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Current OGC line

Raw OGC API Tiles, Maps, and Records discovery/use is \`beta\` and fixture-proven.
Raw OGC API Processes discovery and raw Processes execution are both
\`experimental\` and both \`standalone\`. They stay deliberately separate claims
so discovery evidence can never be mistaken for execution support: discovery
carries a scheduled anonymous live lane, while execution is fixture-proven only
because no public Processes endpoint permits anonymous execution.`;
}

function lifecycleCounts(manifest) {
  const counts = Object.fromEntries(STATUS_VOCABULARY.map((status) => [status, 0]));
  for (const entrypoint of manifest.packageLifecycle.entrypoints) counts[entrypoint.status]++;
  return counts;
}

export function renderReadmeReleaseSection(manifest, packageJson) {
  const counts = lifecycleCounts(manifest);
  return `**Release status: ${manifest.sdk.releaseStatus}** (\`${packageJson.version}\`). The ${counts.supported}-entrypoint stable tier is guarded <!-- x-release-please-version -->
by an API-surface gate; ${counts.experimental} experimental subpaths may change before 1.0, and
${counts.deprecated} deprecated compatibility subpaths have explicit removal versions. See
[\`config/support-manifest.v1.json\`](./config/support-manifest.v1.json) for the versioned support truth,
[\`config/public-surface.json\`](./config/public-surface.json) for its generated package projection,
[\`support/projections/sdk-support.v1.json\`](./support/projections/sdk-support.v1.json) for the generic
site/sample consumer contract, and
[the scope decision](./docs/decisions/scope-split-and-1.0.md).

This README tracks the current development branch. The version above is its
package baseline, not a claim that every capability described here is already
present in the npm artifact with that version. For published behavior, use the
[tagged release documentation](./docs/documentation-versions.md).`;
}

function supportClaim(manifest, id) {
  const claim = manifest.supportClaims.find((candidate) => candidate.id === id);
  if (!claim) throw new Error(`Missing required support claim ${id}`);
  return claim;
}

export function renderReadmeStandaloneSection(manifest) {
  const tiles = supportClaim(manifest, "ogc-tiles-standalone");
  const maps = supportClaim(manifest, "ogc-maps-standalone");
  const records = supportClaim(manifest, "ogc-records-standalone");
  const discovery = supportClaim(manifest, "ogc-processes-discovery-standalone");
  const execution = supportClaim(manifest, "ogc-processes-execution-standalone");
  const openTier = manifest.capabilityTiers.find((tier) => !tier.honuaServerRequired);
  const attachTier = manifest.capabilityTiers.find((tier) => tier.honuaServerRequired);
  const openClaims = claimsInTier(manifest, openTier);
  const attachClaims = claimsInTier(manifest, attachTier);
  const roadmapCount = attachClaims.filter((claim) => claim.serverAttach.disposition === "roadmap").length;
  return `**Two deployment tiers, named up front.** ${openClaims.length} of the ${manifest.supportClaims.length} generated support
claims are \`${openTier.id}\`: they run against standards-speaking endpoints you already
have, or entirely in the client and build — no Honua account, no Honua Server.
${attachClaims.length} are \`${attachTier.id}\` and execute only after attaching to a Honua Server facade;
${roadmapCount} of those link a roadmap issue for an open-endpoint path and the rest state why the
server dependency is inherent, in the generated
[capability tiers table](./docs/standalone-capability-matrix.md#capability-tiers).

**Honua Server is optional for standards clients.** Supported GeoServices, OGC API
Features, WFS 2.0, WMS 1.3, WMTS 1.0, STAC, and OData claims work against raw standards-speaking endpoints.
OGC API Tiles (\`${tiles.status}\`), Maps (\`${maps.status}\`), and Records
(\`${records.status}\`) also discover and use raw advertised paths. OGC API Processes
keeps two honest lanes against a raw server:
discovery (\`${discovery.status}\`, \`${discovery.environment}\`) and
typed execution (\`${execution.status}\`, \`${execution.environment}\`).

A [Honua Server](https://github.com/honua-io/honua-server) adds server-authored
\`MapPackage\`s, realtime, collaboration, compatibility metadata, a richer hosted
\`/mcp\` operator catalog, and the facade-required execution paths. See the generated
[backend-agnostic capability matrix](./docs/standalone-capability-matrix.md) for every
claim's tier, execution mode, and evidence link.`;
}

export function renderInstallSupportSection(manifest) {
  const counts = lifecycleCounts(manifest);
  const ceilings = manifest.packageLifecycle.ceilings;
  return `## Generated support status

The versioned source of truth is [\`config/support-manifest.v1.json\`](./config/support-manifest.v1.json).
It projects ${counts.supported} supported (documented below as stable), ${counts.experimental} experimental,
and ${counts.deprecated} deprecated package entrypoints. Protocol status is independent
of package lifecycle: raw endpoint support, facade requirements, execution mode, and
evidence are listed in the generated
[backend-agnostic capability matrix](./docs/standalone-capability-matrix.md). The generic
[support projection](./support/projections/sdk-support.v1.json) carries explicit contracts
for both honua.io and the canonical \`samples/catalog.v2.json\` inventory.

The reviewed package-root ceilings are ${ceilings.rootRuntimeExports} runtime
exports and ${ceilings.rootTypeExports} declaration exports. The exact inventory
and generated migration table come from
[\`config/root-surface.json\`](./config/root-surface.json). This guide tracks the
current development branch; its package baseline can match the latest release
while the branch contains unreleased work. Use the
[tagged release documentation](./docs/documentation-versions.md) for the
published artifact.`;
}

export function buildSupportProjection(manifest, packageJson) {
  return {
    $schema: "../contract/v1/schemas/support-projection.schema.json",
    format: "honua.sdk.support-projection.v1",
    schemaVersion: 1,
    generatedFrom: MANIFEST_PATH,
    sdk: {
      package: manifest.sdk.package,
      version: packageJson.version,
      releaseStatus: manifest.sdk.releaseStatus,
    },
    statusVocabulary: manifest.statusVocabulary,
    environmentVocabulary: manifest.environmentVocabulary,
    executionModeVocabulary: manifest.executionModeVocabulary,
    capabilityTiers: manifest.capabilityTiers,
    connectProtocols: manifest.connectProtocols,
    discoveryInventory: manifest.discoveryInventory,
    protocolOperations: manifest.protocolOperations,
    operationSurfaces: manifest.operationSurfaces,
    claimCapabilities: manifest.claimCapabilities,
    claimOnlyProtocols: manifest.claimOnlyProtocols,
    consumerContracts: manifest.consumerContracts,
    freshnessPolicies: manifest.freshnessPolicies,
    evidence: manifest.evidence,
    protocols: manifest.protocols,
    supportClaims: manifest.supportClaims,
    packageLifecycle: manifest.packageLifecycle,
  };
}

export function buildSupportProjectionSchema(manifestSchema) {
  const sharedPropertyNames = [
    "statusVocabulary",
    "environmentVocabulary",
    "executionModeVocabulary",
    "capabilityTiers",
    "connectProtocols",
    "discoveryInventory",
    "protocolOperations",
    "operationSurfaces",
    "claimCapabilities",
    "claimOnlyProtocols",
    "consumerContracts",
    "freshnessPolicies",
    "evidence",
    "protocols",
    "supportClaims",
  ];
  const sharedProperties = Object.fromEntries(
    sharedPropertyNames.map((name) => {
      const property = manifestSchema.properties?.[name];
      if (!property) throw new Error(`Manifest schema is missing projection property ${name}`);
      return [name, structuredClone(property)];
    }),
  );
  const packageLifecycle = manifestSchema.$defs?.packageLifecycle;
  if (!packageLifecycle) throw new Error("Manifest schema is missing $defs.packageLifecycle");

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://honua.io/schemas/sdk/support-projection.v1.schema.json",
    $comment:
      "Generated from config/support-manifest.schema.json so downstream consumers can compile this schema offline without pre-registering another schema.",
    title: "Honua SDK downstream support projection",
    type: "object",
    additionalProperties: false,
    required: [
      "format",
      "schemaVersion",
      "generatedFrom",
      "sdk",
      ...sharedPropertyNames,
      "packageLifecycle",
    ],
    properties: {
      $schema: { type: "string" },
      format: { const: "honua.sdk.support-projection.v1" },
      schemaVersion: { const: 1 },
      generatedFrom: { const: MANIFEST_PATH },
      sdk: {
        type: "object",
        additionalProperties: false,
        required: ["package", "version", "releaseStatus"],
        properties: {
          package: { const: "@honua/sdk-js" },
          version: { type: "string", minLength: 1 },
          releaseStatus: { $ref: "#/$defs/status" },
        },
      },
      ...sharedProperties,
      packageLifecycle: structuredClone(packageLifecycle),
    },
    $defs: structuredClone(manifestSchema.$defs),
  };
}

export function replaceManagedSection(markdown, name, body) {
  const start = `<!-- support-manifest:${name}:start -->`;
  const end = `<!-- support-manifest:${name}:end -->`;
  const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (!pattern.test(markdown)) throw new Error(`Missing managed section ${name}`);
  return markdown.replace(pattern, `${start}\n${body.trim()}\n${end}`);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generateOutputs({ manifest, packageJson, projectRoot = PROJECT_ROOT }) {
  const manifestSchema = readJson(path.join(projectRoot, "config/support-manifest.schema.json"));
  const protocolDoc = fs.readFileSync(path.join(projectRoot, "docs/protocol-capability-matrix.md"), "utf8");
  const standaloneDoc = fs.readFileSync(path.join(projectRoot, "docs/standalone-capability-matrix.md"), "utf8");
  const readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf8");
  const install = fs.readFileSync(path.join(projectRoot, "INSTALL.md"), "utf8");
  return new Map([
    [GENERATED_PATHS.publicSurface, renderPublicSurface(manifest)],
    [
      "docs/protocol-capability-matrix.md",
      replaceManagedSection(
        replaceManagedSection(protocolDoc, "protocol-matrix", renderProtocolSection(manifest)),
        "filter-matrix",
        renderFilterSection(manifest),
      ),
    ],
    [
      "docs/standalone-capability-matrix.md",
      replaceManagedSection(standaloneDoc, "standalone-matrix", renderStandaloneSection(manifest)),
    ],
    ["README.md", replaceManagedSection(replaceManagedSection(readme, "release", renderReadmeReleaseSection(manifest, packageJson)), "standalone", renderReadmeStandaloneSection(manifest))],
    ["INSTALL.md", replaceManagedSection(install, "install-status", renderInstallSupportSection(manifest))],
    [GENERATED_PATHS.supportProjectionSchema, json(buildSupportProjectionSchema(manifestSchema))],
    [GENERATED_PATHS.supportProjection, json(buildSupportProjection(manifest, packageJson))],
    [
      GENERATED_PATHS.discoveryInventory,
      json({
        ...manifest.discoveryInventory,
        generatedFrom: MANIFEST_PATH,
      }),
    ],
    [
      GENERATED_PATHS.rasterSourceRegistry,
      json({
        ...readJson(path.join(projectRoot, manifest.rasterSourceRegistry)),
        $schema: "../../config/raster-source-registry.schema.json",
        generatedFrom: manifest.rasterSourceRegistry,
      }),
    ],
  ]);
}

export function checkOutputs(outputs, projectRoot = PROJECT_ROOT) {
  const failures = [];
  for (const [relativePath, expected] of outputs) {
    const filename = path.join(projectRoot, relativePath);
    const actual = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : undefined;
    if (actual !== expected) failures.push(relativePath);
  }
  return failures;
}

function run(mode) {
  if (!["write", "check"].includes(mode)) {
    process.stderr.write("Usage: node scripts/support-manifest.mjs <write|check>\n");
    process.exitCode = 2;
    return;
  }
  const manifest = loadSupportManifest();
  const failures = validateSupportManifest(manifest);
  if (failures.length > 0) {
    process.stderr.write(`Support manifest validation FAILED:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  const packageJson = readJson(path.join(PROJECT_ROOT, "package.json"));
  const outputs = generateOutputs({ manifest, packageJson });
  if (mode === "write") {
    for (const [relativePath, content] of outputs) {
      const filename = path.join(PROJECT_ROOT, relativePath);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }
    process.stdout.write(`supportManifest=written outputs=${outputs.size}\n`);
    return;
  }
  const drift = checkOutputs(outputs);
  if (drift.length > 0) {
    process.stderr.write(`Support projections are stale. Run npm run support:generate:\n${drift.map((file) => `  - ${file}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`supportManifest=ok claims=${manifest.supportClaims.length} protocols=${manifest.protocols.length} outputs=${outputs.size}\n`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) run(process.argv[2]);
