#!/usr/bin/env node

// 2026.1 installed-package certification denominator (honua-io/honua-sdk-js#39, AC1).
//
// #39 certifies the client product customers install against the exact 2026.1
// server candidate. Its first acceptance criterion -- "the denominator and
// active capability/profile digests are frozen before execution" -- is the one
// piece of that gate that lives entirely in this repository, and every later
// criterion counts against it: "every supported row executes from installed
// bytes; zero supported rows are skipped" is meaningless until "supported row"
// names a fixed, enumerated set.
//
// So the denominator is GENERATED, never hand-listed. A hand-maintained row
// list is exactly the drift this gate exists to prevent: a `supported` claim
// added to config/support-manifest.v1.json after the freeze would silently sit
// outside the certification run and the run would still report 100%.
//
// Four derivations, each from a manifest that already exists:
//
//   sdk-operation         config/support-manifest.v1.json supportClaims x operations
//   protocol-operation    config/support-manifest.v1.json protocols x operationClaims x operations
//                         (MapLibre client-only render rows are tagged renderer:true --
//                          the "representative MapLibre rendering" half of the denominator)
//   protocol-certification config/protocol-certification.v1.json operations, tiered by
//                         joining capability_key back to support-manifest through
//                         config/sdk-coverage-crosswalk.v1.json
//   terminal-journey      mcp/release/zero-to-map/journey.v1.json stages x actions,
//                         with the Admin MCP tools joined to their generated REST
//                         projection in config/admin-mcp-coverage.v1.json
//
// A protocol-operation row is additionally tagged portableMapArtifact when
// schemas/honua-map-package.v1.json can bind a source to it, so "representative
// MapLibre rendering from the portable map artifact" names rows the canonical
// map artifact can actually reference.
//
// Tiers are COPIED, never promoted. `beta`, `experimental`, `facade-required`
// and `deprecated` rows stay in the artifact -- they must remain visible -- but
// carry counts:false, and evaluateCertificationRun() refuses to let one satisfy
// a supported pass. A counting row also carries environmentSkipAllowed:false,
// which is how "a supported row may not pass through an environment skip"
// becomes enforceable rather than aspirational.
//
// Usage: node scripts/certification-denominator.mjs <write|check>
// Drift gate: scripts/verify-certification-denominator.mjs

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DENOMINATOR_PATH = "config/certification-denominator.v1.json";
export const DENOMINATOR_SCHEMA_PATH = "config/certification-denominator.schema.json";
export const SUPPORT_MANIFEST_PATH = "config/support-manifest.v1.json";
export const PROTOCOL_CERTIFICATION_PATH = "config/protocol-certification.v1.json";
export const SDK_COVERAGE_PATH = "config/sdk-coverage.v1.json";
export const SDK_COVERAGE_CROSSWALK_PATH = "config/sdk-coverage-crosswalk.v1.json";
export const CAPABILITY_CROSSWALK_PATH = "config/capability-crosswalk.v1.json";
export const RELEASE_ARTIFACTS_PATH = "config/release-artifacts.v1.json";
export const ADMIN_MCP_COVERAGE_PATH = "config/admin-mcp-coverage.v1.json";
export const APP_PLATFORM_QUALIFICATION_PATH = "config/app-platform-reference-qualification.v1.json";
export const JOURNEY_PATH = "mcp/release/zero-to-map/journey.v1.json";
export const MAP_PACKAGE_SCHEMA_PATH = "schemas/honua-map-package.v1.json";
export const SOURCE_BRIDGE_PATH = "src/runtime/source-bridge.ts";

/** Every file the denominator is derived from, digested into the frozen artifact. */
export const INPUT_PATHS = [
  ADMIN_MCP_COVERAGE_PATH,
  APP_PLATFORM_QUALIFICATION_PATH,
  CAPABILITY_CROSSWALK_PATH,
  JOURNEY_PATH,
  MAP_PACKAGE_SCHEMA_PATH,
  PROTOCOL_CERTIFICATION_PATH,
  RELEASE_ARTIFACTS_PATH,
  SDK_COVERAGE_CROSSWALK_PATH,
  SDK_COVERAGE_PATH,
  SOURCE_BRIDGE_PATH,
  SUPPORT_MANIFEST_PATH,
];

export const RELEASE = "2026.1";
export const CERTIFICATION_ISSUE = "https://github.com/honua-io/honua-sdk-js/issues/39";
export const REGENERATE_COMMAND = "npm run denominator:certification";

/**
 * The only tier that may be counted as a pass. Everything else is visible in the
 * artifact and inert in the arithmetic.
 */
export const COUNTING_TIER = "supported";

/**
 * Strongest-first. A capability key reached from several support-manifest
 * contributors takes the strongest one, mirroring how scripts/sdk-coverage.mjs
 * resolves the same many-to-one join (a key is `covered` when ANY contribution
 * is full). Taking the weakest instead would demote STAC -- whose baseline
 * stac-standalone claim is `supported` and whose dynamic workflow claim is
 * `experimental` -- and 2026.1 retains STAC as a supported protocol row.
 */
export const TIER_STRENGTH = ["supported", "beta", "experimental", "facade-required", "deprecated", "unsupported"];

/** Tier for a protocol-certification row whose capability key no manifest can tier. */
export const UNMAPPED_TIER = "unmapped";

export const TIER_VOCABULARY = [...TIER_STRENGTH, UNMAPPED_TIER];

/** Journey stages that compose, save, reopen and propose Studio content. */
export const STUDIO_LIFECYCLE_TOOLS = [
  "honua_studio_create_draft",
  "honua_studio_save_version",
  "honua_studio_get_version",
  "honua_studio_reopen_version",
  "honua_studio_propose_publication",
];

const ADMIN_TOOL_PREFIX = "honua_admin_";

/**
 * Wire protocols the portable map artifact can bind a source to, read out of
 * schemas/honua-map-package.v1.json rather than restated. The schema writes them
 * in the server's snake_case; config/support-manifest.v1.json uses kebab-case
 * for the same identifiers, and src/runtime/source-bridge.ts already translates
 * between the two.
 */
export function portableMapArtifactProtocols(mapPackageSchema) {
  const values = mapPackageSchema?.$defs?.sourceBinding?.properties?.protocol?.enum;
  return Array.isArray(values) ? values.map((value) => value.replaceAll("_", "-")).sort() : [];
}

/**
 * Which portable-map-artifact source bindings render through which MapLibre
 * pipeline, read out of `toMapLibreNativeSource` in src/runtime/source-bridge.ts
 * rather than restated here. That function IS the translation: a binding it
 * projects onto a MapLibre source spec of `type: "vector"` renders through the
 * vector source/layer wiring config/support-manifest.v1.json calls
 * `maplibre-vector`, and `type: "raster"` through `maplibre-raster`.
 *
 * Without this join the denominator tags renderer rows and portable rows
 * independently and no row carries both, so a run could pass an unrelated
 * renderer row plus an unrelated portable row and never prove "representative
 * MapLibre rendering FROM the portable map artifact". The conjunction is the
 * requirement; two separately satisfiable checks are not it.
 *
 * Derived by the same read-the-source method scripts/verify-release-artifacts.mjs
 * uses on the split-package generator, and guarded the same way: a parse that
 * stops matching fails loudly instead of silently emptying the set.
 *
 * @returns {Map<string, string[]>} renderer protocol id -> map-package protocols reaching it
 */
export function mapLibreNativeBindings(sourceBridgeSource) {
  const fn = /function toMapLibreNativeSource\([\s\S]*?\n\}/u.exec(sourceBridgeSource ?? "");
  const bindings = new Map();
  if (!fn) return bindings;
  const body = fn[0];

  const labels = [...body.matchAll(/case "([a-z_]+)":/gu)];
  const terminator = body.search(/\n\s*default:/u);
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    const next = labels[index + 1];
    // Consecutive `case` labels share one body; only the last of a run has it.
    const between = body.slice(label.index + label[0].length, next ? next.index : (terminator >= 0 ? terminator : body.length));
    if (/^\s*$/u.test(between)) continue;
    const type = /\btype:\s*"(vector|raster)"/u.exec(between);
    if (!type) continue; // e.g. `pmtiles`, whose spec type is decided at runtime.
    const rendererProtocol = `maplibre-${type[1]}`;
    // Walk back over the labels that fell through into this body.
    const group = [label[1]];
    for (let back = index - 1; back >= 0; back -= 1) {
      const gap = body.slice(labels[back].index + labels[back][0].length, labels[back + 1].index);
      if (!/^\s*$/u.test(gap)) break;
      group.unshift(labels[back][1]);
    }
    const reached = bindings.get(rendererProtocol) ?? [];
    bindings.set(rendererProtocol, sortedUnique([...reached, ...group.map((value) => value.replaceAll("_", "-"))]));
  }
  return bindings;
}

function readJson(relativePath, projectRoot = PROJECT_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

/** Key-sorted serialization so a digest describes content, not key order. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestValue(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function digestBytes(text) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function strongestTier(statuses) {
  let best;
  for (const status of statuses) {
    const rank = TIER_STRENGTH.indexOf(status);
    if (rank < 0) continue;
    if (best === undefined || rank < TIER_STRENGTH.indexOf(best)) best = status;
  }
  return best;
}

/**
 * capabilityKey -> the support-manifest claims that back it, using the exact
 * precedence scripts/sdk-coverage.mjs uses: a protocol with its own
 * supportClaims is described by those claims, and its generic operationClaims
 * are not a second, competing voice. `ogc-tiles` is the case that matters --
 * its operationClaims say `supported` while its one supportClaim says `beta`,
 * and 2026.1 ships OGC Tiles as beta.
 */
export function capabilityContributors({ supportManifest, coverageCrosswalk }) {
  const errors = [];
  const contributors = new Map();
  const add = (key, contribution) => {
    if (!contributors.has(key)) contributors.set(key, []);
    contributors.get(key).push(contribution);
  };

  const claimsByProtocol = new Map();
  for (const claim of supportManifest.supportClaims ?? []) {
    if (!claim.protocol) continue;
    if (!claimsByProtocol.has(claim.protocol)) claimsByProtocol.set(claim.protocol, []);
    claimsByProtocol.get(claim.protocol).push(claim);
  }

  for (const protocol of supportManifest.protocols ?? []) {
    const mapping = coverageCrosswalk.protocols?.[protocol.id];
    if (mapping === undefined) {
      errors.push(
        `${SDK_COVERAGE_CROSSWALK_PATH} has no entry for support-manifest protocol "${protocol.id}", so its rows cannot be tiered`,
      );
      continue;
    }
    if (mapping.internalOnly) continue;
    const tied = claimsByProtocol.get(protocol.id) ?? [];
    const sources =
      tied.length > 0
        ? tied.map((claim) => ({ status: claim.status, origin: `supportClaims/${claim.id}` }))
        : (protocol.operationClaims ?? []).map((claim, index) => ({
            status: claim.status,
            origin: `protocols/${protocol.id}/operationClaims/${index}`,
          }));
    for (const key of mapping.capabilityKeys ?? []) {
      for (const source of sources) add(key, source);
    }
  }

  const declaredProtocols = new Set((supportManifest.protocols ?? []).map((protocol) => protocol.id));
  for (const claim of supportManifest.supportClaims ?? []) {
    // A protocol-tied claim is described by its protocol above -- unless the
    // manifest has no `protocols` entry for it. `ogc-processes` is exactly that:
    // two supportClaims naming a protocol that is not in the protocol table, so
    // reading only the protocol table would drop OGC Processes from the
    // capability profile and leave its certification rows untierable.
    if (claim.protocol && declaredProtocols.has(claim.protocol)) continue;
    const mapping = coverageCrosswalk.supportClaims?.[claim.id];
    if (mapping === undefined) {
      errors.push(
        `${SDK_COVERAGE_CROSSWALK_PATH} has no entry for support-manifest supportClaim "${claim.id}", so its rows cannot be tiered`,
      );
      continue;
    }
    if (mapping.internalOnly) continue;
    for (const key of mapping.capabilityKeys ?? []) {
      add(key, { status: claim.status, origin: `supportClaims/${claim.id}` });
    }
  }

  return { contributors, errors };
}

/** capabilitySlug -> canonical keys, inverted so a key can name the docs vocabulary it serves. */
function documentationSlugsByCapabilityKey(capabilityCrosswalk) {
  const slugs = new Map();
  for (const [slug, entry] of Object.entries(capabilityCrosswalk.crosswalk ?? {})) {
    for (const key of entry.capabilityKeys ?? []) {
      if (!slugs.has(key)) slugs.set(key, []);
      slugs.get(key).push(slug);
    }
  }
  return slugs;
}

/**
 * `cappedBy` is how a row keeps its own manifest status verbatim while still
 * being refused a supported pass. config/support-manifest.v1.json models
 * `ogc-tiles` twice: the protocol-adapter operationClaim is `supported`, and the
 * one standalone supportClaim that decides whether the protocol ships is `beta`.
 * Rewriting the row's tier to `beta` would misquote the manifest; letting it
 * count would let a beta protocol satisfy a supported pass. So the row says
 * `supported`, names the beta claim that caps it, and does not count.
 */
function makeRow(row) {
  const counts = row.tier === COUNTING_TIER && !row.cappedBy;
  return {
    cappedBy: null,
    ...row,
    counts,
    // The whole point of AC1's second sentence. A row that counts toward the
    // supported denominator has no environment in which not running it is an
    // acceptable outcome; a non-counting row is allowed to be absent.
    environmentSkipAllowed: !counts,
  };
}

/** supportClaims x operations. The SDK operation rows. */
export function sdkOperationRows(supportManifest) {
  const rows = [];
  (supportManifest.supportClaims ?? []).forEach((claim, index) => {
    for (const operation of claim.operations ?? []) {
      rows.push(
        makeRow({
          id: `sdk-operation:${claim.id}:${operation}`,
          family: "sdk-operation",
          subject: claim.id,
          label: claim.label,
          operation,
          tier: claim.status,
          tierSource: `${SUPPORT_MANIFEST_PATH}#/supportClaims/${index}/status`,
          protocol: claim.protocol || null,
          environment: claim.environment ?? null,
          executionMode: claim.executionMode ?? null,
          source: { path: SUPPORT_MANIFEST_PATH, pointer: `/supportClaims/${index}` },
          evidence: sortedUnique(claim.evidence ?? []),
        }),
      );
    }
  });
  return rows;
}

/**
 * protocols x operationClaims x operations. The open-endpoint protocol rows --
 * GeoServices FeatureServer/MapServer/ImageServer/GPServer and the retained
 * OGC/WFS/WMS/WMTS/STAC/OData rows -- plus the client-only MapLibre render rows,
 * which are tagged rather than split into their own family because they are the
 * same kind of manifest row read through the same join.
 */
export function protocolOperationRows(supportManifest, mapPackageSchema = {}, sourceBridgeSource = "") {
  const rows = [];
  // Two ways a protocol row belongs to the portable map artifact: the artifact
  // binds a source to it directly, or the artifact binds a source to something
  // that renders through it. The second is what makes a renderer row portable.
  const direct = portableMapArtifactProtocols(mapPackageSchema);
  const viaRenderer = mapLibreNativeBindings(sourceBridgeSource);
  const portable = new Set([...direct, ...viaRenderer.keys()]);
  const claimsByProtocol = new Map();
  for (const claim of supportManifest.supportClaims ?? []) {
    if (!claim.protocol) continue;
    if (!claimsByProtocol.has(claim.protocol)) claimsByProtocol.set(claim.protocol, []);
    claimsByProtocol.get(claim.protocol).push(claim);
  }

  (supportManifest.protocols ?? []).forEach((protocol, protocolIndex) => {
    // The standalone claims that decide whether this protocol ships at all.
    const tied = claimsByProtocol.get(protocol.id) ?? [];
    const standaloneTier = tied.length > 0 ? strongestTier(tied.map((claim) => claim.status)) : undefined;
    const cappedBy =
      standaloneTier !== undefined && standaloneTier !== COUNTING_TIER
        ? {
            tier: standaloneTier,
            source: sortedUnique(
              tied
                .filter((claim) => claim.status === standaloneTier)
                .map((claim) => `${SUPPORT_MANIFEST_PATH}#/supportClaims/${claim.id}`),
            ).join(" "),
          }
        : null;

    (protocol.operationClaims ?? []).forEach((claim, claimIndex) => {
      for (const operation of claim.operations ?? []) {
        rows.push(
          makeRow({
            id: `protocol-operation:${protocol.id}:${operation}`,
            family: "protocol-operation",
            subject: protocol.id,
            label: protocol.label,
            operation,
            tier: claim.status,
            tierSource: `${SUPPORT_MANIFEST_PATH}#/protocols/${protocolIndex}/operationClaims/${claimIndex}/status`,
            cappedBy,
            protocol: protocol.id,
            environment: claim.environment ?? null,
            executionMode: claim.executionMode ?? null,
            // Derived from the claim, not from the protocol's name: a renderer
            // row is one that renders inside the client with no endpoint of its
            // own. Renaming maplibre-vector cannot quietly empty this set --
            // assertCertificationDenominatorInvariants fails when it does.
            renderer: operation === "render" && claim.environment === "client-only",
            // Whether the portable map artifact can bind a source to this
            // protocol at all. Read out of the canonical map-package schema, so
            // "representative MapLibre rendering from the portable map artifact"
            // names rows the artifact can actually reference.
            portableMapArtifact: portable.has(protocol.id),
            // Which map-package source bindings reach this row, so the artifact
            // evidences the conjunction rather than asserting it.
            portableMapArtifactBindings: viaRenderer.get(protocol.id) ?? (direct.includes(protocol.id) ? [protocol.id] : []),
            source: {
              path: SUPPORT_MANIFEST_PATH,
              pointer: `/protocols/${protocolIndex}/operationClaims/${claimIndex}`,
            },
            evidence: sortedUnique(claim.evidence ?? []),
          }),
        );
      }
    });
  });
  return rows;
}

/**
 * config/protocol-certification.v1.json operations, tiered by joining
 * capability_key back to the support manifest. A key with no support-manifest
 * contributor (alerts, geocoding, routing, grpc.web -- server capabilities this
 * SDK certifies but the support manifest does not tier) becomes `unmapped`: it
 * stays visible and cannot count. It is never invented as `supported`.
 */
export function protocolCertificationRows({
  protocolCertification,
  supportManifest,
  coverageCrosswalk,
  sdkCoverage,
  capabilityCrosswalk,
}) {
  const { contributors, errors } = capabilityContributors({ supportManifest, coverageCrosswalk });
  const coverageByKey = new Map((sdkCoverage.capabilities ?? []).map((entry) => [entry.key, entry.status]));
  const slugsByKey = documentationSlugsByCapabilityKey(capabilityCrosswalk);

  const rows = [];
  (protocolCertification.operations ?? []).forEach((operation, index) => {
    const backing = contributors.get(operation.capability_key) ?? [];
    const tier = strongestTier(backing.map((entry) => entry.status)) ?? UNMAPPED_TIER;
    rows.push(
      makeRow({
        id: `protocol-certification:${operation.surface}:${operation.operation}`,
        family: "protocol-certification",
        subject: operation.surface,
        label: operation.capability_key,
        operation: operation.operation,
        tier,
        tierSource:
          backing.length > 0
            ? sortedUnique(backing.map((entry) => `${SUPPORT_MANIFEST_PATH}#/${entry.origin}`)).join(" ")
            : `${PROTOCOL_CERTIFICATION_PATH} declares capability key "${operation.capability_key}", which no ${SUPPORT_MANIFEST_PATH} claim tiers`,
        capabilityKey: operation.capability_key,
        coverage: coverageByKey.get(operation.capability_key) ?? "absent",
        documentationSlugs: sortedUnique(slugsByKey.get(operation.capability_key) ?? []),
        scenarioFacets: [...(operation.scenario_facets ?? [])],
        source: { path: PROTOCOL_CERTIFICATION_PATH, pointer: `/operations/${index}` },
        evidence: [],
      }),
    );
  });

  return { rows, errors };
}

/**
 * The 2026.1 terminal journey, one row per action. The journey is the release
 * contract (its `releaseContract` field names it); it carries no per-action
 * status because there is no optional step in a terminal journey, so every
 * action is a counting row and the tier source says so rather than pretending
 * a manifest tiered it.
 *
 * Admin MCP tools are joined to their generated REST projection so a journey
 * action naming a tool the Admin projection no longer publishes fails the gate
 * instead of becoming an unexecutable denominator row.
 */
export function terminalJourneyRows({ journey, adminMcpCoverage }) {
  const errors = [];
  const projections = new Map((adminMcpCoverage.projected ?? []).map((entry) => [entry.toolName, entry]));
  const rows = [];

  if (typeof journey.releaseContract !== "string" || journey.releaseContract.length === 0) {
    errors.push(
      `${JOURNEY_PATH} no longer declares a releaseContract, so its actions cannot be treated as required 2026.1 rows`,
    );
  }

  (journey.stages ?? []).forEach((stage, stageIndex) => {
    (stage.actions ?? []).forEach((action, actionIndex) => {
      const projection = action.tool ? projections.get(action.tool) : undefined;
      if (typeof action.tool === "string" && action.tool.startsWith(ADMIN_TOOL_PREFIX) && !projection) {
        errors.push(
          `${JOURNEY_PATH} stage "${stage.id}" invokes admin tool "${action.tool}", which ${ADMIN_MCP_COVERAGE_PATH} does not project`,
        );
      }
      rows.push(
        makeRow({
          id: `terminal-journey:${stage.id}:${action.id}`,
          family: "terminal-journey",
          subject: stage.id,
          label: action.title,
          operation: action.id,
          tier: COUNTING_TIER,
          tierSource: `${JOURNEY_PATH}#/releaseContract (${journey.releaseContract ?? "missing"})`,
          kind: action.kind,
          tool: action.tool ?? null,
          adminProjection: projection
            ? { operationId: projection.operationId, method: projection.method, path: projection.path }
            : null,
          source: { path: JOURNEY_PATH, pointer: `/stages/${stageIndex}/actions/${actionIndex}` },
          evidence: [],
        }),
      );
    });
  });

  return { rows, errors };
}

/**
 * The frozen capability/profile digests AC1 asks for, separately from the row
 * list: the support-manifest status profile and the resolved capability-key
 * tier profile. Either changing changes a digest, and the drift gate says which.
 */
export function capabilityProfile({ supportManifest, coverageCrosswalk, capabilityCrosswalk }) {
  const { contributors } = capabilityContributors({ supportManifest, coverageCrosswalk });
  const slugsByKey = documentationSlugsByCapabilityKey(capabilityCrosswalk);
  const profile = {};
  for (const key of [...contributors.keys()].sort()) {
    const backing = contributors.get(key);
    profile[key] = {
      tier: strongestTier(backing.map((entry) => entry.status)) ?? UNMAPPED_TIER,
      contributors: sortedUnique(backing.map((entry) => entry.origin)),
      documentationSlugs: sortedUnique(slugsByKey.get(key) ?? []),
    };
  }
  return profile;
}

export function supportProfile(supportManifest) {
  const claims = {};
  for (const claim of supportManifest.supportClaims ?? []) {
    claims[claim.id] = claim.status;
  }
  const protocols = {};
  for (const protocol of supportManifest.protocols ?? []) {
    const operations = {};
    for (const claim of protocol.operationClaims ?? []) {
      for (const operation of claim.operations ?? []) {
        operations[operation] = strongestTier([operations[operation], claim.status].filter(Boolean)) ?? claim.status;
      }
    }
    protocols[protocol.id] = operations;
  }
  return { claims, protocols };
}

/**
 * Structural invariants the frozen artifact must satisfy on its own terms, so a
 * hand-edited denominator fails even when nobody re-runs the generator.
 */
export function assertCertificationDenominatorInvariants(denominator) {
  const errors = [];
  const rows = denominator.rows ?? [];

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) errors.push(`duplicate denominator row id "${row.id}"`);
    seen.add(row.id);
    if (!TIER_VOCABULARY.includes(row.tier)) {
      errors.push(`row "${row.id}" carries tier "${row.tier}", which is not in the tier vocabulary`);
    }
    if (row.counts !== (row.tier === COUNTING_TIER && !row.cappedBy)) {
      errors.push(
        row.cappedBy
          ? `row "${row.id}" is capped at "${row.cappedBy.tier}" by ${row.cappedBy.source} but counts=${row.counts}; a ${row.cappedBy.tier} claim may not be counted as a supported pass`
          : `row "${row.id}" is tier "${row.tier}" but counts=${row.counts}; only ${COUNTING_TIER} rows may count toward the denominator`,
      );
    }
    if (row.environmentSkipAllowed !== !row.counts) {
      errors.push(
        `row "${row.id}" counts=${row.counts} but environmentSkipAllowed=${row.environmentSkipAllowed}; a supported row may not pass through an environment skip`,
      );
    }
  }

  // Guards against a silently emptied derivation: a regex or join that stops
  // matching would otherwise leave a smaller denominator that still says "no
  // drift". Every family named by #39 must actually be populated.
  for (const family of ["sdk-operation", "protocol-operation", "protocol-certification", "terminal-journey"]) {
    if (!rows.some((row) => row.family === family)) {
      errors.push(`the denominator contains no "${family}" rows, so that derivation is no longer proving anything`);
    }
  }
  if (!rows.some((row) => row.renderer === true && row.counts)) {
    errors.push(
      "the denominator contains no counting renderer row, so representative MapLibre rendering is no longer covered",
    );
  }
  if (!rows.some((row) => row.portableMapArtifact === true && row.counts)) {
    errors.push(
      `the denominator contains no counting row for any protocol ${MAP_PACKAGE_SCHEMA_PATH} can bind a source to, so the portable map artifact is no longer covered`,
    );
  }
  // Both halves of the portable-map-artifact join must still be readable. Either
  // one silently emptying would leave a denominator that reports no drift while
  // proving strictly less than it claims.
  if ((denominator.portableMapArtifact?.sourceProtocols ?? []).length === 0) {
    errors.push(
      `${MAP_PACKAGE_SCHEMA_PATH} declares no source bindings this gate can read, so the portable map artifact is no longer described`,
    );
  }
  if (Object.keys(denominator.portableMapArtifact?.rendererBindings ?? {}).length === 0) {
    errors.push(
      `no portable map artifact source binding could be traced to a MapLibre pipeline through ${SOURCE_BRIDGE_PATH}, so this gate can no longer prove rendering from the portable map artifact`,
    );
  }
  // The conjunction, and the reason the two checks above are not enough. #39
  // requires "representative MapLibre rendering FROM the portable map artifact".
  // A renderer row and a portable row that are different rows can each be
  // satisfied in isolation without ever rendering a portable map.
  if (!rows.some((row) => row.renderer === true && row.portableMapArtifact === true && row.counts)) {
    errors.push(
      `the denominator contains no counting row that is BOTH a renderer row and bound to the portable map artifact, so representative MapLibre rendering from the portable map artifact cannot be certified; check that ${SOURCE_BRIDGE_PATH} still projects map-package source bindings onto MapLibre-native sources`,
    );
  }
  const journeyTools = new Set(rows.filter((row) => row.family === "terminal-journey").map((row) => row.tool));
  for (const tool of STUDIO_LIFECYCLE_TOOLS) {
    if (!journeyTools.has(tool)) {
      errors.push(
        `the terminal journey no longer invokes "${tool}", so the canonical Studio lifecycle is not in the denominator`,
      );
    }
  }

  return errors;
}

/** Pure builder: every input is supplied, so every failure mode is fixture-testable. */
export function buildCertificationDenominator(inputs) {
  const {
    supportManifest,
    protocolCertification,
    sdkCoverage,
    coverageCrosswalk,
    capabilityCrosswalk,
    releaseArtifacts,
    adminMcpCoverage,
    appPlatformQualification,
    journey,
    mapPackageSchema,
    sourceBridgeSource,
    inputDigests,
  } = inputs;

  const errors = [];
  const certification = protocolCertificationRows({
    protocolCertification,
    supportManifest,
    coverageCrosswalk,
    sdkCoverage,
    capabilityCrosswalk,
  });
  const journeyRows = terminalJourneyRows({ journey, adminMcpCoverage });
  errors.push(...certification.errors, ...journeyRows.errors);

  const rows = [
    ...sdkOperationRows(supportManifest),
    ...protocolOperationRows(supportManifest, mapPackageSchema, sourceBridgeSource),
    ...certification.rows,
    ...journeyRows.rows,
  ].sort((left, right) => left.id.localeCompare(right.id));

  const byTier = {};
  for (const tier of TIER_VOCABULARY) {
    const count = rows.filter((row) => row.tier === tier).length;
    if (count > 0) byTier[tier] = count;
  }
  const byFamily = {};
  for (const row of rows) byFamily[row.family] = (byFamily[row.family] ?? 0) + 1;

  const profiles = {
    capability: capabilityProfile({ supportManifest, coverageCrosswalk, capabilityCrosswalk }),
    support: supportProfile(supportManifest),
  };

  const denominator = {
    $schema: "./certification-denominator.schema.json",
    format: "honua.sdk.certification-denominator.v1",
    schemaVersion: 1,
    release: RELEASE,
    certificationIssue: CERTIFICATION_ISSUE,
    generator: "scripts/certification-denominator.mjs",
    driftGate: "scripts/verify-certification-denominator.mjs",
    description:
      "Frozen 2026.1 installed-package certification denominator. Every row that must execute from installed registry bytes, tagged with the support tier it was copied from and the manifest row it came from. Only `supported` rows count; beta, experimental, facade-required and deprecated rows remain visible and inert. Generated -- never hand-authored.",
    countingTier: COUNTING_TIER,
    tierVocabulary: TIER_VOCABULARY,
    candidatePackages: sortedUnique((releaseArtifacts.included ?? []).map((artifact) => artifact.npmName)),
    registry: releaseArtifacts.registry ?? null,
    terminalJourney: {
      journeyId: journey.journeyId ?? null,
      releaseContract: journey.releaseContract ?? null,
      stages: (journey.stages ?? []).map((stage) => stage.id),
    },
    portableMapArtifact: {
      schema: MAP_PACKAGE_SCHEMA_PATH,
      $id: mapPackageSchema?.$id ?? null,
      title: mapPackageSchema?.title ?? null,
      sourceProtocols: portableMapArtifactProtocols(mapPackageSchema),
      rendererBindings: Object.fromEntries([...mapLibreNativeBindings(sourceBridgeSource)].sort()),
      rendererBindingSource: SOURCE_BRIDGE_PATH,
    },
    appPlatform: {
      journey: [...(appPlatformQualification.journey ?? [])],
      lanes: (appPlatformQualification.lanes ?? []).map((lane) => lane.id),
      browsers: (appPlatformQualification.browsers ?? []).map((browser) => browser.id),
      evidenceDigest: appPlatformQualification.evidenceDigest ?? null,
      maturityDigest: appPlatformQualification.maturityDigest ?? null,
    },
    inputs: inputDigests,
    profiles,
    digests: {
      inputs: digestValue(inputDigests),
      capabilityProfile: digestValue(profiles.capability),
      supportProfile: digestValue(profiles.support),
      rows: digestValue(rows),
    },
    summary: {
      rows: rows.length,
      counting: rows.filter((row) => row.counts).length,
      visibleNonCounting: rows.filter((row) => !row.counts).length,
      renderer: rows.filter((row) => row.renderer === true).length,
      portableMapArtifact: rows.filter((row) => row.portableMapArtifact === true).length,
      rendererFromPortableMapArtifact: rows.filter((row) => row.renderer === true && row.portableMapArtifact === true)
        .length,
      byTier,
      byFamily,
    },
    rows,
  };

  errors.push(...assertCertificationDenominatorInvariants(denominator));
  return { denominator, errors };
}

/**
 * Drift evaluation: the frozen artifact against a denominator regenerated from
 * the manifests as they are now. Input digests are compared first and named
 * individually -- "support-manifest changed, denominator did not" is the
 * failure this gate exists to report, and it should not arrive as an unreadable
 * row diff.
 */
export function evaluateCertificationDenominatorDrift({ frozen, generated }) {
  const errors = [];
  if (!frozen || typeof frozen !== "object") {
    return [`${DENOMINATOR_PATH} is missing or unreadable; regenerate it with ${REGENERATE_COMMAND}`];
  }

  const frozenInputs = new Map((frozen.inputs ?? []).map((entry) => [entry.path, entry]));
  const generatedInputs = new Map((generated.inputs ?? []).map((entry) => [entry.path, entry]));
  for (const [inputPath, entry] of generatedInputs) {
    const recorded = frozenInputs.get(inputPath);
    if (!recorded) {
      errors.push(`${DENOMINATOR_PATH} records no digest for input ${inputPath}`);
      continue;
    }
    if (recorded.sha256 !== entry.sha256) {
      errors.push(
        `${inputPath} changed (${entry.sha256}) but ${DENOMINATOR_PATH} was frozen against ${recorded.sha256}`,
      );
    }
  }
  for (const inputPath of frozenInputs.keys()) {
    if (!generatedInputs.has(inputPath)) {
      errors.push(`${DENOMINATOR_PATH} records input ${inputPath}, which is no longer a denominator input`);
    }
  }

  const frozenRows = new Map((frozen.rows ?? []).map((row) => [row.id, row]));
  const generatedRows = new Map((generated.rows ?? []).map((row) => [row.id, row]));

  for (const [id, row] of generatedRows) {
    const recorded = frozenRows.get(id);
    if (!recorded) {
      errors.push(
        row.counts
          ? `${row.tier} row "${id}" is required by ${row.source?.path} but is absent from ${DENOMINATOR_PATH}`
          : `row "${id}" (${row.tier}) is absent from ${DENOMINATOR_PATH}`,
      );
      continue;
    }
    if (recorded.tier !== row.tier) {
      errors.push(
        `row "${id}" is tier "${recorded.tier}" in ${DENOMINATOR_PATH} but "${row.tier}" in ${row.tierSource ?? row.source?.path}`,
      );
    }
    if (stableJson(recorded) !== stableJson(row)) {
      errors.push(`row "${id}" no longer matches the manifests it was generated from`);
    }
  }
  for (const id of frozenRows.keys()) {
    if (!generatedRows.has(id)) {
      errors.push(`${DENOMINATOR_PATH} declares row "${id}", which no manifest produces`);
    }
  }

  for (const key of ["inputs", "capabilityProfile", "supportProfile", "rows"]) {
    if (frozen.digests?.[key] !== generated.digests?.[key]) {
      errors.push(
        `frozen ${key} digest ${frozen.digests?.[key] ?? "<missing>"} does not match the regenerated ${generated.digests?.[key]}`,
      );
    }
  }

  if (errors.length > 0) errors.push(`Regenerate the frozen denominator with ${REGENERATE_COMMAND}.`);
  return errors;
}

/**
 * The counting policy for a certification run. #39 is executed elsewhere -- it
 * needs a live candidate server and published registry bytes -- but the rules by
 * which its results are scored are repository policy and are enforced here, so
 * a run cannot be assembled that skips a supported row or promotes a beta one.
 *
 * @param {object} options
 * @param {object} options.denominator the frozen artifact
 * @param {Array<{rowId: string, status: string, skipReason?: string, countedAsSupported?: boolean}>} options.results
 */
export function evaluateCertificationRun({ denominator, results }) {
  const errors = [];
  const rows = new Map((denominator.rows ?? []).map((row) => [row.id, row]));
  const seen = new Set();

  for (const result of results ?? []) {
    const row = rows.get(result.rowId);
    if (!row) {
      errors.push(`certification result references "${result.rowId}", which is not a denominator row`);
      continue;
    }
    if (seen.has(result.rowId)) {
      errors.push(`certification result for "${result.rowId}" appears more than once`);
      continue;
    }
    seen.add(result.rowId);

    if (result.countedAsSupported === true && !row.counts) {
      errors.push(
        `"${result.rowId}" is a ${row.tier} row and was counted as a supported pass; ${COUNTING_TIER} is the only counting tier`,
      );
    }
    if (!row.counts) continue;

    if (result.status === "skipped") {
      errors.push(
        `supported row "${result.rowId}" was satisfied by an environment skip (${result.skipReason ?? "no reason given"}); a supported row may not pass through an environment skip`,
      );
      continue;
    }
    if (result.status !== "passed") {
      errors.push(`supported row "${result.rowId}" did not pass from installed bytes (status "${result.status}")`);
    }
  }

  for (const [id, row] of rows) {
    if (row.counts && !seen.has(id)) {
      errors.push(`supported row "${id}" has no certification result; zero supported rows may be skipped`);
    }
  }

  errors.push(...evaluateRendererRequirement({ denominator, results }));

  return errors;
}

/**
 * "Representative MapLibre rendering from the portable map artifact" is one
 * requirement, not two. Passing a renderer row and separately passing a row the
 * portable artifact can carry does not establish the conjunction: nothing in
 * that pair ever rendered a portable map.
 *
 * So the requirement is satisfied only by a row that is BOTH -- a renderer row
 * the portable map artifact can actually reach through
 * src/runtime/source-bridge.ts. A denominator with no such row cannot certify
 * the requirement at all, and says so rather than accepting the pair.
 */
export function evaluateRendererRequirement({ denominator, results }) {
  const rows = denominator.rows ?? [];
  const combined = rows.filter((row) => row.renderer === true && row.portableMapArtifact === true && row.counts);
  if (combined.length === 0) {
    const renderer = rows.filter((row) => row.renderer === true && row.counts).length;
    const portable = rows.filter((row) => row.portableMapArtifact === true && row.counts).length;
    return [
      `the denominator has ${renderer} counting renderer rows and ${portable} counting portable-map-artifact rows but none that is both, so "representative MapLibre rendering from the portable map artifact" cannot be certified; satisfying the two independently does not satisfy the conjunction`,
    ];
  }
  // Only a `passed` result counts. A skipped or failed result on the one row
  // that could prove the conjunction leaves it unproven.
  const passed = combined.filter((row) =>
    (results ?? []).some((result) => result.rowId === row.id && result.status === "passed"),
  );
  if (passed.length === 0) {
    return [
      `no row proving MapLibre rendering from the portable map artifact passed (candidates: ${combined.map((row) => row.id).join(", ")})`,
    ];
  }
  return [];
}

/** Read every input the builder needs from a checkout, digesting each file's bytes. */
export function loadCertificationDenominatorInputs(projectRoot = PROJECT_ROOT) {
  const inputDigests = INPUT_PATHS.map((relativePath) => {
    const text = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    return { path: relativePath, bytes: Buffer.byteLength(text, "utf8"), sha256: digestBytes(text) };
  });
  return {
    supportManifest: readJson(SUPPORT_MANIFEST_PATH, projectRoot),
    protocolCertification: readJson(PROTOCOL_CERTIFICATION_PATH, projectRoot),
    sdkCoverage: readJson(SDK_COVERAGE_PATH, projectRoot),
    coverageCrosswalk: readJson(SDK_COVERAGE_CROSSWALK_PATH, projectRoot),
    capabilityCrosswalk: readJson(CAPABILITY_CROSSWALK_PATH, projectRoot),
    releaseArtifacts: readJson(RELEASE_ARTIFACTS_PATH, projectRoot),
    adminMcpCoverage: readJson(ADMIN_MCP_COVERAGE_PATH, projectRoot),
    appPlatformQualification: readJson(APP_PLATFORM_QUALIFICATION_PATH, projectRoot),
    journey: readJson(JOURNEY_PATH, projectRoot),
    mapPackageSchema: readJson(MAP_PACKAGE_SCHEMA_PATH, projectRoot),
    sourceBridgeSource: fs.readFileSync(path.join(projectRoot, SOURCE_BRIDGE_PATH), "utf8"),
    inputDigests,
  };
}

export function serializeCertificationDenominator(denominator) {
  return `${JSON.stringify(denominator, null, 2)}\n`;
}

export async function validateCertificationDenominatorSchema(denominator, schema) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020").default;
  const addFormats = require("ajv-formats").default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(denominator)) return [];
  return (validate.errors ?? []).map((error) => `denominator${error.instancePath} ${error.message}`);
}

async function main() {
  const command = process.argv[2];
  if (command !== "write" && command !== "check") {
    process.stderr.write("Usage: node scripts/certification-denominator.mjs <write|check>\n");
    process.exit(2);
  }
  const { denominator, errors } = buildCertificationDenominator(loadCertificationDenominatorInputs());
  const schemaErrors = await validateCertificationDenominatorSchema(
    denominator,
    readJson(DENOMINATOR_SCHEMA_PATH),
  );
  const failures = [...errors, ...schemaErrors];
  if (failures.length > 0) {
    process.stderr.write(`Certification denominator generation failed:\n${failures.map((f) => `- ${f}`).join("\n")}\n`);
    process.exit(1);
  }

  const serialized = serializeCertificationDenominator(denominator);
  const output = path.join(PROJECT_ROOT, DENOMINATOR_PATH);
  if (command === "write") {
    fs.writeFileSync(output, serialized);
  } else if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== serialized) {
    process.stderr.write(`${DENOMINATOR_PATH} has drifted. Run ${REGENERATE_COMMAND}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${command === "write" ? "Wrote" : "Verified"} ${DENOMINATOR_PATH}: ${denominator.summary.rows} rows, ` +
      `${denominator.summary.counting} counting (${COUNTING_TIER}), ` +
      `${denominator.summary.visibleNonCounting} visible non-counting.\n`,
  );
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) await main();
