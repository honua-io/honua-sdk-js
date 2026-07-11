#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = "samples/catalog.v1.json";
const GENERATED_CATALOG_PATH = "docs/generated/sample-catalog.md";
const SITE_PROJECTION_PATH = "samples/dist/honua-site-samples.v1.json";
const SITE_CONSUMER_FIXTURE_PATH = "samples/contract/v1/consumer-fixtures/honua-site-consumer.v1.json";
const README_START = "<!-- sample-catalog:start -->";
const README_END = "<!-- sample-catalog:end -->";

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

export async function validateCatalog(catalog, packageJson) {
  invariant(catalog.format === "honua.sdk.sample-catalog.v1", "catalog format must be v1");
  invariant(catalog.schemaVersion === 1, "catalog schemaVersion must be 1");
  invariant(catalog.sdk && typeof catalog.sdk === "object", "catalog SDK metadata is required");
  invariant(catalog.sdk?.package === packageJson.name, "catalog SDK package must match package.json");
  invariant(!Object.hasOwn(catalog.sdk, "version"), "catalog SDK version is derived from package.json and must not be pinned");
  invariant(catalog.configuration?.endpointValuePolicy === "environment-name-only", "catalog endpoint values must remain external");
  invariant(
    JSON.stringify(catalog.configuration?.allowedSchemes) === JSON.stringify(["http", "https"]),
    "catalog endpoints must be restricted to HTTP(S)",
  );
  sortedUnique(catalog.configuration?.credentialQueryParameters, "configuration.credentialQueryParameters");
  invariant(Array.isArray(catalog.samples), "catalog samples must be an array");
  invariant(Array.isArray(catalog.siteMappings), "catalog siteMappings must be an array");

  const sampleIds = new Set();
  const sourcePaths = new Set();
  for (const sample of catalog.samples) {
    invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sample.id), `invalid sample id: ${sample.id}`);
    invariant(!sampleIds.has(sample.id), `duplicate sample id: ${sample.id}`);
    sampleIds.add(sample.id);
    invariant(typeof sample.title === "string" && sample.title.length > 0, `${sample.id}: title is required`);
    invariant(["flagship", "recipe", "advanced", "reference"].includes(sample.tier), `${sample.id}: invalid tier`);
    invariant(
      ["supported", "experimental", "internal", "deprecated"].includes(sample.supportStatus),
      `${sample.id}: invalid support status`,
    );
    invariant(
      ["keep", "rework", "merge", "replace", "retire"].includes(sample.disposition?.decision),
      `${sample.id}: disposition decision is required`,
    );
    invariant(typeof sample.disposition?.reason === "string", `${sample.id}: disposition reason is required`);
    assertRelativePath(sample.sourcePath, `${sample.id}.sourcePath`);
    assertRelativePath(sample.docsPath, `${sample.id}.docsPath`);
    invariant(await pathExists(sample.sourcePath), `${sample.id}: sourcePath does not exist: ${sample.sourcePath}`);
    invariant(await pathExists(sample.docsPath), `${sample.id}: docsPath does not exist: ${sample.docsPath}`);
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
    for (const command of [...sample.lanes.fixture.commands, ...sample.lanes.live.commands, ...sample.validation]) {
      const npmScript = parseNpmCommand(command);
      if (npmScript) invariant(packageJson.scripts?.[npmScript], `${sample.id}: unknown package script ${npmScript}`);
    }
    invariant(
      ["executed", "not-applicable", "planned"].includes(sample.lanes.fixture.status),
      `${sample.id}: invalid fixture lane status`,
    );
    invariant(
      ["executed", "not-applicable", "planned", "credential-unavailable"].includes(sample.lanes.live.status),
      `${sample.id}: invalid live lane status`,
    );
  }

  const exampleDirectories = (await readdir(path.join(PROJECT_ROOT, "examples"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `examples/${entry.name}`)
    .sort();
  const representedExamples = [...sourcePaths].filter((sourcePath) => sourcePath.startsWith("examples/")).sort();
  invariant(
    JSON.stringify(exampleDirectories) === JSON.stringify(representedExamples),
    `example inventory drift:\nexpected ${exampleDirectories.join(", ")}\nrepresented ${representedExamples.join(", ")}`,
  );

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
      sortedUnique(mapping.capabilities, `${mapping.id}.capabilities`);
    }
  }
  invariant(catalog.siteMappings.length === 21, "the v1 site migration fixture must map all 21 current honua.io samples");
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
    tier: sample.tier,
    supportStatus: sample.supportStatus,
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
    },
    lanes: {
      fixture: { status: sample.lanes.fixture.status },
      live: { status: sample.lanes.live.status },
    },
    expectedDegradation: sample.expectedDegradation,
  };
}

export function generateSiteProjection(catalog, packageJson) {
  const effective = effectiveCatalog(catalog, packageJson);
  const samplesById = new Map(effective.samples.map((sample) => [sample.id, sample]));
  const projectedSamples = new Map();
  const routes = catalog.siteMappings.map((mapping) => {
    if (mapping.ownership === "site-exception") {
      projectedSamples.set(mapping.id, {
        id: mapping.id,
        title: mapping.title,
        summary: mapping.summary,
        tier: mapping.tier,
        supportStatus: mapping.supportStatus,
        capabilities: mapping.capabilities,
      });
      return {
        id: mapping.id,
        route: mapping.route,
        ownership: mapping.ownership,
        sampleId: mapping.id,
        exceptionReason: mapping.exceptionReason,
      };
    }
    if (!projectedSamples.has(mapping.sampleId)) {
      projectedSamples.set(mapping.sampleId, publicSample(samplesById.get(mapping.sampleId), effective.sdk));
    }
    return {
      id: mapping.id,
      route: mapping.route,
      ownership: mapping.ownership,
      sampleId: mapping.sampleId,
    };
  });
  return {
    format: "honua.site.sdk-sample-projection.v1",
    schemaVersion: 1,
    catalog: {
      format: effective.format,
      schemaVersion: effective.schemaVersion,
      package: effective.sdk.package,
      version: effective.sdk.version,
    },
    contract: {
      producer: "honua-io/honua-sdk-js#401",
      consumer: "honua-io/honua-site#120",
      executableSourceOwner: "honua-io/honua-sdk-js",
      presentationOwner: "honua-io/honua-site",
    },
    samples: [...projectedSamples.values()],
    routes,
  };
}

function generateSiteConsumerFixture(projection) {
  return {
    format: "honua.site.sdk-sample-consumer-fixture.v1",
    schemaVersion: 1,
    accepts: {
      projectionFormat: projection.format,
      projectionSchemaVersion: projection.schemaVersion,
      catalogFormat: projection.catalog.format,
      catalogSchemaVersion: projection.catalog.schemaVersion,
    },
    input: {
      path: "samples/dist/honua-site-samples.v1.json",
      schemaPath: "samples/contract/v1/schemas/site-projection.schema.json",
      sha256: sha256(Buffer.from(stableJson(projection))),
    },
    assertions: {
      routeCount: projection.routes.length,
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
  const rows = catalog.samples.map(
    (sample) =>
      `| [\`${sample.id}\`](../../${sample.docsPath}) | ${sample.tier} | ${sample.supportStatus} | ${sample.data.mode} | ${sample.disposition.decision} | ${sample.summary} |`,
  );
  return [
    "# SDK sample catalog",
    "",
    "This inventory is generated from [`samples/catalog.v1.json`](../../samples/catalog.v1.json). Do not edit it by hand.",
    "",
    `Catalog contract: \`${catalog.format}\` · SDK: \`${packageJson.name}\` (effective version derived from \`package.json\`) · ${catalog.samples.length} executable examples`,
    "",
    "| Sample | Tier | Support | Data | Disposition | Demonstration |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "The catalog also carries fixture/live commands, endpoint configuration names, provenance, attribution, freshness, validation, and the complete 21-route honua.io migration mapping. The presentation-safe projection is [`samples/dist/honua-site-samples.v1.json`](../../samples/dist/honua-site-samples.v1.json).",
    "",
  ].join("\n");
}

function readmeFragment(catalog) {
  const counts = Object.fromEntries(
    ["flagship", "recipe", "advanced", "reference"].map((tier) => [
      tier,
      catalog.samples.filter((sample) => sample.tier === tier).length,
    ]),
  );
  return [
    README_START,
    `The versioned [SDK sample catalog](./docs/generated/sample-catalog.md) tracks all ${catalog.samples.length} executable examples: ${counts.flagship} flagship, ${counts.recipe} recipe, ${counts.advanced} advanced, and ${counts.reference} reference. It is the source of truth for support, fixture/live modes, provenance, validation, and the honua.io projection.`,
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
  return new Map([
    [GENERATED_CATALOG_PATH, generatedCatalogMarkdown(catalog, packageJson)],
    [SITE_PROJECTION_PATH, stableJson(projection)],
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
    `${command === "write" ? "Generated" : "Verified"} ${catalog.samples.length} SDK examples and ${catalog.siteMappings.length} honua.io routes (${catalog.format})\n`,
  );
}

async function main(argv) {
  const [command = "check", ...args] = argv;
  if (["check", "write"].includes(command)) {
    invariant(args.length === 0, `${command} does not accept arguments`);
    await runContract(command);
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
