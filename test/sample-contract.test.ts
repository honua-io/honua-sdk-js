import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  buildBrowserArtifactManifest,
  compareReleases,
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
    expect(generatedOutputDrift(bumpedOutputs, currentOutputs)).toEqual([]);

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
    expect(generatedOutputDrift(bumpedOutputs, integrityDrift)).toEqual([fixturePath]);
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
      "sample replacement cycle: geoprocessing-job-runner -> stac-imagery-browser -> geoprocessing-job-runner",
    );

    const unboundExecuted = await readJson("samples/catalog.v2.json");
    const planned = unboundExecuted.samples.find(
      (sample: { evidence: { live: { status: string } } }) => sample.evidence.live.status === "planned",
    );
    planned.evidence.live.status = "executed";
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

  it("promotes only supported, active, fully evidenced candidates to golden", async () => {
    const packageJson = await readJson("package.json");

    const unsupported = await readJson("samples/catalog.v2.json");
    unsupported.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").supportTier =
      "experimental";
    await expect(validateCatalog(unsupported, packageJson, validationTime)).rejects.toThrow(
      "maplibre-quickstart: golden samples must be supported",
    );

    const inactive = await readJson("samples/catalog.v2.json");
    inactive.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").lifecycle = {
      state: "rework",
      reason: "Promotion regression fixture.",
      targetRelease: "0.2.0-beta.0",
    };
    await expect(validateCatalog(inactive, packageJson, validationTime)).rejects.toThrow(
      "maplibre-quickstart: golden samples must be active",
    );

    const missingFixture = await readJson("samples/catalog.v2.json");
    missingFixture.samples.find(
      (sample: { id: string }) => sample.id === "maplibre-quickstart",
    ).evidence.fixture.status = "planned";
    await expect(validateCatalog(missingFixture, packageJson, validationTime)).rejects.toThrow(
      "maplibre-quickstart: golden samples require executed fixture evidence",
    );

    const missingLive = await readJson("samples/catalog.v2.json");
    const live = missingLive.samples.find((sample: { id: string }) => sample.id === "maplibre-quickstart").evidence
      .live;
    live.status = "planned";
    delete live.evidencePath;
    delete live.expiresAt;
    await expect(validateCatalog(missingLive, packageJson, validationTime)).rejects.toThrow(
      "maplibre-quickstart: golden samples require current executed live evidence",
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
