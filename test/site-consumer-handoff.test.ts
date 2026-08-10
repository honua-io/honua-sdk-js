import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import {
  collectQualificationEvidence,
  filterSiteConsumerCards,
  generateCapabilitySampleMatrix,
  generateGoldenJourneyVisualEvidence,
  generateLegacyVisualReceiptArchive,
  generateSiteConsumerFixtureV4,
  generateSiteConsumerHandoff,
  generateSiteProjection,
  validateLegacyVisualReceiptArchive,
  validateSiteConsumerFixtureV3,
  validateSiteConsumerFixtureV4,
  validateSiteConsumerHandoff,
  validateSiteProjection,
} from "../scripts/sample-contract.mjs";
import type {
  CapabilitySampleMatrix,
  GoldenJourneyVisualEvidence,
  LegacyVisualReceiptArchive,
  SiteConsumerHandoff,
} from "../scripts/sample-contract.mjs";

// canonicalInputs() reads the real samples/evidence tree (receipts,
// screenshots, live evidence) for the now genuinely qualified First Map,
// Imagery and Terrain, Universal Service Explorer, and ArcGIS Migration
// Workbench journeys. That real I/O regularly exceeds vitest's 5s default
// under full-suite contention; it was effectively instant against the
// previously always-empty evidence set, so this was never exercised before.
// Four qualified journeys' worth of receipts (up from one) need more
// headroom than the original single-journey budget.
vi.setConfig({ testTimeout: 60_000 });

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const derivedArtifactsRelaxed = /^(1|true|yes|on)$/i.test(process.env.HONUA_DERIVED_ARTIFACTS_RELAX ?? "");
const isCapabilityNarrowing = (legacy: readonly string[], current: readonly string[]): boolean => {
  const legacyKeys = new Set(legacy);
  return current.every((key) => legacyKeys.has(key));
};

async function checkoutBoundHandoff(current: SiteConsumerHandoff): Promise<SiteConsumerHandoff> {
  // PR CI validates the newly generated authority set and the committed,
  // internally bound projection independently until trunk regenerates them.
  if (!derivedArtifactsRelaxed) return current;
  return readJson("samples/dist/honua-site-consumer-handoff.v2.json");
}

async function buildCanonicalInputs() {
  const [catalog, packageJson, supportTruth] = await Promise.all([
    readJson("samples/catalog.v2.json"),
    readJson("package.json"),
    readJson("config/support-manifest.v1.json"),
  ]);
  const qualificationEvidence = await collectQualificationEvidence(catalog);
  const projection = generateSiteProjection(catalog, packageJson);
  const matrix = generateCapabilitySampleMatrix(catalog, packageJson, supportTruth, qualificationEvidence);
  const visualEvidence = await generateGoldenJourneyVisualEvidence(catalog, qualificationEvidence);
  const handoff = generateSiteConsumerHandoff(projection, matrix, visualEvidence);
  const fixture = generateSiteConsumerFixtureV4(handoff);
  return {
    catalog,
    packageJson,
    supportTruth,
    qualificationEvidence,
    projection,
    matrix,
    visualEvidence,
    handoff,
    fixture,
  };
}

type CanonicalInputs = Awaited<ReturnType<typeof buildCanonicalInputs>>;
let canonicalInputsPromise: Promise<CanonicalInputs> | undefined;

function canonicalInputs(): Promise<CanonicalInputs> {
  canonicalInputsPromise ??= buildCanonicalInputs();
  return canonicalInputsPromise;
}

function allObjectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  return [...Object.keys(value), ...Object.values(value as Record<string, unknown>).flatMap(allObjectKeys)];
}

describe("honua-site consumer handoff", () => {
  // This is the first test in the file to call canonicalInputs(), so it also
  // pays the cold-cache cost of the initial real samples/evidence read (both
  // golden samples' packed tarballs and screenshots) that later tests reuse
  // a warm fs cache for; give it headroom above this file's already-doubled
  // 40s default.
  it(
    "deterministically joins all three validated authorities without inventing qualification",
    { timeout: 90_000 },
    async () => {
      const inputs = await canonicalInputs();
      const committedHandoff = await checkoutBoundHandoff(inputs.handoff);

      await expect(validateSiteConsumerHandoff(inputs.handoff, inputs)).resolves.toBeUndefined();
      await expect(validateSiteConsumerHandoff(committedHandoff)).resolves.toBeUndefined();
      await expect(validateSiteConsumerFixtureV4(inputs.fixture, inputs.handoff)).resolves.toBeUndefined();
      expect(generateSiteConsumerHandoff(inputs.projection, inputs.matrix, inputs.visualEvidence)).toEqual(
        inputs.handoff,
      );
      expect(inputs.handoff).toMatchObject({
        format: "honua.site.sdk-sample-consumer-handoff.v2",
        schemaVersion: 2,
        ownership: {
          executableSourceOwner: "honua-io/honua-sdk-js",
          presentationOwner: "honua-io/honua-site",
          sourceImplementationDuplicated: false,
        },
        counts: {
          cards: 31,
          qualifiedJourneys: 4,
          canonicalRoutes: 31,
          legacyRoutes: 20,
          gaps: inputs.matrix.gaps.length,
        },
      });
      // maplibre-quickstart, imagery-cog-quickstart, migration-workbench,
      // and service-explorer are the four real, evidence-backed golden
      // journeys; check stable identity fields rather than the full
      // volatile object (timestamps, run IDs, and screenshot hashes
      // legitimately change every capture).
      expect(inputs.handoff.qualifiedJourneys).toHaveLength(4);
      expect(
        [...inputs.handoff.qualifiedJourneys].sort((left, right) => left.journeyId.localeCompare(right.journeyId)),
      ).toMatchObject([
        {
          journeyId: "arcgis-migration",
          sampleId: "migration-workbench",
          canonicalPath: "samples/migration-workbench.html",
        },
        {
          journeyId: "first-map",
          sampleId: "maplibre-quickstart",
          canonicalPath: "samples/maplibre-quickstart.html",
        },
        {
          journeyId: "imagery-terrain",
          sampleId: "imagery-cog-quickstart",
          canonicalPath: "samples/imagery-cog-quickstart.html",
        },
        {
          journeyId: "service-explorer",
          sampleId: "service-explorer",
          canonicalPath: "samples/service-explorer.html",
        },
      ]);
      expect(inputs.handoff.policy).toMatchObject({
        canonicalRoutes: { statusPages: ["fixture", "retire", "replace"] },
        limits: {
          maxArtifactBytes: 16 * 1024 * 1024,
          maxCards: 512,
          maxRoutes: 1024,
          maxGaps: 8192,
          maxFacetValues: 2048,
          maxFilterValueCharacters: 512,
          maxJsonNodes: 250_000,
          maxJsonDepth: 64,
          maxStringCharacters: 32 * 1024,
          maxAggregateStringCharacters: 16 * 1024 * 1024,
        },
      });
      expect(
        inputs.handoff.cards.every(
          (card) => card.track === "golden" || card.track === "recipe" || card.track === "lab",
        ),
      ).toBe(true);
      // maplibre-quickstart, imagery-cog-quickstart, migration-workbench,
      // and service-explorer are the four real, evidence-backed qualified
      // cards; every OTHER card must still carry no invented evidence.
      const qualifiedCardIds = new Set([
        "maplibre-quickstart",
        "imagery-cog-quickstart",
        "migration-workbench",
        "service-explorer",
      ]);
      expect(
        inputs.handoff.cards
          .filter((card) => !qualifiedCardIds.has(card.id))
          .every((card) => card.evidenceBindingId === null && card.visualEvidence === null),
      ).toBe(true);
      for (const id of qualifiedCardIds) {
        const card = inputs.handoff.cards.find((candidate) => candidate.id === id);
        expect(card?.evidenceBindingId).not.toBeNull();
        expect(card?.visualEvidence).not.toBeNull();
      }
      expect(inputs.handoff.counts.qualifiedMatrixCells).toEqual({
        goldenJourneys: 4,
        protocolOperations: 5,
        supportClaims: 1,
        packageEntrypoints: 2,
      });
    },
  );

  it("keeps the v2 projection, v1 handoff, and v3 fixture valid for existing consumers", async () => {
    const [projection, handoff, fixture] = await Promise.all([
      readJson("samples/dist/honua-site-samples.v2.json"),
      readJson("samples/dist/honua-site-consumer-handoff.v1.json"),
      readJson("samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json"),
    ]);

    await expect(validateSiteProjection(projection)).resolves.toBeUndefined();
    await expect(validateSiteConsumerHandoff(handoff, { verifyCheckout: false })).resolves.toBeUndefined();
    await expect(validateSiteConsumerFixtureV3(fixture, handoff, { verifyCheckout: false })).resolves.toBeUndefined();
    const projectionSchemaBytes = await readFile(handoff.inputs.siteProjection.schemaPath, "utf8");
    expect(handoff.inputs.siteProjection.schemaBytes).toBe(Buffer.byteLength(projectionSchemaBytes));
    expect(handoff.inputs.siteProjection.schemaSha256).toBe(sha256(projectionSchemaBytes));
    expect(projection).toMatchObject({ format: "honua.site.sdk-sample-projection.v2", schemaVersion: 2 });
    expect(handoff).toMatchObject({ format: "honua.site.sdk-sample-consumer-handoff.v1", schemaVersion: 1 });
    expect(fixture).toMatchObject({ format: "honua.site.sdk-sample-consumer-fixture.v3", schemaVersion: 3 });
  });

  it("permits v3 to retire stale capability claims but rejects expansion under an existing identity", () => {
    expect(isCapabilityNarrowing(["geocoding.forward", "geocoding.reverse"], ["geocoding.forward"])).toBe(true);
    expect(isCapabilityNarrowing(["geocoding.forward"], ["geocoding.forward", "geocoding.reverse"])).toBe(false);
  });

  it("publishes live-backed samples through v3 without forking identities or adding capability claims", async () => {
    const [legacyProjection, projection, handoff, fixture] = await Promise.all([
      readJson("samples/dist/honua-site-samples.v2.json"),
      readJson("samples/dist/honua-site-samples.v3.json"),
      readJson("samples/dist/honua-site-consumer-handoff.v2.json"),
      readJson("samples/contract/v2/consumer-fixtures/honua-site-consumer.v4.json"),
    ]);

    await expect(validateSiteProjection(projection)).resolves.toBeUndefined();
    await expect(validateSiteConsumerHandoff(handoff, { verifyCheckout: false })).resolves.toBeUndefined();
    await expect(validateSiteConsumerFixtureV4(fixture, handoff, { verifyCheckout: false })).resolves.toBeUndefined();
    for (const sampleId of ["service-explorer"]) {
      expect(projection.sampleBundles.published).toContainEqual(
        expect.objectContaining({ id: sampleId, runnability: "requires-live-endpoint" }),
      );
      expect(projection.sampleBundles.published).not.toContainEqual(
        expect.objectContaining({ id: sampleId, runnability: "standalone" }),
      );
    }
    const currentSamplesById = new Map(projection.samples.map((sample: { id: string }) => [sample.id, sample]));
    const legacySamplesById = new Map(legacyProjection.samples.map((sample: { id: string }) => [sample.id, sample]));
    expect(currentSamplesById.size).toBe(projection.samples.length);
    expect([...legacySamplesById.keys()].filter((id) => !currentSamplesById.has(id))).toEqual([]);
    const additiveIds = [...currentSamplesById.keys()].filter((id) => !legacySamplesById.has(id));
    expect(additiveIds.every((id) => id === "coverages-wcs-basic")).toBe(true);
    expect(additiveIds.length).toBeLessThanOrEqual(1);
    expect(projection.routes).toEqual(legacyProjection.routes);
    const legacyCapabilities = new Map<string, string[]>(
      legacyProjection.samples.map((sample: { id: string; capabilityKeys: string[] }): [string, string[]] => [
        sample.id,
        sample.capabilityKeys,
      ]),
    );
    for (const sample of projection.samples as Array<{ id: string; capabilityKeys: string[] }>) {
      const legacyCapabilityKeys = legacyCapabilities.get(sample.id);
      if (legacyCapabilityKeys === undefined) {
        expect(sample.id).toBe("coverages-wcs-basic");
        continue;
      }
      expect(isCapabilityNarrowing(legacyCapabilityKeys, sample.capabilityKeys)).toBe(true);
    }
  });

  it("content-binds the committed handoff, upstream artifacts, schemas, and consumer fixture", async () => {
    const inputs = await canonicalInputs();
    const handoffBytes = await readFile("samples/dist/honua-site-consumer-handoff.v2.json", "utf8");
    const committedHandoff = JSON.parse(handoffBytes) as SiteConsumerHandoff;
    const fixtureBytes = await readFile("samples/contract/v2/consumer-fixtures/honua-site-consumer.v4.json", "utf8");
    const committedFixture = JSON.parse(fixtureBytes);

    expect(inputs.packageJson.files).toEqual(
      expect.arrayContaining([
        "samples/dist",
        "samples/contract/v2/schemas",
        "samples/contract/v2/consumer-fixtures/honua-site-consumer.v4.json",
      ]),
    );
    expect(handoffBytes).toBe(`${JSON.stringify(committedHandoff, null, 2)}\n`);
    if (!derivedArtifactsRelaxed) {
      expect(committedHandoff).toEqual(inputs.handoff);
      expect(committedFixture).toEqual(inputs.fixture);
    }
    expect(committedFixture.input).toMatchObject({
      path: "samples/dist/honua-site-consumer-handoff.v2.json",
      schemaPath: "samples/contract/v2/schemas/site-consumer-handoff.v2.schema.json",
      bytes: Buffer.byteLength(handoffBytes),
      sha256: sha256(handoffBytes),
    });
    for (const input of Object.values(committedHandoff.inputs)) {
      const bytes = await readFile(input.path, "utf8");
      expect(bytes).toBe(`${JSON.stringify(JSON.parse(bytes), null, 2)}\n`);
      expect(input.bytes).toBe(Buffer.byteLength(bytes));
      expect(input.sha256).toBe(sha256(bytes));
      await expect(readFile(input.schemaPath, "utf8")).resolves.toContain("$schema");
    }
  });

  it("executes task, capability, protocol, combined, text, and zero-result filter semantics", async () => {
    const { handoff, fixture } = await canonicalInputs();

    for (const filterCase of fixture.filterCases) {
      expect(filterSiteConsumerCards(handoff.cards, filterCase.filters).map((card) => card.id)).toEqual(
        filterCase.expectedSampleIds,
      );
    }
    expect(
      filterSiteConsumerCards(handoff.cards, { text: "ＲＥＡＬＴＩＭＥ   incident" }).map((card) => card.id),
    ).toContain("realtime-incident-dashboard");
    expect(fixture.filterCases.map((filterCase) => filterCase.id)).toEqual([
      "all-public-cards",
      "task",
      "capability",
      "protocol",
      "combined",
      "text",
      "zero-results",
    ]);
    expect(
      fixture.filterCases.find((filterCase) => filterCase.id === "text")?.expectedSampleIds.length,
    ).toBeGreaterThan(0);
    for (const task of handoff.filters.tasks) {
      expect(filterSiteConsumerCards(handoff.cards, { task }).length).toBeGreaterThan(0);
    }
    for (const capability of handoff.filters.capabilities) {
      expect(filterSiteConsumerCards(handoff.cards, { capability }).length).toBeGreaterThan(0);
    }
    for (const protocol of handoff.filters.protocols) {
      expect(filterSiteConsumerCards(handoff.cards, { protocol }).length).toBeGreaterThan(0);
    }
    expect(() => filterSiteConsumerCards(handoff.cards, { typo: "map" } as never)).toThrow("filter is unsupported");
    expect(() => filterSiteConsumerCards(handoff.cards, { text: "x".repeat(513) })).toThrow(
      "filter exceeds its character budget",
    );
  });

  it("publishes explicit accessible keyboard and desktop/mobile responsive consumer requirements", async () => {
    const { handoff, fixture } = await canonicalInputs();

    expect(fixture.interaction).toEqual(handoff.policy.interaction);
    expect(fixture.interaction).toMatchObject({
      filters: {
        dimensions: expect.arrayContaining(["task", "capability", "protocol"]),
        zeroResultsVisible: true,
        clearControlRequired: true,
      },
      accessibility: {
        filterRegionRole: "search",
        nativeControlLabelsRequired: true,
        resultsRole: "status",
        resultsAriaLive: "polite",
        resultsAriaAtomic: true,
        focusIndicatorRequired: true,
      },
      keyboard: {
        navigation: "native-tab-order",
        focusAfterClear: "task-search",
        noKeyboardTrap: true,
      },
      responsive: {
        requiredViewports: [
          { id: "desktop", viewport: { width: 1280, height: 720 } },
          { id: "mobile", viewport: { width: 390, height: 844 } },
        ],
        mobileControls: "single-column",
        minimumTouchTargetCssPixels: 44,
        horizontalPageOverflowForbidden: true,
        contentLossForbidden: true,
      },
    });
  });

  it("resolves every legacy alias and lifecycle transition without creating a second source tree", async () => {
    const { catalog, handoff } = await canonicalInputs();
    const handedOffRouteIds = handoff.legacyRoutes.flatMap((route) => route.routeIds).sort();

    expect(handedOffRouteIds).toEqual(catalog.siteMappings.map((mapping: { id: string }) => mapping.id).sort());
    expect(handoff.legacyRoutes.find((route) => route.path === "demo.html")).toMatchObject({
      routeIds: ["maui-explorer", "quickstart-map"],
      resolution: "canonical-sample",
      canonicalPath: "samples/maplibre-quickstart.html",
      httpStatus: 308,
      presentation: "permanent-redirect",
    });
    // #544 promotes the universal Service Explorer as the canonical replacement for the
    // former `two-protocols` site-exception (matching that route's documented exceptionReason),
    // leaving two site-owned exception routes (control-legend, control-search).
    expect(handoff.legacyRoutes.filter((route) => route.resolution === "site-exception")).toHaveLength(2);
    expect(
      handoff.legacyRoutes
        .filter((route) => route.resolution !== "canonical-sample")
        .every((route) => route.presentation === "status-page" && route.reason.includes("Display an explicit")),
    ).toBe(true);
    expect(handoff.canonicalRoutes.every((route) => route.path === `samples/${route.sampleId}.html`)).toBe(true);
    expect(handoff.canonicalRoutes.every((route) => route.externalListingEligible === true)).toBe(true);
    expect(handoff.canonicalRoutes.find((route) => route.sampleId === "app-bootstrap-basic")).toMatchObject({
      lifecycleState: "retire",
      presentation: "lifecycle-status",
    });
    expect(handoff.canonicalRoutes.find((route) => route.sampleId === "runtime-parity-showcase")).toMatchObject({
      lifecycleState: "replace",
      presentation: "lifecycle-status",
    });

    const publicNonActiveIds = handoff.cards.filter((card) => card.lifecycle.state !== "active").map((card) => card.id);
    expect(handoff.lifecycleNotices.map((notice) => notice.sampleId)).toEqual(publicNonActiveIds);
    expect(handoff.lifecycleNotices.find((notice) => notice.sampleId === "app-bootstrap-basic")).toMatchObject({
      state: "retire",
      replacement: {
        kind: "external",
        id: "honua-app-platform",
      },
    });
    expect(allObjectKeys(handoff.cards)).not.toEqual(
      expect.arrayContaining(["commands", "sourceCode", "javascript", "html"]),
    );
  });

  it("keeps the incident journey realtime while its absent qualification remains explicit", async () => {
    const { projection, matrix, visualEvidence, handoff } = await canonicalInputs();
    const incident = handoff.cards.find((card) => card.id === "realtime-incident-dashboard");

    expect(incident).toMatchObject({
      journey: { id: "incident-operations", status: "planned" },
      qualification: { state: "planned" },
      evidenceBindingId: null,
      visualEvidence: null,
    });
    expect(incident?.tasks).toContain("realtime");
    expect(incident?.evidence.live).toMatchObject({
      mode: "unavailable",
      targetMode: "demo-live",
      status: "skipped",
    });
    expect(incident?.expectedDegradation).toContain("read-only replay");

    const promotedProjection = structuredClone(projection);
    const promotedMatrix = structuredClone(matrix) as CapabilitySampleMatrix;
    const staticVisual = structuredClone(visualEvidence) as GoldenJourneyVisualEvidence;
    const projectedJourney = promotedProjection.goldenJourneys.find(
      (journey: { id: string }) => journey.id === "incident-operations",
    );
    const projectedSample = promotedProjection.samples.find(
      (sample: { id: string }) => sample.id === "realtime-incident-dashboard",
    );
    const matrixJourney = promotedMatrix.goldenJourneys.find((journey) => journey.id === "incident-operations");
    const matrixSample = promotedMatrix.samples.find((sample) => sample.id === "realtime-incident-dashboard");
    if (!projectedJourney || !projectedSample || !matrixJourney || !matrixSample) {
      throw new Error("canonical incident journey fixture is missing");
    }
    projectedJourney.status = "qualified";
    projectedSample.track = "golden";
    matrixJourney.catalogStatus = "qualified";
    matrixSample.track = "golden";
    matrixSample.qualification = {
      state: "qualified",
      catalogStatus: "qualified",
      evidenceBindingId: `qualification:${"a".repeat(64)}`,
    };
    promotedMatrix.evidenceBindings.push({
      id: `qualification:${"a".repeat(64)}`,
      sampleId: matrixSample.id,
    } as never);
    staticVisual.qualifiedGoldenJourneys.push({
      journeyId: "incident-operations",
      sampleId: "realtime-incident-dashboard",
      liveEvidence: {},
    } as never);

    expect(() => generateSiteConsumerHandoff(promotedProjection, promotedMatrix, staticVisual)).toThrow(
      "must remain realtime",
    );
  });

  it("fails closed on tampered authorities, routes, links, and executable fixture expectations", async () => {
    const inputs = await canonicalInputs();
    const checkoutHandoff = await checkoutBoundHandoff(inputs.handoff);

    const digestDrift = structuredClone(inputs.handoff);
    digestDrift.inputs.capabilityMatrix.sha256 = "0".repeat(64);
    await expect(validateSiteConsumerHandoff(digestDrift, inputs)).rejects.toThrow(
      "does not match its validated authority inputs",
    );
    await expect(validateSiteConsumerHandoff(digestDrift)).rejects.toThrow("artifact byte or digest binding drift");

    const manuallyForkedCard = structuredClone(checkoutHandoff);
    manuallyForkedCard.cards[0].summary = "A manually maintained site-only sample description.";
    await expect(validateSiteConsumerHandoff(manuallyForkedCard)).rejects.toThrow(
      "does not match its content-bound projection inputs",
    );

    const manuallyForkedRoute = structuredClone(checkoutHandoff);
    manuallyForkedRoute.legacyRoutes[0].reason = "A manually maintained site-only route disposition.";
    await expect(validateSiteConsumerHandoff(manuallyForkedRoute)).rejects.toThrow(
      "does not match its content-bound projection inputs",
    );

    const missingQualifiedVisual = structuredClone(inputs.matrix);
    const firstMap = missingQualifiedVisual.samples.find((sample) => sample.id === "maplibre-quickstart");
    if (!firstMap) throw new Error("canonical first-map fixture is missing");
    firstMap.qualification = {
      state: "qualified",
      catalogStatus: "qualified",
      evidenceBindingId: `qualification:${"b".repeat(64)}`,
    };
    missingQualifiedVisual.evidenceBindings.push({
      id: `qualification:${"b".repeat(64)}`,
      sampleId: firstMap.id,
    } as never);
    // inputs.visualEvidence now genuinely carries maplibre-quickstart's real
    // entry, so it would satisfy the fabricated binding above by accident.
    // Clear it to isolate "matrix claims qualified but visual evidence has
    // nothing for this sample".
    const noVisualEvidence = structuredClone(inputs.visualEvidence);
    noVisualEvidence.qualifiedGoldenJourneys = [];
    expect(() => generateSiteConsumerHandoff(inputs.projection, missingQualifiedVisual, noVisualEvidence)).toThrow(
      "missing qualified visual evidence",
    );

    const brokenRoute = structuredClone(inputs.handoff);
    brokenRoute.canonicalRoutes[0].path = "samples/missing.html";
    await expect(validateSiteConsumerHandoff(brokenRoute, { verifyCheckout: false })).rejects.toThrow(
      "external listings must use only stable canonical routes",
    );

    const brokenLink = structuredClone(checkoutHandoff);
    brokenLink.cards[0].source.docsPath = "docs/does-not-exist.md";
    await expect(validateSiteConsumerHandoff(brokenLink)).rejects.toThrow("docs link is broken or missing");

    const fixtureDrift = structuredClone(inputs.fixture);
    fixtureDrift.filterCases[1].expectedSampleIds = [];
    await expect(validateSiteConsumerFixtureV4(fixtureDrift, inputs.handoff)).rejects.toThrow(
      "does not match the versioned handoff",
    );

    const excessiveProjection = structuredClone(inputs.projection);
    excessiveProjection.samples = Array.from({ length: 513 }, () => structuredClone(inputs.projection.samples[0]));
    expect(() => generateSiteConsumerHandoff(excessiveProjection, inputs.matrix, inputs.visualEvidence)).toThrow(
      "projection exceeds its bounded inventory",
    );

    const excessiveHandoff = structuredClone(inputs.handoff);
    excessiveHandoff.cards = Array.from({ length: 513 }, () => structuredClone(inputs.handoff.cards[0]));
    excessiveHandoff.counts.cards = excessiveHandoff.cards.length;
    await expect(validateSiteConsumerHandoff(excessiveHandoff, { verifyCheckout: false })).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const cyclicHandoff = structuredClone(inputs.handoff);
    cyclicHandoff.policy.cycle = cyclicHandoff;
    await expect(validateSiteConsumerHandoff(cyclicHandoff, { verifyCheckout: false })).rejects.toThrow(
      "contains a JSON cycle",
    );

    const forgedMatrix = structuredClone(inputs.matrix);
    forgedMatrix.gaps = [];
    const forgedHandoff = generateSiteConsumerHandoff(inputs.projection, forgedMatrix, inputs.visualEvidence);
    await expect(
      validateSiteConsumerHandoff(forgedHandoff, {
        ...inputs,
        matrix: forgedMatrix,
        authoritiesValidated: true,
      } as never),
    ).rejects.toThrow("capability matrix visible-gap coverage drift");

    const externalQuery = structuredClone(inputs.handoff);
    const externalNotice = externalQuery.lifecycleNotices.find((notice) => notice.replacement?.kind === "external");
    if (!externalNotice || externalNotice.replacement?.kind !== "external") {
      throw new Error("canonical external replacement fixture is missing");
    }
    externalNotice.replacement.url += "?view=docs";
    await expect(validateSiteConsumerHandoff(externalQuery, { verifyCheckout: false })).rejects.toThrow(
      "must be credential-free canonical HTTPS",
    );
  });

  it("rejects duplicated card, journey, replacement, and evidence-binding identities", async () => {
    const inputs = await canonicalInputs();
    const checkoutHandoff = await checkoutBoundHandoff(inputs.handoff);

    const duplicateJourney = structuredClone(inputs.projection);
    duplicateJourney.goldenJourneys.push(structuredClone(duplicateJourney.goldenJourneys[0]));
    expect(() => generateSiteConsumerHandoff(duplicateJourney, inputs.matrix, inputs.visualEvidence)).toThrow(
      "duplicate journey, replacement, evidence-binding, or visual identities",
    );

    const duplicateReplacement = structuredClone(inputs.projection);
    duplicateReplacement.externalReplacements.push(structuredClone(duplicateReplacement.externalReplacements[0]));
    expect(() => generateSiteConsumerHandoff(duplicateReplacement, inputs.matrix, inputs.visualEvidence)).toThrow(
      "duplicate journey, replacement, evidence-binding, or visual identities",
    );

    const duplicateBinding = structuredClone(inputs.matrix) as CapabilitySampleMatrix;
    duplicateBinding.evidenceBindings.push(structuredClone(duplicateBinding.evidenceBindings[0]));
    expect(() => generateSiteConsumerHandoff(inputs.projection, duplicateBinding, inputs.visualEvidence)).toThrow(
      "duplicate journey, replacement, evidence-binding, or visual identities",
    );

    const duplicateVisualSample = structuredClone(inputs.visualEvidence) as GoldenJourneyVisualEvidence;
    duplicateVisualSample.qualifiedGoldenJourneys[1].sampleId =
      duplicateVisualSample.qualifiedGoldenJourneys[0].sampleId;
    expect(() => generateSiteConsumerHandoff(inputs.projection, inputs.matrix, duplicateVisualSample)).toThrow(
      "duplicate journey, replacement, evidence-binding, or visual identities",
    );

    // Two catalog IDs pointing at one executable tree is the duplicated-implementation
    // shape the gallery must never publish, even though both card IDs stay unique.
    const forkedSourcePath = structuredClone(inputs.projection);
    const forkedMatrixSource = structuredClone(inputs.matrix) as CapabilitySampleMatrix;
    const [firstProjected, secondProjected] = forkedSourcePath.samples;
    secondProjected.source.path = firstProjected.source.path;
    const secondMatrixSample = forkedMatrixSource.samples.find((sample) => sample.id === secondProjected.id);
    if (!secondMatrixSample) throw new Error("canonical matrix sample fixture is missing");
    secondMatrixSample.sourcePath = firstProjected.source.path;
    expect(() => generateSiteConsumerHandoff(forkedSourcePath, forkedMatrixSource, inputs.visualEvidence)).toThrow(
      "duplicated card executable source path",
    );

    const sharedBinding = structuredClone(inputs.matrix) as CapabilitySampleMatrix;
    const qualifiedMatrixSamples = sharedBinding.samples.filter((sample) => sample.qualification.evidenceBindingId);
    expect(qualifiedMatrixSamples.length).toBeGreaterThan(1);
    qualifiedMatrixSamples[1].qualification.evidenceBindingId =
      qualifiedMatrixSamples[0].qualification.evidenceBindingId;
    expect(() => generateSiteConsumerHandoff(inputs.projection, sharedBinding, inputs.visualEvidence)).toThrow(
      "duplicated card evidence binding",
    );

    const duplicatedCardJourney = structuredClone(checkoutHandoff);
    const qualifiedCards = duplicatedCardJourney.cards.filter((card) => card.qualification.state === "qualified");
    expect(qualifiedCards.length).toBeGreaterThan(1);
    qualifiedCards[1].journey = structuredClone(qualifiedCards[0].journey);
    await expect(validateSiteConsumerHandoff(duplicatedCardJourney)).rejects.toThrow("duplicated card golden journey");

    const duplicatedCardVisual = structuredClone(checkoutHandoff);
    const duplicatedVisualCards = duplicatedCardVisual.cards.filter((card) => card.qualification.state === "qualified");
    duplicatedVisualCards[1].visualEvidence!.sampleId = duplicatedVisualCards[0].id;
    await expect(validateSiteConsumerHandoff(duplicatedCardVisual)).rejects.toThrow(
      "duplicated card visual evidence sample",
    );
  });

  it("fails publication on stale, orphaned, or unverifiable golden-card receipts", async () => {
    const inputs = await canonicalInputs();
    const checkoutHandoff = await checkoutBoundHandoff(inputs.handoff);
    const qualifiedCardId = checkoutHandoff.cards.find((card) => card.qualification.state === "qualified")?.id;
    if (!qualifiedCardId) throw new Error("canonical qualified golden card fixture is missing");
    const tamper = (mutate: (visual: NonNullable<SiteConsumerHandoff["cards"][number]["visualEvidence"]>) => void) => {
      const candidate = structuredClone(checkoutHandoff);
      const card = candidate.cards.find((entry) => entry.id === qualifiedCardId);
      if (!card?.visualEvidence) throw new Error("canonical qualified golden card fixture is missing");
      mutate(card.visualEvidence);
      return candidate;
    };

    // The published policy names packed-package qualification, so a card whose
    // packed-build receipt silently came from the source-mode SDK overstates it.
    await expect(
      validateSiteConsumerHandoff(
        tamper((visual) => {
          const packed = visual.semanticEvidence.find((entry) => entry.gate === "packed-build");
          if (!packed) throw new Error("canonical packed-build receipt fixture is missing");
          packed.sdkMode = "source";
        }),
      ),
    ).rejects.toThrow("packed-build visual evidence must come from the packed SDK mode");

    await expect(
      validateSiteConsumerHandoff(
        tamper((visual) => {
          const fixtureGate = visual.semanticEvidence.find((entry) => entry.gate === "fixture");
          if (!fixtureGate) throw new Error("canonical fixture receipt fixture is missing");
          fixtureGate.receiptPath = fixtureGate.receiptPath.replace(
            `/${visual.sampleId}/`,
            "/realtime-incident-dashboard/",
          );
        }),
      ),
    ).rejects.toThrow("fixture visual evidence receipt is orphaned from its sample");

    await expect(
      validateSiteConsumerHandoff(
        tamper((visual) => {
          visual.semanticEvidence[0].expiresAt = "2026-01-01T00:00:00.000Z";
        }),
      ),
    ).rejects.toThrow("visual evidence is stale or has an invalid freshness window");

    await expect(
      validateSiteConsumerHandoff(
        tamper((visual) => {
          visual.expiresAt = visual.observedAt;
        }),
      ),
    ).rejects.toThrow("visual evidence is stale or has an invalid freshness window");

    await expect(
      validateSiteConsumerHandoff(
        tamper((visual) => {
          visual.source.path = "examples/does-not-exist";
        }),
      ),
    ).rejects.toThrow("golden card source receipt is missing or unbound");

    await expect(
      validateSiteConsumerHandoff(
        tamper((visual) => {
          const [desktop] = visual.screenshots;
          desktop.sourcePath = desktop.sourcePath.replace(/[^/]+\.png$/, "screenshot-desktop-missing.png");
        }),
      ),
    ).rejects.toThrow("desktop screenshot is broken or missing");

    await expect(
      validateSiteConsumerHandoff(
        tamper((visual) => {
          const [desktop] = visual.screenshots;
          desktop.sha256 = sha256("a-replaced-screenshot");
          desktop.reproducibility.repeatSha256 = desktop.sha256;
        }),
      ),
    ).rejects.toThrow("desktop screenshot byte or digest binding is stale");

    await expect(
      validateSiteConsumerHandoff(
        tamper((visual) => {
          visual.semanticEvidence[0].reportSha256 = sha256("a-replaced-gate-report");
        }),
      ),
    ).rejects.toThrow("report byte or digest binding is stale");

    // Only overstated claims fail: a card that honestly reports no qualification
    // still publishes, and the qualified cards on the current tree stay admissible.
    const honestlyPending = checkoutHandoff.cards.filter((card) => card.qualification.state !== "qualified");
    expect(honestlyPending.length).toBeGreaterThan(0);
    expect(honestlyPending.every((card) => !card.visualEvidence && !card.evidenceBindingId)).toBe(true);
    await expect(validateSiteConsumerHandoff(checkoutHandoff)).resolves.toBeUndefined();
  });

  it("resolves frozen live producers from the content-addressed archive root", async () => {
    const legacyHandoff = (await readJson("samples/dist/honua-site-consumer-handoff.v1.json")) as SiteConsumerHandoff;
    const archive = (await readJson(
      "samples/contract/v2/consumer-fixtures/honua-site-consumer-legacy-receipts.v2.json",
    )) as LegacyVisualReceiptArchive;
    const archivedGenerator = archive.artifacts.files.find(
      (file) => file.path === "scripts/first-map-live-evidence.mjs",
    );
    if (!archivedGenerator) throw new Error("legacy archive needs the First Map live producer");
    expect(sha256(await readFile(archivedGenerator.path))).not.toBe(archivedGenerator.sha256);

    const originalRelax = process.env.HONUA_DERIVED_ARTIFACTS_RELAX;
    Reflect.deleteProperty(process.env, "HONUA_DERIVED_ARTIFACTS_RELAX");
    try {
      await expect(validateLegacyVisualReceiptArchive(archive, legacyHandoff)).resolves.toBeInstanceOf(Map);

      const tamperedArchivedGenerator = structuredClone(archive);
      const archivedGeneratorBlob = tamperedArchivedGenerator.artifacts.blobs.find(
        (blob) => blob.sha256 === archivedGenerator.sha256,
      );
      if (!archivedGeneratorBlob) throw new Error("legacy archive needs the First Map live producer blob");
      archivedGeneratorBlob.contentBase64 = gzipSync(Buffer.from("forged archived generator")).toString("base64");
      await expect(validateLegacyVisualReceiptArchive(tamperedArchivedGenerator, legacyHandoff)).rejects.toThrow(
        "legacy visual artifact blob is missing or stale",
      );

      const missingArchivedGenerator = structuredClone(archive);
      missingArchivedGenerator.artifacts.files = missingArchivedGenerator.artifacts.files.filter(
        (file) => file.path !== archivedGenerator.path,
      );
      await expect(validateLegacyVisualReceiptArchive(missingArchivedGenerator, legacyHandoff)).rejects.toThrow(
        /blob is broken or missing|inventory is incomplete, excessive, or cross-run/,
      );
    } finally {
      if (originalRelax === undefined) Reflect.deleteProperty(process.env, "HONUA_DERIVED_ARTIFACTS_RELAX");
      else process.env.HONUA_DERIVED_ARTIFACTS_RELAX = originalRelax;
    }
  });

  it("keeps frozen legacy receipts content-bound across current receipt rollover", { timeout: 240_000 }, async () => {
    const inputs = await canonicalInputs();
    const legacyHandoff = (await readJson("samples/dist/honua-site-consumer-handoff.v1.json")) as SiteConsumerHandoff;
    const archive = (await readJson(
      "samples/contract/v2/consumer-fixtures/honua-site-consumer-legacy-receipts.v2.json",
    )) as LegacyVisualReceiptArchive;

    await expect(validateLegacyVisualReceiptArchive(archive, legacyHandoff)).resolves.toBeInstanceOf(Map);
    await expect(
      validateSiteConsumerHandoff(legacyHandoff, { legacyReceiptArchive: archive }),
    ).resolves.toBeUndefined();
    await expect(generateLegacyVisualReceiptArchive(legacyHandoff)).resolves.toEqual(archive);
    expect(
      archive.artifacts.files.filter((file) => file.path.startsWith("samples/dist/")).map((file) => file.path),
    ).toEqual(
      Object.values(legacyHandoff.inputs)
        .map((reference) => reference.path)
        .sort(),
    );

    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(validateLegacyVisualReceiptArchive(archive, legacyHandoff)).resolves.toBeInstanceOf(Map);
    } finally {
      process.env.PATH = originalPath;
    }

    const tamperedBlob = structuredClone(archive);
    tamperedBlob.entries[0].contentBase64 = Buffer.from("forged legacy receipt").toString("base64");
    await expect(validateLegacyVisualReceiptArchive(tamperedBlob, legacyHandoff)).rejects.toThrow(
      "legacy receipt archive blob is missing or has stale bytes",
    );

    const missingBlob = structuredClone(archive);
    missingBlob.entries.shift();
    await expect(validateLegacyVisualReceiptArchive(missingBlob, legacyHandoff)).rejects.toThrow(
      "legacy visual receipt archive entry set is incomplete or excessive",
    );

    const missingRevision = structuredClone(archive);
    Reflect.deleteProperty(missingRevision.entries[0], "sourceRevision");
    await expect(validateLegacyVisualReceiptArchive(missingRevision, legacyHandoff)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const missingProducerBlob = structuredClone(archive);
    Reflect.deleteProperty(missingProducerBlob.producers[0], "contentBase64");
    await expect(validateLegacyVisualReceiptArchive(missingProducerBlob, legacyHandoff)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const tamperedProducerBlob = structuredClone(archive);
    tamperedProducerBlob.producers[0].contentBase64 = Buffer.from("forged producer").toString("base64");
    await expect(validateLegacyVisualReceiptArchive(tamperedProducerBlob, legacyHandoff)).rejects.toThrow(
      "legacy producer blob is missing or stale",
    );

    const tamperedArtifactBlob = structuredClone(archive);
    tamperedArtifactBlob.artifacts.blobs[0].contentBase64 = Buffer.from("forged artifact").toString("base64");
    await expect(validateLegacyVisualReceiptArchive(tamperedArtifactBlob, legacyHandoff)).rejects.toThrow(
      "legacy visual artifact blob is missing, malformed, or excessive",
    );

    const missingArtifact = structuredClone(archive);
    missingArtifact.artifacts.files.shift();
    await expect(validateLegacyVisualReceiptArchive(missingArtifact, legacyHandoff)).rejects.toThrow(
      /blob is broken or missing|inventory is incomplete, excessive, or cross-run/,
    );

    const missingHandoffInput = structuredClone(archive);
    missingHandoffInput.artifacts.files = missingHandoffInput.artifacts.files.filter(
      (file) => file.path !== legacyHandoff.inputs.capabilityMatrix.path,
    );
    await expect(validateLegacyVisualReceiptArchive(missingHandoffInput, legacyHandoff)).rejects.toThrow(
      /blob is broken or missing|inventory is incomplete, excessive, or cross-run/,
    );

    const excessiveArtifact = structuredClone(archive);
    const firstArtifact = excessiveArtifact.artifacts.files.find((file) => file.path.includes("/runs/"));
    if (!firstArtifact) throw new Error("legacy archive needs a run artifact");
    excessiveArtifact.artifacts.files.push({
      ...firstArtifact,
      path: firstArtifact.path.replace(/[^/]+$/u, "unrelated-fifth-artifact.json"),
    });
    excessiveArtifact.artifacts.files.sort((left, right) => left.path.localeCompare(right.path));
    await expect(validateLegacyVisualReceiptArchive(excessiveArtifact, legacyHandoff)).rejects.toThrow(
      "legacy visual artifact file inventory is incomplete, excessive, or cross-run",
    );

    const duplicateArtifactPath = structuredClone(archive);
    duplicateArtifactPath.artifacts.files.push(structuredClone(duplicateArtifactPath.artifacts.files[0]));
    await expect(validateLegacyVisualReceiptArchive(duplicateArtifactPath, legacyHandoff)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const missingArtifactBlob = structuredClone(archive);
    missingArtifactBlob.artifacts.blobs.shift();
    await expect(validateLegacyVisualReceiptArchive(missingArtifactBlob, legacyHandoff)).rejects.toThrow(
      /blob summary is stale or excessive|has no content-addressed blob/,
    );

    const decompressionBomb = structuredClone(archive);
    const bombBytes = gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1));
    decompressionBomb.artifacts.blobs[0].contentBase64 = bombBytes.toString("base64");
    decompressionBomb.artifacts.blobs[0].encodedBytes = bombBytes.byteLength;
    await expect(validateLegacyVisualReceiptArchive(decompressionBomb, legacyHandoff)).rejects.toThrow(
      "legacy visual artifact blob is missing, malformed, or excessive",
    );

    const escapedArtifactPath = structuredClone(archive);
    escapedArtifactPath.artifacts.files[0].path = "../../forged-artifact.json";
    await expect(validateLegacyVisualReceiptArchive(escapedArtifactPath, legacyHandoff)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const crossRunArtifact = structuredClone(archive);
    const firstRunFile = crossRunArtifact.artifacts.files.find((file) => file.path.includes("/runs/"));
    const firstRun = firstRunFile?.path.match(/^(.*\/runs\/[^/]+)\/artifacts\//u)?.[1];
    const otherRun = crossRunArtifact.artifacts.files
      .find((file) => file.path.includes("/runs/") && !file.path.startsWith(`${firstRun}/`))
      ?.path.match(/^(.*\/runs\/[^/]+)\/artifacts\//u)?.[1];
    if (!firstRunFile || !firstRun || !otherRun) throw new Error("legacy archive needs at least two run roots");
    firstRunFile.path = firstRunFile.path.replace(firstRun, otherRun);
    crossRunArtifact.artifacts.files.sort((left, right) => left.path.localeCompare(right.path));
    await expect(validateLegacyVisualReceiptArchive(crossRunArtifact, legacyHandoff)).rejects.toThrow(
      /blob is broken or missing|inventory is incomplete, excessive, or cross-run/,
    );

    const escapedPath = structuredClone(archive);
    escapedPath.entries[0].sourcePath = "../../forged-receipt.json";
    await expect(validateLegacyVisualReceiptArchive(escapedPath, legacyHandoff)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const escapedProducerPath = structuredClone(archive);
    escapedProducerPath.producers[0].sourcePath = "../../forged-producer.mjs";
    await expect(validateLegacyVisualReceiptArchive(escapedProducerPath, legacyHandoff)).rejects.toThrow(
      "JSON Schema validation failed",
    );

    const staleCurrentHandoff = structuredClone(await checkoutBoundHandoff(inputs.handoff));
    const currentVisual = staleCurrentHandoff.cards.find((card) => card.visualEvidence)?.visualEvidence;
    if (!currentVisual) throw new Error("current qualified visual fixture is missing");
    currentVisual.semanticEvidence[0].receiptSha256 = sha256("rolled-current-receipt");
    await expect(validateSiteConsumerHandoff(staleCurrentHandoff)).rejects.toThrow(
      "receipt byte or digest binding is stale",
    );
    await expect(validateSiteConsumerHandoff(staleCurrentHandoff, { legacyReceiptArchive: archive })).rejects.toThrow(
      "legacy receipt archives cannot validate the current site consumer handoff",
    );
    await expect(validateSiteConsumerHandoff(inputs.handoff, inputs)).resolves.toBeUndefined();
  });

  it(
    "validates the self-contained legacy archive from extracted, shallow, and packed inputs",
    { timeout: 180_000 },
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "honua-legacy-archive-contexts-"));
      const archivePath = "samples/contract/v2/consumer-fixtures/honua-site-consumer-legacy-receipts.v2.json";
      const handoffPath = "samples/dist/honua-site-consumer-handoff.v1.json";
      try {
        const extracted = path.join(root, "source-extract");
        await mkdir(path.join(extracted, path.dirname(archivePath)), { recursive: true });
        await mkdir(path.join(extracted, path.dirname(handoffPath)), { recursive: true });
        await cp(archivePath, path.join(extracted, archivePath));
        await cp(handoffPath, path.join(extracted, handoffPath));

        const shallow = path.join(root, "depth-one");
        execFileSync("git", ["clone", "--depth", "1", pathToFileURL(process.cwd()).href, shallow], {
          stdio: "ignore",
          windowsHide: true,
        });
        expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: shallow, encoding: "utf8" }).trim()).toBe(
          "1",
        );
        await cp(archivePath, path.join(shallow, archivePath));

        const packed = path.join(root, "packed");
        await mkdir(packed, { recursive: true });
        const npmCli = process.env.npm_execpath;
        if (!npmCli) throw new Error("npm_execpath is unavailable for the packed archive fixture");
        const packResult = JSON.parse(
          execFileSync(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", packed], {
            cwd: process.cwd(),
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
          }),
        );
        const tarball = path.join(packed, packResult[0].filename);
        execFileSync("tar", ["-xf", tarball, "-C", packed], { stdio: "ignore", windowsHide: true });

        const contexts = [extracted, shallow, path.join(packed, "package")];
        const originalPath = process.env.PATH;
        process.env.PATH = "";
        try {
          for (const context of contexts) {
            const archive = JSON.parse(await readFile(path.join(context, archivePath), "utf8"));
            const handoff = JSON.parse(await readFile(path.join(context, handoffPath), "utf8"));
            await expect(validateLegacyVisualReceiptArchive(archive, handoff)).resolves.toBeInstanceOf(Map);
          }
        } finally {
          process.env.PATH = originalPath;
        }
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it(
    "fails publication when a referenced contract schema is edited without a version bump",
    { timeout: 90_000 },
    async () => {
      const inputs = await canonicalInputs();
      // The schema-integrity assertions below publish the handoff, so they must
      // run against the same authority set the committed artifacts are bound to.
      // Under the derived-artifact decoupling a branch that adds a package
      // entrypoint regenerates a projection whose capabilityMatrix digest
      // legitimately differs from the committed one, and that artifact drift
      // would fire before the schema binding under test. The sibling tests in
      // this file use the same helper for the same reason; a strict run returns
      // the generated handoff unchanged, so trunk behaviour is identical.
      const publishable = await checkoutBoundHandoff(inputs.handoff);

      // Every published reference content-addresses its governing schema, including
      // the handoff's own schema, which only the v4 fixture can reference.
      const references = [...Object.values(publishable.inputs), inputs.fixture.input];
      expect(references).toHaveLength(4);
      for (const reference of references) {
        const bytes = await readFile(reference.schemaPath, "utf8");
        expect(reference.schemaBytes).toBe(Buffer.byteLength(bytes));
        expect(reference.schemaSha256).toBe(sha256(bytes));
      }

      const upstream = publishable.inputs.visualEvidence;
      const upstreamOriginal = await readFile(upstream.schemaPath, "utf8");
      try {
        // Whitespace only: same file, same $id, same format, same schemaVersion, and
        // identical semantics. This is exactly what the self-declared version pin
        // cannot see, so only the recomputed digest can reject it.
        await writeFile(upstream.schemaPath, `${upstreamOriginal.trimEnd()}\n\n`, "utf8");
        const reformatted = JSON.parse(await readFile(upstream.schemaPath, "utf8"));
        expect(reformatted).toEqual(JSON.parse(upstreamOriginal));
        expect(reformatted.$id).toBe(JSON.parse(upstreamOriginal).$id);
        expect(reformatted.properties.schemaVersion.const).toBe(upstream.schemaVersion);
        expect(reformatted.properties.format.const).toBe(upstream.format);
        await expect(validateSiteConsumerHandoff(publishable)).rejects.toThrow(
          "visualEvidence schema definition changed without a version bump",
        );

        // A weakened constraint under the same version is rejected for the same reason.
        const weakened = JSON.parse(upstreamOriginal);
        weakened.$defs.qualifiedJourney.properties.screenshots.minItems = 1;
        await writeFile(upstream.schemaPath, `${JSON.stringify(weakened, null, 2)}\n`, "utf8");
        await expect(validateSiteConsumerHandoff(publishable)).rejects.toThrow(
          "visualEvidence schema definition changed without a version bump",
        );
      } finally {
        await writeFile(upstream.schemaPath, upstreamOriginal, "utf8");
      }

      const handoffSchemaPath = inputs.fixture.input.schemaPath;
      const handoffSchemaOriginal = await readFile(handoffSchemaPath, "utf8");
      try {
        await writeFile(handoffSchemaPath, `${handoffSchemaOriginal.trimEnd()}\n\n`, "utf8");
        await expect(validateSiteConsumerFixtureV4(inputs.fixture, inputs.handoff)).rejects.toThrow(
          "fixture handoff schema definition changed without a version bump",
        );
      } finally {
        await writeFile(handoffSchemaPath, handoffSchemaOriginal, "utf8");
      }

      // A handoff published before this binding existed carries no digest. The first
      // test in this file covers the pending-under-relax side by validating the
      // committed artifact; a strict run must never accept it as verified.
      const pending = structuredClone(publishable);
      for (const reference of Object.values(pending.inputs)) {
        delete reference.schemaBytes;
        delete reference.schemaSha256;
      }
      const previousRelax = process.env.HONUA_DERIVED_ARTIFACTS_RELAX;
      process.env.HONUA_DERIVED_ARTIFACTS_RELAX = "";
      try {
        await expect(validateSiteConsumerHandoff(pending)).rejects.toThrow("schema integrity binding is missing");
      } finally {
        if (previousRelax === undefined) delete process.env.HONUA_DERIVED_ARTIFACTS_RELAX;
        else process.env.HONUA_DERIVED_ARTIFACTS_RELAX = previousRelax;
      }

      // Restored schemas publish cleanly again.
      await expect(validateSiteConsumerHandoff(publishable)).resolves.toBeUndefined();
      await expect(validateSiteConsumerHandoff(inputs.handoff, inputs)).resolves.toBeUndefined();
      await expect(validateSiteConsumerFixtureV4(inputs.fixture, inputs.handoff)).resolves.toBeUndefined();
    },
  );

  it("rejects symlinked source-link components instead of trusting lexical containment", async () => {
    const inputs = await canonicalInputs();
    const checkoutHandoff = await checkoutBoundHandoff(inputs.handoff);
    const directory = await mkdtemp(path.join("docs", ".site-consumer-link-"));
    const link = path.join(directory, "README.md");
    try {
      await symlink(path.resolve("README.md"), link, "file");
      const symlinked = structuredClone(checkoutHandoff);
      symlinked.cards[0].source.docsPath = link.replaceAll(path.sep, "/");
      await expect(validateSiteConsumerHandoff(symlinked)).rejects.toThrow("must not contain a symlink");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
