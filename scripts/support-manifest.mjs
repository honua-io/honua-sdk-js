#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "config/support-manifest.v1.json";
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

const GENERATED_PATHS = {
  publicSurface: "config/public-surface.json",
  supportProjectionSchema: "support/contract/v1/schemas/support-projection.schema.json",
  supportProjection: "support/projections/sdk-support.v1.json",
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

export function validateSupportManifest(manifest, { projectRoot = PROJECT_ROOT, checkEvidencePaths = true } = {}) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (manifest.format !== "honua.sdk.support-manifest.v1" || manifest.schemaVersion !== 1) {
    fail("manifest must use honua.sdk.support-manifest.v1 schema version 1");
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
  for (const claim of manifest.supportClaims ?? []) {
    usedStatuses.add(claim.status);
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
  }
  const stableCount = entrypoints.filter((entrypoint) => entrypoint.status === "supported").length;
  if (stableCount !== manifest.packageLifecycle?.ceilings?.stableEntrypoints) {
    fail(`supported entrypoint count ${stableCount} disagrees with stableEntrypoints ceiling`);
  }

  for (const status of STATUS_VOCABULARY) {
    if (!usedStatuses.has(status)) fail(`status vocabulary value is not represented by a claim: ${status}`);
  }
  return failures;
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

${table}

### Generated claim evidence

Every non-unsupported operation claim maps to executable evidence and a freshness
policy in the manifest.

| Protocol | Operations | Status | Environment | Execution mode | Evidence |
| --- | --- | --- | --- | --- | --- |
${evidenceRows.join("\n")}`;
}

export function renderStandaloneSection(manifest) {
  const rows = manifest.supportClaims.map(
    (claim) =>
      `| ${claim.label} | \`${claim.status}\` | \`${claim.environment}\` | \`${claim.executionMode}\` | ${claim.backendNeeded} | ${claim.api} | ${markdownEvidence(manifest, claim.evidence, "../") || "Lifecycle-only claim"} | ${claim.notes} |`,
  );
  return `This is the generated, evidence-linked line between capabilities that work
against raw standards-speaking endpoints and capabilities that require the Honua
facade. The source of truth is [\`${MANIFEST_PATH}\`](../${MANIFEST_PATH}).
See the [standalone quickstart](./standalone-quickstart.md) for the runnable path.

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

| Capability | Status | Environment | Execution | Backend needed | API | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Current OGC line

Raw OGC API Tiles, Maps, and Records discovery/use is \`beta\` and fixture-proven.
Raw OGC API Processes discovery is \`experimental\`; typed Processes execution is
still \`facade-required\`. Those are deliberately separate claims so discovery
evidence can never be mistaken for execution support.`;
}

function lifecycleCounts(manifest) {
  const counts = Object.fromEntries(STATUS_VOCABULARY.map((status) => [status, 0]));
  for (const entrypoint of manifest.packageLifecycle.entrypoints) counts[entrypoint.status]++;
  return counts;
}

export function renderReadmeReleaseSection(manifest, packageJson) {
  const counts = lifecycleCounts(manifest);
  return `**Release status: ${manifest.sdk.releaseStatus}** (\`${packageJson.version}\`). The ${counts.supported}-entrypoint stable tier is frozen and guarded
by an API-surface gate; ${counts.experimental} experimental subpaths may change before 1.0, and
${counts.deprecated} deprecated compatibility subpaths have explicit removal versions. See
[\`config/support-manifest.v1.json\`](./config/support-manifest.v1.json) for the versioned support truth,
[\`config/public-surface.json\`](./config/public-surface.json) for its generated package projection,
[\`support/projections/sdk-support.v1.json\`](./support/projections/sdk-support.v1.json) for the generic
site/sample consumer contract, and
[the scope decision](./docs/decisions/scope-split-and-1.0.md).`;
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
  const execution = supportClaim(manifest, "ogc-processes-execution-facade");
  return `**Honua Server is optional for standards clients.** Supported GeoServices, OGC API
Features, WFS 2.0, STAC, and OData claims work against raw standards-speaking endpoints.
OGC API Tiles (\`${tiles.status}\`), Maps (\`${maps.status}\`), and Records
(\`${records.status}\`) also discover and use raw advertised paths. OGC API Processes
keeps two honest lanes: raw discovery is \`${discovery.status}\`, while typed execution
is \`${execution.status}\`.

A [Honua Server](https://github.com/honua-io/honua-server) adds server-authored
\`MapPackage\`s, realtime, collaboration, MCP/AI execution, compatibility metadata, and
the facade-required execution paths. See the generated
[backend-agnostic capability matrix](./docs/standalone-capability-matrix.md) for every
claim, execution mode, and evidence link.`;
}

export function renderInstallSupportSection(manifest) {
  const counts = lifecycleCounts(manifest);
  return `## Generated support status

The versioned source of truth is [\`config/support-manifest.v1.json\`](./config/support-manifest.v1.json).
It projects ${counts.supported} supported (documented below as stable), ${counts.experimental} experimental,
and ${counts.deprecated} deprecated package entrypoints. Protocol status is independent
of package lifecycle: raw endpoint support, facade requirements, execution mode, and
evidence are listed in the generated
[backend-agnostic capability matrix](./docs/standalone-capability-matrix.md). The generic
[support projection](./support/projections/sdk-support.v1.json) carries explicit contracts
for both honua.io and the canonical \`samples/catalog.v2.json\` inventory.`;
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
    connectProtocols: manifest.connectProtocols,
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
    "connectProtocols",
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
      replaceManagedSection(protocolDoc, "protocol-matrix", renderProtocolSection(manifest)),
    ],
    [
      "docs/standalone-capability-matrix.md",
      replaceManagedSection(standaloneDoc, "standalone-matrix", renderStandaloneSection(manifest)),
    ],
    ["README.md", replaceManagedSection(replaceManagedSection(readme, "release", renderReadmeReleaseSection(manifest, packageJson)), "standalone", renderReadmeStandaloneSection(manifest))],
    ["INSTALL.md", replaceManagedSection(install, "install-status", renderInstallSupportSection(manifest))],
    [GENERATED_PATHS.supportProjectionSchema, json(buildSupportProjectionSchema(manifestSchema))],
    [GENERATED_PATHS.supportProjection, json(buildSupportProjection(manifest, packageJson))],
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
