import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { deflateSync } from "node:zlib";
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
const capabilityMatrixBytes = fs.readFileSync("samples/dist/capability-sample-matrix.v1.json", "utf8");
const capabilityMatrix = JSON.parse(capabilityMatrixBytes);
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

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function solidGrayscalePng(width, height, shade) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    scanlines.fill(shade, row * (width + 1) + 1, (row + 1) * (width + 1));
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function truncatedGrayscalePng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc(1))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
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

function matrixForEvidence(evidence, value = projection) {
  const matrix = structuredClone(capabilityMatrix);
  matrix.inputs.visualEvidence.sha256 = createHash("sha256").update(stableBytes(evidence)).digest("hex");
  const evidenceBySample = new Map(evidence.qualifiedGoldenJourneys.map((entry) => [entry.sampleId, entry]));
  for (const sample of matrix.samples) {
    const entry = evidenceBySample.get(sample.id);
    sample.qualification = entry
      ? {
          state: "qualified",
          evidence: {
            sourceRevision: entry.sourceRevision,
            observedAt: entry.observedAt,
            expiresAt: entry.expiresAt,
            semanticGates: entry.semanticEvidence.map((item) => item.gate),
            screenshotVariants: entry.screenshots.map((item) => item.variant),
          },
        }
      : { state: sample.journeyId ? "planned" : "partial" };
  }
  for (const journey of matrix.goldenJourneys) {
    const projected = value.goldenJourneys.find((candidate) => candidate.id === journey.id);
    journey.catalogStatus = projected.status;
    journey.coverageState = evidenceBySample.has(journey.candidateSampleId) ? "qualified" : "planned";
  }
  matrix.gaps = [
    ...matrix.gaps.filter((gap) => gap.targetType !== "golden-journey"),
    ...matrix.goldenJourneys
      .filter((journey) => journey.coverageState !== "qualified")
      .map((journey) => ({
        targetType: "golden-journey",
        targetId: journey.id,
        supportStatus: "supported",
        coverageState: "planned",
        candidateSampleIds: [journey.candidateSampleId],
        reason: "The canonical journey remains planned until its complete receipt set is current.",
      })),
  ];
  return matrix;
}

function fixtureForProjection(
  value,
  evidence = visualEvidenceForProjection(value),
  matrix = matrixForEvidence(evidence, value),
) {
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
    capabilityMatrixFormat: matrix.format,
    capabilityMatrixSchemaVersion: matrix.schemaVersion,
  };
  fixture.inputs.projection.sha256 = createHash("sha256").update(bytes).digest("hex");
  fixture.inputs.visualEvidence.sha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  fixture.inputs.capabilityMatrix.sha256 = createHash("sha256").update(stableBytes(matrix)).digest("hex");
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
    capabilityMatrixGapCount: matrix.gaps.length,
    capabilityMatrixQualifiedCellCount:
      matrix.protocolOperations.filter((cell) => cell.coverage.state === "qualified").length +
      matrix.supportClaims.filter((cell) => cell.coverage.state === "qualified").length +
      matrix.entrypoints.filter((cell) => cell.coverage.state === "qualified").length,
    unsupportedClaimsVisible: matrix.gaps.length > 0,
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
    matrix = matrixForEvidence(evidence, value),
    matrixBytes = stableBytes(matrix),
    fixture = fixtureForProjection(value, evidence, matrix),
  } = {},
) {
  const integrity = await verifyGalleryProjectionIntegrity({
    projectionBytes: bytes,
    visualEvidenceBytes: evidenceBytes,
    capabilityMatrixBytes: matrixBytes,
    consumerFixture: fixture,
  });
  return createGalleryModel(integrity);
}

function canonicalGallery() {
  return verifiedGallery(projection, {
    bytes: projectionBytes,
    evidence: visualEvidence,
    evidenceBytes: visualEvidenceBytes,
    matrix: capabilityMatrix,
    matrixBytes: capabilityMatrixBytes,
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
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.parse(observedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const screenshots = [
    ["desktop", { width: 1280, height: 720 }],
    ["mobile", { width: 390, height: 844 }],
  ].map(([variant, viewport]) => {
    const bytes = solidGrayscalePng(viewport.width, viewport.height, variant === "desktop" ? 0x55 : 0xaa);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      variant,
      sourcePath: `samples/evidence/${sample.id}/runs/${runId}/artifacts/screenshot-${variant}.png`,
      publicationPath: `assets/gallery-evidence/${sample.id}/${variant}-${digest.slice(0, 16)}.png`,
      mediaType: "image/png",
      viewport,
      bytes: bytes.byteLength,
      sha256: digest,
      fixtureBytes: bytes,
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
  const assets = new Map(screenshots.map((screenshot) => [screenshot.sourcePath, screenshot.fixtureBytes]));
  for (const screenshot of screenshots) delete screenshot.fixtureBytes;
  return { projection: qualifiedProjection, evidence, assets };
}

function replaceScreenshotBytes(evidence, assets, variant, bytes) {
  const screenshot = evidence.qualifiedGoldenJourneys[0].screenshots.find((entry) => entry.variant === variant);
  const digest = createHash("sha256").update(bytes).digest("hex");
  screenshot.bytes = bytes.byteLength;
  screenshot.sha256 = digest;
  screenshot.publicationPath = `assets/gallery-evidence/${screenshot.sourcePath.split("/")[2]}/${variant}-${digest.slice(0, 16)}.png`;
  assets.set(screenshot.sourcePath, bytes);
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
    capabilityMatrixSha256: consumerFixture.inputs.capabilityMatrix.sha256,
    publicationQualificationGate: "npm run samples:verify",
    validation: {
      projectionSchemaPath: "samples/contract/v2/schemas/site-projection.schema.json",
      visualEvidenceSchemaPath: "samples/contract/v2/schemas/site-visual-evidence.schema.json",
      capabilityMatrixSchemaPath: "samples/contract/v2/schemas/capability-sample-matrix.schema.json",
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
  const callerMatrix = matrixForEvidence(callerEvidence);
  const verifiedTitle = sampleById(callerProjection, "endpoint-to-map").title;
  const integrity = await verifyGalleryProjectionIntegrity({
    projectionBytes: stableBytes(callerProjection),
    visualEvidenceBytes: stableBytes(callerEvidence),
    capabilityMatrixBytes: stableBytes(callerMatrix),
    consumerFixture: fixtureForProjection(callerProjection, callerEvidence, callerMatrix),
  });

  assert.equal(Object.isFrozen(integrity), true);
  assert.notStrictEqual(integrity.projection, callerProjection);
  assertDeepFrozen(integrity.projection);
  assertDeepFrozen(integrity.visualEvidence);
  assertDeepFrozen(integrity.capabilityMatrix);
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
        capabilityMatrixBytes,
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
        capabilityMatrixBytes,
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
        capabilityMatrixBytes,
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
        capabilityMatrixBytes,
        consumerFixture: assertionMismatch,
      }),
    /consumer assertion sampleCount does not match/,
  );

  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: JSON.stringify(projection),
        visualEvidenceBytes,
        capabilityMatrixBytes,
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
        capabilityMatrixBytes,
        consumerFixture: visualDigestMismatch,
      }),
    /consumer visual evidence digest mismatch/,
  );

  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes,
        visualEvidenceBytes: JSON.stringify(visualEvidence),
        capabilityMatrixBytes,
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
  const credentialMatrix = matrixForEvidence(credentialEvidence);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(credentialBearing),
        visualEvidenceBytes: stableBytes(credentialEvidence),
        capabilityMatrixBytes: stableBytes(credentialMatrix),
        consumerFixture: fixtureForProjection(credentialBearing, credentialEvidence, credentialMatrix),
      }),
    /forbidden credential query parameter access_token/,
  );

  const schemaInvalid = structuredClone(projection);
  delete sampleById(schemaInvalid, "endpoint-to-map").title;
  const invalidEvidence = visualEvidenceForProjection(schemaInvalid);
  const invalidMatrix = matrixForEvidence(invalidEvidence);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(schemaInvalid),
        visualEvidenceBytes: stableBytes(invalidEvidence),
        capabilityMatrixBytes: stableBytes(invalidMatrix),
        consumerFixture: fixtureForProjection(schemaInvalid, invalidEvidence, invalidMatrix),
      }),
    /JSON Schema validation failed.*title/,
  );

  const foreignRepository = structuredClone(projection);
  sampleById(foreignRepository, "endpoint-to-map").source.repository = "honua-io/forked-sdk";
  const foreignEvidence = visualEvidenceForProjection(foreignRepository);
  const foreignMatrix = matrixForEvidence(foreignEvidence);
  await assert.rejects(
    () =>
      verifyGalleryProjectionIntegrity({
        projectionBytes: stableBytes(foreignRepository),
        visualEvidenceBytes: stableBytes(foreignEvidence),
        capabilityMatrixBytes: stableBytes(foreignMatrix),
        consumerFixture: fixtureForProjection(foreignRepository, foreignEvidence, foreignMatrix),
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
  for (const sample of emptyProjection.samples) sample.track = "fixture";

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
    capabilityMatrix: {
      format: capabilityMatrix.format,
      schemaVersion: capabilityMatrix.schemaVersion,
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
  assert.match(html, /Verified First Map: public endpoint to MapLibre at the desktop evidence viewport/);
  assert.match(html, /Verified First Map: public endpoint to MapLibre at the mobile evidence viewport/);
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

test("rejects corrupt PNG receipts and screenshots whose pixels contradict the declared viewport", async () => {
  const wrongViewport = qualifiedVisualFixture();
  replaceScreenshotBytes(
    wrongViewport.evidence,
    wrongViewport.assets,
    "desktop",
    solidGrayscalePng(1279, 720, 0x55),
  );
  const wrongViewportGallery = await verifiedGallery(wrongViewport.projection, {
    evidence: wrongViewport.evidence,
  });
  await assert.rejects(
    () => verifyGalleryVisualAssets(wrongViewportGallery, (sourcePath) => wrongViewport.assets.get(sourcePath)),
    /PNG dimensions do not match its declared viewport/,
  );

  const corrupt = qualifiedVisualFixture();
  const corruptBytes = Buffer.from(corrupt.assets.values().next().value);
  corruptBytes[corruptBytes.byteLength - 1] ^= 0xff;
  replaceScreenshotBytes(corrupt.evidence, corrupt.assets, "desktop", corruptBytes);
  const corruptGallery = await verifiedGallery(corrupt.projection, { evidence: corrupt.evidence });
  await assert.rejects(
    () => verifyGalleryVisualAssets(corruptGallery, (sourcePath) => corrupt.assets.get(sourcePath)),
    /invalid IEND CRC/,
  );

  const truncated = qualifiedVisualFixture();
  replaceScreenshotBytes(
    truncated.evidence,
    truncated.assets,
    "desktop",
    truncatedGrayscalePng(1280, 720),
  );
  const truncatedGallery = await verifiedGallery(truncated.projection, { evidence: truncated.evidence });
  await assert.rejects(
    () => verifyGalleryVisualAssets(truncatedGallery, (sourcePath) => truncated.assets.get(sourcePath)),
    /invalid decompressed PNG pixel length/,
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

  const staleSemantic = structuredClone(fixture.evidence);
  staleSemantic.qualifiedGoldenJourneys[0].semanticEvidence[0].expiresAt = "2020-01-01T00:00:00.000Z";
  await assert.rejects(
    () => verifiedGallery(fixture.projection, { evidence: staleSemantic }),
    /packed-build semantic evidence is stale/,
  );

  const aggregateDrift = structuredClone(fixture.evidence);
  aggregateDrift.qualifiedGoldenJourneys[0].semanticEvidence[0].expiresAt = new Date(
    Date.parse(aggregateDrift.qualifiedGoldenJourneys[0].expiresAt) - 60_000,
  ).toISOString();
  await assert.rejects(
    () => verifiedGallery(fixture.projection, { evidence: aggregateDrift }),
    /visual evidence aggregate window drift/,
  );

  const wrongLiveSample = structuredClone(fixture.evidence);
  wrongLiveSample.qualifiedGoldenJourneys[0].liveEvidence.evidencePath =
    "samples/evidence/other-sample/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/artifacts/live-evidence.json";
  await assert.rejects(
    () => verifiedGallery(fixture.projection, { evidence: wrongLiveSample }),
    /live visual evidence path binding drift/,
  );

  const liveWindowDrift = structuredClone(fixture.evidence);
  liveWindowDrift.qualifiedGoldenJourneys[0].liveEvidence.expiresAt = new Date(
    Date.parse(liveWindowDrift.qualifiedGoldenJourneys[0].liveEvidence.expiresAt) - 60_000,
  ).toISOString();
  await assert.rejects(
    () => verifiedGallery(fixture.projection, { evidence: liveWindowDrift }),
    /live visual evidence receipt window drift/,
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
    "Capability matrix",
    "Contract",
  ]) {
    assert.match(html, new RegExp(`<dt>${label}</dt>`));
  }
  assert.match(html, /<form[^>]+role="search"[^>]+aria-label="Filter demo gallery"/);
  assert.match(html, /<label for="gallery-search">Task or sample<\/label>/);
  assert.match(html, /<label for="gallery-capability">Task \/ capability<\/label>/);
  assert.match(html, /<label for="gallery-protocol">Protocol<\/label>/);
  assert.match(html, /<label for="gallery-renderer">Renderer<\/label>/);
  assert.match(html, /<label for="gallery-data-mode">Data mode<\/label>/);
  assert.match(html, /<label for="gallery-auth-mode">Authentication<\/label>/);
  assert.match(html, /<label for="gallery-support-tier">Support<\/label>/);
  assert.match(html, /<label for="gallery-lifecycle-state">Lifecycle<\/label>/);
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
    renderers: card.sample.renderers,
    dataMode: card.sample.data.mode,
    authMode: card.sample.data.authMode,
    supportTier: card.sample.supportTier,
    lifecycleState: card.sample.lifecycle.state,
  }));

  assert.deepEqual(normalizeGalleryFilters({ text: "  REALTIME\t operations  " }), {
    text: "realtime operations",
    capability: "",
    protocol: "",
    renderer: "",
    dataMode: "",
    authMode: "",
    supportTier: "",
    lifecycleState: "",
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
  const exactFacetIds = filterGalleryCards(records, {
    renderer: "maplibre",
    dataMode: "hybrid",
    authMode: "anonymous",
    supportTier: "supported",
    lifecycleState: "active",
  }).map(({ id }) => id);
  assert.ok(exactFacetIds.includes("maplibre-quickstart"));
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
