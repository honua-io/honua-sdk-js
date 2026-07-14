#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const CATALOG_PATH = "samples/catalog.v2.json";
const V1_CATALOG_PATH = "samples/catalog.v1.json";
const V1_MIGRATION_PATH = "samples/contract/v2/migrations/catalog.v1-to-v2.json";
const CATALOG_SCHEMA_PATH = "samples/contract/v2/schemas/sample-catalog.schema.json";
const MIGRATION_SCHEMA_PATH = "samples/contract/v2/schemas/catalog-migration.schema.json";
const GENERATED_CATALOG_PATH = "docs/generated/sample-catalog.md";
const SITE_PROJECTION_PATH = "samples/dist/honua-site-samples.v2.json";
const SITE_PROJECTION_SCHEMA_PATH = "samples/contract/v2/schemas/site-projection.schema.json";
const CI_SELECTION_PATH = "samples/dist/sample-ci-selection.v2.json";
const CI_SELECTION_SCHEMA_PATH = "samples/contract/v2/schemas/sample-ci-selection.schema.json";
const SITE_CONSUMER_FIXTURE_PATH = "samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json";
const README_START = "<!-- sample-catalog:start -->";
const README_END = "<!-- sample-catalog:end -->";
const RESERVED_GOLDEN_JOURNEY_IDS = [
  "first-map",
  "service-explorer",
  "planning-permitting",
  "incident-operations",
  "imagery-terrain",
  "cloud-native-analysis",
  "arcgis-migration",
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedUnique(values, label) {
  invariant(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`);
  const sorted = [...values].sort();
  invariant(new Set(values).size === values.length, `${label} contains duplicates`);
  invariant(JSON.stringify(values) === JSON.stringify(sorted), `${label} must be sorted`);
}

function assertRelativePath(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty path`);
  invariant(!path.isAbsolute(value) && !value.includes(".."), `${label} must stay inside the repository`);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

async function validateJsonSchema(value, schemaPath) {
  const schema = await readJson(schemaPath);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(value)) return;
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new Error(`${schemaPath}: JSON Schema validation failed: ${details}`);
}

function parseDateTime(value, label) {
  invariant(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
    `${label} must be an RFC 3339 date-time`,
  );
  return Date.parse(value);
}

function parseRelease(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? "");
  invariant(match, `${label} must be a semantic release`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareReleases(left, right) {
  const leftRelease = parseRelease(left, "package version");
  const rightRelease = parseRelease(right, "target release");
  for (let index = 0; index < leftRelease.core.length; index += 1) {
    if (leftRelease.core[index] !== rightRelease.core[index]) {
      return leftRelease.core[index] - rightRelease.core[index];
    }
  }
  if (leftRelease.prerelease.length === 0) return rightRelease.prerelease.length === 0 ? 0 : 1;
  if (rightRelease.prerelease.length === 0) return -1;
  const length = Math.max(leftRelease.prerelease.length, rightRelease.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftRelease.prerelease[index];
    const rightPart = rightRelease.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function pathExists(relativePath) {
  try {
    await stat(path.join(PROJECT_ROOT, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseNpmCommand(command) {
  const match = /^npm run ([a-zA-Z0-9:_-]+)(?:\s|$)/.exec(command);
  return match?.[1];
}

async function runnableDocsExampleDirectories() {
  const root = path.join(PROJECT_ROOT, "docs/examples");
  const entries = await readdir(root, { withFileTypes: true });
  const runnable = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relative = `docs/examples/${entry.name}`;
    if (!(await pathExists(`${relative}/index.html`))) continue;
    const hasAppEntry = ["app.js", "app.mjs", "app.ts"].some((name) =>
      require("node:fs").existsSync(path.join(PROJECT_ROOT, relative, name)),
    );
    if (hasAppEntry) runnable.push(relative);
  }
  return runnable.sort();
}

export function isRunnableRootExampleDirectory(name, markers) {
  if (name.startsWith("_") || name.startsWith(".")) return false;
  return ["index.html", "package.json", "src/server.ts"].some((marker) => markers.includes(marker));
}

async function runnableRootExampleDirectories() {
  const root = path.join(PROJECT_ROOT, "examples");
  const entries = await readdir(root, { withFileTypes: true });
  const runnable = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relative = `examples/${entry.name}`;
    const markers = [];
    for (const marker of ["index.html", "package.json", "src/server.ts"]) {
      if (await pathExists(`${relative}/${marker}`)) markers.push(marker);
    }
    if (isRunnableRootExampleDirectory(entry.name, markers)) runnable.push(relative);
  }
  return runnable.sort();
}

function inferredLiveMode(sample) {
  if (sample.lanes.live.status === "not-applicable") return "unavailable";
  if (!["none", "anonymous"].includes(sample.data.authMode)) return "authenticated";
  return sample.protocols.includes("honua") || sample.protocols.includes("sse") ? "demo-live" : "public-live";
}

export async function migrateCatalogV1ToV2(catalog, migration) {
  await validateJsonSchema(migration, MIGRATION_SCHEMA_PATH);
  invariant(catalog.format === "honua.sdk.sample-catalog.v1", "migration source catalog format must be v1");
  invariant(catalog.schemaVersion === 1, "migration source catalog schemaVersion must be 1");
  const sourceIds = catalog.samples.map((sample) => sample.id).sort();
  const overrideIds = Object.keys(migration.sampleOverrides).sort();
  invariant(
    JSON.stringify(sourceIds) === JSON.stringify(overrideIds),
    `migration overrides must cover every v1 sample exactly:\nsource ${sourceIds.join(", ")}\noverrides ${overrideIds.join(", ")}`,
  );

  const migratedSamples = catalog.samples.map((sample) => {
    const override = migration.sampleOverrides[sample.id];
    const state = sample.disposition.decision === "keep" ? "active" : sample.disposition.decision;
    const lifecycle = {
      state,
      reason: sample.disposition.reason,
      ...(state === "active" ? {} : { targetRelease: migration.targetRelease }),
      ...(override.replacement ? { replacement: override.replacement } : {}),
    };
    const originalLive = sample.lanes.live;
    const liveOverride = override.live ?? {};
    const live = {
      mode: liveOverride.mode ?? inferredLiveMode(sample),
      ...(liveOverride.targetMode ? { targetMode: liveOverride.targetMode } : {}),
      status: liveOverride.status ?? originalLive.status,
      commands: [...originalLive.commands],
      ...(liveOverride.evidencePath || originalLive.evidencePath
        ? { evidencePath: liveOverride.evidencePath ?? originalLive.evidencePath }
        : {}),
      ...(liveOverride.expiresAt ? { expiresAt: liveOverride.expiresAt } : {}),
    };
    return {
      id: sample.id,
      title: sample.title,
      summary: sample.summary,
      sourceKind: "root-example",
      track: override.track,
      ...(override.journeyId ? { journeyId: override.journeyId } : {}),
      supportTier: sample.supportStatus,
      lifecycle,
      sourcePath: sample.sourcePath,
      docsPath: sample.docsPath,
      capabilities: [...sample.capabilities],
      protocols: [...sample.protocols],
      renderers: [...sample.renderers],
      data: {
        ...structuredClone(sample.data),
        configurationStatus: sample.data.config.length > 0 ? "approved" : "not-required",
      },
      evidence: {
        fixture: {
          mode: "fixture",
          status: sample.lanes.fixture.status,
          commands: [...sample.lanes.fixture.commands],
          ...(sample.lanes.fixture.evidencePath ? { evidencePath: sample.lanes.fixture.evidencePath } : {}),
        },
        live,
      },
      expectedDegradation: sample.expectedDegradation,
      validationProfile: override.validationProfile,
      validation: [...sample.validation],
    };
  });

  const siteMappings = catalog.siteMappings.map((mapping) => {
    if (mapping.ownership === "sdk-projection") return structuredClone(mapping);
    const track =
      mapping.tier === "flagship"
        ? "golden"
        : mapping.tier === "recipe"
          ? "recipe"
          : "lab";
    const { tier: _tier, supportStatus: _supportStatus, ...rest } = mapping;
    return { ...rest, track, supportTier: mapping.supportStatus };
  });

  return {
    $schema: "./contract/v2/schemas/sample-catalog.schema.json",
    format: "honua.sdk.sample-catalog.v2",
    schemaVersion: 2,
    migratedFrom: { format: catalog.format, path: migration.source },
    sdk: structuredClone(catalog.sdk),
    configuration: {
      ...structuredClone(catalog.configuration),
      evidenceExpiry: structuredClone(migration.configuration.evidenceExpiry),
    },
    goldenJourneys: structuredClone(migration.goldenJourneys),
    qualityProfiles: structuredClone(migration.qualityProfiles),
    externalReplacements: structuredClone(migration.externalReplacements),
    samples: [...migratedSamples, ...structuredClone(migration.addedSamples)].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    siteMappings,
  };
}

export async function validateCatalog(catalog, packageJson, options = {}) {
  await validateJsonSchema(catalog, CATALOG_SCHEMA_PATH);
  invariant(catalog.format === "honua.sdk.sample-catalog.v2", "catalog format must be v2");
  invariant(catalog.schemaVersion === 2, "catalog schemaVersion must be 2");
  invariant(catalog.migratedFrom?.path === V1_CATALOG_PATH, "catalog v1 migration source is required");
  invariant(catalog.sdk && typeof catalog.sdk === "object", "catalog SDK metadata is required");
  invariant(catalog.sdk?.package === packageJson.name, "catalog SDK package must match package.json");
  invariant(!Object.hasOwn(catalog.sdk, "version"), "catalog SDK version is derived from package.json and must not be pinned");
  invariant(catalog.configuration?.endpointValuePolicy === "environment-name-only", "catalog endpoint values must remain external");
  invariant(
    JSON.stringify(catalog.configuration?.allowedSchemes) === JSON.stringify(["http", "https"]),
    "catalog endpoints must be restricted to HTTP(S)",
  );
  sortedUnique(catalog.configuration?.credentialQueryParameters, "configuration.credentialQueryParameters");
  invariant(Number.isInteger(catalog.configuration?.evidenceExpiry?.executedMaxDays), "executed evidence expiry policy is required");
  invariant(Number.isInteger(catalog.configuration?.evidenceExpiry?.nonExecutedMaxDays), "non-executed evidence expiry policy is required");
  invariant(Array.isArray(catalog.samples), "catalog samples must be an array");
  invariant(Array.isArray(catalog.siteMappings), "catalog siteMappings must be an array");

  const journeyIds = catalog.goldenJourneys.map((journey) => journey.id);
  invariant(
    JSON.stringify(journeyIds) === JSON.stringify(RESERVED_GOLDEN_JOURNEY_IDS),
    `golden journey IDs must be reserved in canonical order: ${RESERVED_GOLDEN_JOURNEY_IDS.join(", ")}`,
  );
  invariant(
    new Set(catalog.goldenJourneys.map((journey) => journey.candidateSampleId)).size === 7,
    "golden journey candidate sample IDs must be unique",
  );

  const qualityProfileIds = catalog.qualityProfiles.map((profile) => profile.id);
  invariant(new Set(qualityProfileIds).size === qualityProfileIds.length, "quality profile IDs must be unique");
  invariant(
    JSON.stringify(qualityProfileIds) === JSON.stringify([...qualityProfileIds].sort()),
    "quality profiles must be sorted by id",
  );
  const qualityProfiles = new Map(catalog.qualityProfiles.map((profile) => [profile.id, profile]));
  const goldenProfile = qualityProfiles.get("golden-browser");
  invariant(goldenProfile, "golden-browser quality profile is required");
  invariant(Object.values(goldenProfile.gates).every(Boolean), "golden-browser must require every quality gate");

  const externalReplacementIds = catalog.externalReplacements.map((replacement) => replacement.id);
  invariant(new Set(externalReplacementIds).size === externalReplacementIds.length, "external replacement IDs must be unique");
  const externalReplacements = new Set(externalReplacementIds);

  const sampleIds = new Set();
  const sourcePaths = new Set();
  const orderedSampleIds = catalog.samples.map((sample) => sample.id);
  invariant(JSON.stringify(orderedSampleIds) === JSON.stringify([...orderedSampleIds].sort()), "catalog samples must be sorted by id");
  const currentTime = options.now === undefined ? Date.now() : parseDateTime(options.now, "validation time");
  for (const sample of catalog.samples) {
    invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sample.id), `invalid sample id: ${sample.id}`);
    invariant(!sampleIds.has(sample.id), `duplicate sample id: ${sample.id}`);
    sampleIds.add(sample.id);
    invariant(typeof sample.title === "string" && sample.title.length > 0, `${sample.id}: title is required`);
    invariant(["golden", "recipe", "lab", "fixture"].includes(sample.track), `${sample.id}: invalid track`);
    invariant(
      ["supported", "experimental", "internal", "deprecated"].includes(sample.supportTier),
      `${sample.id}: invalid support tier`,
    );
    invariant(qualityProfiles.has(sample.validationProfile), `${sample.id}: unknown validation profile ${sample.validationProfile}`);
    invariant(typeof sample.lifecycle?.reason === "string" && sample.lifecycle.reason.length > 0, `${sample.id}: lifecycle reason is required`);
    if (sample.lifecycle.state !== "active") {
      invariant(sample.lifecycle.targetRelease, `${sample.id}: unresolved lifecycle requires targetRelease`);
      invariant(
        compareReleases(packageJson.version, sample.lifecycle.targetRelease) < 0,
        `${sample.id}: lifecycle ${sample.lifecycle.state} expired at ${sample.lifecycle.targetRelease}`,
      );
    }
    assertRelativePath(sample.sourcePath, `${sample.id}.sourcePath`);
    assertRelativePath(sample.docsPath, `${sample.id}.docsPath`);
    invariant(await pathExists(sample.sourcePath), `${sample.id}: sourcePath does not exist: ${sample.sourcePath}`);
    invariant(await pathExists(sample.docsPath), `${sample.id}: docsPath does not exist: ${sample.docsPath}`);
    invariant(
      sample.sourceKind === "root-example"
        ? sample.sourcePath.startsWith("examples/")
        : sample.sourcePath.startsWith("docs/examples/"),
      `${sample.id}: sourceKind does not match sourcePath`,
    );
    sourcePaths.add(sample.sourcePath);
    sortedUnique(sample.capabilities, `${sample.id}.capabilities`);
    sortedUnique(sample.protocols, `${sample.id}.protocols`);
    sortedUnique(sample.renderers, `${sample.id}.renderers`);
    invariant(
      ["fixture", "public-live", "demo-live", "authenticated-live", "hybrid", "none"].includes(
        sample.data.mode,
      ),
      `${sample.id}: invalid data mode`,
    );
    invariant(["none", "anonymous", "api-key", "bearer", "oauth", "host-mediated"].includes(sample.data.authMode), `${sample.id}: invalid auth mode`);
    invariant(typeof sample.data.provenance === "string", `${sample.id}: provenance is required`);
    invariant(typeof sample.data.attribution === "string", `${sample.id}: attribution is required`);
    invariant(typeof sample.data.freshness === "string", `${sample.id}: freshness is required`);
    invariant(Array.isArray(sample.data.config) && sample.data.config.every((entry) => typeof entry === "string"), `${sample.id}: data.config must contain variable names`);
    if (sample.data.config.length > 0) sortedUnique(sample.data.config, `${sample.id}.data.config`);
    if (sample.data.configurationStatus === "approved") {
      invariant(sample.data.config.length > 0, `${sample.id}: approved configuration requires declared config names`);
      invariant(!sample.data.configurationGap, `${sample.id}: approved configuration cannot declare a gap`);
    } else if (sample.data.configurationStatus === "not-required") {
      invariant(sample.data.config.length === 0, `${sample.id}: not-required configuration cannot declare config names`);
      invariant(!sample.data.configurationGap, `${sample.id}: not-required configuration cannot declare a gap`);
    } else {
      invariant(sample.data.configurationStatus === "legacy-unsafe", `${sample.id}: invalid configuration status`);
      invariant(sample.data.config.length === 0, `${sample.id}: legacy-unsafe configuration cannot be approved by name`);
      invariant(
        typeof sample.data.configurationGap === "string" && sample.data.configurationGap.length > 0,
        `${sample.id}: legacy-unsafe configuration requires a configurationGap`,
      );
      invariant(sample.lifecycle.state !== "active", `${sample.id}: legacy-unsafe configuration requires bounded rework`);
    }
    if (
      ["hybrid", "authenticated-live"].includes(sample.data.mode) &&
      !["none", "anonymous"].includes(sample.data.authMode)
    ) {
      invariant(
        sample.data.configurationStatus !== "not-required",
        `${sample.id}: credentialed live data requires approved configuration or an explicit legacy gap`,
      );
    }
    if (sample.data.config.length > 0) {
      const configFiles = (await walkFiles(sample.sourcePath)).filter(
        (file) =>
          !file.endsWith("package-lock.json") &&
          [".ts", ".tsx", ".js", ".mjs", ".md", ".html", ".json"].includes(path.extname(file)),
      );
      const configSurface = (
        await Promise.all(configFiles.map((file) => readFile(path.join(PROJECT_ROOT, file), "utf8")))
      ).join("\n");
      for (const variable of sample.data.config) {
        invariant(configSurface.includes(variable), `${sample.id}: undeclared implementation config ${variable}`);
      }
    }
    invariant(!JSON.stringify(sample).match(/(?:AKIA|Bearer\s|api[_-]?key\s*[=:]\s*[^<])/i), `${sample.id}: catalog appears to contain a credential`);
    invariant(typeof sample.expectedDegradation === "string", `${sample.id}: expectedDegradation is required`);
    invariant(Array.isArray(sample.validation) && sample.validation.length > 0, `${sample.id}: validation is required`);
    for (const command of [...sample.evidence.fixture.commands, ...sample.evidence.live.commands, ...sample.validation]) {
      const npmScript = parseNpmCommand(command);
      if (npmScript) invariant(packageJson.scripts?.[npmScript], `${sample.id}: unknown package script ${npmScript}`);
    }
    for (const command of sample.validation) {
      invariant(
        !/(?:^|:)(?:mock|live-evidence)(?:\s|$)|\bbench:live\b/.test(command),
        `${sample.id}: validation command must be bounded; fixture and live producers belong in their evidence lanes`,
      );
    }
    invariant(
      ["executed", "not-applicable", "planned"].includes(sample.evidence.fixture.status),
      `${sample.id}: invalid fixture lane status`,
    );
    invariant(sample.evidence.fixture.mode === "fixture", `${sample.id}: fixture evidence mode must be fixture`);
    invariant(
      ["executed", "not-applicable", "planned", "skipped", "credential-unavailable", "failed"].includes(
        sample.evidence.live.status,
      ),
      `${sample.id}: invalid live lane status`,
    );
    const evidenceBoundStatuses = new Set(["executed", "skipped", "credential-unavailable", "failed"]);
    if (evidenceBoundStatuses.has(sample.evidence.live.status)) {
      invariant(sample.evidence.live.evidencePath, `${sample.id}: ${sample.evidence.live.status} live status requires evidencePath`);
      invariant(sample.evidence.live.expiresAt, `${sample.id}: ${sample.evidence.live.status} live status requires expiresAt`);
      assertRelativePath(sample.evidence.live.evidencePath, `${sample.id}.evidence.live.evidencePath`);
      const evidence = validateEvidenceEnvelope(await readJson(sample.evidence.live.evidencePath));
      invariant(evidence.sampleId === sample.id, `${sample.id}: live evidence sampleId drift`);
      invariant(evidence.lane === "live", `${sample.id}: catalog evidence must be a live envelope`);
      invariant(evidence.status === sample.evidence.live.status, `${sample.id}: live lane status must match evidence`);
      invariant(
        evidence.sdk.version === packageJson.version,
        `${sample.id}: live evidence SDK version ${evidence.sdk.version} does not match ${packageJson.version}`,
      );
      const observedAt = parseDateTime(evidence.observedAt, `${sample.id}.evidence.observedAt`);
      const expiresAt = parseDateTime(sample.evidence.live.expiresAt, `${sample.id}.evidence.live.expiresAt`);
      invariant(expiresAt > observedAt, `${sample.id}: evidence expiry must follow observation time`);
      const maxDays =
        sample.evidence.live.status === "executed"
          ? catalog.configuration.evidenceExpiry.executedMaxDays
          : catalog.configuration.evidenceExpiry.nonExecutedMaxDays;
      invariant(
        expiresAt - observedAt <= maxDays * 24 * 60 * 60 * 1000,
        `${sample.id}: evidence expiry exceeds ${maxDays}-day policy`,
      );
      invariant(currentTime < expiresAt, `${sample.id}: live evidence expired at ${sample.evidence.live.expiresAt}`);
      if (sample.evidence.live.status === "executed") {
        invariant(
          ["public-live", "demo-live", "authenticated"].includes(sample.evidence.live.mode),
          `${sample.id}: executed live evidence requires a live mode`,
        );
        invariant(!sample.evidence.live.targetMode, `${sample.id}: executed evidence cannot declare targetMode`);
      } else {
        invariant(
          ["degraded", "unavailable"].includes(sample.evidence.live.mode),
          `${sample.id}: non-executed evidence must be degraded or unavailable`,
        );
        invariant(sample.evidence.live.targetMode, `${sample.id}: non-executed live evidence requires targetMode`);
      }
      await validateLiveEvidenceProducer(evidence, sample);
    } else {
      invariant(!sample.evidence.live.evidencePath, `${sample.id}: ${sample.evidence.live.status} cannot carry evidencePath`);
      invariant(!sample.evidence.live.expiresAt, `${sample.id}: ${sample.evidence.live.status} cannot carry expiresAt`);
      invariant(!sample.evidence.live.targetMode, `${sample.id}: ${sample.evidence.live.status} cannot carry targetMode`);
      if (sample.evidence.live.status === "not-applicable") {
        invariant(sample.evidence.live.mode === "unavailable", `${sample.id}: not-applicable live mode must be unavailable`);
      } else {
        invariant(
          ["public-live", "demo-live", "authenticated"].includes(sample.evidence.live.mode),
          `${sample.id}: planned live evidence requires a target live mode`,
        );
      }
    }
  }

  for (const sample of catalog.samples) {
    const replacement = sample.lifecycle.replacement;
    if (!replacement) continue;
    invariant(replacement.id !== sample.id, `${sample.id}: lifecycle replacement cannot reference itself`);
    if (replacement.kind === "sample") invariant(sampleIds.has(replacement.id), `${sample.id}: unknown replacement sample ${replacement.id}`);
    if (replacement.kind === "journey") invariant(journeyIds.includes(replacement.id), `${sample.id}: unknown replacement journey ${replacement.id}`);
    if (replacement.kind === "external") invariant(externalReplacements.has(replacement.id), `${sample.id}: unknown external replacement ${replacement.id}`);
  }
  const sampleReplacement = new Map(
    catalog.samples
      .filter((sample) => sample.lifecycle.replacement?.kind === "sample")
      .map((sample) => [sample.id, sample.lifecycle.replacement.id]),
  );
  for (const start of sampleReplacement.keys()) {
    const chain = [start];
    let current = start;
    while (sampleReplacement.has(current)) {
      const next = sampleReplacement.get(current);
      invariant(!chain.includes(next), `sample replacement cycle: ${[...chain, next].join(" -> ")}`);
      chain.push(next);
      current = next;
    }
  }

  for (const journey of catalog.goldenJourneys) {
    const sample = catalog.samples.find((candidate) => candidate.id === journey.candidateSampleId);
    invariant(sample, `${journey.id}: candidate sample does not exist: ${journey.candidateSampleId}`);
    invariant(sample.journeyId === journey.id, `${journey.id}: journey/candidate mapping drift`);
    if (journey.status === "qualified") {
      invariant(sample.track === "golden", `${journey.id}: qualified journey candidate must use the golden track`);
    } else {
      invariant(sample.track !== "golden", `${journey.id}: planned journey candidate cannot use the golden track`);
    }
  }
  for (const sample of catalog.samples) {
    if (!sample.journeyId) continue;
    const journey = catalog.goldenJourneys.find((candidate) => candidate.id === sample.journeyId);
    invariant(journey, `${sample.id}: unknown golden journey ${sample.journeyId}`);
    invariant(journey.candidateSampleId === sample.id, `${sample.id}: sample is not the declared candidate for ${sample.journeyId}`);
  }

  const goldenSamples = catalog.samples.filter((sample) => sample.track === "golden");
  const qualifiedJourneys = catalog.goldenJourneys.filter((journey) => journey.status === "qualified");
  invariant(
    goldenSamples.length === qualifiedJourneys.length,
    "golden sample count must match the qualified journey count",
  );
  for (const sample of goldenSamples) {
    const profile = qualityProfiles.get(sample.validationProfile);
    invariant(sample.supportTier === "supported", `${sample.id}: golden samples must be supported`);
    invariant(sample.lifecycle.state === "active", `${sample.id}: golden samples must be active`);
    invariant(sample.evidence.fixture.status === "executed", `${sample.id}: golden samples require executed fixture evidence`);
    invariant(Object.values(profile.gates).every(Boolean), `${sample.id}: golden samples require every quality gate`);
    if (profile.gates.liveEvidence) {
      invariant(sample.evidence.live.status === "executed", `${sample.id}: golden samples require current executed live evidence`);
    }
    const journey = catalog.goldenJourneys.find((candidate) => candidate.id === sample.journeyId);
    invariant(journey?.status === "qualified", `${sample.id}: golden sample journey must be qualified`);
    invariant(journey.candidateSampleId === sample.id, `${sample.id}: golden sample must be its journey candidate`);
  }

  const exampleDirectories = await runnableRootExampleDirectories();
  const representedExamples = catalog.samples
    .filter((sample) => sample.sourceKind === "root-example")
    .map((sample) => sample.sourcePath)
    .sort();
  invariant(
    JSON.stringify(exampleDirectories) === JSON.stringify(representedExamples),
    `example inventory drift:\nexpected ${exampleDirectories.join(", ")}\nrepresented ${representedExamples.join(", ")}`,
  );
  const docsExamples = await runnableDocsExampleDirectories();
  const representedDocsExamples = catalog.samples
    .filter((sample) => sample.sourceKind === "docs-example")
    .map((sample) => sample.sourcePath)
    .sort();
  invariant(
    JSON.stringify(docsExamples) === JSON.stringify(representedDocsExamples),
    `runnable docs example inventory drift:\nexpected ${docsExamples.join(", ")}\nrepresented ${representedDocsExamples.join(", ")}`,
  );
  invariant(sourcePaths.size === catalog.samples.length, "sample source paths must be unique");

  const siteIds = new Set();
  for (const mapping of catalog.siteMappings) {
    invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mapping.id), `invalid site sample id: ${mapping.id}`);
    invariant(!siteIds.has(mapping.id), `duplicate site sample id: ${mapping.id}`);
    siteIds.add(mapping.id);
    invariant(/^[-a-z0-9]+\.html$/.test(mapping.route), `${mapping.id}: invalid static site route`);
    invariant(["sdk-projection", "site-exception"].includes(mapping.ownership), `${mapping.id}: invalid ownership`);
    if (mapping.ownership === "sdk-projection") {
      invariant(sampleIds.has(mapping.sampleId), `${mapping.id}: unknown SDK sample ${mapping.sampleId}`);
    } else {
      invariant(!mapping.sampleId, `${mapping.id}: site exceptions cannot identify SDK executable source`);
      invariant(typeof mapping.exceptionReason === "string" && mapping.exceptionReason.length > 0, `${mapping.id}: site exception reason is required`);
      invariant(typeof mapping.title === "string" && mapping.title.length > 0, `${mapping.id}: site exception title is required`);
      invariant(["golden", "recipe", "lab", "fixture"].includes(mapping.track), `${mapping.id}: site exception track is required`);
      invariant(
        ["supported", "experimental", "internal", "deprecated"].includes(mapping.supportTier),
        `${mapping.id}: site exception support tier is required`,
      );
      sortedUnique(mapping.capabilities, `${mapping.id}.capabilities`);
    }
  }
  invariant(catalog.siteMappings.length === 21, "the compatibility route fixture must map all 21 existing honua.io samples");
}

export async function validateLiveEvidenceProducer(evidence, sample) {
  if (!evidence.sdk.gitCommit) return;
  if (sample.evidence.live.commands.includes("npm run bench:live")) {
    const producer = evidence.artifacts.find((artifact) =>
      artifact.kind.startsWith("producer-generator:"),
    );
    invariant(producer, `${sample.id}: live evidence requires a producer-generator artifact`);
    invariant(
      producer.kind === `producer-generator:${evidence.sdk.gitCommit}`,
      `${sample.id}: producer artifact does not match sdk.gitCommit`,
    );
    assertRelativePath(producer.path, `${sample.id}.producer.path`);
    const generatorBytes = await readFile(path.join(PROJECT_ROOT, producer.path));
    invariant(
      sha256(generatorBytes) === producer.sha256,
      `${sample.id}: producer generator digest drift`,
    );
    const generator = generatorBytes.toString("utf8");
    const sampleLiteral = `sampleId: "${sample.id}"`;
    const journeyLiteral = `journeyId: "${evidence.semantics.operation}"`;
    invariant(generator.includes(sampleLiteral), `${sample.id}: producer generator does not support this sample`);
    invariant(generator.includes(journeyLiteral), `${sample.id}: producer generator does not support this journey`);
  }
}

export function effectiveCatalog(catalog, packageJson) {
  return {
    ...catalog,
    sdk: {
      package: packageJson.name,
      version: packageJson.version,
    },
  };
}

function publicSample(sample, sdk) {
  return {
    id: sample.id,
    title: sample.title,
    summary: sample.summary,
    sourceKind: sample.sourceKind,
    track: sample.track,
    ...(sample.journeyId ? { journeyId: sample.journeyId } : {}),
    supportTier: sample.supportTier,
    lifecycle: structuredClone(sample.lifecycle),
    validationProfile: sample.validationProfile,
    source: {
      repository: "honua-io/honua-sdk-js",
      path: sample.sourcePath,
      docsPath: sample.docsPath,
    },
    sdk: { package: sdk.package, version: sdk.version },
    capabilities: sample.capabilities,
    protocols: sample.protocols,
    renderers: sample.renderers,
    data: {
      mode: sample.data.mode,
      authMode: sample.data.authMode,
      provenance: sample.data.provenance,
      attribution: sample.data.attribution,
      freshness: sample.data.freshness,
      configurationStatus: sample.data.configurationStatus,
      ...(sample.data.configurationGap ? { configurationGap: sample.data.configurationGap } : {}),
    },
    evidence: {
      fixture: {
        mode: sample.evidence.fixture.mode,
        status: sample.evidence.fixture.status,
      },
      live: {
        mode: sample.evidence.live.mode,
        ...(sample.evidence.live.targetMode ? { targetMode: sample.evidence.live.targetMode } : {}),
        status: sample.evidence.live.status,
        ...(sample.evidence.live.evidencePath ? { evidencePath: sample.evidence.live.evidencePath } : {}),
        ...(sample.evidence.live.expiresAt ? { expiresAt: sample.evidence.live.expiresAt } : {}),
      },
    },
    expectedDegradation: sample.expectedDegradation,
  };
}

export function generateSiteProjection(catalog, packageJson) {
  const effective = effectiveCatalog(catalog, packageJson);
  const routes = catalog.siteMappings.map((mapping) => {
    if (mapping.ownership === "site-exception") {
      return {
        id: mapping.id,
        route: mapping.route,
        ownership: mapping.ownership,
        exceptionReason: mapping.exceptionReason,
        title: mapping.title,
        summary: mapping.summary,
        track: mapping.track,
        supportTier: mapping.supportTier,
        capabilities: mapping.capabilities,
      };
    }
    return {
      id: mapping.id,
      route: mapping.route,
      ownership: mapping.ownership,
      sampleId: mapping.sampleId,
    };
  });
  return {
    format: "honua.site.sdk-sample-projection.v2",
    schemaVersion: 2,
    catalog: {
      format: effective.format,
      schemaVersion: effective.schemaVersion,
      package: effective.sdk.package,
      version: effective.sdk.version,
    },
    contract: {
      producer: "honua-io/honua-sdk-js#540",
      consumer: "honua-io/honua-sdk-js#550",
      executableSourceOwner: "honua-io/honua-sdk-js",
      presentationOwner: "honua-io/honua-site",
    },
    goldenJourneys: structuredClone(catalog.goldenJourneys),
    externalReplacements: structuredClone(catalog.externalReplacements),
    qualityProfiles: structuredClone(catalog.qualityProfiles),
    samples: effective.samples.map((sample) => publicSample(sample, effective.sdk)),
    routes,
  };
}

export function generateCiSelection(catalog) {
  const profiles = catalog.qualityProfiles.map((profile) => ({
    id: profile.id,
    gates: structuredClone(profile.gates),
    sampleIds: catalog.samples
      .filter((sample) => sample.validationProfile === profile.id)
      .map((sample) => sample.id),
  }));
  const profileById = new Map(catalog.qualityProfiles.map((profile) => [profile.id, profile]));
  return {
    format: "honua.sdk.sample-ci-selection.v2",
    schemaVersion: 2,
    catalog: {
      format: catalog.format,
      schemaVersion: catalog.schemaVersion,
    },
    goldenJourneys: structuredClone(catalog.goldenJourneys),
    profiles,
    samples: catalog.samples.map((sample) => {
      return {
        id: sample.id,
        sourcePath: sample.sourcePath,
        track: sample.track,
        ...(sample.journeyId ? { journeyId: sample.journeyId } : {}),
        supportTier: sample.supportTier,
        validationProfile: sample.validationProfile,
        gates: structuredClone(profileById.get(sample.validationProfile).gates),
        commandPlan: {
          validation: {
            execution: "automatic",
            commands: [...sample.validation],
          },
          fixtureEvidence: {
            execution: "orchestrated",
            commands: [...sample.evidence.fixture.commands],
          },
          liveEvidence: {
            execution: "scheduled-only",
            commands: [...sample.evidence.live.commands],
          },
        },
        liveEvidence: {
          mode: sample.evidence.live.mode,
          ...(sample.evidence.live.targetMode ? { targetMode: sample.evidence.live.targetMode } : {}),
          status: sample.evidence.live.status,
          ...(sample.evidence.live.evidencePath ? { evidencePath: sample.evidence.live.evidencePath } : {}),
          ...(sample.evidence.live.expiresAt ? { expiresAt: sample.evidence.live.expiresAt } : {}),
        },
      };
    }),
  };
}

export async function validateSiteProjection(projection) {
  await validateJsonSchema(projection, SITE_PROJECTION_SCHEMA_PATH);
}

export async function validateCiSelection(selection) {
  await validateJsonSchema(selection, CI_SELECTION_SCHEMA_PATH);
}

function generateSiteConsumerFixture(projection) {
  return {
    format: "honua.site.sdk-sample-consumer-fixture.v2",
    schemaVersion: 2,
    accepts: {
      projectionFormat: projection.format,
      projectionSchemaVersion: projection.schemaVersion,
      catalogFormat: projection.catalog.format,
      catalogSchemaVersion: projection.catalog.schemaVersion,
    },
    input: {
      path: SITE_PROJECTION_PATH,
      schemaPath: SITE_PROJECTION_SCHEMA_PATH,
      sha256: sha256(Buffer.from(stableJson(projection))),
    },
    assertions: {
      sampleCount: projection.samples.length,
      rootExampleCount: projection.samples.filter((sample) => sample.sourceKind === "root-example").length,
      docsExampleCount: projection.samples.filter((sample) => sample.sourceKind === "docs-example").length,
      goldenJourneyCount: projection.goldenJourneys.length,
      qualifiedGoldenCount: projection.goldenJourneys.filter((journey) => journey.status === "qualified").length,
      routeCount: projection.routes.length,
      sampleIdsUnique: true,
      routeIdsUnique: true,
      routesEndInHtml: true,
      executableSourceOwner: "honua-io/honua-sdk-js",
      presentationOwner: "honua-io/honua-site",
      credentialValuesForbidden: true,
    },
    representativeRoutes: ["quickstart-map", "public-safety", "two-protocols"],
  };
}

function generatedCatalogMarkdown(catalog, packageJson) {
  const journeyRows = catalog.goldenJourneys.map(
    (journey) =>
      `| \`${journey.id}\` | ${journey.status} | [\`${journey.candidateSampleId}\`](#${journey.candidateSampleId}) |`,
  );
  const rows = catalog.samples.map(
    (sample) =>
      `| <a id="${sample.id}"></a>[\`${sample.id}\`](../../${sample.docsPath}) | ${sample.track} | ${sample.journeyId ?? "-"} | ${sample.supportTier} | ${sample.lifecycle.state} | ${sample.validationProfile} | ${sample.data.mode} | ${sample.data.configurationStatus} | ${sample.summary} |`,
  );
  return [
    "# SDK sample catalog",
    "",
    "This inventory is generated from [`samples/catalog.v2.json`](../../samples/catalog.v2.json). Do not edit it by hand.",
    "",
    `Catalog contract: \`${catalog.format}\` · SDK: \`${packageJson.name}\` (effective version derived from \`package.json\`) · ${catalog.samples.length} executable examples`,
    "",
    "## Golden journey readiness",
    "",
    "Journey IDs are stable roadmap slots. `planned` candidates remain recipes or labs until their golden quality profile and evidence are satisfied; only `qualified` candidates use the golden track.",
    "",
    "| Journey | Status | Candidate sample |",
    "| --- | --- | --- |",
    ...journeyRows,
    "",
    "## Executable samples",
    "",
    "| Sample | Track | Journey candidate | Support | Lifecycle | Quality profile | Data | Configuration | Demonstration |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "The catalog also carries fixture/live evidence, evidence expiry, endpoint configuration names, provenance, attribution, freshness, lifecycle targets, validation profiles, and the complete 21-route honua.io migration mapping. The presentation-safe projection is [`samples/dist/honua-site-samples.v2.json`](../../samples/dist/honua-site-samples.v2.json).",
    "",
  ].join("\n");
}

function readmeFragment(catalog) {
  const counts = Object.fromEntries(
    ["golden", "recipe", "lab", "fixture"].map((track) => [
      track,
      catalog.samples.filter((sample) => sample.track === track).length,
    ]),
  );
  const plannedJourneys = catalog.goldenJourneys.filter((journey) => journey.status === "planned").length;
  return [
    README_START,
    `The versioned [SDK sample catalog](./docs/generated/sample-catalog.md) tracks all ${catalog.samples.length} executable examples: ${counts.golden} qualified golden ${counts.golden === 1 ? "sample" : "samples"}, ${counts.recipe} recipes, ${counts.lab} labs, and ${counts.fixture} fixtures. Seven journey IDs are reserved; ${plannedJourneys} remain explicitly planned candidates. The catalog is the source of truth for track, support, lifecycle, fixture/live evidence, quality profiles, and the honua.io projection.`,
    README_END,
  ].join("\n");
}

function replaceReadmeFragment(readme, fragment) {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  invariant(start >= 0 && end > start, "README sample catalog markers are missing or malformed");
  return `${readme.slice(0, start)}${fragment}${readme.slice(end + README_END.length)}`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function generatedOutputs(catalog, packageJson) {
  const readme = await readFile(path.join(PROJECT_ROOT, "README.md"), "utf8");
  const projection = generateSiteProjection(catalog, packageJson);
  const ciSelection = generateCiSelection(catalog);
  return new Map([
    [GENERATED_CATALOG_PATH, generatedCatalogMarkdown(catalog, packageJson)],
    [SITE_PROJECTION_PATH, stableJson(projection)],
    [CI_SELECTION_PATH, stableJson(ciSelection)],
    [SITE_CONSUMER_FIXTURE_PATH, stableJson(generateSiteConsumerFixture(projection))],
    ["README.md", replaceReadmeFragment(readme, readmeFragment(catalog))],
  ]);
}

function normalizeProjectionVersion(serialized) {
  const projection = JSON.parse(serialized);
  projection.catalog.version = "$PACKAGE_VERSION";
  for (const sample of projection.samples) {
    if (sample.sdk) sample.sdk.version = "$PACKAGE_VERSION";
  }
  return stableJson(projection);
}

function normalizeConsumerProjectionHash(serialized) {
  const fixture = JSON.parse(serialized);
  fixture.input.sha256 = "$PROJECTION_SHA256";
  return stableJson(fixture);
}

export function generatedOutputDrift(expectedOutputs, currentOutputs) {
  const failures = [];
  const expectedProjection = expectedOutputs.get(SITE_PROJECTION_PATH);
  const currentProjection = currentOutputs.get(SITE_PROJECTION_PATH) ?? "";
  const projectionVersionOnly =
    expectedProjection !== currentProjection &&
    normalizeProjectionVersion(expectedProjection) === normalizeProjectionVersion(currentProjection);
  const currentConsumerFixture = JSON.parse(currentOutputs.get(SITE_CONSUMER_FIXTURE_PATH) ?? "{}");
  const expectedConsumerFixture = JSON.parse(expectedOutputs.get(SITE_CONSUMER_FIXTURE_PATH) ?? "{}");
  const currentProjectionDigestIsValid =
    currentConsumerFixture.input?.sha256 === sha256(Buffer.from(currentProjection));
  const expectedProjectionDigestIsValid =
    expectedConsumerFixture.input?.sha256 === sha256(Buffer.from(expectedProjection));

  for (const [relativePath, expected] of expectedOutputs) {
    const current = currentOutputs.get(relativePath) ?? "";
    if (current === expected) continue;
    if (relativePath === SITE_PROJECTION_PATH && projectionVersionOnly) continue;
    if (
      relativePath === SITE_CONSUMER_FIXTURE_PATH &&
      projectionVersionOnly &&
      currentProjectionDigestIsValid &&
      expectedProjectionDigestIsValid &&
      normalizeConsumerProjectionHash(expected) === normalizeConsumerProjectionHash(current)
    ) {
      continue;
    }
    failures.push(relativePath);
  }
  return failures;
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walkFiles(relativeDirectory) {
  const files = [];
  const entries = await readdir(path.join(PROJECT_ROOT, relativeDirectory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

export async function buildBrowserArtifactManifest({ artifacts, gitCommit = gitSha() }) {
  const packageJson = await readJson("package.json");
  const packageLock = await readFile(path.join(PROJECT_ROOT, "package-lock.json"));
  invariant(typeof gitCommit === "string" && /^[a-f0-9]{40}$/.test(gitCommit), "gitCommit must be a 40-character SHA");
  invariant(Array.isArray(artifacts) && artifacts.length > 0, "at least one browser artifact is required");
  const files = [];
  for (const artifact of [...artifacts].sort((left, right) => left.path.localeCompare(right.path))) {
    assertRelativePath(artifact.path, "artifact.path");
    const bytes = await readFile(path.join(PROJECT_ROOT, artifact.path));
    files.push({
      path: artifact.path,
      entrypoint: artifact.entrypoint,
      mediaType: artifact.mediaType ?? "text/javascript",
      bytes: bytes.byteLength,
      integrity: `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
      sha256: sha256(bytes),
    });
  }
  const inputPaths = [
    "package.json",
    "package-lock.json",
    "scripts/build-browser-bundle.mjs",
    ...(await walkFiles("src")),
  ];
  const inputs = [];
  for (const inputPath of inputPaths.sort()) {
    const bytes = await readFile(path.join(PROJECT_ROOT, inputPath));
    inputs.push({ path: inputPath, sha256: sha256(bytes) });
  }
  return {
    format: "honua.sdk.browser-artifacts.v1",
    schemaVersion: 1,
    package: { name: packageJson.name, version: packageJson.version, gitCommit },
    build: {
      command: "npm run build:browser",
      node: packageJson.engines.node,
      lockfileSha256: sha256(packageLock),
      inputs,
    },
    compatibility: {
      exports: ["./browser"],
      browsers: packageJson.browserslist,
      peers: Object.fromEntries(Object.entries(packageJson.peerDependencies ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      optionalPeers: Object.keys(packageJson.peerDependenciesMeta ?? {})
        .filter((name) => packageJson.peerDependenciesMeta[name]?.optional)
        .sort(),
    },
    files,
  };
}

export async function verifyBrowserArtifactManifest(manifest) {
  invariant(manifest.format === "honua.sdk.browser-artifacts.v1", "artifact manifest format must be v1");
  invariant(manifest.schemaVersion === 1, "artifact manifest schemaVersion must be 1");
  invariant(/^[a-f0-9]{40}$/.test(manifest.package.gitCommit), "artifact manifest gitCommit is invalid");
  const packageJson = await readJson("package.json");
  invariant(manifest.package.name === packageJson.name, "artifact package name drift");
  invariant(manifest.package.version === packageJson.version, "artifact package version drift");
  invariant(manifest.build.command === "npm run build:browser", "artifact build command drift");
  const packageLock = await readFile(path.join(PROJECT_ROOT, "package-lock.json"));
  invariant(manifest.build.lockfileSha256 === sha256(packageLock), "artifact lockfile digest drift");
  for (const input of manifest.build.inputs) {
    const bytes = await readFile(path.join(PROJECT_ROOT, input.path));
    invariant(sha256(bytes) === input.sha256, `${input.path}: build input digest drift`);
  }
  const expectedPeers = Object.fromEntries(
    Object.entries(packageJson.peerDependencies ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  invariant(JSON.stringify(manifest.compatibility.peers) === JSON.stringify(expectedPeers), "artifact peer compatibility drift");
  invariant(new Set(manifest.files.map((file) => file.path)).size === manifest.files.length, "artifact paths must be unique");
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(PROJECT_ROOT, file.path));
    invariant(bytes.byteLength === file.bytes, `${file.path}: byte length drift`);
    invariant(sha256(bytes) === file.sha256, `${file.path}: SHA-256 drift`);
    invariant(
      `sha256-${createHash("sha256").update(bytes).digest("base64")}` === file.integrity,
      `${file.path}: SRI drift`,
    );
  }
}

export function validateEvidenceEnvelope(evidence) {
  const isDateTime = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
  invariant(evidence.format === "honua.sdk.sample-evidence.v1", "evidence format must be v1");
  invariant(evidence.schemaVersion === 1, "evidence schemaVersion must be 1");
  invariant(["fixture", "live"].includes(evidence.lane), "evidence lane must be fixture or live");
  invariant(
    ["executed", "failed", "skipped", "credential-unavailable"].includes(evidence.status),
    "evidence status is invalid",
  );
  invariant(typeof evidence.sampleId === "string", "evidence sampleId is required");
  invariant(isDateTime(evidence.observedAt), "evidence observedAt must be an RFC 3339 date-time");
  invariant(["none", "anonymous", "api-key", "bearer", "oauth", "host-mediated"].includes(evidence.authMode), "evidence authMode is invalid");
  invariant(evidence.sdk?.package === "@honua/sdk-js", "evidence sdk.package is invalid");
  invariant(typeof evidence.sdk?.version === "string", "evidence sdk.version is required");
  invariant(
    evidence.sdk?.gitCommit === null || typeof evidence.sdk?.gitCommit === "string",
    "evidence sdk.gitCommit is invalid",
  );
  invariant(typeof evidence.source?.provider === "string", "evidence source.provider is required");
  invariant(typeof evidence.source?.identity === "string", "evidence source.identity is required");
  for (const field of ["endpoint", "deploymentVersion", "dataVersion"]) {
    invariant(
      evidence.source?.[field] === null || typeof evidence.source?.[field] === "string",
      `evidence source.${field} is invalid`,
    );
  }
  if (evidence.source.endpoint !== null) {
    let endpoint;
    try {
      endpoint = new URL(evidence.source.endpoint);
    } catch {
      throw new Error("evidence source.endpoint must be an absolute URL");
    }
    invariant(["http:", "https:"].includes(endpoint.protocol), "evidence source.endpoint must use HTTP(S)");
    invariant(!endpoint.username && !endpoint.password, "evidence source.endpoint must not contain credentials");
    invariant(!endpoint.hash, "evidence source.endpoint must not contain a fragment");
    const sensitiveParameters = new Set([
      "access_token",
      "api-key",
      "api_key",
      "apikey",
      "authorization",
      "awsaccesskeyid",
      "credential",
      "key",
      "password",
      "secret",
      "sig",
      "signature",
      "token",
      "x-amz-credential",
      "x-amz-signature",
    ]);
    for (const parameter of endpoint.searchParams.keys()) {
      invariant(
        !sensitiveParameters.has(parameter.toLowerCase()),
        `evidence source.endpoint contains forbidden credential query parameter ${parameter}`,
      );
    }
  }
  if (evidence.status === "executed") {
    invariant(typeof evidence.provenance?.sourceId === "string", "executed evidence requires provenance.sourceId");
  } else if (evidence.provenance !== null) {
    invariant(typeof evidence.provenance?.sourceId === "string", "evidence provenance.sourceId is invalid");
  }
  if (evidence.provenance !== null) {
    invariant(isDateTime(evidence.provenance?.observedAt), "evidence provenance.observedAt must be an RFC 3339 date-time");
    invariant(
      evidence.provenance?.validAt === null || isDateTime(evidence.provenance?.validAt),
      "evidence provenance.validAt must be null or an RFC 3339 date-time",
    );
    invariant(
      ["live", "cached", "replayed", "pending-local"].includes(evidence.provenance?.state),
      "evidence provenance.state is invalid",
    );
    invariant(typeof evidence.provenance?.attribution === "string", "evidence provenance.attribution is required");
  }
  invariant(!JSON.stringify(evidence).match(/(?:AKIA|Bearer\s|[?&](?:token|key|signature)=)/i), "evidence appears to contain a credential");
  invariant(typeof evidence.semantics?.operation === "string", "evidence semantics.operation is required");
  invariant(
    evidence.semantics?.outcome === null || typeof evidence.semantics?.outcome === "string",
    "evidence semantics.outcome is invalid",
  );
  invariant(
    evidence.semantics?.itemCount === null ||
      (Number.isInteger(evidence.semantics?.itemCount) && evidence.semantics.itemCount >= 0),
    "evidence semantics.itemCount is invalid",
  );
  invariant(
    Array.isArray(evidence.semantics?.assertions) && evidence.semantics.assertions.every((value) => typeof value === "string"),
    "evidence semantics.assertions is invalid",
  );
  invariant(
    evidence.timing?.totalMs === null || (typeof evidence.timing?.totalMs === "number" && evidence.timing.totalMs >= 0),
    "evidence timing.totalMs is invalid",
  );
  invariant(
    evidence.timing?.firstSuccessfulInteractionMs === null ||
      (typeof evidence.timing?.firstSuccessfulInteractionMs === "number" &&
        evidence.timing.firstSuccessfulInteractionMs >= 0),
    "evidence timing.firstSuccessfulInteractionMs is invalid",
  );
  invariant(
    ["none", "expected", "unexpected", "unavailable"].includes(evidence.degradation?.state),
    "evidence degradation.state is invalid",
  );
  invariant(
    Array.isArray(evidence.degradation?.reasons) && evidence.degradation.reasons.every((value) => typeof value === "string"),
    "evidence degradation.reasons is invalid",
  );
  invariant(Array.isArray(evidence.artifacts), "evidence artifacts must be an array");
  for (const artifact of evidence.artifacts ?? []) {
    invariant(typeof artifact?.kind === "string", "evidence artifact.kind is required");
    invariant(typeof artifact?.path === "string", "evidence artifact.path is required");
    invariant(/^[a-f0-9]{64}$/.test(artifact?.sha256), "evidence artifact.sha256 is invalid");
  }
  if (evidence.status === "executed") {
    invariant(typeof evidence.semantics?.outcome === "string", "executed evidence requires semantic outcome");
    invariant(typeof evidence.timing?.totalMs === "number" && evidence.timing.totalMs >= 0, "executed evidence requires timing");
  } else {
    invariant(typeof evidence.reason === "string" && evidence.reason.length > 0, "non-executed evidence requires a reason");
  }
  if (evidence.realtime) {
    invariant(typeof evidence.realtime.observationWindowMs === "number", "realtime evidence requires an observation window");
    invariant("snapshotAt" in evidence.realtime, "realtime evidence requires snapshotAt");
    invariant("cursor" in evidence.realtime, "realtime evidence requires cursor");
    invariant("lagMs" in evidence.realtime, "realtime evidence requires lagMs");
  }
  return evidence;
}

async function runContract(command) {
  const catalog = await readJson(CATALOG_PATH);
  const packageJson = await readJson("package.json");
  await validateCatalog(catalog, packageJson);
  for (const fixturePath of [
    "samples/contract/v1/fixtures/sample-evidence.fixture.json",
    "samples/contract/v1/fixtures/sample-evidence.live.json",
    "samples/contract/v1/fixtures/sample-evidence.skipped.json",
  ]) {
    validateEvidenceEnvelope(await readJson(fixturePath));
  }
  await validateSiteProjection(generateSiteProjection(catalog, packageJson));
  await validateCiSelection(generateCiSelection(catalog));
  const outputs = await generatedOutputs(catalog, packageJson);
  if (command === "write") {
    for (const [relativePath, expected] of outputs) {
      await mkdir(path.dirname(path.join(PROJECT_ROOT, relativePath)), { recursive: true });
      await writeFile(path.join(PROJECT_ROOT, relativePath), expected, "utf8");
    }
  } else {
    const currentOutputs = new Map();
    for (const relativePath of outputs.keys()) {
      currentOutputs.set(relativePath, await readFile(path.join(PROJECT_ROOT, relativePath), "utf8"));
    }
    const drift = generatedOutputDrift(outputs, currentOutputs);
    invariant(drift.length === 0, `${drift.join(", ")} has drifted; run npm run samples:generate`);
  }
  process.stdout.write(
    `${command === "write" ? "Generated" : "Verified"} ${catalog.samples.length} SDK and docs examples, seven reserved journey IDs, and ${catalog.siteMappings.length} honua.io routes (${catalog.format})\n`,
  );
}

async function main(argv) {
  const [command = "check", ...args] = argv;
  if (["check", "write"].includes(command)) {
    invariant(args.length === 0, `${command} does not accept arguments`);
    await runContract(command);
    return;
  }
  if (command === "migrate-v1") {
    invariant(args.length === 0, "migrate-v1 does not accept arguments");
    const catalog = await migrateCatalogV1ToV2(
      await readJson(V1_CATALOG_PATH),
      await readJson(V1_MIGRATION_PATH),
    );
    await validateJsonSchema(catalog, CATALOG_SCHEMA_PATH);
    await writeFile(path.join(PROJECT_ROOT, CATALOG_PATH), stableJson(catalog), "utf8");
    process.stdout.write(`Migrated ${catalog.samples.length} executable examples to ${CATALOG_PATH}\n`);
    return;
  }
  if (command === "artifacts") {
    let output = "dist/browser/honua-sdk.browser-artifacts.v1.json";
    let gitCommit = gitSha();
    const artifacts = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--output") output = args[++index];
      else if (args[index] === "--git-sha") gitCommit = args[++index];
      else if (args[index] === "--artifact") {
        const [artifactPath, entrypoint] = (args[++index] ?? "").split("=");
        artifacts.push({ path: artifactPath, entrypoint });
      } else throw new Error(`Unknown artifacts argument: ${args[index]}`);
    }
    const defaults = [
      { path: "dist/browser/honua-sdk.esm.js", entrypoint: "./browser:import" },
      {
        path: "dist/browser/honua-sdk.esm.js.map",
        entrypoint: "./browser:import:sourcemap",
        mediaType: "application/json",
      },
      { path: "dist/browser/honua-sdk.min.js", entrypoint: "browser" },
      {
        path: "dist/browser/honua-sdk.min.js.map",
        entrypoint: "browser:sourcemap",
        mediaType: "application/json",
      },
    ];
    const manifest = await buildBrowserArtifactManifest({ artifacts: artifacts.length > 0 ? artifacts : defaults, gitCommit });
    await verifyBrowserArtifactManifest(manifest);
    await mkdir(path.dirname(path.join(PROJECT_ROOT, output)), { recursive: true });
    await writeFile(path.join(PROJECT_ROOT, output), stableJson(manifest), "utf8");
    process.stdout.write(`Wrote verified browser artifact manifest to ${output}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`sample contract failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
