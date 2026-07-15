import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  filterGalleryCards,
  initializeGallery,
  normalizeGalleryFilters,
} from "../../scripts/lib/docs-gallery-client.mjs";
import {
  createGalleryModel,
  renderGalleryContent,
  verifyGalleryProjectionIntegrity,
  verifyGalleryVisualAssets,
} from "../../scripts/lib/docs-gallery.mjs";

const projectionBytes = fs.readFileSync("samples/dist/honua-site-samples.v2.json", "utf8");
const projection = JSON.parse(projectionBytes);
const visualEvidenceBytes = fs.readFileSync("samples/dist/honua-site-visual-evidence.v1.json", "utf8");
const visualEvidence = JSON.parse(visualEvidenceBytes);
const consumerFixture = JSON.parse(
  fs.readFileSync("samples/contract/v2/consumer-fixtures/honua-site-consumer.v3.json", "utf8"),
);
const repositorySourceResolver = (sample) => {
  const { docsPath } = sample.source;
  if (docsPath.startsWith("docs/") && docsPath.endsWith(".md")) {
    return {
      href: "guides/" + docsPath.slice("docs/".length).replace(/\.md$/u, ".html"),
      kind: "guide",
    };
  }
  return {
    href: "https://github.com/" + sample.source.repository + "/blob/trunk/" + docsPath,
    kind: "source",
  };
};

function stableBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function visualEvidenceForProjection(value) {
  const evidence = structuredClone(visualEvidence);
  evidence.projection = {
    path: "samples/dist/honua-site-samples.v2.json",
    format: value.format,
    schemaVersion: value.schemaVersion,
    sha256: createHash("sha256").update(stableBytes(value)).digest("hex"),
  };
  return evidence;
}

function fixtureForProjection(value, evidence = visualEvidenceForProjection(value)) {
  const fixture = structuredClone(consumerFixture);
  const bytes = stableBytes(value);
  const evidenceBytes = stableBytes(evidence);
  const sampleIds = value.samples.map((sample) => sample.id);
  const routeIds = value.routes.map((route) => route.id);
  fixture.accepts = {
    projectionFormat: value.format,
    projectionSchemaVersion: value.schemaVersion,
    catalogFormat: value.catalog.format,
    catalogSchemaVersion: value.catalog.schemaVersion,
    visualEvidenceFormat: evidence.format,
    visualEvidenceSchemaVersion: evidence.schemaVersion,
  };
  fixture.inputs.projection.sha256 = createHash("sha256").update(bytes).digest("hex");
  fixture.inputs.visualEvidence.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  fixture.assertions = {
    sampleCount: value.samples.length,
    rootExampleCount: value.samples.filter((sample) => sample.sourceKind === "root-example").length,
    docsExampleCount: value.samples.filter((sample) => sample.sourceKind === "docs-example").length,
    goldenJourneyCount: value.goldenJourneys.length,
    qualifiedGoldenCount: value.goldenJourneys.filter((journey) => journey.status === "qualified").length,
    visualEvidenceCount: evidence.qualifiedGoldenJourneys.length,
    routeCount: value.routes.length,
    sampleIdsUnique: new Set(sampleIds).size === sampleIds.length,
    routeIdsUnique: new Set(routeIds).size === routeIds.length,
    routesEndInHtml: value.routes.every((route) => route.route.endsWith(".html")),
    visualEvidenceMatchesQualifiedGolden:
      evidence.qualifiedGoldenJourneys.length ===
      value.goldenJourneys.filter((journey) => journey.status === "qualified").length,
    desktopMobileEvidenceRequired: true,
    semanticGateSetRequired: true,
    executableSourceOwner: value.contract.executableSourceOwner,
    presentationOwner: value.contract.presentationOwner,
    sourceImplementationDuplicated: false,
    credentialValuesForbidden: true,
  };
  return fixture;
}

async function verifiedGallery(
  value,
  {
    bytes = stableBytes(value),
    evidence = visualEvidenceForProjection(value),
    evidenceBytes = stableBytes(evidence),
    fixture = fixtureForProjection(value, evidence),
  } = {},
) {
  const integrity = await verifyGalleryProjectionIntegrity({
    projectionBytes: bytes,
    visualEvidenceBytes: evidenceBytes,
    consumerFixture: fixture,
  });
  return createGalleryModel(integrity);
}

function canonicalGallery() {
  return verifiedGallery(projection, {
    bytes: projectionBytes,
    evidence: visualEvidence,
    evidenceBytes: visualEvidenceBytes,
    fixture: consumerFixture,
  });
}

function renderGallery(gallery, resolveSourceLink = repositorySourceResolver) {
  return renderGalleryContent(gallery, { resolveSourceLink });
}

function sampleById(value, id) {
  return value.samples.find((sample) => sample.id === id);
}

function galleryCards(gallery) {
  return gallery.groups.flatMap((group) => group.cards);
}

function qualifiedVisualFixture() {
  const qualifiedProjection = structuredClone(projection);
  const journey = qualifiedProjection.goldenJourneys.find((candidate) => candidate.id === "first-map");
  journey.status = "qualified";
  const sample = sampleById(qualifiedProjection, journey.candidateSampleId);
  sample.track = "golden";
  sample.lifecycle = { state: "active", reason: "Synthetic qualified gallery fixture." };
  sample.validationProfile = "golden-browser";

  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const observedAt = "2099-01-01T00:00:00.000Z";
  const expiresAt = "2099-01-08T00:00:00.000Z";
  const imageBytes = {
    desktop: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("desktop-fixture")]),
    mobile: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("mobile-fixture")]),
  };
  const screenshots = [
    ["desktop", { width: 1280, height: 720 }],
    ["mobile", { width: 390, height: 844 }],
  ].map(([variant, viewport]) => {
    const bytes = imageBytes[variant];
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      variant,
      sourcePath: `samples/evidence/${sample.id}/runs/${runId}/artifacts/screenshot-${variant}.png`,
      publicationPath: `assets/gallery-evidence/${sample.id}/${variant}-${digest.slice(0, 16)}.png`,
      mediaType: "image/png",
      viewport,
      bytes: bytes.byteLength,
      sha256: digest,
    };
  });
  const gates = [
    "packed-build",
    "browser",
    "accessibility",
    "console",
    "responsive",
    "screenshot",
    "performance",
    "fixture",
    "live",
  ];
  const evidence = visualEvidenceForProjection(qualifiedProjection);
  evidence.qualifiedGoldenJourneys = [
    {
      journeyId: journey.id,
      sampleId: sample.id,
      sourceRevision: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      observedAt,
      expiresAt,
      screenshots,
      semanticEvidence: gates.map((gate) => ({
        gate,
        receiptPath: `samples/evidence/${sample.id}/receipts/${gate}.v1.json`,
        reportPath: `samples/evidence/${sample.id}/runs/${runId}/artifacts/${gate}.json`,
        observedAt,
        expiresAt,
        sha256: createHash("sha256").update(`receipt:${gate}`).digest("hex"),
      })),
      liveEvidence: {
        mode: sample.evidence.live.mode,
        status: "executed",
        observedAt,
        expiresAt,
        evidencePath: `samples/evidence/${sample.id}/runs/${runId}/artifacts/live-evidence.json`,
        provenance: { state: "live", observedAt, attribution: "Synthetic public fixture" },
        semantics: {
          operation: "discover-query-render",
          outcome: "rendered",
          itemCount: 3,
          assertions: ["map and linked result are visible"],
        },
        timing: { totalMs: 125 },
        degradation: { state: "none", reasons: [] },
      },
    },
  ];
  const assets = new Map(screenshots.map((screenshot) => [screenshot.sourcePath, imageBytes[screenshot.variant]]));
  return { projection: qualifiedProjection, evidence, assets };
}

function occurrenceCount(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function assertDeepFrozen(root) {
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    assert.equal(Object.isFrozen(value), true);
    pending.push(...Object.values(value));
  }
}

test("binds the canonical projection and visual evidence to its v3 consumer fixture", async () => {
  const gallery = await canonicalGallery();

  assert.deepEqual(gallery.integrity, {
    consumerFixtureFormat: consumerFixture.format,
    projectionSha256: consumerFixture.inputs.projection.sha256,
    visualEvidenceSha256: consumerFixture.inputs.visualEvidence.sha256,
    publicationQualificationGate: "npm run samples:verify",
    validation: {
      projectionSchemaPath: "samples/contract/v2/schemas/site-projection.schema.json",
      visualEvidenceSchemaPath: "samples/contract/v2/schemas/site-visual-evidence.schema.json",
      schemaValidated: true,
      sensitiveMetadataValidated: true,
    },
  });
  assert.throws(
    () => createGalleryModel({}),
    /gallery model requires a verified integrity token/,
  );
});

test("owns a deeply frozen projection snapshot across the verification and render boundary", async () => {
  const callerProjection = structuredClone(projection);
  const callerEvidence = visualEvidenceForProjection(callerProjection);
  const verifiedTitle = sampleById(callerProjection, "endpoint-to-map").title;
  const integrity = await verifyGalleryProjectionIntegrity({
    projectionBytes: stableBytes(callerProjection),
    visualEvidenceBytes: stableBytes(callerEvidence),
    consumerFixture: fixtureForProjection(callerProjection, callerEvidence),
  });

  assert.equal(Object.isFrozen(integrity), true);
  assert.notStrictEqual(integrity.projection, callerProjection);
  assertDeepFrozen(integrity.projection);
  assertDeepFrozen(integrity.visualEvidence);
  assert.throws(() => {
    sampleById(integrity.projection, "endpoint-to-map").title = "Forged frozen title";
  }, TypeError);

  sampleById(callerProjection, "endpoint-to-map").title = "Forged caller title";
  callerProjection.samples.push({
    ...structuredClone(sampleById(callerProjection, "endpoint-to-map")),
    id: "forged-after-verification",
  });

  const gallery = createGalleryModel(integrity);
  const html = renderGallery(gallery);
  assert.equal(gallery.cardCount, 32);
  assert.equal(
    galleryCards(gallery).find((card) => card.sample.id === "endpoint-to-map").sample.title,
    verifiedTitle,
  );
  assert.doesNotMatch(html, /Forged caller title|forged-after-verification/);
});

test("deep-freezes and brands every rendered model claim", async () => {
  const gallery = await canonicalGallery();
  const cards = galleryCards(gallery);
  const endpointCard = cards.find((card) => card.sample.id === "endpoint-to-map");
  const incidentCard = cards.find((card) => card.sample.id === "realtime-incident-dashboard");
  const replacementCard = cards.find((card) => card.sample.id === "web-components-basic");

  assertDeepFrozen(gallery);
  const mutations = [
    () => {
      gallery.integrity.projectionSha256 = "0".repeat(64);
    },
    () => {
      gallery.integrity.validation.sensitiveMetadataValidated = false;
    },
    () => {
      gallery.provenance.catalog.version = "forged";
    },
    () => {
      gallery.provenance.contract.executableSourceOwner = "foreign/fork";
    },
    () => {
      gallery.cardCount = 0;
    },
    () => {
      gallery.groups[0].title = "Forged group";
    },
    () => {
      endpointCard.sample.title = "Forged title";
    },
    () => {
      endpointCard.sample.summary = "Forged summary";
    },
    () => {
      endpointCard.sample.data.provenance = "Forged provenance";
    },
    () => {
      endpointCard.sample.evidence.fixture.status = "planned";
    },
    () => {
      endpointCard.sample.lifecycle.state = "retire";
    },
    () => {
      endpointCard.sample.source.docsPath = "../forged.md";
    },
    () => {
      endpointCard.sample.sdk.version = "forged";
    },
    () => {
      endpointCard.sample.capabilities[0] = "forged";
    },
    () => {
      endpointCard.sample.protocols[0] = "forged";
    },
    () => {
      endpointCard.sample.renderers[0] = "forged";
    },
    () => {
      endpointCard.sample.expectedDegradation = "Forged degradation";
    },
    () => {
      endpointCard.qualityProfile.description = "Forged profile";
    },
    () => {
      endpointCard.qualification.label = "Forged qualification";
    },
    () => {
      endpointCard.qualification.requiredGates[0] = "forged";
    },
    () => {
      endpointCard.searchText = "forged";
    },
    () => {
      incidentCard.journey.title = "Forged journey";
    },
    () => {
      replacementCard.replacement.url = "https://example.test/forged";
    },
    () => {
      gallery.filters.capabilities.push("forged");
    },
    () => {
      gallery.groups.push({ track: "golden", title: "Forged", cards: [] });
    },
  ];
  for (const mutate of mutations) assert.throws(mutate, TypeError);

  const forgedModel = structuredClone(gallery);
  forgedModel.groups[0].cards[0].sample.title = "Forged HTML with original SHA";
  assert.equal(forgedModel.integrity.projectionSha256, gallery.integrity.projectionSha256);
  assert.throws(
    () => renderGallery(forgedModel),
    /gallery rendering requires a verified gallery model/,
  );
});

test("rejects consumer digest, format, assertion, and stable-byte tampering", async () => {
  const digestMismatch = structuredClone(consumerFixture);
  digestMismatch.inputs.projection.sha256 = "0".repeat(64);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        visualEvidenceBytes,
        consumerFixture: digestMismatch,
      }),
    /consumer projection digest mismatch/,
  );

  const formatMismatch = structuredClone(consumerFixture);
  formatMismatch.accepts.projectionFormat = "honua.site.sdk-sample-projection.v1";
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        visualEvidenceBytes,
        consumerFixture: formatMismatch,
      }),
    /accepted formats do not match/,
  );

  const fixtureFormatMismatch = structuredClone(consumerFixture);
  fixtureFormatMismatch.format = "honua.site.sdk-sample-consumer-fixture.v1";
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        visualEvidenceBytes,
        consumerFixture: fixtureFormatMismatch,
      }),
    /consumer fixture format is not v3/,
  );

  const assertionMismatch = structuredClone(consumerFixture);
  assertionMismatch.assertions.sampleCount += 1;
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        visualEvidenceBytes,
        consumerFixture: assertionMismatch,
      }),
    /consumer assertion sampleCount does not match/,
  );

  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: JSON.stringify(projection),
        visualEvidenceBytes,
        consumerFixture,
      }),
    /projection bytes are not canonical stable JSON/,
  );

  const visualDigestMismatch = structuredClone(consumerFixture);
  visualDigestMismatch.inputs.visualEvidence.sha256 = "0".repeat(64);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        visualEvidenceBytes,
        consumerFixture: visualDigestMismatch,
      }),
    /consumer visual evidence digest mismatch/,
  );

  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        visualEvidenceBytes: JSON.stringify(visualEvidence),
        consumerFixture,
      }),
    /visual evidence bytes are not canonical stable JSON/,
  );
});

test("cannot mint a token for credential-bearing or schema-invalid canonical bytes", async () => {
  const credentialBearing = structuredClone(projection);
  sampleById(credentialBearing, "endpoint-to-map").data.provenance =
    "https://data.example.test/features?access_token=actual-secret-value";
  const credentialEvidence = visualEvidenceForProjection(credentialBearing);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(credentialBearing),
        visualEvidenceBytes: stableBytes(credentialEvidence),
        consumerFixture: fixtureForProjection(credentialBearing, credentialEvidence),
      }),
    /forbidden credential query parameter access_token/,
  );

  const schemaInvalid = structuredClone(projection);
  delete sampleById(schemaInvalid, "endpoint-to-map").title;
  const invalidEvidence = visualEvidenceForProjection(schemaInvalid);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(schemaInvalid),
        visualEvidenceBytes: stableBytes(invalidEvidence),
        consumerFixture: fixtureForProjection(schemaInvalid, invalidEvidence),
      }),
    /JSON Schema validation failed.*title/,
  );

  const foreignRepository = structuredClone(projection);
  sampleById(foreignRepository, "endpoint-to-map").source.repository = "honua-io/forked-sdk";
  const foreignEvidence = visualEvidenceForProjection(foreignRepository);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(foreignRepository),
        visualEvidenceBytes: stableBytes(foreignEvidence),
        consumerFixture: fixtureForProjection(foreignRepository, foreignEvidence),
      }),
    /JSON Schema validation failed.*repository/,
  );
});

test("fails closed on missing quality profiles and forged golden qualification relations", async () => {
  const missingProfile = structuredClone(projection);
  missingProfile.qualityProfiles = missingProfile.qualityProfiles.filter((profile) => profile.id !== "browser-recipe");
  await assert.rejects(
    () => verifiedGallery(missingProfile),
    /references missing quality profile browser-recipe/,
  );

  const forgedQualification = structuredClone(projection);
  forgedQualification.goldenJourneys[0].status = "qualified";
  await assert.rejects(
    () => verifiedGallery(forgedQualification),
    /visual evidence does not exactly cover qualified golden journeys/,
  );
});

test("rejects a schema-valid empty public portfolio with the explicit zero-card error", async () => {
  const emptyProjection = structuredClone(projection);
  emptyProjection.samples = [];

  await assert.rejects(() => verifiedGallery(emptyProjection), {
    name: "Error",
    message: "Gallery projection produced zero public cards; refusing to publish an empty gallery.",
  });
});

test("projects one canonical catalog-v2 sample into an honest public gallery card", async () => {
  const gallery = await canonicalGallery();
  const card = galleryCards(gallery).find((candidate) => candidate.sample.id === "endpoint-to-map");
  assert.deepEqual(card.sample, sampleById(projection, "endpoint-to-map"));
  assert.equal(card.journey, null);
  assert.equal(card.replacement, null);
  assert.deepEqual(gallery.provenance, {
    projection: {
      format: projection.format,
      schemaVersion: projection.schemaVersion,
    },
    visualEvidence: {
      format: visualEvidence.format,
      schemaVersion: visualEvidence.schemaVersion,
    },
    catalog: projection.catalog,
    contract: projection.contract,
  });
  assert.ok(gallery.filters.capabilities.includes("direct-connect"));
  assert.ok(gallery.filters.protocols.includes("geoservices"));
});

test("projects the canonical public portfolio without hiding lifecycle or replacement truth", async () => {
  const gallery = await canonicalGallery();
  const counts = Object.fromEntries(gallery.groups.map((group) => [group.track, group.cards.length]));
  const cards = galleryCards(gallery);
  const byId = new Map(cards.map((card) => [card.sample.id, card]));

  assert.equal(gallery.cardCount, 32);
  assert.deepEqual(counts, { recipe: 15, lab: 17 });
  assert.ok(!byId.has("arcgis-source-app"));
  assert.ok(!byId.has("automatic-source-workflow"));
  assert.deepEqual(byId.get("runtime-parity-showcase").replacement, {
    kind: "journey",
    id: "service-explorer",
    title: "Universal Service Explorer",
    status: "planned",
    candidateSampleId: "service-explorer",
    publicSampleId: "service-explorer",
  });
  assert.deepEqual(byId.get("web-components-basic").replacement, {
    kind: "external",
    id: "honua-app-platform",
    title: "@honua/app-platform",
    url: "https://www.npmjs.com/package/@honua/app-platform",
  });
  assert.equal(byId.get("web-components-basic").sample.lifecycle.state, "retire");
  assert.equal(byId.get("realtime-incident-dashboard").journey.title, "Realtime Incident Operations");
  assert.ok(cards.every((card) => card.qualification.label.includes("not receipt-qualified")));
  assert.ok(cards.every((card) => card.qualification.state !== "receipt-qualified-golden"));
  assert.deepEqual(byId.get("endpoint-to-map").qualification.requiredGates, [
    "packedBuild",
    "browser",
    "accessibility",
    "console",
    "responsive",
  ]);
});

test("publishes content-addressed desktop/mobile and semantic evidence only for qualified golden cards", async () => {
  const fixture = qualifiedVisualFixture();
  const gallery = await verifiedGallery(fixture.projection, { evidence: fixture.evidence });
  const card = galleryCards(gallery).find((candidate) => candidate.sample.id === "maplibre-quickstart");
  assert.equal(card.qualification.state, "receipt-qualified-golden");
  assert.deepEqual(
    card.visualEvidence.screenshots.map(({ variant, viewport }) => ({ variant, viewport })),
    [
      { variant: "desktop", viewport: { width: 1280, height: 720 } },
      { variant: "mobile", viewport: { width: 390, height: 844 } },
    ],
  );
  assert.deepEqual(
    card.visualEvidence.semanticEvidence.map(({ gate }) => gate),
    fixture.evidence.policy.requiredSemanticGates,
  );
  const html = renderGallery(gallery);
  for (const screenshot of card.visualEvidence.screenshots) {
    assert.ok(html.includes(screenshot.publicationPath));
  }
  assert.match(html, /Verified Honua × MapLibre flagship workflow at the desktop evidence viewport/);
  assert.match(html, /Verified Honua × MapLibre flagship workflow at the mobile evidence viewport/);
  assert.match(html, /<dt>Semantic evidence<\/dt>/);
  assert.match(html, /discover-query-render/);

  const assets = await verifyGalleryVisualAssets(gallery, (sourcePath) => fixture.assets.get(sourcePath));
  assert.deepEqual(
    assets.map(({ publicationPath }) => publicationPath),
    card.visualEvidence.screenshots.map(({ publicationPath }) => publicationPath),
  );
  await assert.rejects(
    () => verifyGalleryVisualAssets(gallery, () => Buffer.from("tampered")),
    /screenshot bytes do not match visual evidence/,
  );
});

test("fails publication when qualified golden visual evidence is missing or incomplete", async () => {
  const fixture = qualifiedVisualFixture();
  const missing = structuredClone(fixture.evidence);
  missing.qualifiedGoldenJourneys = [];
  await assert.rejects(
    () => verifiedGallery(fixture.projection, { evidence: missing }),
    /does not exactly cover qualified golden journeys/,
  );

  const incomplete = structuredClone(fixture.evidence);
  incomplete.qualifiedGoldenJourneys[0].screenshots.pop();
  await assert.rejects(
    () => verifiedGallery(fixture.projection, { evidence: incomplete }),
    /JSON Schema validation failed/,
  );

  const stale = structuredClone(fixture.evidence);
  stale.qualifiedGoldenJourneys[0].expiresAt = "2020-01-01T00:00:00.000Z";
  await assert.rejects(
    () => verifiedGallery(fixture.projection, { evidence: stale }),
    /visual evidence is stale/,
  );
});

test("sorts public capability and protocol facets deterministically", async () => {
  const gallery = await canonicalGallery();
  const capabilities = galleryCards(gallery).flatMap((card) => card.sample.capabilities);
  const protocols = galleryCards(gallery).flatMap((card) => card.sample.protocols);

  assert.deepEqual(gallery.filters.capabilities, [...new Set(capabilities)].sort());
  assert.deepEqual(gallery.filters.protocols, [...new Set(protocols)].sort());
  assert.ok(!gallery.filters.capabilities.includes("interaction-state"));
});

test("renders accessible controls, compact essentials, and disclosed catalog truth", async () => {
  const incidentSample = sampleById(projection, "realtime-incident-dashboard");
  const gallery = await canonicalGallery();
  const html = renderGallery(gallery);

  for (const label of [
    "SDK",
    "Data",
    "Evidence state",
    "Qualification",
    "Replacement",
    "Capabilities",
    "Protocols",
    "Lifecycle",
    "Data provenance",
    "Attribution",
    "Freshness",
    "Evidence details",
    "Expected degradation",
    "Renderers",
    "Golden journey",
    "Quality profile",
    "Required gates",
    "Catalog",
    "Projection",
    "Visual evidence",
    "Contract",
  ]) {
    assert.match(html, new RegExp(`<dt>${label}</dt>`));
  }
  assert.match(html, /<form[^>]+role="search"[^>]+aria-label="Filter demo gallery"/);
  assert.match(html, /<label for="gallery-search">Task or sample<\/label>/);
  assert.match(html, /<label for="gallery-capability">Capability<\/label>/);
  assert.match(html, /<label for="gallery-protocol">Protocol<\/label>/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /data-gallery-empty hidden/);
  assert.match(html, /@honua\/sdk-js/);
  assert.ok(html.includes(gallery.provenance.catalog.version));
  assert.match(html, /honua\.sdk\.sample-catalog\.v2/);
  assert.match(html, /honua\.site\.sdk-sample-projection\.v2/);
  assert.match(html, /honua-io\/honua-sdk-js#540/);
  assert.match(html, /Fixture: <strong>executed<\/strong>/);
  assert.match(html, /unavailable<\/code> · <strong>skipped<\/strong>/);
  assert.match(html, /evidence expires <time/);
  assert.ok(html.includes(incidentSample.evidence.live.expiresAt));
  assert.match(html, /Realtime Incident Operations/);
  assert.match(html, /Planned golden candidate · not receipt-qualified/);
  assert.match(html, /Publication runs <code>npm run samples:verify<\/code>/);
  assert.match(html, /validates the complete receipt/);
  assert.match(html, /profile gates alone are only requirements/);
  assert.match(html, /safe-editing/);
  assert.match(html, /maplibre/);
  assert.match(html, /<summary>Evidence, provenance, lifecycle, and degradation<\/summary>/);
  assert.doesNotMatch(html, /<script|\son[a-z]+=/i);
});

test("renders global provenance once and puts every card CTA before its disclosure", async () => {
  const html = renderGallery(await canonicalGallery());
  const cards = [...html.matchAll(/<article class="demo-card[\s\S]*?<\/article>/g)].map((match) => match[0]);

  assert.equal(occurrenceCount(html, /data-gallery-provenance/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Catalog<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Projection<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Visual evidence<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Contract<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Consumer fixture<\/dt>/g), 1);
  assert.equal(occurrenceCount(html, /<dt>Projection SHA-256<\/dt>/g), 1);
  assert.ok(html.includes(consumerFixture.format));
  assert.ok(html.includes(consumerFixture.inputs.projection.sha256));
  assert.ok(html.includes(consumerFixture.inputs.visualEvidence.sha256));
  assert.equal(cards.length, 32);
  for (const card of cards) {
    const ctaIndex = card.indexOf('<a class="demo-link"');
    const detailsIndex = card.indexOf('<details class="demo-card-details">');
    assert.doesNotMatch(card, /<dt>(?:Catalog|Projection|Contract)<\/dt>/);
    assert.ok(ctaIndex >= 0 && detailsIndex > ctaIndex);
    assert.match(card, /<summary>Evidence, provenance, lifecycle, and degradation<\/summary>/);
  }
});

test("requires an ownership-bound source resolver and rejects unsafe or foreign URLs", async () => {
  const gallery = await canonicalGallery();
  assert.throws(
    () => renderGalleryContent(gallery),
    /requires an explicit source-link resolver/,
  );

  const unsafeUrls = [
    "javascript:alert(1)",
    "http://example.test/source",
    "//example.test/source",
    "https://user:password@example.test/source",
    "https://example.test/source?token=secret",
    "https://example.test/source#access-token",
    " https://example.test/source",
    "guides/\u0000bad.html",
    "guides\\bad.html",
    "../secrets.txt",
    "guides/../secrets.txt",
    "guides/%2e%2e/secrets.txt",
    "guides/%252e%252e/secrets.txt",
    "guides/%255csecrets.txt",
    "/absolute/source.html",
    "https://cross-origin.example/source",
    "https://github.com/honua-io/forked-sdk/blob/trunk/examples/ai-spatial-app-builder/README.md",
    "https://github.com/honua-io/honua-sdk-js/blob/trunk/examples/wrong/README.md",
    "https://github.com/honua-io/honua-sdk-js/blob/trunk/examples/./ai-spatial-app-builder/README.md",
    "https://github.com/honua-io/honua-sdk-js/blob/trunk/examples/%2e%2e/secret.md",
  ];
  for (const href of unsafeUrls) {
    assert.throws(
      () => renderGallery(gallery, () => ({ href, kind: "source" })),
      /source resolver does not match canonical source ownership/,
      href,
    );
  }
  assert.throws(
    () => renderGallery(gallery, () => ({ href: "guides/quickstart.html", kind: "unknown" })),
    /source resolver kind is unsupported/,
  );
  assert.throws(
    () => renderGallery(gallery, () => ({ href: "guides/quickstart.html", kind: "guide", extra: true })),
    /source resolver result keys must match/,
  );
  assert.throws(
    () => renderGallery(gallery, () => ({ href: "guides/quickstart.html", kind: "guide" })),
    /classified a non-guide docsPath as a guide/,
  );

  const html = renderGallery(gallery);
  assert.match(
    html,
    /href="https:\/\/github\.com\/honua-io\/honua-sdk-js\/blob\/trunk\/examples\/ai-spatial-app-builder\/README\.md">View source/,
  );
  assert.match(
    html,
    /href="guides\/examples\/cesium-route-playback\/README\.html">Read the walkthrough/,
  );
});

test("rejects unsafe public source paths before minting a model or invoking a resolver", async () => {
  const unsafeSources = [
    { field: "docsPath", value: "../secret.md", expected: /source docsPath is unsafe/ },
    { field: "docsPath", value: "examples/%2e%2e/secret.md", expected: /source docsPath is unsafe/ },
    { field: "docsPath", value: "examples/%255csecret.md", expected: /source docsPath is unsafe/ },
    { field: "path", value: "../examples/ai-spatial-app-builder", expected: /source path is unsafe/ },
  ];
  for (const { field, value, expected } of unsafeSources) {
    const unsafeProjection = structuredClone(projection);
    sampleById(unsafeProjection, "ai-spatial-app-builder").source[field] = value;
    let resolverCallCount = 0;
    await assert.rejects(
      async () => {
        const gallery = await verifiedGallery(unsafeProjection);
        renderGallery(gallery, (sample) => {
          resolverCallCount += 1;
          return repositorySourceResolver(sample);
        });
      },
      expected,
    );
    assert.equal(resolverCallCount, 0);
  }
});

test("escapes projected content and links only credential-free HTTPS replacements", async () => {
  for (const url of ["javascript:alert(1)", "http://example.test/replacement"]) {
    const unsafe = structuredClone(projection);
    const sample = sampleById(unsafe, "web-components-basic");
    sample.title = '<img src=x onerror="alert(1)">';
    sample.data.provenance = '</dd><script>alert("x")</script>';
    unsafe.externalReplacements[0].url = url;
    const html = renderGallery(await verifiedGallery(unsafe));

    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;\/dd&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<img|<script|href="(?:javascript:|http:|https:\/\/user:)/i);
    assert.match(html, /external: @honua\/app-platform \(honua-app-platform\)/);
  }

  const safeHtml = renderGallery(await canonicalGallery());
  assert.match(
    safeHtml,
    /href="https:\/\/www\.npmjs\.com\/package\/@honua\/app-platform" rel="noopener noreferrer"/,
  );
});

test("filters task text with AND semantics and combines exact capability and protocol facets", async () => {
  const records = galleryCards(await canonicalGallery()).map((card) => ({
    id: card.sample.id,
    searchText: card.searchText,
    capabilities: card.sample.capabilities,
    protocols: card.sample.protocols,
  }));

  assert.deepEqual(normalizeGalleryFilters({ text: "  REALTIME\t operations  " }), {
    text: "realtime operations",
    capability: "",
    protocol: "",
  });
  assert.deepEqual(
    filterGalleryCards(records, { text: "realtime guarded" }).map(({ id }) => id),
    ["realtime-incident-dashboard"],
  );
  assert.deepEqual(
    filterGalleryCards(records, { capability: "safe-editing", protocol: "sse" }).map(({ id }) => id),
    ["realtime-incident-dashboard"],
  );
  assert.deepEqual(filterGalleryCards(records, { capability: "safe-editing", protocol: "stac" }), []);
});

test("initializes accessible DOM filtering, implicit Enter submit, empty, and clear behavior", async () => {
  const dom = new JSDOM(renderGallery(await canonicalGallery()), {
    url: "https://docs.example.test/gallery.html",
  });
  const { document, Event } = dom.window;
  initializeGallery(document);

  const form = document.querySelector("[data-gallery-controls]");
  const search = form.querySelector("[data-gallery-search]");
  const capability = form.querySelector("[data-gallery-capability]");
  const protocol = form.querySelector("[data-gallery-protocol]");
  const clear = form.querySelector("[data-gallery-clear]");
  const count = document.querySelector("[data-gallery-result-count]");
  const empty = document.querySelector("[data-gallery-empty]");
  const groups = [...document.querySelectorAll("[data-gallery-group]")];

  assert.equal(count.textContent, "32");
  assert.equal(clear.disabled, true);
  assert.equal(empty.hidden, true);

  search.value = "realtime guarded";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(count.textContent, "1");
  assert.deepEqual(
    [...document.querySelectorAll("[data-gallery-card]:not([hidden])")].map((card) => card.dataset.sampleId),
    ["realtime-incident-dashboard"],
  );
  assert.equal(document.querySelector("#gallery-recipe").closest("[data-gallery-group]").hidden, true);
  assert.equal(document.querySelector("#gallery-lab").closest("[data-gallery-group]").hidden, false);

  search.value = "";
  capability.value = "safe-editing";
  protocol.value = "sse";
  capability.dispatchEvent(new Event("change", { bubbles: true }));
  protocol.dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(count.textContent, "1");

  protocol.value = "stac";
  protocol.dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(count.textContent, "0");
  assert.equal(empty.hidden, false);
  assert.ok(groups.every((group) => group.hidden));

  capability.value = "";
  protocol.value = "";
  search.value = "endpoint-to-map four statements";
  let submitWasPrevented = false;
  form.addEventListener("submit", (event) => {
    submitWasPrevented = event.defaultPrevented;
  });
  // requestSubmit follows the form submit path used by implicit Enter on the
  // search input without depending on JSDOM's incomplete keyboard defaults.
  form.requestSubmit();
  assert.equal(submitWasPrevented, true);
  assert.equal(count.textContent, "1");

  clear.click();
  assert.equal(search.value, "");
  assert.equal(capability.value, "");
  assert.equal(protocol.value, "");
  assert.equal(count.textContent, "32");
  assert.equal(empty.hidden, true);
  assert.ok(groups.every((group) => !group.hidden));
  assert.equal(document.activeElement, search);
  dom.window.close();
});
