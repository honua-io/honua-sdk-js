import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createFixtureBuildEnvironment } from "../scripts/lib/fixture-build-environment.mjs";
import {
  buildBrowserArtifactManifest,
  classifyConfigurationName,
  collectQualificationEvidence,
  compareReleases,
  extractSampleConfiguration,
  generateCiSelection,
  generateGoldenJourneyVisualEvidence,
  generateSiteProjection,
  generatedOutputDrift,
  generatedOutputs,
  inspectSampleConfiguration,
  isRunnableRootExampleDirectory,
  migrateCatalogV1ToV2,
  parseJsonDocument,
  validateCatalog,
  validateCiSelection,
  validateEvidenceEnvelope,
  validateFixtureBuildHarnessSource,
  validateFixtureBuildHarnesses,
  validateGoldenJourneyVisualEvidence,
  validateLiveEvidenceProducer,
  validateSiteProjection,
  verifyBrowserArtifactManifest,
} from "../scripts/sample-contract.mjs";
import type { GoldenJourneyVisualEvidence } from "../scripts/sample-contract.mjs";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const execFileAsync = promisify(execFile);
const validationTime = { now: "2026-07-18T12:00:00.000Z" };
const goldenJourneyIds = [
  "first-map",
  "service-explorer",
  "planning-permitting",
  "incident-operations",
  "imagery-terrain",
  "cloud-native-analysis",
  "arcgis-migration",
];
const visualSemanticGates = [
  "packed-build",
  "browser",
  "accessibility",
  "console",
  "responsive",
  "screenshot",
  "performance",
  "fixture",
  "live",
] as const;

function visualEvidenceAdversary(
  journeyId: string,
  sampleId: string,
  observedAt: string,
  expiresAt: string,
): GoldenJourneyVisualEvidence["qualifiedGoldenJourneys"][number] {
  const runRoot = `samples/evidence/${sampleId}/runs/11111111-1111-4111-8111-111111111111`;
  const screenshot = (variant: "desktop" | "mobile", width: number, height: number) => ({
    variant,
    projectName: "chromium",
    browserName: "chromium",
    sourcePath: `${runRoot}/artifacts/screenshot-${variant}.png`,
    mediaType: "image/png",
    viewport: { width, height },
    bytes: 1,
    sha256: "a".repeat(64),
    reproducibility: {
      captureCount: 2,
      comparison: "byte-identical",
      repeatSourcePath: `${runRoot}/artifacts/screenshot-${variant}-repeat.png`,
      repeatBytes: 1,
      repeatSha256: "a".repeat(64),
    },
  });
  return {
    journeyId,
    sampleId,
    source: {
      repository: "honua-io/honua-sdk-js",
      path: "examples/maplibre-quickstart",
      revision: "b".repeat(40),
      evidenceNeutralSha256: "c".repeat(64),
    },
    runtime: {
      playwrightVersion: "1.58.0",
      projectName: "chromium",
      browserName: "chromium",
      browserVersion: "123.0.0.0",
      platform: "linux",
      architecture: "x64",
    },
    observedAt,
    expiresAt,
    screenshots: [screenshot("desktop", 1280, 720), screenshot("mobile", 390, 844)],
    semanticEvidence: visualSemanticGates.map((gate) => ({
      gate,
      sdkMode: gate === "packed-build" ? "packed" : "source",
      receiptPath: `samples/evidence/${sampleId}/receipts/${gate}.v1.json`,
      receiptSha256: "d".repeat(64),
      runRoot,
      observedAt,
      expiresAt,
      reportKind: `${gate}-report`,
      reportPath: `${runRoot}/artifacts/${gate}.json`,
      reportBytes: 1,
      reportSha256: "e".repeat(64),
    })),
    liveEvidence: {
      mode: "public-live",
      status: "executed",
      observedAt,
      expiresAt,
      evidencePath: `${runRoot}/artifacts/live-evidence.json`,
      provenance: { state: "live", observedAt, attribution: "Fixture adversary" },
      semantics: { operation: "query", outcome: "passed", itemCount: 1, assertions: ["bounded"] },
      timing: { totalMs: 1 },
      degradation: { state: "none", reasons: [] },
    },
  };
}

describe("sample publication contract", () => {
  it("discovers every runnable example and reserves exactly seven golden journeys", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    expect(catalog.configuration.browserSecretPolicy).toMatch(/^Approved browser configuration/);
    const packageJson = await readJson("package.json");

    await expect(validateCatalog(catalog, packageJson, validationTime)).resolves.toBeUndefined();
    expect(catalog.samples).toHaveLength(32);
    expect(
      catalog.samples.filter((sample: { sourceKind: string }) => sample.sourceKind === "root-example"),
    ).toHaveLength(29);
    expect(
      catalog.samples.filter((sample: { sourceKind: string }) => sample.sourceKind === "docs-example"),
    ).toHaveLength(3);
    expect(catalog.goldenJourneys.map((journey: { id: string }) => journey.id)).toEqual(goldenJourneyIds);
    expect(catalog.samples.filter((sample: { track: string }) => sample.track === "golden")).toHaveLength(1);
    expect(catalog.goldenJourneys.filter((journey: { status: string }) => journey.status === "qualified")).toHaveLength(
      1,
    );
    expect(catalog.goldenJourneys.filter((journey: { status: string }) => journey.status === "planned")).toHaveLength(
      6,
    );
    expect(catalog.samples.find((sample: { id: string }) => sample.id === "cesium-route-playback")).toMatchObject({
      lifecycle: { state: "rework", targetRelease: "0.2.0-beta.0" },
      data: { configurationStatus: "legacy-unsafe", config: [] },
    });
    expect(catalog.siteMappings).toHaveLength(21);
  });

  it("replays the reviewed v1 migration without semantic drift", async () => {
    const v1 = await readJson("samples/catalog.v1.json");
    const migration = await readJson("samples/contract/v2/migrations/catalog.v1-to-v2.json");
    const canonical = await readJson("samples/catalog.v2.json");

    const migrated = await migrateCatalogV1ToV2(v1, migration);
    expect(migrated).toEqual(canonical);
    expect(migrated.samples.find((sample) => sample.id === "migration-workbench")).toMatchObject({
      track: "lab",
      journeyId: "arcgis-migration",
      supportTier: "supported",
      lifecycle: { state: "active" },
      data: { configurationStatus: "not-required", config: [] },
      validation: [
        "npm run demo:migration-workbench:typecheck",
        "npm run demo:migration-workbench:build",
        "npm run test:playwright:migration-workbench",
      ],
      evidence: {
        fixture: {
          status: "executed",
          commands: ["npm run demo:migration-workbench:mock"],
        },
        live: { mode: "unavailable", status: "not-applicable", commands: [] },
      },
    });

    delete migration.sampleOverrides[Object.keys(migration.sampleOverrides)[0]];
    await expect(migrateCatalogV1ToV2(v1, migration)).rejects.toThrow(
      "migration overrides must cover every v1 sample exactly",
    );
  });

  it("rejects duplicate JSON properties before permissive parsing can hide them", () => {
    expect(() =>
      parseJsonDocument('{"data":{"attribution":"first","attribution":"second"}}', "duplicate-catalog.json"),
    ).toThrow('duplicate-catalog.json:1: duplicate JSON property "attribution"');
    expect(parseJsonDocument('{"data":{"attribution":"single"}}')).toEqual({
      data: { attribution: "single" },
    });
  });

  it("discovers runnable roots without treating reserved infrastructure as a sample", () => {
    expect(isRunnableRootExampleDirectory("maplibre-quickstart", ["index.html"])).toBe(true);
    expect(isRunnableRootExampleDirectory("node-backend-quickstart", ["src/server.ts"])).toBe(true);
    expect(isRunnableRootExampleDirectory("_kit", ["index.html", "package.json"])).toBe(false);
    expect(isRunnableRootExampleDirectory("shared-test-helpers", ["README.md", "tsconfig.json"])).toBe(false);
  });

  it("compares lifecycle targets with full semantic prerelease precedence", () => {
    expect(compareReleases("0.2.0-alpha.9", "0.2.0-beta.0")).toBeLessThan(0);
    expect(compareReleases("0.2.0-beta.0", "0.2.0-beta.0")).toBe(0);
    expect(compareReleases("0.2.0-beta.1", "0.2.0-beta.0")).toBeGreaterThan(0);
    expect(compareReleases("0.2.0", "0.2.0-beta.0")).toBeGreaterThan(0);
  });

  it("generates one shared docs/site taxonomy and an executable CI selection", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const packageJson = await readJson("package.json");
    const projection = generateSiteProjection(catalog, packageJson);
    const ciSelection = generateCiSelection(catalog);
    const qualificationEvidence = await collectQualificationEvidence(catalog);
    const visualEvidence = await generateGoldenJourneyVisualEvidence(catalog, qualificationEvidence);

    await expect(validateSiteProjection(projection)).resolves.toBeUndefined();
    await expect(validateCiSelection(ciSelection)).resolves.toBeUndefined();
    await expect(
      validateGoldenJourneyVisualEvidence(visualEvidence, catalog, qualificationEvidence),
    ).resolves.toBeUndefined();

    expect(projection.samples).toHaveLength(32);
    expect(projection.routes).toHaveLength(21);
    expect(projection.goldenJourneys.map((journey: { id: string }) => journey.id)).toEqual(goldenJourneyIds);
    expect(
      projection.goldenJourneys.find((journey: { id: string }) => journey.id === "incident-operations"),
    ).toMatchObject({ status: "planned", candidateSampleId: "realtime-incident-dashboard" });
    expect(ciSelection.samples).toHaveLength(32);
    expect(ciSelection.profiles).toHaveLength(catalog.qualityProfiles.length);
    expect(visualEvidence).toMatchObject({
      format: "honua.sdk.golden-journey-visual-evidence.v1",
      schemaVersion: 1,
      policy: {
        sourceRepository: "honua-io/honua-sdk-js",
        requiredScreenshotVariants: [
          { id: "desktop", viewport: { width: 1280, height: 720 } },
          { id: "mobile", viewport: { width: 390, height: 844 } },
        ],
        screenshotReproducibility: {
          reportFormat: "honua.sdk.sample-screenshot-gate.v3",
          captureCount: 2,
          comparison: "byte-identical",
          scope: "same-page-session",
          runtimeBinding: [
            "playwright-version",
            "project-name",
            "browser-name",
            "browser-version",
            "platform",
            "architecture",
          ],
        },
      },
      qualifiedGoldenJourneys: [],
    });
    expect(projection.externalReplacements).toEqual(catalog.externalReplacements);
    expect(JSON.stringify(projection)).not.toContain('"commands"');
    expect(JSON.stringify(projection)).not.toContain("VITE_");
    for (const sample of catalog.samples) {
      const projected = projection.samples.find((candidate: { id: string }) => candidate.id === sample.id);
      const selected = ciSelection.samples.find((candidate: { id: string }) => candidate.id === sample.id);
      expect(projected).toMatchObject({
        track: sample.track,
        supportTier: sample.supportTier,
        lifecycle: sample.lifecycle,
        validationProfile: sample.validationProfile,
      });
      expect(selected).toMatchObject({
        track: sample.track,
        supportTier: sample.supportTier,
        validationProfile: sample.validationProfile,
      });
      expect(selected?.commandPlan.validation.commands.length).toBeGreaterThan(0);
    }
    const quickstart = ciSelection.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart");
    expect(quickstart?.commandPlan.validation).toMatchObject({ execution: "automatic" });
    expect(quickstart?.commandPlan.validation.commands).not.toContain("npm run demo:quickstart:mock");
    expect(quickstart?.commandPlan.fixtureEvidence).toEqual({
      execution: "orchestrated",
      commands: ["npm run demo:quickstart:mock"],
    });
    expect(quickstart?.commandPlan.liveEvidence).toEqual({
      execution: "scheduled-only",
      commands: ["npm run evidence:first-map:live"],
    });
    const imagery = ciSelection.samples.find((sample: { id: string }) => sample.id === "imagery-cog-quickstart");
    expect(imagery).toMatchObject({ validationProfile: "golden-browser" });
    expect(imagery?.commandPlan.liveEvidence).toEqual({
      execution: "scheduled-only",
      commands: ["npm run evidence:cog:live"],
    });
    expect(
      projection.routes
        .filter((route) => ["imagery-terrain", "maui-3d", "wms-overlay"].includes(String(route.id)))
        .map((route) => String(route.sampleId)),
    ).toEqual(["imagery-cog-quickstart", "imagery-cog-quickstart", "imagery-cog-quickstart"]);
    expect(projection.samples.some((sample: { id: string }) => sample.id === "two-protocols")).toBe(false);

    const malformedProjection = structuredClone(projection);
    delete malformedProjection.samples[0].lifecycle.state;
    await expect(validateSiteProjection(malformedProjection)).rejects.toThrow("JSON Schema validation failed");

    const sensitiveProjection = structuredClone(projection);
    sensitiveProjection.externalReplacements[0].url = "https://example.test/replacement?clientSecret=secret";
    await expect(validateSiteProjection(sensitiveProjection)).rejects.toThrow(
      "forbidden credential query parameter clientSecret",
    );

    const flattenedCi = structuredClone(ciSelection);
    const flattenedSample = flattenedCi.samples[0] as unknown as Record<string, unknown>;
    flattenedSample.commands = ["npm run demo:quickstart:mock"];
    delete flattenedSample.commandPlan;
    await expect(validateCiSelection(flattenedCi)).rejects.toThrow("JSON Schema validation failed");
  });

  it("rejects overstated, stale, cross-runtime, and non-realtime visual evidence", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const qualificationEvidence = await collectQualificationEvidence(catalog);
    const canonical = await generateGoldenJourneyVisualEvidence(catalog, qualificationEvidence);
    const observedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const overstated = structuredClone(canonical);
    overstated.qualifiedGoldenJourneys.push(
      visualEvidenceAdversary("first-map", "maplibre-quickstart", observedAt, expiresAt),
    );
    await expect(validateGoldenJourneyVisualEvidence(overstated, catalog, qualificationEvidence)).rejects.toThrow(
      "orphaned, missing, or overstated",
    );

    const staleCatalog = structuredClone(catalog);
    staleCatalog.goldenJourneys[0].status = "qualified";
    staleCatalog.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").track = "golden";
    const stale = structuredClone(canonical);
    stale.qualifiedGoldenJourneys.push(
      visualEvidenceAdversary(
        "first-map",
        "maplibre-quickstart",
        "2026-07-01T00:00:00.000Z",
        "2026-07-08T00:00:00.000Z",
      ),
    );
    await expect(validateGoldenJourneyVisualEvidence(stale, staleCatalog, qualificationEvidence)).rejects.toThrow(
      "stale or has an invalid freshness window",
    );

    const staleLive = structuredClone(canonical);
    staleLive.qualifiedGoldenJourneys.push(
      visualEvidenceAdversary("first-map", "maplibre-quickstart", observedAt, expiresAt),
    );
    staleLive.qualifiedGoldenJourneys[0].liveEvidence.observedAt = "2026-07-01T00:00:00.000Z";
    staleLive.qualifiedGoldenJourneys[0].liveEvidence.expiresAt = "2026-07-08T00:00:00.000Z";
    await expect(validateGoldenJourneyVisualEvidence(staleLive, staleCatalog, qualificationEvidence)).rejects.toThrow(
      "stale or has an invalid freshness window",
    );

    const incidentCatalog = structuredClone(catalog);
    const incidentJourney = incidentCatalog.goldenJourneys.find(
      (journey: { id: string }) => journey.id === "incident-operations",
    );
    incidentJourney.status = "qualified";
    incidentCatalog.samples.find((sample: { id: string }) => sample.id === "realtime-incident-dashboard").track =
      "golden";
    const staticIncident = structuredClone(canonical);
    staticIncident.qualifiedGoldenJourneys.push(
      visualEvidenceAdversary("incident-operations", "realtime-incident-dashboard", observedAt, expiresAt),
    );
    await expect(
      validateGoldenJourneyVisualEvidence(staticIncident, incidentCatalog, qualificationEvidence),
    ).rejects.toThrow("must remain realtime");

    const crossRuntime = structuredClone(canonical);
    crossRuntime.policy.screenshotReproducibility.scope = "cross-platform";
    await expect(validateGoldenJourneyVisualEvidence(crossRuntime, catalog, qualificationEvidence)).rejects.toThrow(
      "JSON Schema validation failed",
    );
  });

  it("derives release versions without catalog edits and still detects semantic drift", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const packageJson = await readJson("package.json");
    const currentOutputs = await generatedOutputs(catalog, packageJson);
    const bumpedPackage = { ...packageJson, version: "0.1.1-beta.0" };

    await expect(validateCatalog(catalog, bumpedPackage, validationTime)).rejects.toThrow(
      "live evidence SDK version 0.1.0-beta.0 does not match 0.1.1-beta.0",
    );
    const bumpedOutputs = await generatedOutputs(catalog, bumpedPackage);
    const bumpedProjection = JSON.parse(bumpedOutputs.get("samples/dist/honua-site-samples.v2.json")!);
    expect(bumpedProjection.catalog.version).toBe("0.1.1-beta.0");
    expect(bumpedProjection.samples[0].sdk.version).toBe("0.1.1-beta.0");
    expect(generatedOutputDrift(bumpedOutputs, currentOutputs)).toEqual([
      "samples/dist/honua-site-samples.v2.json",
      "samples/dist/capability-sample-matrix.v1.json",
      "samples/dist/honua-site-consumer-handoff.v1.json",
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json",
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json",
    ]);

    const semanticDrift = new Map(currentOutputs);
    semanticDrift.set(
      "docs/generated/sample-catalog.md",
      currentOutputs.get("docs/generated/sample-catalog.md")!.replace("# SDK sample catalog", "# Stale catalog"),
    );
    expect(generatedOutputDrift(currentOutputs, semanticDrift)).toEqual(["docs/generated/sample-catalog.md"]);

    const integrityDrift = new Map(currentOutputs);
    const fixturePath = "samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json";
    const consumerFixture = JSON.parse(currentOutputs.get(fixturePath)!);
    consumerFixture.input.sha256 = "0".repeat(64);
    integrityDrift.set(fixturePath, `${JSON.stringify(consumerFixture, null, 2)}\n`);
    expect(generatedOutputDrift(currentOutputs, integrityDrift)).toEqual([fixturePath]);
    expect(generatedOutputDrift(bumpedOutputs, integrityDrift)).toEqual([
      "samples/dist/honua-site-samples.v2.json",
      "samples/dist/capability-sample-matrix.v1.json",
      "samples/dist/honua-site-consumer-handoff.v1.json",
      fixturePath,
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json",
    ]);
  });

  it("rejects taxonomy, lifecycle, inventory, and evidence-policy drift", async () => {
    const packageJson = await readJson("package.json");

    const unsorted = await readJson("samples/catalog.v2.json");
    unsorted.samples[0].capabilities = [...unsorted.samples[0].capabilities].reverse();
    await expect(validateCatalog(unsorted, packageJson, validationTime)).rejects.toThrow("must be sorted");

    const renamedJourney = await readJson("samples/catalog.v2.json");
    renamedJourney.goldenJourneys[0].id = "renamed-first-map";
    await expect(validateCatalog(renamedJourney, packageJson, validationTime)).rejects.toThrow(
      "golden journey IDs must be reserved",
    );

    const missingExample = await readJson("samples/catalog.v2.json");
    missingExample.samples = missingExample.samples.filter(
      (sample: { id: string }) => sample.id !== "shared-renderer-state",
    );
    await expect(validateCatalog(missingExample, packageJson, validationTime)).rejects.toThrow(
      "runnable docs example inventory drift",
    );

    const expiredLifecycle = await readJson("samples/catalog.v2.json");
    expiredLifecycle.samples.find(
      (sample: { id: string }) => sample.id === "app-bootstrap-basic",
    ).lifecycle.targetRelease = packageJson.version;
    await expect(validateCatalog(expiredLifecycle, packageJson, validationTime)).rejects.toThrow(
      `lifecycle retire expired at ${packageJson.version}`,
    );

    const missingReplacement = await readJson("samples/catalog.v2.json");
    const merged = missingReplacement.samples.find((sample: { lifecycle: { state: string } }) =>
      ["merge", "replace", "retire"].includes(sample.lifecycle.state),
    );
    delete merged.lifecycle.replacement;
    await expect(validateCatalog(missingReplacement, packageJson, validationTime)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const replacementCycle = await readJson("samples/catalog.v2.json");
    const first = replacementCycle.samples.find((sample: { id: string }) => sample.id === "geoprocessing-job-runner");
    const second = replacementCycle.samples.find((sample: { id: string }) => sample.id === "stac-imagery-browser");
    first.lifecycle.replacement = { kind: "sample", id: second.id };
    second.lifecycle.state = "merge";
    second.lifecycle.targetRelease = "0.2.0-beta.0";
    second.lifecycle.replacement = { kind: "sample", id: first.id };
    await expect(validateCatalog(replacementCycle, packageJson, validationTime)).rejects.toThrow(
      "sample/journey replacement cycle: sample:geoprocessing-job-runner -> sample:stac-imagery-browser -> sample:geoprocessing-job-runner",
    );

    const expandedJourneyCycle = await readJson("samples/catalog.v2.json");
    const imagery = expandedJourneyCycle.samples.find(
      (sample: { id: string }) => sample.id === "imagery-cog-quickstart",
    );
    imagery.lifecycle.state = "merge";
    imagery.lifecycle.targetRelease = "0.2.0-beta.0";
    imagery.lifecycle.replacement = { kind: "journey", id: "imagery-terrain" };
    await expect(validateCatalog(expandedJourneyCycle, packageJson, validationTime)).rejects.toThrow(
      "sample/journey replacement cycle: sample:imagery-cog-quickstart -> journey:imagery-terrain -> sample:imagery-cog-quickstart",
    );

    const unboundExecuted = await readJson("samples/catalog.v2.json");
    const planned = unboundExecuted.samples.find(
      (sample: { evidence: { live: { status: string } } }) => sample.evidence.live.status === "planned",
    );
    planned.evidence.live.status = "executed";
    planned.evidence.live.commands = ["npm run bench:live"];
    await expect(validateCatalog(unboundExecuted, packageJson, validationTime)).rejects.toThrow(
      "executed live status requires evidencePath",
    );

    const expiredEvidence = await readJson("samples/catalog.v2.json");
    const bound = expiredEvidence.samples.find(
      (sample: { evidence: { live: { status: string } } }) => sample.evidence.live.status === "skipped",
    );
    bound.evidence.live.expiresAt = "2026-07-12T23:59:59.000Z";
    await expect(validateCatalog(expiredEvidence, packageJson, validationTime)).rejects.toThrow(
      "live evidence expired",
    );

    const unsafeActiveConfig = await readJson("samples/catalog.v2.json");
    const cesium = unsafeActiveConfig.samples.find((sample: { id: string }) => sample.id === "cesium-route-playback");
    cesium.lifecycle = { state: "active", reason: "Invalid promotion fixture." };
    await expect(validateCatalog(unsafeActiveConfig, packageJson, validationTime)).rejects.toThrow(
      "cesium-route-playback: legacy-unsafe configuration requires bounded rework",
    );

    const sensitiveReplacementUrl = await readJson("samples/catalog.v2.json");
    sensitiveReplacementUrl.externalReplacements[0].url = "https://example.test/replacement?X-Goog-Signature=secret";
    await expect(validateCatalog(sensitiveReplacementUrl, packageJson, validationTime)).rejects.toThrow(
      "forbidden credential query parameter X-Goog-Signature",
    );

    const embeddedUrlCredential = await readJson("samples/catalog.v2.json");
    embeddedUrlCredential.externalReplacements[0].url = "https://publisher:password@example.test/replacement";
    await expect(validateCatalog(embeddedUrlCredential, packageJson, validationTime)).rejects.toThrow(
      "URL must not contain embedded credentials",
    );

    const literalCredential = await readJson("samples/catalog.v2.json");
    literalCredential.samples[0].summary = "Unsafe Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";
    await expect(validateCatalog(literalCredential, packageJson, validationTime)).rejects.toThrow(
      "contains a credential value",
    );

    const benignCredentialLanguage = await readJson("samples/catalog.v2.json");
    benignCredentialLanguage.samples[0].summary =
      "Bearer authentication, Bearer credentials, authorization=required, and AKIA12345678 are documentation text.";
    await expect(validateCatalog(benignCredentialLanguage, packageJson, validationTime)).resolves.toBeUndefined();
  });

  it("binds exact source configuration reads and makes browser credential exposure explicit", async () => {
    const packageJson = await readJson("package.json");
    const catalog = await readJson("samples/catalog.v2.json");
    const node = catalog.samples.find((sample: { id: string }) => sample.id === "node-backend-quickstart");
    expect(node.data.config).toEqual(
      expect.arrayContaining(["HONUA_API_KEY", "HONUA_BASE_URL", "HONUA_SERVICE_ACCOUNT_TOKEN", "HOST", "PORT"]),
    );
    expect(
      node.data.configClassifications.every((entry: { exposure: string }) => entry.exposure === "server-only"),
    ).toBe(true);
    expect(
      node.data.configClassifications.find(
        (entry: { name: string }) => entry.name === "HONUA_SERVICE_ACCOUNT_TOKEN_TTL_MS",
      ),
    ).toEqual({
      name: "HONUA_SERVICE_ACCOUNT_TOKEN_TTL_MS",
      exposure: "server-only",
      valueKind: "non-secret",
    });
    expect(
      node.data.configClassifications.find((entry: { name: string }) => entry.name === "HONUA_SERVICE_ACCOUNT_TOKEN"),
    ).toMatchObject({ valueKind: "credential", credentialScope: "secret" });
    for (const name of [
      "VITE_CLIENT_SECRET",
      "VITE_DATABASE_PASSWORD",
      "VITE_SIGNING_PRIVATE_KEY",
      "VITE_STORAGE_ACCESS_KEY_ID",
      "VITE_CLIENT_SECRET_TOKEN_TTL_MS",
    ]) {
      expect(classifyConfigurationName(name)).toMatchObject({
        exposure: "browser-public",
        valueKind: "credential",
        credentialScope: "secret",
      });
    }
    const kepler = catalog.samples.find((sample: { id: string }) => sample.id === "kepler-analytics");
    expect(kepler).toMatchObject({
      lifecycle: { state: "rework" },
      data: { configurationStatus: "legacy-unsafe" },
    });
    expect(
      kepler.data.configClassifications.find((entry: { name: string }) => entry.name === "VITE_MAPBOX_TOKEN"),
    ).toEqual({
      name: "VITE_MAPBOX_TOKEN",
      exposure: "browser-public",
      valueKind: "credential",
      credentialScope: "public-token",
    });

    const missingRead = structuredClone(catalog);
    const missingNode = missingRead.samples.find((sample: { id: string }) => sample.id === "node-backend-quickstart");
    const missingIndex = missingNode.data.config.indexOf("HONUA_SERVICE_ACCOUNT_TOKEN");
    missingNode.data.config.splice(missingIndex, 1);
    missingNode.data.configClassifications.splice(missingIndex, 1);
    await expect(validateCatalog(missingRead, packageJson, validationTime)).rejects.toThrow(
      "node-backend-quickstart: configuration declaration drift",
    );

    const inventedRead = structuredClone(catalog);
    const inventedNode = inventedRead.samples.find((sample: { id: string }) => sample.id === "node-backend-quickstart");
    inventedNode.data.config.push("ZZZ_INVENTED_CONFIG");
    inventedNode.data.configClassifications.push({
      name: "ZZZ_INVENTED_CONFIG",
      exposure: "server-only",
      valueKind: "non-secret",
    });
    await expect(validateCatalog(inventedRead, packageJson, validationTime)).rejects.toThrow(
      "node-backend-quickstart: configuration declaration drift",
    );

    const hiddenBrowserCredential = structuredClone(catalog);
    const hiddenKepler = hiddenBrowserCredential.samples.find(
      (sample: { id: string }) => sample.id === "kepler-analytics",
    );
    hiddenKepler.data.configurationStatus = "approved";
    delete hiddenKepler.data.configurationGap;
    await expect(validateCatalog(hiddenBrowserCredential, packageJson, validationTime)).rejects.toThrow(
      "kepler-analytics: browser-public credentials require legacy-unsafe status and bounded rework",
    );

    const maplibre = catalog.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart");
    expect(maplibre.data).toMatchObject({
      configurationStatus: "approved",
      config: [
        "VITE_HONUA_QUICKSTART_BASEMAP_STYLE",
        "VITE_HONUA_QUICKSTART_ENDPOINT",
        "VITE_HONUA_QUICKSTART_PROTOCOL",
        "VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT",
        "VITE_HONUA_QUICKSTART_WHERE",
      ],
    });
    expect(
      maplibre.data.configClassifications.every(
        (entry: { exposure: string; valueKind: string }) =>
          entry.exposure === "browser-public" && entry.valueKind === "non-secret",
      ),
    ).toBe(true);
    await expect(validateCatalog(catalog, packageJson, validationTime)).resolves.toBeUndefined();

    const inventedExemption = structuredClone(catalog);
    inventedExemption.configuration.environmentReadExemptions.push({
      name: "HONUA_FAKE_BUILTIN",
      provider: "vite",
      reason: "Invalid test exemption.",
    });
    inventedExemption.configuration.environmentReadExemptions.sort((left: { name: string }, right: { name: string }) =>
      left.name.localeCompare(right.name),
    );
    await expect(validateCatalog(inventedExemption, packageJson, validationTime)).rejects.toThrow(
      "configuration exemption HONUA_FAKE_BUILTIN is not an approved standard built-in",
    );

    const credentialPolicyDrift = structuredClone(catalog);
    credentialPolicyDrift.configuration.credentialQueryParameters.pop();
    await expect(validateCatalog(credentialPolicyDrift, packageJson, validationTime)).rejects.toThrow(
      "configuration.credentialQueryParameters must exactly match the canonical normalized credential-key set",
    );
  });

  it("resolves finite environment aliases and fails closed on dynamic reads", async () => {
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-static")).resolves.toEqual([
      "HONUA_ALIASED_URL",
      "HONUA_DESTRUCTURED_URL",
      "HONUA_DYNAMIC_URL",
    ]);
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-lexical-keys")).resolves.toEqual([
      "HONUA_LEXICAL_CHAIN_URL",
      "HONUA_LITERAL_CHAIN_URL",
    ]);
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-unresolved")).rejects.toThrow(
      "unresolved dynamic environment read",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-mutable-key")).rejects.toThrow(
      "finite environment key binding environmentKey must be const",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-assigned-key")).rejects.toThrow(
      "finite environment key binding environmentKey must not be assigned",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-shadowed-key")).rejects.toThrow(
      "shadowed finite environment key environmentKey",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-var-shadowed-key")).rejects.toThrow(
      "shadowed finite environment key environmentKey",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-property-key")).rejects.toThrow(
      "unresolved call into dynamic environment reader readEnvironment",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-dynamic-process-root")).rejects.toThrow(
      "unresolved dynamic environment root",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-dynamic-import-root")).rejects.toThrow(
      "unresolved dynamic environment root",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-rest")).rejects.toThrow(
      "environment rest destructuring is not statically bounded",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-parameter-rest")).rejects.toThrow(
      "environment rest destructuring is not statically bounded",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-exported-arrow-reader")).rejects.toThrow(
      "exported dynamic environment reader readEnvironment is not statically bounded",
    );
    await expect(
      extractSampleConfiguration("test/fixtures/sample-contract/env-exported-specifier-reader"),
    ).rejects.toThrow("exported dynamic environment reader readEnvironment is not statically bounded");
    await expect(
      extractSampleConfiguration("test/fixtures/sample-contract/env-dynamic-call-target-shadow"),
    ).rejects.toThrow("dynamic environment reader readEnvironment has no finite call sites");
    await expect(
      extractSampleConfiguration("test/fixtures/sample-contract/env-process-promise-reader"),
    ).rejects.toThrow("node:process dynamic imports must be awaited before environment access");
  });

  it("inventories computed environment roots and fixed object-binding defaults", async () => {
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-computed-roots")).resolves.toEqual([
      "HONUA_COMPUTED_NODE_URL",
      "VITE_COMPUTED_BROWSER_URL",
    ]);
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-binding-defaults")).resolves.toEqual({
      names: ["HONUA_BINDING_DEFAULT_URL", "HONUA_PARAMETER_DEFAULT_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-process-aliases")).resolves.toEqual({
      names: ["HONUA_DESTRUCTURED_ENV_URL", "HONUA_PROCESS_ALIAS_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-process-imports")).resolves.toEqual({
      names: ["HONUA_DEFAULT_PROCESS_IMPORT_URL", "HONUA_NAMED_ENV_IMPORT_URL", "HONUA_NAMESPACE_PROCESS_IMPORT_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-process-loaders")).resolves.toEqual({
      names: ["HONUA_CJS_TOKEN", "HONUA_DYNAMIC_TOKEN"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-global-process-roots")).resolves.toEqual(
      {
        names: ["HONUA_COMPUTED_GLOBAL_THIS_PROCESS_URL", "HONUA_GLOBAL_PROCESS_URL", "HONUA_GLOBAL_THIS_PROCESS_URL"],
        wholeEnvironmentEscapes: [],
      },
    );
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-shadowed-host-roots")).resolves.toEqual({
      names: [],
      wholeEnvironmentEscapes: [],
    });
  });

  it("traces scoped environment carriers and reports whole-object browser escapes", async () => {
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-forwarded")).resolves.toEqual({
      names: ["HONUA_FORWARDED_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-defaulted")).resolves.toEqual({
      names: ["HONUA_DEFAULTED_URL"],
      wholeEnvironmentEscapes: [],
    });
    await expect(inspectSampleConfiguration("test/fixtures/sample-contract/env-browser-projected")).resolves.toEqual({
      names: ["VITE_PROJECTED_URL"],
      wholeEnvironmentEscapes: [],
    });

    const wholeBrowserEnvironment = await inspectSampleConfiguration("test/fixtures/sample-contract/env-browser-whole");
    expect(wholeBrowserEnvironment.names).toEqual(["VITE_WHOLE_INVENTORIED_URL"]);
    expect(wholeBrowserEnvironment.wholeEnvironmentEscapes).toHaveLength(2);
    expect(wholeBrowserEnvironment.wholeEnvironmentEscapes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "test/fixtures/sample-contract/env-browser-whole/index.ts",
          line: 2,
          roots: ["import.meta.env"],
          reason: "passed to an untraceable call",
        }),
        expect.objectContaining({
          file: "test/fixtures/sample-contract/env-browser-whole/index.ts",
          line: 3,
          roots: ["import.meta.env"],
          reason: "passed to an untraceable call",
        }),
      ]),
    );

    const localBrowserEnvironment = await inspectSampleConfiguration("test/fixtures/sample-contract/env-browser-local");
    expect(localBrowserEnvironment.names).toEqual(["VITE_LOCAL_URL"]);
    expect(localBrowserEnvironment.wholeEnvironmentEscapes).toEqual([
      expect.objectContaining({ roots: ["import.meta.env"], reason: "used as a whole object" }),
      expect.objectContaining({ roots: ["import.meta.env"], reason: "passed whole to a local call" }),
    ]);

    const shadowedCallTarget = await inspectSampleConfiguration("test/fixtures/sample-contract/env-call-target-shadow");
    expect(shadowedCallTarget.names).toEqual([]);
    expect(shadowedCallTarget.wholeEnvironmentEscapes).toEqual([
      expect.objectContaining({ roots: ["process.env"], reason: "passed to an untraceable call" }),
    ]);

    const processHostEscapes = await inspectSampleConfiguration(
      "test/fixtures/sample-contract/env-process-host-escapes",
    );
    expect(processHostEscapes.names).toEqual([]);
    expect(processHostEscapes.wholeEnvironmentEscapes).toEqual([
      expect.objectContaining({ roots: ["process.env"], reason: "passed to an untraceable call" }),
      expect.objectContaining({ roots: ["process.env"], reason: "used as a whole object" }),
    ]);
  });

  it("isolates fixture Vite environments and gates every build launcher", async () => {
    const environment = createFixtureBuildEnvironment(
      { VITE_DECLARED: "fixture", VITE_EMPTY: "" },
      {
        PATH: "/usr/bin",
        HONUA_KEEP: "yes",
        VITE_DECLARED: "ambient",
        VITE_UNDECLARED_FIXTURE_SENTINEL: "must-not-leak",
        vite_mixed_case_sentinel: "must-not-leak",
      },
    );
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HONUA_KEEP: "yes",
      VITE_DECLARED: "fixture",
      VITE_EMPTY: "",
    });
    expect(() => createFixtureBuildEnvironment({ HONUA_NOT_PUBLIC: "invalid" }, {})).toThrow(
      "Fixture build overrides must use uppercase VITE_* names",
    );

    const fixtureEnvironmentImport =
      'import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";';
    const helperImport = [
      'import { spawnSync } from "node:child_process";',
      fixtureEnvironmentImport,
      'const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";',
    ].join("\n");
    expect(
      validateFixtureBuildHarnessSource(
        `${helperImport}\nspawnSync(npmCommand, ["run", "demo:fixture:build", "--silent"], { env: createFixtureBuildEnvironment() });`,
      ),
    ).toBe(1);
    expect(
      validateFixtureBuildHarnessSource(
        `${helperImport}
import { startSampleFixtureHarness } from "../../samples/scenarios/index.mjs";
void startSampleFixtureHarness;
spawnSync(npmCommand, ["run", "demo:fixture:build", "--silent"], { env: createFixtureBuildEnvironment() });`,
      ),
    ).toBe(1);
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}\nspawnSync(npmCommand, ["run", "demo:fixture:build", "--silent"], {});`,
      ),
    ).toThrow("fixture build must declare an explicit env option");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}\nspawnSync(npmCommand, ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("fixture build env must come directly from createFixtureBuildEnvironment");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const argv = ["run", "demo:second:build", "--silent"];
spawnSync(npmCommand, ["run", "demo:fixture:build", "--silent"], { env: createFixtureBuildEnvironment() });
spawnSync(npmCommand, argv, { env: process.env });`,
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const argv = createArgv();
spawnSync(npmCommand, argv, { env: createFixtureBuildEnvironment() });`,
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `import { spawnSync as launch } from "node:child_process";
${fixtureEnvironmentImport}
launch("npm", ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("fixture build env must come directly from createFixtureBuildEnvironment");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `import * as childProcess from "node:child_process";
${fixtureEnvironmentImport}
childProcess.execFileSync("npm", ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("unsupported fixture build invocation");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { execSync } from "node:child_process";\nexecSync("npm run demo:fixture:build --silent");',
      ),
    ).toThrow("execSync permits only allowlisted non-build commands");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `const { spawnSync: launch } = require("node:child_process");
${fixtureEnvironmentImport}
launch("npm", ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("fixture build env must come directly from createFixtureBuildEnvironment");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `import { spawnSync } from "node:child_process";
${fixtureEnvironmentImport}
const launch = spawnSync;
launch("npm", ["run", "demo:fixture:build", "--silent"], { env: process.env });`,
      ),
    ).toThrow("fixture build env must come directly from createFixtureBuildEnvironment");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { spawnSync } from "node:child_process";\nconst holder = { launch: spawnSync };\nholder.launch(dynamicCommand);',
      ),
    ).toThrow("child-process launch functions cannot escape direct calls or const aliases");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import * as childProcess from "node:child_process";\nconst method = "spawnSync";\nchildProcess[method](dynamicCommand);',
      ),
    ).toThrow("child-process namespaces cannot escape launch API member access or const aliases");
    expect(() => validateFixtureBuildHarnessSource('consume(require("node:child_process"));')).toThrow(
      "child-process namespaces cannot escape launch API member access or const aliases",
    );
    expect(() => validateFixtureBuildHarnessSource('consume(await import("node:child_process"));')).toThrow(
      "child-process namespaces cannot escape launch API member access or const aliases",
    );
    const validFixtureBuild = `${helperImport}
spawnSync(npmCommand, ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment(),
});`;
    for (const source of [
      `${validFixtureBuild}
import("node:child_process").then((childProcess) =>
  childProcess.spawnSync("npm", ["run", "demo:quickstart:build", "--silent"], { env: process.env }),
);`,
      `${validFixtureBuild}
const childProcess = await import("node:child_process");
childProcess.default.spawnSync("npm", ["run", "demo:quickstart:build", "--silent"], { env: process.env });`,
    ]) {
      expect(() => validateFixtureBuildHarnessSource(source, "mock-server.mjs", "demo:fixture:build")).toThrow(
        "child-process namespaces cannot escape launch API member access or const aliases",
      );
    }
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
import "./unsafe-build.mjs";
spawnSync(npmCommand, ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment(),
});`,
        "mock-server.mjs",
        "demo:fixture:build",
      ),
    ).toThrow("fixture build harnesses cannot import unreviewed local or data modules");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${validFixtureBuild}
await import("DATA:text/javascript,export default 1");`,
        "mock-server.mjs",
        "demo:fixture:build",
      ),
    ).toThrow("fixture build harnesses cannot dynamically load unreviewed local or data modules");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'process.getBuiltinModule("node:child_process").spawnSync("npm", dynamicArguments);',
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'const moduleName = "node:child_process";\nconst childProcess = await import(moduleName);\nchildProcess.spawnSync("npm", dynamicArguments);',
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { createRequire as cr } from "node:module";\nconst load = cr(import.meta.url);\nconst moduleName = "node:child_process";\nconst childProcess = load(moduleName);\nchildProcess.spawnSync("npm", dynamicArguments);',
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    for (const source of [
      'import * as Module from "node:module";\nconst load = Module.createRequire(import.meta.url);\nconst childProcess = load("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
      'import Module from "node:module";\nconst load = Module.createRequire(import.meta.url);\nconst childProcess = load("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
    ]) {
      expect(() => validateFixtureBuildHarnessSource(source)).toThrow("spawnSync argv must be statically bounded");
    }
    for (const source of [
      'import proc from "node:process";\nconst processAlias = proc;\nconst childProcess = processAlias.getBuiltinModule("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
      'import { getBuiltinModule as loadBuiltin } from "node:process";\nconst load = loadBuiltin;\nconst childProcess = load("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
      'const childProcess = globalThis.process.getBuiltinModule("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
      'const proc = globalThis.process;\nconst load = proc.getBuiltinModule;\nconst childProcess = load("node:child_process");\nchildProcess.spawnSync("npm", dynamicArguments);',
    ]) {
      expect(() => validateFixtureBuildHarnessSource(source)).toThrow("spawnSync argv must be statically bounded");
    }
    expect(() =>
      validateFixtureBuildHarnessSource("async function load(moduleName) { return import(moduleName); }"),
    ).toThrow("static process-launch value moduleName must be a lexical const");
    expect(
      validateFixtureBuildHarnessSource(
        "function respond(payload) { return payload; }\nfunction require(moduleName) { return respond(moduleName); }\nrespond(dynamicPayload);\nrequire(dynamicModuleName);",
      ),
    ).toBe(0);
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { execFileSync } from "node:child_process";\nexecFileSync("git", dynamicGitArguments);',
      ),
    ).toThrow("execFileSync argv must be statically bounded");
    expect(
      validateFixtureBuildHarnessSource(
        'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status", "--short"]);',
      ),
    ).toBe(0);
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["-c", "alias.x=!npm run demo:fixture:build", "x"]);',
      ),
    ).toThrow("unsupported fixture build invocation");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { spawnSync } from "node:child_process";\nspawnSync("npm", ["run", "build"]);',
      ),
    ).toThrow("spawnSync process launch is not a proven non-build command");
    expect(() =>
      validateFixtureBuildHarnessSource(
        'import { spawnSync } from "node:child_process";\nspawnSync("python", ["safe.py"]);',
      ),
    ).toThrow("spawnSync process launch is not a proven non-build command");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
function launch(argv) {
  spawnSync("npm", argv, { env: createFixtureBuildEnvironment() });
  { const argv = ["run", "demo:borrowed:build", "--silent"]; void argv; }
}`,
      ),
    ).toThrow("spawnSync argv must be statically bounded");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
spawnSync("npm", ["run", condition ? "demo:fixture:build" : "unsafe-script", "--silent"], {
  env: createFixtureBuildEnvironment(),
});`,
      ),
    ).toThrow("unsupported fixture build invocation");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const leaked = process.env.VITE_HONUA_LEAKED_URL;
spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment({ VITE_HONUA_FIXTURE_URL: leaked }),
});`,
      ),
    ).toThrow("fixture build overrides cannot derive from ambient environment variables");
    for (const source of [
      `${helperImport}
import proc from "node:process";
const processAlias = proc;
spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment({ VITE_HONUA_FIXTURE_URL: processAlias.env.VITE_HONUA_FIXTURE_URL }),
});`,
      `${helperImport}
spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment({ VITE_HONUA_FIXTURE_URL: globalThis.process.env.VITE_HONUA_FIXTURE_URL }),
});`,
      `${helperImport}
const processAlias = globalThis.process;
spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment({ VITE_HONUA_FIXTURE_URL: processAlias.env.VITE_HONUA_FIXTURE_URL }),
});`,
    ]) {
      expect(() => validateFixtureBuildHarnessSource(source)).toThrow(
        "fixture build overrides cannot derive from ambient environment variables",
      );
    }
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment({ VITE_HONUA_API_TOKEN: "not-even-a-real-token" }),
});`,
      ),
    ).toThrow("fixture build override VITE_HONUA_API_TOKEN is credential-classified");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment({ ...fixtureOverrides }),
});`,
      ),
    ).toThrow("fixture build overrides must use explicit property assignments");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
const overrides = { VITE_HONUA_FIXTURE_URL: "fixture" };
overrides.VITE_HONUA_FIXTURE_URL = process.env.VITE_HONUA_FIXTURE_URL;
spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment(overrides),
});`,
      ),
    ).toThrow("fixture build override objects must remain immutable and cannot escape");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
try { throw () => process.env; } catch (createFixtureBuildEnvironment) {
  spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
    env: createFixtureBuildEnvironment(),
  });
}`,
      ),
    ).toThrow("fixture build env must come directly from createFixtureBuildEnvironment");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
spawnSync("npm", ["run", "demo:fixture:build", "--silent"], {
  env: createFixtureBuildEnvironment(),
  ...unsafeOptions,
});`,
      ),
    ).toThrow("fixture build options cannot use spreads");
    expect(() =>
      validateFixtureBuildHarnessSource(
        `${helperImport}
spawnSync("npm", ["run", "demo:wrong:build", "--silent"], {
  env: createFixtureBuildEnvironment(),
});`,
        "mock-server.mjs",
        "demo:fixture:build",
      ),
    ).toThrow("expected exactly one demo:fixture:build fixture build");
    await expect(validateFixtureBuildHarnesses()).resolves.toBe(24);
  });

  it("accepts only bounded, whole catalog commands", async () => {
    const packageJson = await readJson("package.json");

    const shellInjection = await readJson("samples/catalog.v2.json");
    shellInjection.samples[0].validation[0] = "npm run demo:quickstart:build && curl https://example.test";
    await expect(validateCatalog(shellInjection, packageJson, validationTime)).rejects.toThrow(
      "unsafe or unsupported catalog command",
    );

    const uninstalledNpx = await readJson("samples/catalog.v2.json");
    uninstalledNpx.samples[0].validation[0] = "npx cowsay test/sample.test.ts";
    await expect(validateCatalog(uninstalledNpx, packageJson, validationTime)).rejects.toThrow(
      "unsafe or unsupported catalog command",
    );

    const pathTraversal = await readJson("samples/catalog.v2.json");
    pathTraversal.samples[0].validation[0] = "npx vitest run ../outside.test.ts";
    await expect(validateCatalog(pathTraversal, packageJson, validationTime)).rejects.toThrow(
      "unsafe or unsupported catalog command",
    );

    const viteDevValidation = await readJson("samples/catalog.v2.json");
    viteDevValidation.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").validation[0] =
      "npm run demo:quickstart";
    await expect(validateCatalog(viteDevValidation, packageJson, validationTime)).rejects.toThrow(
      "automatic validation command is not in the reviewed bounded registry",
    );

    const deceptiveValidation = await readJson("samples/catalog.v2.json");
    const deceptiveValidationPackage = structuredClone(packageJson);
    deceptiveValidationPackage.scripts["demo:quickstart:build"] = "vite";
    await expect(validateCatalog(deceptiveValidation, deceptiveValidationPackage, validationTime)).rejects.toThrow(
      "automatic validation command is not in the reviewed bounded registry",
    );

    const viteDevLive = await readJson("samples/catalog.v2.json");
    viteDevLive.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").evidence.live.commands = [
      "npm run demo:quickstart",
    ];
    await expect(validateCatalog(viteDevLive, packageJson, validationTime)).rejects.toThrow(
      "scheduled live command is not in the reviewed bounded producer registry",
    );

    const deceptiveProducer = await readJson("samples/catalog.v2.json");
    deceptiveProducer.samples.find(
      (sample: { id: string }) => sample.id === "maplibre-quickstart",
    ).evidence.live.commands = ["npm run demo:evil:live-smoke"];
    const deceptivePackage = structuredClone(packageJson);
    deceptivePackage.scripts["demo:evil:live-smoke"] = "vite";
    await expect(validateCatalog(deceptiveProducer, deceptivePackage, validationTime)).rejects.toThrow(
      "scheduled live command is not in the reviewed bounded producer registry",
    );

    const reboundProducer = await readJson("samples/catalog.v2.json");
    const reboundPackage = structuredClone(packageJson);
    reboundPackage.scripts["evidence:first-map:live"] = "node scripts/overture-live-evidence.mjs";
    await expect(validateCatalog(reboundProducer, reboundPackage, validationTime)).rejects.toThrow(
      "scheduled live command is not in the reviewed bounded producer registry",
    );

    for (const hook of ["prebench:live", "postbench:live"]) {
      const hookedPackage = structuredClone(packageJson);
      hookedPackage.scripts[hook] = "node scripts/forged-live-hook.mjs";
      await expect(
        validateCatalog(await readJson("samples/catalog.v2.json"), hookedPackage, validationTime),
      ).rejects.toThrow("scheduled live command is not in the reviewed bounded producer registry");
    }

    for (const [script, definition] of [
      ["build", "tsc -p forged.json"],
      ["clean", "rm -rf dist forged"],
      ["prebuild", "node scripts/forged-live-hook.mjs"],
      ["postbuild", "node scripts/forged-live-hook.mjs"],
      ["preclean", "node scripts/forged-live-hook.mjs"],
      ["postclean", "node scripts/forged-live-hook.mjs"],
    ]) {
      const driftedDependencyPackage = structuredClone(packageJson);
      driftedDependencyPackage.scripts[script] = definition;
      await expect(
        validateCatalog(await readJson("samples/catalog.v2.json"), driftedDependencyPackage, validationTime),
      ).rejects.toThrow("scheduled live command is not in the reviewed bounded producer registry");
    }
  });

  it("keeps candidates non-golden until the full qualification contract is satisfied", async () => {
    const packageJson = await readJson("package.json");

    const promoteIncident = async () => {
      const catalog = await readJson("samples/catalog.v2.json");
      catalog.goldenJourneys.find((journey: { id: string }) => journey.id === "incident-operations").status =
        "qualified";
      const sample = catalog.samples.find(
        (candidate: { id: string }) => candidate.id === "realtime-incident-dashboard",
      );
      sample.track = "golden";
      sample.validationProfile = "golden-browser";
      return { catalog, sample };
    };

    const unsupported = await promoteIncident();
    unsupported.sample.supportTier = "experimental";
    await expect(validateCatalog(unsupported.catalog, packageJson, validationTime)).rejects.toThrow(
      "realtime-incident-dashboard: golden samples must be supported",
    );

    const inactive = await promoteIncident();
    inactive.sample.lifecycle = {
      state: "rework",
      reason: "Promotion regression fixture.",
      targetRelease: "0.2.0-beta.0",
    };
    await expect(validateCatalog(inactive.catalog, packageJson, validationTime)).rejects.toThrow(
      "realtime-incident-dashboard: golden samples must be active",
    );

    const missingFixture = await promoteIncident();
    missingFixture.sample.evidence.fixture.status = "planned";
    await expect(validateCatalog(missingFixture.catalog, packageJson, validationTime)).rejects.toThrow(
      "realtime-incident-dashboard: golden samples require executed fixture evidence",
    );

    const missingLive = await promoteIncident();
    await expect(validateCatalog(missingLive.catalog, packageJson, validationTime)).rejects.toThrow(
      "realtime-incident-dashboard: golden samples require current executed live evidence",
    );

    const prematurePromotion = await readJson("samples/catalog.v2.json");
    prematurePromotion.samples.find((sample: { id: string }) => sample.id === "realtime-incident-dashboard").track =
      "golden";
    await expect(validateCatalog(prematurePromotion, packageJson, validationTime)).rejects.toThrow(
      "incident-operations: planned journey candidate cannot use the golden track",
    );

    const metadataOnly = await promoteIncident();
    const evidencePath = "test-results/metadata-only-golden-evidence.json";
    const executedEvidence = await readJson("examples/realtime-incident-dashboard/evidence/live-skipped.v1.json");
    executedEvidence.status = "executed";
    executedEvidence.reason = null;
    executedEvidence.provenance = {
      sourceId: "honua-demo:incident-realtime",
      observedAt: executedEvidence.observedAt,
      validAt: null,
      state: "live",
      attribution: "Honua demo synthetic incident data",
    };
    executedEvidence.semantics.outcome = "connected";
    executedEvidence.timing.totalMs = 1;
    executedEvidence.degradation = { state: "none", reasons: [] };
    metadataOnly.sample.evidence.live = {
      mode: "demo-live",
      status: "executed",
      commands: ["npm run bench:live"],
      evidencePath,
      expiresAt: "2026-07-26T02:18:02.730Z",
    };
    try {
      await mkdir("test-results", { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(executedEvidence, null, 2)}\n`);
      await expect(
        validateCatalog(metadataOnly.catalog, packageJson, { ...validationTime, verifyCheckout: false }),
      ).rejects.toThrow("realtime-incident-dashboard: missing gate receipt directory");
      await expect(
        validateCatalog(metadataOnly.catalog, packageJson, {
          ...validationTime,
          qualificationBootstrapSampleId: "realtime-incident-dashboard",
          verifyCheckout: false,
        }),
      ).resolves.toBeUndefined();
      await expect(
        validateCatalog(metadataOnly.catalog, packageJson, {
          ...validationTime,
          qualificationBootstrapSampleId: "not-a-golden-sample",
          verifyCheckout: false,
        }),
      ).rejects.toThrow("qualification bootstrap requires a qualified golden sample");
    } finally {
      await rm(evidencePath, { force: true });
    }
  });

  it("uses one credential-safe evidence envelope for fixture, live, and unavailable lanes", async () => {
    for (const name of ["fixture", "live", "skipped"]) {
      const evidence = await readJson(`samples/contract/v1/fixtures/sample-evidence.${name}.json`);
      expect(validateEvidenceEnvelope(evidence)).toBe(evidence);
    }

    const invalid = await readJson("samples/contract/v1/fixtures/sample-evidence.skipped.json");
    invalid.reason = null;
    expect(() => validateEvidenceEnvelope(invalid)).toThrow("requires a reason");

    for (const parameter of [
      "client_secret",
      "access-token",
      "auth_token",
      "x-api-key",
      "x_amz_signature",
      "X-Goog-Signature",
      "clientSecret",
      "ｘ－ａｐｉ－ｋｅｙ",
    ]) {
      const credentialUrl = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
      credentialUrl.source.endpoint = `https://example.test/features?${parameter}=secret`;
      expect(() => validateEvidenceEnvelope(credentialUrl)).toThrow(
        `forbidden credential query parameter ${parameter}`,
      );
    }

    const benignQuery = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    benignQuery.source.endpoint =
      "https://example.test/features?monkey=1&hockey=2&keyboard=3&tokenizer=4&secretary=5&signature_version=v4&token_type=bearer";
    expect(validateEvidenceEnvelope(benignQuery)).toBe(benignQuery);

    const websocketCredentials = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    websocketCredentials.source.endpoint = "wss://publisher:password@example.test/events";
    expect(() => validateEvidenceEnvelope(websocketCredentials)).toThrow("URL must not contain embedded credentials");

    const customSchemeQuery = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    customSchemeQuery.source.identity = "s3://sample-bucket/data?clientSecret=secret";
    expect(() => validateEvidenceEnvelope(customSchemeQuery)).toThrow(
      "forbidden credential query parameter clientSecret",
    );

    for (const literal of [
      "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "AKIA1234567890ABCDEF",
      "-----BEGIN PRIVATE KEY-----",
      "client_secret=s3cr3t-value",
    ]) {
      const literalCredentialEvidence = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
      literalCredentialEvidence.source.identity = literal;
      expect(() => validateEvidenceEnvelope(literalCredentialEvidence)).toThrow("contains a credential value");
    }

    const benignCredentialLanguage = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    benignCredentialLanguage.source.identity =
      "Bearer authentication, Bearer credentials, authorization=required, and AKIA12345678 are documentation text.";
    expect(validateEvidenceEnvelope(benignCredentialLanguage)).toBe(benignCredentialLanguage);

    for (const { key, value } of [
      { key: "apiKey", value: "this-is-an-actual-secret-value-123456" },
      { key: "password", value: "correct-horse-battery-staple" },
      { key: "password", value: 8675309 },
    ]) {
      const nestedSecret = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
      nestedSecret.extra = { nested: { [key]: value } };
      expect(() => validateEvidenceEnvelope(nestedSecret)).toThrow(
        "contains a credential value under a sensitive property name",
      );
    }

    const benignSensitiveProperties = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    benignSensitiveProperties.extra = {
      apiKey: "HONUA_API_KEY",
      authorization: "required",
      clientSecret: "not-applicable",
      password: "redacted",
    };
    expect(validateEvidenceEnvelope(benignSensitiveProperties)).toBe(benignSensitiveProperties);

    const sensitiveUrlProperty = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    sensitiveUrlProperty.extra = { "s3://sample-bucket/data?password=secret": "documentation" };
    expect(() => validateEvidenceEnvelope(sensitiveUrlProperty)).toThrow(
      "forbidden credential query parameter password",
    );

    const cyclicEvidence = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cyclicEvidence.extra = cycle;
    expect(() => validateEvidenceEnvelope(cyclicEvidence)).toThrow("contains a cyclic metadata reference");

    const deepEvidence = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    let deepCursor = deepEvidence as Record<string, unknown>;
    for (let depth = 0; depth < 70; depth += 1) {
      const next: Record<string, unknown> = {};
      deepCursor.extra = next;
      deepCursor = next;
    }
    expect(() => validateEvidenceEnvelope(deepEvidence)).toThrow("exceeds the metadata depth limit of 64");

    for (const lane of ["fixture.v1", "live-skipped.v1"]) {
      const safeAgentEvidence = await readJson(`examples/ai-spatial-app-builder/evidence/${lane}.json`);
      expect(validateEvidenceEnvelope(safeAgentEvidence)).toBe(safeAgentEvidence);
    }

    const missingSource = await readJson("examples/ai-spatial-app-builder/evidence/fixture.v1.json");
    delete missingSource.source;
    expect(() => validateEvidenceEnvelope(missingSource)).toThrow("source.provider is required");

    const futureObservation = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    futureObservation.observedAt = "2026-01-01T00:10:01.000Z";
    futureObservation.provenance.observedAt = futureObservation.observedAt;
    expect(() =>
      validateEvidenceEnvelope(futureObservation, {
        now: "2026-01-01T00:05:00.000Z",
        maxFutureSkewSeconds: 300,
      }),
    ).toThrow("evidence observedAt is more than 300 seconds in the future");

    const inconsistentProvenance = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    inconsistentProvenance.provenance.observedAt = "2026-01-01T00:06:01.000Z";
    expect(() =>
      validateEvidenceEnvelope(inconsistentProvenance, {
        now: "2026-01-01T01:00:00.000Z",
        maxFutureSkewSeconds: 300,
      }),
    ).toThrow("evidence provenance.observedAt cannot follow evidence observedAt beyond clock skew");
  });

  it("records the configured live-data endpoint instead of the proposal host", async () => {
    const outputPath = "test-results/ai-spatial-app-builder-live-evidence.json";
    try {
      const { stdout } = await execFileAsync(process.execPath, ["examples/ai-spatial-app-builder/live-evidence.mjs"], {
        env: {
          ...process.env,
          HONUA_AGENT_HOST_URL: "https://agent.example.test/proposals",
          HONUA_LIVE_DATA_URL: "https://data.example.test/features",
        },
      });
      const evidence = JSON.parse(stdout);
      expect(evidence.source.endpoint).toBe("https://data.example.test/features");
      expect(evidence.reason).toContain("no request was sent");
    } finally {
      await rm(outputPath, { force: true });
    }
  });

  it("content-binds executed live evidence to its current generator, sample, and journey", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const sample = catalog.samples.find((candidate: { id: string }) => candidate.id === "maplibre-quickstart");
    expect(sample.evidence.live).toMatchObject({
      mode: "public-live",
      status: "executed",
      commands: ["npm run evidence:first-map:live"],
      evidencePath: "samples/evidence/maplibre-quickstart/live.v1.json",
    });
    expect(sample.evidence.live.expiresAt).toMatch(/^2026-07-24T/);
    const evidence = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    evidence.sampleId = sample.id;
    delete evidence.realtime;
    evidence.semantics.operation = "first-map-anonymous-public-endpoint";
    evidence.semantics.outcome = "map-popup-filter-plan-ready";
    evidence.artifacts = [
      {
        kind: "producer-generator",
        path: "scripts/first-map-live-evidence.mjs",
        sha256: createHash("sha256")
          .update(await readFile("scripts/first-map-live-evidence.mjs"))
          .digest("hex"),
      },
    ];

    expect(validateEvidenceEnvelope(evidence)).toBe(evidence);
    await expect(validateLiveEvidenceProducer(evidence, sample)).resolves.toBeUndefined();

    const nonBenchSample = structuredClone(sample);
    nonBenchSample.evidence.live.commands = ["npm run demo:spatial-analytics:live-evidence"];
    const nonBenchGeneratorPath = "examples/spatial-analytics-workbench/live-evidence.mjs";
    const nonBenchEvidence = structuredClone(evidence);
    nonBenchEvidence.artifacts[0] = {
      kind: "producer-generator",
      path: nonBenchGeneratorPath,
      sha256: createHash("sha256")
        .update(await readFile(nonBenchGeneratorPath))
        .digest("hex"),
    };
    await expect(validateLiveEvidenceProducer(nonBenchEvidence, nonBenchSample)).resolves.toBeUndefined();

    const skippedCatalog = await readJson("samples/catalog.v2.json");
    const skippedSample = skippedCatalog.samples.find(
      (candidate: { id: string }) => candidate.id === "realtime-incident-dashboard",
    );
    const skippedEvidence = await readJson(skippedSample.evidence.live.evidencePath);
    await expect(validateLiveEvidenceProducer(skippedEvidence, skippedSample)).resolves.toBeUndefined();

    const staleSkippedProducer = structuredClone(skippedEvidence);
    staleSkippedProducer.artifacts[0].sha256 = "0".repeat(64);
    await expect(validateLiveEvidenceProducer(staleSkippedProducer, skippedSample)).rejects.toThrow(
      "producer generator digest drift",
    );

    const misplacedSkippedProducer = structuredClone(skippedEvidence);
    misplacedSkippedProducer.artifacts[0].path = "package.json";
    misplacedSkippedProducer.artifacts[0].sha256 = createHash("sha256")
      .update(await readFile("package.json"))
      .digest("hex");
    await expect(validateLiveEvidenceProducer(misplacedSkippedProducer, skippedSample)).rejects.toThrow(
      "producer generator path for npm run bench:live must be scripts/live-benchmark-evidence.mjs",
    );

    const unclaimedSkippedProducer = structuredClone(skippedEvidence);
    unclaimedSkippedProducer.artifacts = [];
    await expect(validateLiveEvidenceProducer(unclaimedSkippedProducer, skippedSample)).resolves.toBeUndefined();

    const arbitraryFile = structuredClone(nonBenchEvidence);
    arbitraryFile.artifacts[0].path = "package.json";
    arbitraryFile.artifacts[0].sha256 = createHash("sha256")
      .update(await readFile("package.json"))
      .digest("hex");
    await expect(validateLiveEvidenceProducer(arbitraryFile, nonBenchSample)).rejects.toThrow(
      `producer generator path for npm run demo:spatial-analytics:live-evidence must be ${nonBenchGeneratorPath}`,
    );

    const wrongPathAndDigest = structuredClone(nonBenchEvidence);
    wrongPathAndDigest.artifacts[0].path = "package.json";
    wrongPathAndDigest.artifacts[0].sha256 = "0".repeat(64);
    await expect(validateLiveEvidenceProducer(wrongPathAndDigest, nonBenchSample)).rejects.toThrow(
      `producer generator path for npm run demo:spatial-analytics:live-evidence must be ${nonBenchGeneratorPath}`,
    );

    const otherReviewedGenerator = structuredClone(nonBenchEvidence);
    otherReviewedGenerator.artifacts[0].path = "scripts/overture-live-evidence.mjs";
    otherReviewedGenerator.artifacts[0].sha256 = createHash("sha256")
      .update(await readFile("scripts/overture-live-evidence.mjs"))
      .digest("hex");
    await expect(validateLiveEvidenceProducer(otherReviewedGenerator, nonBenchSample)).rejects.toThrow(
      `producer generator path for npm run demo:spatial-analytics:live-evidence must be ${nonBenchGeneratorPath}`,
    );

    const ambiguousCommand = structuredClone(evidence);
    const ambiguousSample = structuredClone(sample);
    ambiguousSample.evidence.live.commands.push("npm run demo:spatial-analytics:live-evidence");
    await expect(validateLiveEvidenceProducer(ambiguousCommand, ambiguousSample)).rejects.toThrow(
      "executed live evidence requires exactly one reviewed producer command",
    );

    evidence.sdk.gitCommit = "e9ccbdb6e443f9abd3c97026d31e135f39bc0bc0";
    await expect(validateLiveEvidenceProducer(evidence, sample)).resolves.toBeUndefined();

    const missingRevision = structuredClone(evidence);
    missingRevision.sdk.gitCommit = null;
    expect(() => validateEvidenceEnvelope(missingRevision)).toThrow(
      "executed live evidence requires a full reported source revision",
    );
    const emptyRevision = structuredClone(evidence);
    emptyRevision.sdk.gitCommit = "";
    expect(() => validateEvidenceEnvelope(emptyRevision)).toThrow(
      "evidence sdk.gitCommit must be null or a full reported source revision",
    );
    const missingProducer = structuredClone(evidence);
    missingProducer.artifacts = [];
    expect(() => validateEvidenceEnvelope(missingProducer)).toThrow(
      "executed live evidence requires a producer-generator artifact",
    );

    evidence.artifacts[0].sha256 = "0".repeat(64);
    await expect(validateLiveEvidenceProducer(evidence, sample)).rejects.toThrow("producer generator digest drift");
    evidence.artifacts[0].sha256 = createHash("sha256")
      .update(await readFile(evidence.artifacts[0].path))
      .digest("hex");
    evidence.semantics.operation = "unsupported-old-journey";
    await expect(validateLiveEvidenceProducer(evidence, sample)).rejects.toThrow(
      "producer generator does not support this journey",
    );
  });

  it("binds browser artifacts to build inputs, peers, SHA-256, and SRI", async () => {
    const manifest = await buildBrowserArtifactManifest({
      artifacts: [{ path: "test/fixtures/sample-contract/browser.js", entrypoint: "fixture" }],
      gitCommit: "1111111111111111111111111111111111111111",
    });

    expect(manifest.files[0]).toMatchObject({
      entrypoint: "fixture",
      integrity: expect.stringMatching(/^sha256-/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(manifest.build.inputs.length).toBeGreaterThan(250);
    expect(manifest.compatibility.peers).toHaveProperty("maplibre-gl");
    await expect(verifyBrowserArtifactManifest(manifest)).resolves.toBeUndefined();

    manifest.files[0].sha256 = "0".repeat(64);
    await expect(verifyBrowserArtifactManifest(manifest)).rejects.toThrow("SHA-256 drift");
  });
});
