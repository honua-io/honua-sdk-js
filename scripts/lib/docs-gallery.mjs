import { createHash } from "node:crypto";
import {
  validateSiteConsumerFixture,
  validateSiteProjection,
  validateSiteVisualEvidence,
} from "../sample-contract.mjs";
import { normalizeGalleryText } from "./docs-gallery-client.mjs";

const SITE_PROJECTION_PATH = "samples/dist/honua-site-samples.v2.json";
const SITE_PROJECTION_SCHEMA_PATH = "samples/contract/v2/schemas/site-projection.schema.json";
const SITE_VISUAL_EVIDENCE_PATH = "samples/dist/honua-site-visual-evidence.v1.json";
const SITE_VISUAL_EVIDENCE_SCHEMA_PATH = "samples/contract/v2/schemas/site-visual-evidence.schema.json";
const CANONICAL_SOURCE_REPOSITORY = "honua-io/honua-sdk-js";
const CANONICAL_SOURCE_BASE = "https://github.com/honua-io/honua-sdk-js/blob/trunk";
const CONSUMER_FIXTURE_FORMAT = "honua.site.sdk-sample-consumer-fixture.v3";
const SITE_PROJECTION_FORMAT = "honua.site.sdk-sample-projection.v2";
const SITE_VISUAL_EVIDENCE_FORMAT = "honua.site.sdk-sample-visual-evidence.v1";
const SAMPLE_CATALOG_FORMAT = "honua.sdk.sample-catalog.v2";
const REPRESENTATIVE_ROUTES = Object.freeze(["quickstart-map", "public-safety", "two-protocols"]);
const QUALITY_GATE_KEYS = Object.freeze([
  "packedBuild",
  "browser",
  "accessibility",
  "console",
  "responsive",
  "screenshot",
  "performance",
  "liveEvidence",
]);
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
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
const VERIFIED_INTEGRITIES = new WeakSet();
const VERIFIED_GALLERY_MODELS = new WeakSet();

const PUBLIC_GALLERY_TRACKS = Object.freeze([
  { track: "golden", title: "Golden journeys" },
  { track: "recipe", title: "Recipes" },
  { track: "lab", title: "Labs" },
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`Gallery projection integrity: ${message}`);
}

function assertPlainObject(value, label) {
  const prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  invariant(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (prototype === Object.prototype || prototype === null),
    `${label} must be an object`,
  );
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(sortedExpected), `${label} keys must match the declared contract`);
}

function stableJsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreezeJson(value) {
  const objects = [];
  const pending = [value];
  const seen = new WeakSet();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    objects.push(current);
    pending.push(...Object.values(current));
  }
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (!Object.isFrozen(objects[index])) Object.freeze(objects[index]);
  }
  return value;
}

/**
 * Parse and bind canonical site-projection bytes to the committed consumer
 * fixture. The returned token owns a deeply frozen snapshot and is intentionally
 * accepted only by this module's model builder, so callers cannot mutate or
 * substitute projection state after verification.
 */
export async function verifyGalleryProjectionIntegrity({
  projectionBytes,
  visualEvidenceBytes,
  consumerFixture,
}) {
  invariant(typeof projectionBytes === "string", "projection bytes must be supplied as UTF-8 text");
  invariant(typeof visualEvidenceBytes === "string", "visual evidence bytes must be supplied as UTF-8 text");
  let projection;
  let visualEvidence;
  try {
    projection = JSON.parse(projectionBytes);
  } catch {
    throw new Error("Gallery projection integrity: projection bytes must be valid JSON");
  }
  try {
    visualEvidence = JSON.parse(visualEvidenceBytes);
  } catch {
    throw new Error("Gallery projection integrity: visual evidence bytes must be valid JSON");
  }
  assertPlainObject(projection, "projection");
  assertPlainObject(visualEvidence, "visual evidence");
  invariant(
    projection.format === SITE_PROJECTION_FORMAT && projection.schemaVersion === 2,
    "projection format is not the supported v2 contract",
  );
  invariant(
    projection.catalog?.format === SAMPLE_CATALOG_FORMAT && projection.catalog?.schemaVersion === 2,
    "catalog format is not the supported v2 contract",
  );
  invariant(
    visualEvidence.format === SITE_VISUAL_EVIDENCE_FORMAT && visualEvidence.schemaVersion === 1,
    "visual evidence format is not the supported v1 contract",
  );
  const stableProjection = stableJsonBytes(projection);
  const stableVisualEvidence = stableJsonBytes(visualEvidence);
  invariant(projectionBytes === stableProjection, "projection bytes are not canonical stable JSON");
  invariant(
    visualEvidenceBytes === stableVisualEvidence,
    "visual evidence bytes are not canonical stable JSON",
  );
  deepFreezeJson(projection);
  deepFreezeJson(visualEvidence);
  await validateSiteProjection(projection);
  await validateSiteVisualEvidence(visualEvidence, projection);

  assertExactKeys(
    consumerFixture,
    ["format", "schemaVersion", "accepts", "inputs", "assertions", "representativeRoutes"],
    "consumer fixture",
  );
  invariant(consumerFixture.format === CONSUMER_FIXTURE_FORMAT, "consumer fixture format is not v3");
  invariant(consumerFixture.schemaVersion === 3, "consumer fixture schemaVersion is not 3");

  assertExactKeys(
    consumerFixture.accepts,
    [
      "projectionFormat",
      "projectionSchemaVersion",
      "catalogFormat",
      "catalogSchemaVersion",
      "visualEvidenceFormat",
      "visualEvidenceSchemaVersion",
    ],
    "consumer fixture accepts",
  );
  invariant(
    consumerFixture.accepts.projectionFormat === projection.format &&
      consumerFixture.accepts.projectionSchemaVersion === projection.schemaVersion &&
      consumerFixture.accepts.catalogFormat === projection.catalog?.format &&
      consumerFixture.accepts.catalogSchemaVersion === projection.catalog?.schemaVersion &&
      consumerFixture.accepts.visualEvidenceFormat === visualEvidence.format &&
      consumerFixture.accepts.visualEvidenceSchemaVersion === visualEvidence.schemaVersion,
    "consumer accepted formats do not match the projection",
  );

  assertExactKeys(consumerFixture.inputs, ["projection", "visualEvidence"], "consumer fixture inputs");
  assertExactKeys(
    consumerFixture.inputs.projection,
    ["path", "schemaPath", "sha256"],
    "consumer projection input",
  );
  assertExactKeys(
    consumerFixture.inputs.visualEvidence,
    ["path", "schemaPath", "sha256"],
    "consumer visual evidence input",
  );
  invariant(
    consumerFixture.inputs.projection.path === SITE_PROJECTION_PATH,
    "consumer projection input path is not canonical",
  );
  invariant(
    consumerFixture.inputs.projection.schemaPath === SITE_PROJECTION_SCHEMA_PATH,
    "consumer projection schema path is not canonical",
  );
  invariant(
    consumerFixture.inputs.visualEvidence.path === SITE_VISUAL_EVIDENCE_PATH,
    "consumer visual evidence input path is not canonical",
  );
  invariant(
    consumerFixture.inputs.visualEvidence.schemaPath === SITE_VISUAL_EVIDENCE_SCHEMA_PATH,
    "consumer visual evidence schema path is not canonical",
  );
  invariant(
    /^[a-f0-9]{64}$/.test(consumerFixture.inputs.projection.sha256),
    "consumer projection digest is malformed",
  );
  invariant(
    /^[a-f0-9]{64}$/.test(consumerFixture.inputs.visualEvidence.sha256),
    "consumer visual evidence digest is malformed",
  );
  const projectionSha256 = sha256(stableProjection);
  const visualEvidenceSha256 = sha256(stableVisualEvidence);
  invariant(
    consumerFixture.inputs.projection.sha256 === projectionSha256,
    "consumer projection digest mismatch",
  );
  invariant(
    consumerFixture.inputs.visualEvidence.sha256 === visualEvidenceSha256,
    "consumer visual evidence digest mismatch",
  );

  const samples = Array.isArray(projection.samples) ? projection.samples : [];
  const journeys = Array.isArray(projection.goldenJourneys) ? projection.goldenJourneys : [];
  const routes = Array.isArray(projection.routes) ? projection.routes : [];
  const sampleIds = samples.map((sample) => sample.id);
  const routeIds = routes.map((route) => route.id);
  const expectedAssertions = {
    sampleCount: samples.length,
    rootExampleCount: samples.filter((sample) => sample.sourceKind === "root-example").length,
    docsExampleCount: samples.filter((sample) => sample.sourceKind === "docs-example").length,
    goldenJourneyCount: journeys.length,
    qualifiedGoldenCount: journeys.filter((journey) => journey.status === "qualified").length,
    visualEvidenceCount: visualEvidence.qualifiedGoldenJourneys.length,
    routeCount: routes.length,
    sampleIdsUnique: new Set(sampleIds).size === sampleIds.length,
    routeIdsUnique: new Set(routeIds).size === routeIds.length,
    routesEndInHtml: routes.every((route) => typeof route.route === "string" && route.route.endsWith(".html")),
    visualEvidenceMatchesQualifiedGolden:
      visualEvidence.qualifiedGoldenJourneys.length ===
      journeys.filter((journey) => journey.status === "qualified").length,
    desktopMobileEvidenceRequired: true,
    semanticGateSetRequired: true,
    executableSourceOwner: projection.contract?.executableSourceOwner,
    presentationOwner: projection.contract?.presentationOwner,
    sourceImplementationDuplicated: false,
    credentialValuesForbidden: true,
  };
  invariant(expectedAssertions.sampleIdsUnique, "projection sample IDs are not unique");
  invariant(expectedAssertions.routeIdsUnique, "projection route IDs are not unique");
  invariant(expectedAssertions.routesEndInHtml, "projection routes are not static HTML paths");
  invariant(
    expectedAssertions.executableSourceOwner === "honua-io/honua-sdk-js" &&
      expectedAssertions.presentationOwner === "honua-io/honua-site",
    "projection ownership is not the supported SDK/site boundary",
  );
  assertExactKeys(consumerFixture.assertions, Object.keys(expectedAssertions), "consumer fixture assertions");
  for (const [name, expected] of Object.entries(expectedAssertions)) {
    invariant(consumerFixture.assertions[name] === expected, `consumer assertion ${name} does not match`);
  }

  invariant(
    Array.isArray(consumerFixture.representativeRoutes) &&
      JSON.stringify(consumerFixture.representativeRoutes) === JSON.stringify(REPRESENTATIVE_ROUTES),
    "consumer representative routes do not match the v2 contract",
  );
  const routeIdSet = new Set(routeIds);
  invariant(
    consumerFixture.representativeRoutes.every((routeId) => routeIdSet.has(routeId)),
    "consumer representative route is absent from the projection",
  );
  await validateSiteConsumerFixture(consumerFixture, projection, visualEvidence);

  const integrity = Object.freeze({
    projection,
    visualEvidence,
    consumerFixtureFormat: consumerFixture.format,
    projectionSha256,
    visualEvidenceSha256,
    publicationQualificationGate: "npm run samples:verify",
    validation: Object.freeze({
      projectionSchemaPath: SITE_PROJECTION_SCHEMA_PATH,
      visualEvidenceSchemaPath: SITE_VISUAL_EVIDENCE_SCHEMA_PATH,
      schemaValidated: true,
      sensitiveMetadataValidated: true,
    }),
  });
  VERIFIED_INTEGRITIES.add(integrity);
  return integrity;
}

function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

function qualificationFor(sample, journey, qualityProfile) {
  const requiredGates = Object.entries(qualityProfile.gates)
    .filter(([, required]) => required)
    .map(([gate]) => gate);
  if (sample.track === "golden") {
    invariant(journey?.status === "qualified", `${sample.id} golden card is not bound to a qualified journey`);
    invariant(sample.supportTier === "supported", `${sample.id} qualified golden card is not supported`);
    invariant(sample.lifecycle.state === "active", `${sample.id} qualified golden card is not active`);
    invariant(
      sample.evidence.fixture.status === "executed",
      `${sample.id} qualified golden card lacks executed fixture evidence`,
    );
    invariant(
      Object.values(qualityProfile.gates).every(Boolean),
      `${sample.id} qualified golden card does not require every qualification gate`,
    );
    if (qualityProfile.gates.liveEvidence) {
      invariant(
        sample.evidence.live.status === "executed",
        `${sample.id} qualified golden card lacks executed live evidence`,
      );
    }
    return {
      state: "receipt-qualified-golden",
      label: "Receipt-qualified golden journey",
      requiredGates,
    };
  }
  if (journey) {
    invariant(journey.status === "planned", `${sample.id} non-golden journey card is forged as qualified`);
    return {
      state: "planned-golden-candidate",
      label: "Planned golden candidate · not receipt-qualified",
      requiredGates,
    };
  }
  invariant(
    sample.track === "recipe" || sample.track === "lab" || sample.track === "fixture",
    `${sample.id} has no honest gallery qualification state`,
  );
  return {
    state: "catalog-declared",
    label: `${sample.track} declaration · CI gates only; not receipt-qualified`,
    requiredGates,
  };
}

function validateQualificationModel(siteProjection, indexes) {
  invariant(Array.isArray(siteProjection.qualityProfiles), "projection qualityProfiles must be an array");
  const qualityProfiles = new Map();
  for (const profile of siteProjection.qualityProfiles) {
    invariant(typeof profile.id === "string" && profile.id, "quality profile ID is missing");
    invariant(typeof profile.description === "string" && profile.description, `${profile.id} description is missing`);
    invariant(!qualityProfiles.has(profile.id), `duplicate quality profile ${profile.id}`);
    assertExactKeys(profile.gates, QUALITY_GATE_KEYS, `${profile.id} quality profile gates`);
    invariant(
      Object.values(profile.gates).every((required) => typeof required === "boolean"),
      `${profile.id} quality profile gates must be booleans`,
    );
    qualityProfiles.set(profile.id, profile);
  }
  for (const sample of siteProjection.samples) {
    invariant(
      qualityProfiles.has(sample.validationProfile),
      `${sample.id} references missing quality profile ${sample.validationProfile}`,
    );
  }

  for (const journey of indexes.journeys.values()) {
    const sample = indexes.samples.get(journey.candidateSampleId);
    invariant(sample, `${journey.id} candidate ${journey.candidateSampleId} is missing`);
    invariant(sample.journeyId === journey.id, `${journey.id} candidate relation is inconsistent`);
    if (journey.status === "qualified") {
      invariant(sample.track === "golden", `${journey.id} qualified candidate is not a golden card`);
    } else {
      invariant(journey.status === "planned", `${journey.id} has an unknown qualification status`);
      invariant(
        sample.track === "recipe" || sample.track === "lab",
        `${journey.id} planned candidate must remain a recipe or lab`,
      );
    }
  }
  for (const sample of siteProjection.samples) {
    if (!sample.journeyId) {
      invariant(sample.track !== "golden", `${sample.id} golden card has no journey relation`);
      continue;
    }
    const journey = indexes.journeys.get(sample.journeyId);
    invariant(journey, `${sample.id} references unknown journey ${sample.journeyId}`);
    invariant(journey.candidateSampleId === sample.id, `${sample.id} is not the candidate for ${sample.journeyId}`);
  }
  const goldenCount = siteProjection.samples.filter((sample) => sample.track === "golden").length;
  const qualifiedCount = [...indexes.journeys.values()].filter((journey) => journey.status === "qualified").length;
  invariant(goldenCount === qualifiedCount, "golden card count does not match qualified journey count");
  return qualityProfiles;
}

function resolvedReplacement(replacement, indexes, publicSampleIds) {
  if (!replacement) return null;
  if (replacement.kind === "sample") {
    const sample = indexes.samples.get(replacement.id);
    return {
      ...replacement,
      title: sample?.title ?? replacement.id,
      publicSampleId: publicSampleIds.has(replacement.id) ? replacement.id : null,
    };
  }
  if (replacement.kind === "journey") {
    const journey = indexes.journeys.get(replacement.id);
    const candidateSampleId = journey?.candidateSampleId ?? null;
    return {
      ...replacement,
      title: journey?.title ?? replacement.id,
      status: journey?.status ?? "unknown",
      candidateSampleId,
      publicSampleId: publicSampleIds.has(candidateSampleId) ? candidateSampleId : null,
    };
  }
  const external = indexes.externalReplacements.get(replacement.id);
  return {
    ...replacement,
    title: external?.title ?? replacement.id,
    url: external?.url ?? null,
  };
}

function gallerySearchText(card) {
  const { sample, journey, replacement, visualEvidence } = card;
  return normalizeGalleryText(
    [
      sample.id,
      sample.title,
      sample.summary,
      sample.track,
      sample.supportTier,
      sample.validationProfile,
      sample.sdk.package,
      sample.sdk.version,
      ...sample.capabilities,
      ...sample.protocols,
      ...sample.renderers,
      sample.data.mode,
      sample.data.authMode,
      sample.data.configurationStatus,
      sample.evidence.fixture.mode,
      sample.evidence.fixture.status,
      sample.evidence.live.mode,
      sample.evidence.live.targetMode,
      sample.evidence.live.status,
      sample.lifecycle.state,
      journey?.id,
      journey?.title,
      journey?.status,
      replacement?.kind,
      replacement?.id,
      replacement?.title,
      card.qualification.state,
      card.qualification.label,
      card.qualityProfile.description,
      ...card.qualification.requiredGates,
      visualEvidence?.liveEvidence.semantics.operation,
      visualEvidence?.liveEvidence.semantics.outcome,
      ...(visualEvidence?.liveEvidence.semantics.assertions ?? []),
    ]
      .filter((value) => value !== undefined && value !== null)
      .join(" "),
  );
}

/**
 * Build the deterministic public-gallery model from the presentation-safe
 * catalog-v2 site projection. Internal fixture entries remain available to
 * validation but are intentionally not promoted as public applications.
 */
export function createGalleryModel(integrity) {
  invariant(
    integrity && VERIFIED_INTEGRITIES.has(integrity),
    "gallery model requires a verified integrity token",
  );
  const siteProjection = integrity.projection;
  if (!siteProjection || !Array.isArray(siteProjection.samples)) {
    throw new TypeError("Gallery projection must contain a samples array.");
  }

  const publicTracks = new Set(PUBLIC_GALLERY_TRACKS.map(({ track }) => track));
  const publicSamples = siteProjection.samples.filter((sample) => publicTracks.has(sample.track));
  if (publicSamples.length === 0) {
    throw new Error("Gallery projection produced zero public cards; refusing to publish an empty gallery.");
  }
  for (const sample of publicSamples) validatedSampleSource(sample);

  const journeys = Array.isArray(siteProjection.goldenJourneys) ? siteProjection.goldenJourneys : [];
  const externalReplacements = Array.isArray(siteProjection.externalReplacements)
    ? siteProjection.externalReplacements
    : [];
  const indexes = {
    samples: new Map(siteProjection.samples.map((sample) => [sample.id, sample])),
    journeys: new Map(journeys.map((journey) => [journey.id, journey])),
    externalReplacements: new Map(externalReplacements.map((replacement) => [replacement.id, replacement])),
  };
  const qualityProfiles = validateQualificationModel(siteProjection, indexes);
  const visualEvidenceBySample = new Map(
    integrity.visualEvidence.qualifiedGoldenJourneys.map((entry) => [entry.sampleId, entry]),
  );
  const publicSampleIds = new Set(publicSamples.map((sample) => sample.id));
  const provenance = {
    projection: {
      format: siteProjection.format,
      schemaVersion: siteProjection.schemaVersion,
    },
    visualEvidence: {
      format: integrity.visualEvidence.format,
      schemaVersion: integrity.visualEvidence.schemaVersion,
    },
    catalog: structuredClone(siteProjection.catalog ?? {}),
    contract: structuredClone(siteProjection.contract ?? {}),
  };
  const cards = publicSamples.map((sample) => {
    const card = {
      sample: structuredClone(sample),
      journey: sample.journeyId
        ? structuredClone(indexes.journeys.get(sample.journeyId) ?? {
            id: sample.journeyId,
            title: sample.journeyId,
            status: "unknown",
            candidateSampleId: sample.id,
          })
        : null,
      replacement: resolvedReplacement(sample.lifecycle.replacement, indexes, publicSampleIds),
      qualityProfile: structuredClone(qualityProfiles.get(sample.validationProfile)),
      visualEvidence: visualEvidenceBySample.has(sample.id)
        ? structuredClone(visualEvidenceBySample.get(sample.id))
        : null,
    };
    card.qualification = qualificationFor(sample, card.journey, card.qualityProfile);
    invariant(
      (card.qualification.state === "receipt-qualified-golden") === (card.visualEvidence !== null),
      `${sample.id} visual evidence does not match its qualification state`,
    );
    return { ...card, searchText: gallerySearchText(card) };
  });
  const groups = PUBLIC_GALLERY_TRACKS.map(({ track, title }) => ({
    track,
    title,
    cards: cards.filter((card) => card.sample.track === track),
  })).filter((group) => group.cards.length > 0);

  const gallery = deepFreezeJson({
    cardCount: cards.length,
    provenance,
    integrity: {
      consumerFixtureFormat: integrity.consumerFixtureFormat,
      projectionSha256: integrity.projectionSha256,
      visualEvidenceSha256: integrity.visualEvidenceSha256,
      publicationQualificationGate: integrity.publicationQualificationGate,
      validation: structuredClone(integrity.validation),
    },
    filters: {
      capabilities: sortedUnique(cards.flatMap((card) => card.sample.capabilities)),
      protocols: sortedUnique(cards.flatMap((card) => card.sample.protocols)),
    },
    groups,
  });
  VERIFIED_GALLERY_MODELS.add(gallery);
  return gallery;
}

/**
 * Re-read every qualified screenshot immediately before publication. The
 * returned content-addressed assets are the only visual files the docs builder
 * may copy into the static site.
 */
export async function verifyGalleryVisualAssets(gallery, readAsset) {
  invariant(
    gallery && VERIFIED_GALLERY_MODELS.has(gallery),
    "visual asset verification requires a verified gallery model",
  );
  if (typeof readAsset !== "function") throw new TypeError("visual asset verification requires an asset reader");
  const assets = [];
  const publicationPaths = new Set();
  for (const card of gallery.groups.flatMap((group) => group.cards)) {
    for (const screenshot of card.visualEvidence?.screenshots ?? []) {
      invariant(
        safeRepositoryRelativeUrl(screenshot.sourcePath) === screenshot.sourcePath &&
          new RegExp(
            `^samples/evidence/${card.sample.id}/runs/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/artifacts/screenshot-${screenshot.variant}\\.png$`,
          ).test(screenshot.sourcePath),
        `${card.sample.id} visual source path is unsafe`,
      );
      const publicationPath = validatedVisualPublicationPath(screenshot, card.sample.id);
      invariant(!publicationPaths.has(publicationPath), `duplicate gallery visual publication path ${publicationPath}`);
      publicationPaths.add(publicationPath);
      const bytes = Buffer.from(await readAsset(screenshot.sourcePath));
      invariant(
        bytes.byteLength === screenshot.bytes && sha256(bytes) === screenshot.sha256,
        `${card.sample.id} ${screenshot.variant} screenshot bytes do not match visual evidence`,
      );
      const dimensions = verifiedPngDimensions(
        bytes,
        `${card.sample.id} ${screenshot.variant} visual evidence`,
      );
      invariant(
        dimensions.width === screenshot.viewport.width && dimensions.height === screenshot.viewport.height,
        `${card.sample.id} ${screenshot.variant} PNG dimensions do not match its declared viewport`,
      );
      assets.push({ publicationPath, bytes });
    }
  }
  return assets;
}

function pngCrc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = PNG_CRC_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function verifiedPngDimensions(bytes, label) {
  invariant(bytes.byteLength >= 45 && bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${label} is not a PNG`);
  let offset = 8;
  let chunkCount = 0;
  let dimensions = null;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    invariant(++chunkCount <= 4_096, `${label} contains too many PNG chunks`);
    invariant(bytes.byteLength - offset >= 12, `${label} has a truncated PNG chunk`);
    const dataLength = bytes.readUInt32BE(offset);
    invariant(dataLength <= bytes.byteLength - offset - 12, `${label} has an invalid PNG chunk length`);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + 4;
    const type = bytes.toString("ascii", typeStart, dataStart);
    invariant(/^[A-Za-z]{4}$/u.test(type), `${label} has an invalid PNG chunk type`);
    invariant(
      bytes.readUInt32BE(dataEnd) === pngCrc32(bytes, typeStart, dataEnd),
      `${label} has an invalid ${type} CRC`,
    );
    if (chunkCount === 1) invariant(type === "IHDR", `${label} does not begin with PNG IHDR`);
    if (type === "IHDR") {
      invariant(dimensions === null && dataLength === 13, `${label} has an invalid PNG IHDR`);
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const validBitDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      invariant(
        width > 0 &&
          height > 0 &&
          validBitDepths[colorType]?.includes(bitDepth) &&
          bytes[dataStart + 10] === 0 &&
          bytes[dataStart + 11] === 0 &&
          (bytes[dataStart + 12] === 0 || bytes[dataStart + 12] === 1),
        `${label} has unsupported PNG image metadata`,
      );
      dimensions = { width, height };
    } else if (type === "IDAT") {
      invariant(dimensions !== null && !sawEnd, `${label} has PNG image data outside its image body`);
      sawImageData = true;
    } else if (type === "IEND") {
      invariant(dataLength === 0 && dimensions !== null && sawImageData && !sawEnd, `${label} has an invalid PNG IEND`);
      sawEnd = true;
      invariant(chunkEnd === bytes.byteLength, `${label} contains bytes after PNG IEND`);
    }
    offset = chunkEnd;
  }
  invariant(dimensions && sawImageData && sawEnd, `${label} is an incomplete PNG`);
  return dimensions;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value || /[\s\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function fullyDecodeUrlComponent(value) {
  let decoded = value;
  for (let depth = 0; depth < 8 && /%[A-Fa-f0-9]{2}/u.test(decoded); depth += 1) {
    decoded = decodeURIComponent(decoded);
  }
  return /%[A-Fa-f0-9]{2}/u.test(decoded) ? null : decoded;
}

function safeRepositoryRelativeUrl(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    /[\u0000-\u0020\u007f\\]/u.test(value) ||
    !/^[A-Za-z0-9._~%/-]+(?:#[A-Za-z0-9._~%/-]+)?$/u.test(value)
  ) {
    return null;
  }
  const [pathPart, fragment] = value.split("#");
  let decodedPath;
  let decodedFragment;
  try {
    decodedPath = fullyDecodeUrlComponent(pathPart);
    decodedFragment = fragment === undefined ? "" : fullyDecodeUrlComponent(fragment);
  } catch {
    return null;
  }
  if (
    decodedPath === null ||
    decodedFragment === null ||
    !/^[A-Za-z0-9._~/-]+$/u.test(decodedPath) ||
    (decodedFragment && !/^[A-Za-z0-9._~/-]+$/u.test(decodedFragment))
  ) {
    return null;
  }
  const segments = decodedPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return value;
}

function safeRepositoryPath(value) {
  if (typeof value !== "string" || value.includes("%") || value.includes("#")) return null;
  return safeRepositoryRelativeUrl(value);
}

function guideRouteForDocsPath(docsPath) {
  if (docsPath === "README.md") return "index.html";
  if (docsPath === "INSTALL.md") return "guides/INSTALL.html";
  if (docsPath.startsWith("docs/") && docsPath.endsWith(".md")) {
    return "guides/" + docsPath.slice("docs/".length).replace(/\.md$/u, ".html");
  }
  return null;
}

function validatedSampleSource(sample) {
  assertExactKeys(sample.source, ["repository", "path", "docsPath"], sample.id + " source");
  invariant(
    sample.source.repository === CANONICAL_SOURCE_REPOSITORY,
    sample.id + " source repository is not canonical",
  );
  const docsPath = safeRepositoryPath(sample.source.docsPath);
  invariant(docsPath, sample.id + " source docsPath is unsafe");
  invariant(safeRepositoryPath(sample.source.path), sample.id + " source path is unsafe");
  return docsPath;
}

function validatedSourceLink(value, docsPath) {
  assertExactKeys(value, ["href", "kind"], "source resolver result");
  invariant(value.kind === "guide" || value.kind === "source", "source resolver kind is unsupported");
  if (value.kind === "source") {
    const expectedHref = CANONICAL_SOURCE_BASE + "/" + docsPath;
    invariant(
      value.href === expectedHref && safeHttpUrl(value.href) === expectedHref,
      "source resolver does not match canonical source ownership",
    );
    return { href: expectedHref, kind: value.kind };
  }
  const expectedHref = guideRouteForDocsPath(docsPath);
  invariant(expectedHref, "source resolver classified a non-guide docsPath as a guide");
  invariant(
    safeRepositoryRelativeUrl(value.href) === expectedHref,
    "guide resolver does not match the repository-built route",
  );
  return { href: expectedHref, kind: value.kind };
}

function renderTags(values, label) {
  if (values.length === 0) return '<span class="demo-none">None declared</span>';
  return `<ul class="demo-tags" aria-label="${escapeHtml(label)}">${values
    .map((value) => `<li><code>${escapeHtml(value)}</code></li>`)
    .join("")}</ul>`;
}

function renderEvidenceSummary(sample) {
  const fixture = sample.evidence.fixture;
  const live = sample.evidence.live;
  const liveParts = [
    `<code>${escapeHtml(live.mode)}</code>`,
    `<strong>${escapeHtml(live.status)}</strong>`,
  ];
  if (live.expiresAt) {
    liveParts.push(
      `<span class="demo-evidence-expiry">evidence expires <time datetime="${escapeHtml(
        live.expiresAt,
      )}">${escapeHtml(live.expiresAt)}</time></span>`,
    );
  }
  return `<span class="demo-evidence-line">Fixture: <strong>${escapeHtml(fixture.status)}</strong></span>
<span class="demo-evidence-line">Live: ${liveParts.join(" · ")}</span>`;
}

function renderEvidenceDetails(sample) {
  const fixture = sample.evidence.fixture;
  const live = sample.evidence.live;
  const parts = [
    `<span class="demo-evidence-line">Fixture mode <code>${escapeHtml(
      fixture.mode,
    )}</code> · status <strong>${escapeHtml(fixture.status)}</strong></span>`,
    `<span class="demo-evidence-line">Live mode <code>${escapeHtml(
      live.mode,
    )}</code> · status <strong>${escapeHtml(live.status)}</strong></span>`,
  ];
  if (live.targetMode) {
    parts.push(
      `<span class="demo-evidence-line">Target mode <code>${escapeHtml(live.targetMode)}</code></span>`,
    );
  }
  if (live.evidencePath) {
    parts.push(
      `<span class="demo-evidence-line">Evidence reference <code>${escapeHtml(
        live.evidencePath,
      )}</code></span>`,
    );
  }
  return parts.join("\n");
}

function renderLifecycle(sample) {
  const lifecycle = sample.lifecycle;
  const parts = [`<strong>${escapeHtml(lifecycle.state)}</strong> — ${escapeHtml(lifecycle.reason)}`];
  if (lifecycle.targetRelease) {
    parts.push(`target release <code>${escapeHtml(lifecycle.targetRelease)}</code>`);
  }
  return parts.join(" · ");
}

function renderReplacement(replacement) {
  if (!replacement) return '<span class="demo-none">None</span>';
  const label = `${replacement.kind}: ${replacement.title} (${replacement.id})`;
  if (replacement.kind === "external") {
    const href = safeHttpUrl(replacement.url);
    return href
      ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      : escapeHtml(label);
  }
  if (replacement.publicSampleId) {
    return `<a href="#sample-${escapeHtml(encodeURIComponent(replacement.publicSampleId))}">${escapeHtml(label)}</a>`;
  }
  return escapeHtml(label);
}

function renderJourney(journey) {
  if (!journey) return '<span class="demo-none">None</span>';
  return `${escapeHtml(journey.title)} (<code>${escapeHtml(journey.id)}</code>) · <strong>${escapeHtml(
    journey.status,
  )}</strong>`;
}

function validatedVisualPublicationPath(screenshot, sampleId) {
  const value = safeRepositoryRelativeUrl(screenshot.publicationPath);
  invariant(
    value === screenshot.publicationPath &&
      value.startsWith(`assets/gallery-evidence/${sampleId}/`) &&
      value.endsWith(`-${screenshot.sha256.slice(0, 16)}.png`),
    `${sampleId} visual publication path is unsafe or not content-addressed`,
  );
  return value;
}

function renderVisualEvidence(entry, title) {
  if (!entry) return "";
  const [desktop, mobile] = entry.screenshots;
  const desktopPath = validatedVisualPublicationPath(desktop, entry.sampleId);
  const mobilePath = validatedVisualPublicationPath(mobile, entry.sampleId);
  return `<div class="demo-visual-evidence" aria-label="Verified desktop and mobile screenshots">
    <figure>
      <img src="${escapeHtml(desktopPath)}" width="${escapeHtml(desktop.viewport.width)}" height="${escapeHtml(
        desktop.viewport.height,
      )}" alt="Verified ${escapeHtml(title)} at the desktop evidence viewport" loading="lazy" decoding="async" />
      <figcaption>Desktop · ${escapeHtml(desktop.viewport.width)}×${escapeHtml(desktop.viewport.height)}</figcaption>
    </figure>
    <figure>
      <img src="${escapeHtml(mobilePath)}" width="${escapeHtml(mobile.viewport.width)}" height="${escapeHtml(
        mobile.viewport.height,
      )}" alt="Verified ${escapeHtml(title)} at the mobile evidence viewport" loading="lazy" decoding="async" />
      <figcaption>Mobile · ${escapeHtml(mobile.viewport.width)}×${escapeHtml(mobile.viewport.height)}</figcaption>
    </figure>
    <p>Content-addressed evidence observed <time datetime="${escapeHtml(entry.observedAt)}">${escapeHtml(
      entry.observedAt,
    )}</time></p>
  </div>`;
}

function renderVisualEvidenceDetails(entry, title) {
  if (!entry) return "";
  const live = entry.liveEvidence;
  const realtime = live.realtime
    ? ` · realtime window ${escapeHtml(live.realtime.observationWindowMs)} ms`
    : "";
  return `<dt>Visual receipt</dt><dd>source <code>${escapeHtml(entry.sourceRevision)}</code> · expires
        <time datetime="${escapeHtml(entry.expiresAt)}">${escapeHtml(entry.expiresAt)}</time></dd>
      <dt>Semantic evidence</dt><dd><strong>${escapeHtml(live.semantics.outcome)}</strong> · ${escapeHtml(
        live.semantics.itemCount,
      )} items · ${escapeHtml(live.semantics.operation)}${realtime}<br />${renderTags(
        entry.semanticEvidence.map(({ gate }) => gate),
        `${title} verified semantic evidence gates`,
      )}</dd>`;
}

function renderOption(value) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
}

function renderGalleryProvenance(gallery) {
  const catalog = gallery.provenance.catalog;
  const projection = gallery.provenance.projection;
  const visualEvidence = gallery.provenance.visualEvidence;
  const contract = gallery.provenance.contract;
  return `<aside class="gallery-provenance" data-gallery-provenance aria-label="Gallery catalog and contract provenance">
  <details>
    <summary>Catalog, projection, and contract provenance</summary>
    <dl class="demo-facts">
      <dt>Catalog</dt><dd><code>${escapeHtml(catalog.package)}</code> <code>${escapeHtml(
        catalog.version,
      )}</code> · <code>${escapeHtml(catalog.format)}</code> schema ${escapeHtml(catalog.schemaVersion)}</dd>
      <dt>Projection</dt><dd><code>${escapeHtml(projection.format)}</code> schema ${escapeHtml(
        projection.schemaVersion,
      )}</dd>
      <dt>Visual evidence</dt><dd><code>${escapeHtml(visualEvidence.format)}</code> schema ${escapeHtml(
        visualEvidence.schemaVersion,
      )} · SHA-256 <code>${escapeHtml(gallery.integrity.visualEvidenceSha256)}</code></dd>
      <dt>Contract</dt><dd>producer <code>${escapeHtml(
        contract.producer,
      )}</code> · consumer <code>${escapeHtml(
        contract.consumer,
      )}</code> · executable owner <code>${escapeHtml(
        contract.executableSourceOwner,
      )}</code> · presentation owner <code>${escapeHtml(contract.presentationOwner)}</code></dd>
      <dt>Consumer fixture</dt><dd><code>${escapeHtml(gallery.integrity.consumerFixtureFormat)}</code></dd>
      <dt>Projection SHA-256</dt><dd><code>${escapeHtml(gallery.integrity.projectionSha256)}</code></dd>
      <dt>Golden publication gate</dt><dd><code>${escapeHtml(
        gallery.integrity.publicationQualificationGate,
      )}</code> receipt-validates qualified journeys before deployment</dd>
    </dl>
  </details>
</aside>`;
}

function renderCard(card, resolveSourceLink) {
  const { sample } = card;
  const docsPath = validatedSampleSource(sample);
  const source = validatedSourceLink(resolveSourceLink(sample), docsPath);
  const sourceLabel = source.kind === "guide" ? "Read the walkthrough" : "View source";
  const dataSummary = [
    `mode <code>${escapeHtml(sample.data.mode)}</code>`,
    `auth <code>${escapeHtml(sample.data.authMode)}</code>`,
    `configuration <strong>${escapeHtml(sample.data.configurationStatus)}</strong>`,
  ];
  const headingId = `sample-${encodeURIComponent(sample.id)}-title`;
  const configurationNote = sample.data.configurationGap
    ? `<dt>Configuration note</dt><dd>${escapeHtml(sample.data.configurationGap)}</dd>`
    : "";
  const visualEvidence = renderVisualEvidence(card.visualEvidence, sample.title);
  const visualEvidenceDetails = renderVisualEvidenceDetails(card.visualEvidence, sample.title);

  return `<article class="demo-card demo-card--${escapeHtml(sample.lifecycle.state)}" id="sample-${escapeHtml(
    encodeURIComponent(sample.id),
  )}" aria-labelledby="${escapeHtml(headingId)}" data-gallery-card data-sample-id="${escapeHtml(
    sample.id,
  )}" data-gallery-search-text="${escapeHtml(card.searchText)}" data-gallery-capabilities="${escapeHtml(
    JSON.stringify(sample.capabilities),
  )}" data-gallery-protocols="${escapeHtml(JSON.stringify(sample.protocols))}">
  <header class="demo-card-header">
    <h3 id="${escapeHtml(headingId)}">${escapeHtml(sample.title)}</h3>
    <div class="demo-badges" aria-label="Support and lifecycle">
      <span class="demo-badge">Support · ${escapeHtml(sample.supportTier)}</span>
      <span class="demo-badge demo-badge--lifecycle">Lifecycle · ${escapeHtml(sample.lifecycle.state)}</span>
    </div>
  </header>
  <p class="demo-id"><code>${escapeHtml(sample.id)}</code></p>
  <p class="demo-summary">${escapeHtml(sample.summary)}</p>
  ${visualEvidence}
  <a class="demo-link" href="${escapeHtml(source.href)}">${sourceLabel} →</a>
  <dl class="demo-facts demo-facts--essential">
    <dt>SDK</dt><dd><code>${escapeHtml(sample.sdk.package)}</code> <code>${escapeHtml(sample.sdk.version)}</code></dd>
    <dt>Data</dt><dd>${dataSummary.join(" · ")}</dd>
    <dt>Evidence state</dt><dd>${renderEvidenceSummary(sample)}</dd>
    <dt>Qualification</dt><dd><strong>${escapeHtml(card.qualification.label)}</strong></dd>
    <dt>Replacement</dt><dd>${renderReplacement(card.replacement)}</dd>
    <dt>Capabilities</dt><dd>${renderTags(sample.capabilities, `${sample.title} capabilities`)}</dd>
    <dt>Protocols</dt><dd>${renderTags(sample.protocols, `${sample.title} protocols`)}</dd>
  </dl>
  <details class="demo-card-details">
    <summary>Evidence, provenance, lifecycle, and degradation</summary>
    <dl class="demo-facts demo-facts--details">
      <dt>Lifecycle</dt><dd>${renderLifecycle(sample)}</dd>
      ${configurationNote}
      <dt>Data provenance</dt><dd>${escapeHtml(sample.data.provenance)}</dd>
      <dt>Attribution</dt><dd>${escapeHtml(sample.data.attribution)}</dd>
      <dt>Freshness</dt><dd>${escapeHtml(sample.data.freshness)}</dd>
      <dt>Evidence details</dt><dd>${renderEvidenceDetails(sample)}</dd>
      ${visualEvidenceDetails}
      <dt>Expected degradation</dt><dd>${escapeHtml(sample.expectedDegradation)}</dd>
      <dt>Renderers</dt><dd>${renderTags(sample.renderers, `${sample.title} renderers`)}</dd>
      <dt>Golden journey</dt><dd>${renderJourney(card.journey)}</dd>
      <dt>Quality profile</dt><dd><code>${escapeHtml(card.qualityProfile.id)}</code> — ${escapeHtml(
        card.qualityProfile.description,
      )}</dd>
      <dt>Required gates</dt><dd>${renderTags(
        card.qualification.requiredGates,
        `${sample.title} required quality gates`,
      )}</dd>
    </dl>
  </details>
</article>`;
}

/** Render only the gallery's main content; the docs builder owns site chrome. */
export function renderGalleryContent(gallery, { resolveSourceLink } = {}) {
  invariant(
    gallery && VERIFIED_GALLERY_MODELS.has(gallery),
    "gallery rendering requires a verified gallery model",
  );
  if (typeof resolveSourceLink !== "function") {
    throw new TypeError("renderGalleryContent requires an explicit source-link resolver");
  }
  const capabilityOptions = gallery.filters.capabilities.map(renderOption).join("");
  const protocolOptions = gallery.filters.protocols.map(renderOption).join("");
  const groups = gallery.groups
    .map(
      (group) => `<section data-gallery-group aria-labelledby="gallery-${escapeHtml(group.track)}">
  <h2 id="gallery-${escapeHtml(group.track)}">${escapeHtml(group.title)}</h2>
  <div class="demo-grid">
${group.cards.map((card) => renderCard(card, resolveSourceLink)).join("\n")}
  </div>
</section>`,
    )
    .join("\n");

  return `<h1>Demo gallery</h1>
<p>Runnable examples projected from the versioned SDK sample catalog. Public recipes
and labs appear here now; qualified golden journeys join automatically as their
evidence gates pass. Cards retain lifecycle, degradation, and evidence truth even
when a sample is scheduled for replacement or retirement.</p>
${renderGalleryProvenance(gallery)}
<p class="gallery-qualification-note">Recipe and lab cards are catalog declarations, not receipt or artifact
qualification claims. Publication runs <code>npm run samples:verify</code>, which validates the complete receipt
set before any future <strong>qualified golden journey</strong> is published; profile gates alone are only requirements.</p>
<form class="gallery-controls" data-gallery-controls role="search" aria-label="Filter demo gallery">
  <div class="gallery-control">
    <label for="gallery-search">Task or sample</label>
    <input id="gallery-search" type="search" autocomplete="off" placeholder="Try editing, realtime, or imagery" data-gallery-search />
  </div>
  <div class="gallery-control">
    <label for="gallery-capability">Capability</label>
    <select id="gallery-capability" data-gallery-capability><option value="">All capabilities</option>${capabilityOptions}</select>
  </div>
  <div class="gallery-control">
    <label for="gallery-protocol">Protocol</label>
    <select id="gallery-protocol" data-gallery-protocol><option value="">All protocols</option>${protocolOptions}</select>
  </div>
  <button type="button" data-gallery-clear disabled>Clear filters</button>
</form>
<p class="gallery-results" role="status" aria-live="polite" aria-atomic="true"><strong data-gallery-result-count>${escapeHtml(
    gallery.cardCount,
  )}</strong> of ${escapeHtml(gallery.cardCount)} public samples</p>
<p class="gallery-empty" data-gallery-empty hidden>No public samples match these filters. Clear a filter or try a broader task.</p>
${groups}`;
}
