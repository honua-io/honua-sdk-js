#!/usr/bin/env node
// Generates and validates config/sdk-coverage.v1.json: this SDK's per
// canonical-capability-key coverage snapshot for the capability matrix
// (honua-io/honua-sdk-js#618, child of honua-io/honua-server#2892).
//
// Coverage is derived, never hand-padded:
//   - The wire-protocol layer (GeoServices, OGC APIs, WFS, STAC, WMS/WMTS,
//     OData, PMTiles, ...) is derived mechanically from config/support-manifest.v1.json
//     (already the hand-maintained, evidence-linked truth of what this SDK
//     implements) via the protocol/supportClaim -> capabilityKey map in
//     config/sdk-coverage-crosswalk.v1.json.
//   - A handful of SDK feature areas that support-manifest.v1.json does not
//     model as protocols/supportClaims (geocoding, routing, offline, plugin,
//     COG, styling, esri-compat Portal, OAuth, diagnostics, agent-safety) are
//     hand-specified as `extras` in the same crosswalk file, each with
//     existence-checked source files and test evidence.
//   - Capabilities the SDK does not touch are omitted entirely -- never
//     padded with a "none" entry.
//
// `partial` always carries a `note` explaining where coverage stops, per the
// #618 honesty rule.
//
// Usage: node scripts/sdk-coverage.mjs <write|check>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCapabilityKeyList } from "./lib/capability-key-list.mjs";
import { loadSupportManifest } from "./support-manifest.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CROSSWALK_PATH = "config/sdk-coverage-crosswalk.v1.json";
const COVERAGE_PATH = "config/sdk-coverage.v1.json";
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveIntroductionVersion(crosswalk, key) {
  const version = crosswalk.introductionVersions?.[key];
  invariant(
    typeof version === "string" && SEMVER_PATTERN.test(version),
    `sdk-coverage-crosswalk.introductionVersions is missing a valid semver for ${key}`,
  );
  return version;
}

/**
 * Full = production-grade coverage of the operations this claim actually
 * names. A claim whose *only* named operation is the pseudo-operation
 * "discovery" (e.g. geoservices-geometry-discovery-standalone) is metadata-only
 * and never creates a queryable Source, so it is always partial. A claim that
 * also names real operations (query/render/tiles/...) is full even when it
 * *reaches* those operations through link discovery (e.g. wfs-standalone,
 * ogc-features-standalone) -- for those protocols, dynamic discovery of the
 * operation path is the complete, native way of working, not a boundary.
 */
function isFullContribution(status, operations) {
  return status === "supported" && (operations ?? []).some((operation) => operation !== "discovery");
}

/** Contributions worth recording at all (i.e. not the unclaimed default). */
function isRealContribution(status) {
  return ["supported", "beta", "experimental", "facade-required", "deprecated"].includes(status);
}

function resolveEvidencePaths(manifest, evidenceIds) {
  const evidenceById = new Map((manifest.evidence ?? []).map((item) => [item.id, item]));
  const paths = [];
  for (const id of evidenceIds ?? []) {
    const evidence = evidenceById.get(id);
    if (!evidence) throw new Error(`sdk-coverage-crosswalk references unknown support-manifest evidence id: ${id}`);
    paths.push(evidence.path);
  }
  return paths;
}

function verifyRepoPathsExist(relativePaths, label) {
  for (const relativePath of relativePaths) {
    if (path.isAbsolute(relativePath) || relativePath.includes("..")) {
      throw new Error(`${label} path must be repository-relative: ${relativePath}`);
    }
    if (!fs.existsSync(path.join(PROJECT_ROOT, relativePath))) {
      throw new Error(`${label} path does not exist: ${relativePath}`);
    }
  }
}

/**
 * Derives per-canonical-key contributions from config/support-manifest.v1.json
 * via the protocol/supportClaim -> capabilityKey map. Returns a
 * Map<capabilityKey, Array<contribution>>.
 */
function deriveAutoContributions(manifest, crosswalk) {
  const claimsByProtocol = new Map();
  for (const claim of manifest.supportClaims ?? []) {
    if (!claim.protocol) continue;
    if (!claimsByProtocol.has(claim.protocol)) claimsByProtocol.set(claim.protocol, []);
    claimsByProtocol.get(claim.protocol).push(claim);
  }

  const perKey = new Map();
  const addContribution = (key, contribution) => {
    if (!perKey.has(key)) perKey.set(key, []);
    perKey.get(key).push(contribution);
  };

  for (const protocol of manifest.protocols ?? []) {
    const mapping = crosswalk.protocols[protocol.id];
    if (mapping === undefined) {
      throw new Error(`sdk-coverage-crosswalk.protocols is missing an entry for support-manifest protocol ${protocol.id}`);
    }
    if (mapping.internalOnly) continue;
    const tiedClaims = claimsByProtocol.get(protocol.id) ?? [];
    for (const key of mapping.capabilityKeys) {
      if (tiedClaims.length > 0) {
        for (const claim of tiedClaims) {
          if (!isRealContribution(claim.status)) continue;
          if (mapping.extraEvidence) verifyRepoPathsExist(mapping.extraEvidence, `sdk-coverage-crosswalk.protocols[${protocol.id}].extraEvidence`);
          addContribution(key, {
            full: isFullContribution(claim.status, claim.operations) && !mapping.forcePartial,
            entrypoints: (claim.api ?? "").split(",").map((value) => value.trim()).filter(Boolean),
            evidence: [...resolveEvidencePaths(manifest, claim.evidence), ...(mapping.extraEvidence ?? [])],
            note: claim.notes || undefined,
          });
        }
      } else {
        for (const claim of protocol.operationClaims ?? []) {
          if (!isRealContribution(claim.status)) continue;
          addContribution(key, {
            full: isFullContribution(claim.status, claim.operations) && !mapping.forcePartial,
            entrypoints: [`connect(), Source (protocol: "${protocol.id}")`],
            evidence: resolveEvidencePaths(manifest, claim.evidence),
            note: undefined,
          });
        }
      }
    }
  }

  for (const claim of manifest.supportClaims ?? []) {
    if (claim.protocol) continue; // protocol-tied claims are handled above via their protocol.
    const mapping = crosswalk.supportClaims[claim.id];
    if (mapping === undefined) {
      throw new Error(`sdk-coverage-crosswalk.supportClaims is missing an entry for support-manifest supportClaim ${claim.id}`);
    }
    if (mapping.internalOnly) continue;
    if (!isRealContribution(claim.status)) continue;
    if (mapping.extraEvidence) verifyRepoPathsExist(mapping.extraEvidence, `sdk-coverage-crosswalk.supportClaims[${claim.id}].extraEvidence`);
    for (const key of mapping.capabilityKeys) {
      addContribution(key, {
        full: isFullContribution(claim.status, claim.operations) && !mapping.forcePartial,
        entrypoints: (claim.api ?? "").split(",").map((value) => value.trim()).filter(Boolean),
        evidence: [...resolveEvidencePaths(manifest, claim.evidence), ...(mapping.extraEvidence ?? [])],
        note: claim.notes || undefined,
      });
    }
  }

  return perKey;
}

export async function buildSdkCoverage({
  projectRoot = PROJECT_ROOT,
  packageJson = readJson("package.json"),
  crosswalk = readJson(CROSSWALK_PATH),
} = {}) {
  invariant(
    crosswalk.format === "honua.sdk.sdk-coverage-crosswalk.v1" && crosswalk.schemaVersion === 1,
    `${CROSSWALK_PATH} must use honua.sdk.sdk-coverage-crosswalk.v1 schema version 1`,
  );
  const manifest = loadSupportManifest(projectRoot);
  const { keys: canonicalKeys, source: keyListSource } = await loadCapabilityKeyList();

  const perKey = deriveAutoContributions(manifest, crosswalk);
  const entries = [];

  for (const [key, contributions] of perKey) {
    if (crosswalk.extras[key]) continue; // extras take precedence for keys they define.
    const status = contributions.every((contribution) => contribution.full) ? "covered" : "partial";
    const entrypoints = [...new Set(contributions.flatMap((contribution) => contribution.entrypoints))];
    const evidence = [...new Set(contributions.flatMap((contribution) => contribution.evidence))];
    const notes = [...new Set(contributions.map((contribution) => contribution.note).filter(Boolean))];
    invariant(entrypoints.length > 0, `derived coverage for ${key} has no entrypoints`);
    invariant(evidence.length > 0, `derived coverage for ${key} has no evidence`);
    const entry = {
      key,
      status,
      sinceVersion: resolveIntroductionVersion(crosswalk, key),
      entrypoints: entrypoints.sort(),
      evidence: evidence.sort(),
      source: "support-manifest",
    };
    if (status === "partial") {
      invariant(notes.length > 0, `derived coverage for ${key} is partial but support-manifest carries no explanatory note`);
      entry.note = notes.join(" ");
    }
    entries.push(entry);
  }

  for (const [key, extra] of Object.entries(crosswalk.extras)) {
    verifyRepoPathsExist(extra.sourceFiles, `sdk-coverage-crosswalk extras[${key}].sourceFiles`);
    verifyRepoPathsExist(extra.evidence, `sdk-coverage-crosswalk extras[${key}].evidence`);
    const entry = {
      key,
      status: extra.status,
      sinceVersion: resolveIntroductionVersion(crosswalk, key),
      entrypoints: [...extra.entrypoints].sort(),
      evidence: [...extra.evidence].sort(),
      source: "sdk-coverage-crosswalk",
    };
    if (extra.status === "partial") entry.note = extra.note;
    entries.push(entry);
  }

  for (const entry of entries) {
    invariant(canonicalKeys.has(entry.key), `unknown canonical capability key (not in ${keyListSource}): ${entry.key}`);
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));
  const entryKeys = new Set(entries.map((entry) => entry.key));
  invariant(entryKeys.size === entries.length, "duplicate capability key in derived coverage");
  for (const key of Object.keys(crosswalk.introductionVersions ?? {})) {
    invariant(entryKeys.has(key), `sdk-coverage-crosswalk.introductionVersions contains unused capability key: ${key}`);
  }

  return {
    doc: {
      $schema: "./sdk-coverage.schema.json",
      format: "honua.sdk.sdk-coverage.v1",
      schemaVersion: 1,
      sdk: { package: packageJson.name, version: packageJson.version },
      generatedFrom: [CROSSWALK_PATH, "config/support-manifest.v1.json"],
      keyListSource,
      statusVocabulary: ["covered", "partial"],
      capabilities: entries,
    },
    keyListSource,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function run(mode) {
  if (!["write", "check"].includes(mode)) {
    process.stderr.write("Usage: node scripts/sdk-coverage.mjs <write|check>\n");
    process.exitCode = 2;
    return;
  }
  let doc;
  let keyListSource;
  try {
    ({ doc, keyListSource } = await buildSdkCoverage());
  } catch (error) {
    process.stderr.write(`sdk-coverage generation FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const rendered = stableJson(doc);
  const outputPath = path.join(PROJECT_ROOT, COVERAGE_PATH);
  if (mode === "write") {
    fs.writeFileSync(outputPath, rendered);
    process.stdout.write(`sdk-coverage=written capabilities=${doc.capabilities.length} keyListSource="${keyListSource}"\n`);
    return;
  }
  const committed = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : undefined;
  if (committed !== rendered) {
    process.stderr.write(`${COVERAGE_PATH} has drifted from config/support-manifest.v1.json / config/sdk-coverage-crosswalk.v1.json. Run npm run sdk-coverage:generate.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`sdk-coverage=ok capabilities=${doc.capabilities.length} keyListSource="${keyListSource}"\n`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run(process.argv[2]).catch((error) => {
    process.stderr.write(`sdk-coverage failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
