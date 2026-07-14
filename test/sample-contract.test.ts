import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  buildBrowserArtifactManifest,
  classifyConfigurationName,
  compareReleases,
  extractSampleConfiguration,
  generateCiSelection,
  generateSiteProjection,
  generatedOutputDrift,
  generatedOutputs,
  isRunnableRootExampleDirectory,
  migrateCatalogV1ToV2,
  validateCatalog,
  validateCiSelection,
  validateEvidenceEnvelope,
  validateLiveEvidenceProducer,
  validateSiteProjection,
  verifyBrowserArtifactManifest,
} from "../scripts/sample-contract.mjs";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const execFileAsync = promisify(execFile);
const validationTime = { now: "2026-07-13T12:00:00.000Z" };
const goldenJourneyIds = [
  "first-map",
  "service-explorer",
  "planning-permitting",
  "incident-operations",
  "imagery-terrain",
  "cloud-native-analysis",
  "arcgis-migration",
];

describe("sample publication contract", () => {
  it("discovers every runnable example and reserves exactly seven golden journeys", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const packageJson = await readJson("package.json");

    await expect(validateCatalog(catalog, packageJson, validationTime)).resolves.toBeUndefined();
    expect(catalog.samples).toHaveLength(34);
    expect(
      catalog.samples.filter((sample: { sourceKind: string }) => sample.sourceKind === "root-example"),
    ).toHaveLength(31);
    expect(
      catalog.samples.filter((sample: { sourceKind: string }) => sample.sourceKind === "docs-example"),
    ).toHaveLength(3);
    expect(catalog.goldenJourneys.map((journey: { id: string }) => journey.id)).toEqual(goldenJourneyIds);
    expect(catalog.samples.filter((sample: { track: string }) => sample.track === "golden")).toHaveLength(0);
    expect(catalog.goldenJourneys.filter((journey: { status: string }) => journey.status === "qualified")).toHaveLength(
      0,
    );
    expect(catalog.goldenJourneys.filter((journey: { status: string }) => journey.status === "planned")).toHaveLength(
      7,
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

    await expect(migrateCatalogV1ToV2(v1, migration)).resolves.toEqual(canonical);

    delete migration.sampleOverrides[Object.keys(migration.sampleOverrides)[0]];
    await expect(migrateCatalogV1ToV2(v1, migration)).rejects.toThrow(
      "migration overrides must cover every v1 sample exactly",
    );
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

    await expect(validateSiteProjection(projection)).resolves.toBeUndefined();
    await expect(validateCiSelection(ciSelection)).resolves.toBeUndefined();

    expect(projection.samples).toHaveLength(34);
    expect(projection.routes).toHaveLength(21);
    expect(projection.goldenJourneys.map((journey: { id: string }) => journey.id)).toEqual(goldenJourneyIds);
    expect(
      projection.goldenJourneys.find((journey: { id: string }) => journey.id === "incident-operations"),
    ).toMatchObject({ status: "planned", candidateSampleId: "realtime-incident-dashboard" });
    expect(ciSelection.samples).toHaveLength(34);
    expect(ciSelection.profiles).toHaveLength(catalog.qualityProfiles.length);
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
      commands: ["npm run bench:live"],
    });
    expect(projection.samples.some((sample: { id: string }) => sample.id === "two-protocols")).toBe(false);

    const malformedProjection = structuredClone(projection);
    delete malformedProjection.samples[0].lifecycle.state;
    await expect(validateSiteProjection(malformedProjection)).rejects.toThrow("JSON Schema validation failed");

    const flattenedCi = structuredClone(ciSelection);
    const flattenedSample = flattenedCi.samples[0] as unknown as Record<string, unknown>;
    flattenedSample.commands = ["npm run demo:quickstart:mock"];
    delete flattenedSample.commandPlan;
    await expect(validateCiSelection(flattenedCi)).rejects.toThrow("JSON Schema validation failed");
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
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json",
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
      fixturePath,
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
    second.lifecycle.replacement = { kind: "sample", id: first.id };
    await expect(validateCatalog(replacementCycle, packageJson, validationTime)).rejects.toThrow(
      "sample/journey replacement cycle: sample:geoprocessing-job-runner -> sample:stac-imagery-browser -> sample:geoprocessing-job-runner",
    );

    const expandedJourneyCycle = await readJson("samples/catalog.v2.json");
    const imagery = expandedJourneyCycle.samples.find(
      (sample: { id: string }) => sample.id === "imagery-cog-quickstart",
    );
    imagery.lifecycle.state = "merge";
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
  });

  it("resolves finite environment aliases and fails closed on dynamic reads", async () => {
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-static")).resolves.toEqual([
      "HONUA_ALIASED_URL",
      "HONUA_DESTRUCTURED_URL",
      "HONUA_DYNAMIC_URL",
    ]);
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-unresolved")).rejects.toThrow(
      "unresolved dynamic environment read",
    );
    await expect(extractSampleConfiguration("test/fixtures/sample-contract/env-rest")).rejects.toThrow(
      "environment rest destructuring is not statically bounded",
    );
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

    const viteDevLive = await readJson("samples/catalog.v2.json");
    viteDevLive.samples.find((sample: { id: string }) => sample.id === "endpoint-to-map").evidence.live.commands = [
      "npm run demo:endpoint-to-map",
    ];
    await expect(validateCatalog(viteDevLive, packageJson, validationTime)).rejects.toThrow(
      "scheduled live command is not in the reviewed bounded producer registry",
    );

    const deceptiveProducer = await readJson("samples/catalog.v2.json");
    deceptiveProducer.samples.find((sample: { id: string }) => sample.id === "endpoint-to-map").evidence.live.commands =
      ["npm run demo:evil:live-smoke"];
    const deceptivePackage = structuredClone(packageJson);
    deceptivePackage.scripts["demo:evil:live-smoke"] = "vite";
    await expect(validateCatalog(deceptiveProducer, deceptivePackage, validationTime)).rejects.toThrow(
      "scheduled live command is not in the reviewed bounded producer registry",
    );
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
  });

  it("uses one credential-safe evidence envelope for fixture, live, and unavailable lanes", async () => {
    for (const name of ["fixture", "live", "skipped"]) {
      const evidence = await readJson(`samples/contract/v1/fixtures/sample-evidence.${name}.json`);
      expect(validateEvidenceEnvelope(evidence)).toBe(evidence);
    }

    const invalid = await readJson("samples/contract/v1/fixtures/sample-evidence.skipped.json");
    invalid.reason = null;
    expect(() => validateEvidenceEnvelope(invalid)).toThrow("requires a reason");

    const credentialUrl = await readJson("samples/contract/v1/fixtures/sample-evidence.live.json");
    credentialUrl.source.endpoint = "https://example.test/features?api_key=secret";
    expect(() => validateEvidenceEnvelope(credentialUrl)).toThrow("forbidden credential query parameter api_key");

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

  it("binds live producer provenance to its commit, generator digest, sample, and journey", async () => {
    const catalog = await readJson("samples/catalog.v2.json");
    const sample = catalog.samples.find((candidate: { id: string }) => candidate.id === "maplibre-quickstart");
    const evidence = await readJson(sample.evidence.live.evidencePath);

    await expect(validateLiveEvidenceProducer(evidence, sample)).resolves.toBeUndefined();
    evidence.sdk.gitCommit = "e9ccbdb6e443f9abd3c97026d31e135f39bc0bc0";
    await expect(validateLiveEvidenceProducer(evidence, sample)).rejects.toThrow(
      "producer artifact does not match sdk.gitCommit",
    );
    evidence.sdk.gitCommit = "a6e2bb0785bcdebf47a1f5bd8254cf62e138963b";
    evidence.artifacts[0].sha256 = "0".repeat(64);
    await expect(validateLiveEvidenceProducer(evidence, sample)).rejects.toThrow("producer generator digest drift");
    evidence.artifacts[0].sha256 = "f4e279e9aeeab199af0be1dc9bf80133c6b938f563a99e97e443f656b364034b";
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
