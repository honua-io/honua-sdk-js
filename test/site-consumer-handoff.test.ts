import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  collectQualificationEvidence,
  filterSiteConsumerCards,
  generateCapabilitySampleMatrix,
  generateGoldenJourneyVisualEvidence,
  generateSiteConsumerFixtureV3,
  generateSiteConsumerHandoff,
  generateSiteProjection,
  validateSiteConsumerFixtureV3,
  validateSiteConsumerHandoff,
} from "../scripts/sample-contract.mjs";
import type {
  CapabilitySampleMatrix,
  GoldenJourneyVisualEvidence,
  SiteConsumerHandoff,
} from "../scripts/sample-contract.mjs";

// canonicalInputs() reads the real samples/evidence tree (receipts,
// screenshots, live evidence) for the now genuinely qualified First Map
// journey. That real I/O regularly exceeds vitest's 5s default under
// full-suite contention; it was effectively instant against the previously
// always-empty evidence set, so this was never exercised before.
vi.setConfig({ testTimeout: 20_000 });

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const derivedArtifactsRelaxed = /^(1|true|yes|on)$/i.test(process.env.HONUA_DERIVED_ARTIFACTS_RELAX ?? "");

async function checkoutBoundHandoff(current: SiteConsumerHandoff): Promise<SiteConsumerHandoff> {
  // PR CI validates the newly generated authority set and the committed,
  // internally bound projection independently until trunk regenerates them.
  if (!derivedArtifactsRelaxed) return current;
  return readJson("samples/dist/honua-site-consumer-handoff.v1.json");
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
  const fixture = generateSiteConsumerFixtureV3(handoff);
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
  it("deterministically joins all three validated authorities without inventing qualification", async () => {
    const inputs = await canonicalInputs();
    const committedHandoff = await checkoutBoundHandoff(inputs.handoff);

    await expect(validateSiteConsumerHandoff(inputs.handoff, inputs)).resolves.toBeUndefined();
    await expect(validateSiteConsumerHandoff(committedHandoff)).resolves.toBeUndefined();
    await expect(validateSiteConsumerFixtureV3(inputs.fixture, inputs.handoff)).resolves.toBeUndefined();
    expect(generateSiteConsumerHandoff(inputs.projection, inputs.matrix, inputs.visualEvidence)).toEqual(
      inputs.handoff,
    );
    expect(inputs.handoff).toMatchObject({
      format: "honua.site.sdk-sample-consumer-handoff.v1",
      schemaVersion: 1,
      ownership: {
        executableSourceOwner: "honua-io/honua-sdk-js",
        presentationOwner: "honua-io/honua-site",
        sourceImplementationDuplicated: false,
      },
      counts: {
        cards: 30,
        qualifiedJourneys: 1,
        canonicalRoutes: 30,
        legacyRoutes: 20,
        gaps: inputs.matrix.gaps.length,
      },
    });
    // maplibre-quickstart is the one real, evidence-backed golden journey;
    // check stable identity fields rather than the full volatile object
    // (timestamps, run IDs, and screenshot hashes legitimately change every
    // capture).
    expect(inputs.handoff.qualifiedJourneys).toHaveLength(1);
    expect(inputs.handoff.qualifiedJourneys[0]).toMatchObject({
      journeyId: "first-map",
      sampleId: "maplibre-quickstart",
      canonicalPath: "samples/maplibre-quickstart.html",
    });
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
      inputs.handoff.cards.every((card) => card.track === "golden" || card.track === "recipe" || card.track === "lab"),
    ).toBe(true);
    // maplibre-quickstart is the one real, evidence-backed qualified card;
    // every OTHER card must still carry no invented evidence.
    expect(
      inputs.handoff.cards
        .filter((card) => card.id !== "maplibre-quickstart")
        .every((card) => card.evidenceBindingId === null && card.visualEvidence === null),
    ).toBe(true);
    const quickstartCard = inputs.handoff.cards.find((card) => card.id === "maplibre-quickstart");
    expect(quickstartCard?.evidenceBindingId).not.toBeNull();
    expect(quickstartCard?.visualEvidence).not.toBeNull();
    expect(inputs.handoff.counts.qualifiedMatrixCells).toEqual({
      goldenJourneys: 1,
      protocolOperations: 1,
      supportClaims: 0,
      packageEntrypoints: 1,
    });
  });

  it("content-binds the committed handoff, upstream artifacts, schemas, and consumer fixture", async () => {
    const inputs = await canonicalInputs();
    const handoffBytes = await readFile("samples/dist/honua-site-consumer-handoff.v1.json", "utf8");
    const committedHandoff = JSON.parse(handoffBytes) as SiteConsumerHandoff;
    const fixtureBytes = await readFile("samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json", "utf8");
    const committedFixture = JSON.parse(fixtureBytes);

    expect(inputs.packageJson.files).toEqual(
      expect.arrayContaining([
        "samples/dist",
        "samples/contract/v2/schemas",
        "samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json",
      ]),
    );
    expect(handoffBytes).toBe(`${JSON.stringify(committedHandoff, null, 2)}\n`);
    if (!derivedArtifactsRelaxed) {
      expect(committedHandoff).toEqual(inputs.handoff);
      expect(committedFixture).toEqual(inputs.fixture);
    }
    expect(committedFixture.input).toMatchObject({
      path: "samples/dist/honua-site-consumer-handoff.v1.json",
      schemaPath: "samples/contract/v2/schemas/site-consumer-handoff.schema.json",
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
    await expect(validateSiteConsumerFixtureV3(fixtureDrift, inputs.handoff)).rejects.toThrow(
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
