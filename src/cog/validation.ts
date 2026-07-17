import type { StacAssetCandidate, StacAssetClassificationEvidence } from "../connect-stac-static.js";
import type { DiscoveryProvenance } from "../contract/discovery.js";
import { HonuaCogError } from "./errors.js";
import type {
  CogBand,
  CogBandWindow,
  CogCrs,
  CogDecodedMetadata,
  CogDecodedWindow,
  CogFootprint,
  CogKnownCrs,
  CogPolygonCoordinates,
  CogPosition,
  CogSampleArray,
  CogStacProvenance,
  CogTransferLimits,
  CogWindowRequest,
} from "./types.js";

const DATA_TYPES = new Set(["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64"]);
const POSITIVE_COG_EVIDENCE = new Set(["media-type", "probe"]);
const EVIDENCE_KINDS = new Set(["media-type", "role", "extension", "asset-field", "probe", "url-policy"]);
const ASSET_KINDS = new Set(["cog", "geoparquet", "pmtiles", "tile", "metadata"]);
const OBJECT_TYPES = new Set(["catalog", "collection", "item"]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const MAX_BANDS = 1024;
const MAX_FOOTPRINT_POSITIONS = 10_000;
const MAX_OVERVIEWS = 64;
const MAX_DIMENSION = 2_147_483_647;

export interface ValidatedCogCandidate {
  readonly assetUrl: string;
  readonly provenance: CogStacProvenance;
}

export function validateCogCandidate(candidate: StacAssetCandidate): ValidatedCogCandidate {
  if (!isObject(candidate)) {
    throw new HonuaCogError("invalid-candidate", "A static STAC asset candidate is required.");
  }
  if (candidate.state !== "classified" || candidate.kind !== "cog" || candidate.confidence === "none") {
    throw new HonuaCogError(
      "invalid-candidate",
      "Only an evidence-classified COG candidate can enter the direct COG boundary.",
    );
  }
  if (!Array.isArray(candidate.evidence) || !candidate.evidence.some(isPositiveCogEvidence)) {
    throw new HonuaCogError(
      "invalid-candidate",
      "The STAC candidate has no positive COG media/probe evidence; filename or extension evidence is insufficient.",
    );
  }
  if (typeof candidate.href !== "string") {
    throw new HonuaCogError("unsafe-asset-url", "The classified COG candidate has no credential-free asset URL.");
  }
  if (!OBJECT_TYPES.has(candidate.objectType) || !CONFIDENCE_VALUES.has(candidate.confidence)) {
    throw new HonuaCogError("invalid-candidate", "The classified COG candidate has invalid STAC identity fields.");
  }
  if (!Array.isArray(candidate.roles) || !Array.isArray(candidate.provenance)) {
    throw new HonuaCogError("invalid-candidate", "The classified COG candidate has invalid provenance arrays.");
  }
  const assetUrl = safeAssetUrl(candidate.href);
  const provenance: CogStacProvenance = Object.freeze({
    candidateId: boundedString(candidate.id, 2048, "candidate id"),
    assetUrl,
    documentUrl: safeDocumentUrl(candidate.documentUrl),
    objectType: candidate.objectType,
    objectId: boundedString(candidate.objectId, 2048, "STAC object id"),
    assetKey: boundedString(candidate.assetKey, 512, "STAC asset key"),
    ...(candidate.collectionId
      ? { collectionId: boundedString(candidate.collectionId, 2048, "STAC collection id") }
      : {}),
    ...(candidate.itemId ? { itemId: boundedString(candidate.itemId, 2048, "STAC item id") } : {}),
    ...(candidate.mediaType ? { mediaType: boundedString(candidate.mediaType, 512, "asset media type") } : {}),
    confidence: candidate.confidence,
    roles: Object.freeze(candidate.roles.map((role) => boundedString(role, 256, "asset role"))),
    evidence: Object.freeze(candidate.evidence.map(cloneEvidence)),
    discovery: Object.freeze(candidate.provenance.map(cloneDiscoveryProvenance)),
  });
  return Object.freeze({ assetUrl, provenance });
}

export function normalizeCogMetadata(value: CogDecodedMetadata): CogDecodedMetadata & { readonly crs: CogCrs } {
  if (!isObject(value)) throw new HonuaCogError("invalid-metadata", "The COG decoder returned invalid metadata.");
  if (value.format !== "cog") {
    throw new HonuaCogError(
      "unsupported-format",
      value.format === "geotiff"
        ? "The asset is a GeoTIFF but not a cloud-optimized GeoTIFF."
        : "The decoder does not recognize a supported COG format.",
    );
  }
  const width = positiveInteger(value.width, MAX_DIMENSION, "raster width", "invalid-metadata");
  const height = positiveInteger(value.height, MAX_DIMENSION, "raster height", "invalid-metadata");
  const crs = normalizeCrs(value.crs);
  if (!Array.isArray(value.bands) || value.bands.length === 0 || value.bands.length > MAX_BANDS) {
    throw new HonuaCogError("invalid-metadata", `COG metadata must describe 1-${MAX_BANDS} bands.`);
  }
  const bands = Object.freeze(value.bands.map(normalizeBand));
  if (new Set(bands.map((band) => band.index)).size !== bands.length) {
    throw new HonuaCogError("invalid-metadata", "COG band indices must be unique.");
  }
  const resolution = Object.freeze({
    x: positiveFinite(value.resolution?.x, "pixel width"),
    y: positiveFinite(value.resolution?.y, "pixel height"),
    ...(value.resolution?.unit
      ? { unit: boundedString(value.resolution.unit, 128, "resolution unit", "invalid-metadata") }
      : {}),
  });
  const footprint = normalizeFootprint(value.footprint);
  const overviewDecimations = normalizeOverviews(value.overviewDecimations);
  return Object.freeze({
    format: "cog" as const,
    width,
    height,
    crs,
    bands,
    resolution,
    footprint,
    overviewDecimations,
  });
}

export function normalizeWindowRequest(
  value: CogWindowRequest,
  metadata: CogDecodedMetadata,
  limits: CogTransferLimits,
): CogWindowRequest {
  if (!isObject(value)) throw new HonuaCogError("invalid-window", "A COG pixel window is required.");
  const x = nonNegativeInteger(value.x, "window x");
  const y = nonNegativeInteger(value.y, "window y");
  const width = positiveInteger(value.width, metadata.width, "window width", "invalid-window");
  const height = positiveInteger(value.height, metadata.height, "window height", "invalid-window");
  if (x + width > metadata.width || y + height > metadata.height) {
    throw new HonuaCogError("invalid-window", "The COG pixel window extends outside the inspected raster.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxWindowPixels) {
    throw new HonuaCogError(
      "invalid-window",
      `The COG window exceeds the ${limits.maxWindowPixels}-pixel decoded window ceiling.`,
    );
  }
  const availableBands = new Set(metadata.bands.map((band) => band.index));
  const requestedBands = value.bands ?? metadata.bands.map((band) => band.index);
  if (!Array.isArray(requestedBands) || requestedBands.length === 0 || requestedBands.length > metadata.bands.length) {
    throw new HonuaCogError("invalid-window", "The COG window must select at least one inspected band.");
  }
  const bands = requestedBands.map((band) => positiveInteger(band, MAX_BANDS, "band index", "invalid-window"));
  if (new Set(bands).size !== bands.length || bands.some((band) => !availableBands.has(band))) {
    throw new HonuaCogError("invalid-window", "COG window bands must be unique inspected band indices.");
  }
  return Object.freeze({ x, y, width, height, bands: Object.freeze(bands) });
}

export function normalizeDecodedWindow(
  value: CogDecodedWindow,
  request: CogWindowRequest,
  limits: CogTransferLimits,
): readonly CogBandWindow[] {
  if (
    !isObject(value) ||
    value.width !== request.width ||
    value.height !== request.height ||
    !Array.isArray(value.bands)
  ) {
    throw new HonuaCogError("invalid-window", "The COG decoder returned a window with mismatched dimensions.");
  }
  const requestedBands = request.bands ?? [];
  if (value.bands.length !== requestedBands.length) {
    throw new HonuaCogError("invalid-window", "The COG decoder returned a mismatched band count.");
  }
  const byBand = new Map<number, CogSampleArray>();
  let decodedBytes = 0;
  const expectedSamples = request.width * request.height;
  for (const entry of value.bands) {
    if (
      !isObject(entry) ||
      typeof entry.band !== "number" ||
      !Number.isSafeInteger(entry.band) ||
      !isSampleArray(entry.values)
    ) {
      throw new HonuaCogError("invalid-window", "The COG decoder returned an invalid band window.");
    }
    const band = entry.band;
    if (entry.values.length !== expectedSamples || byBand.has(band)) {
      throw new HonuaCogError("invalid-window", "Every decoded COG band must contain exactly one value per pixel.");
    }
    decodedBytes += entry.values.byteLength;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > limits.maxDecodedBytes) {
      throw new HonuaCogError(
        "invalid-window",
        `The decoded COG window exceeds the ${limits.maxDecodedBytes}-byte materialization ceiling.`,
      );
    }
    byBand.set(band, entry.values);
  }
  if (requestedBands.some((band) => !byBand.has(band))) {
    throw new HonuaCogError("invalid-window", "The COG decoder returned bands other than those requested.");
  }
  return Object.freeze(
    requestedBands.map((band) => Object.freeze({ band, values: cloneSampleArray(byBand.get(band)!) })),
  );
}

function normalizeCrs(value: CogDecodedMetadata["crs"]): CogCrs {
  if (!isObject(value)) throw new HonuaCogError("unsupported-crs", "The COG decoder returned no usable CRS.");
  if (value.kind === "unsupported") {
    throw new HonuaCogError(
      "unsupported-crs",
      `The COG CRS is unsupported: ${boundedString(value.description, 1024, "CRS description", "unsupported-crs")}`,
    );
  }
  if (value.kind !== "known") {
    throw new HonuaCogError("unsupported-crs", "The COG decoder returned no usable CRS.");
  }
  const authority = value.authority
    ? boundedString(value.authority, 128, "CRS authority", "unsupported-crs")
    : undefined;
  const code = value.code ? boundedString(value.code, 128, "CRS code", "unsupported-crs") : undefined;
  const name = value.name ? boundedString(value.name, 512, "CRS name", "unsupported-crs") : undefined;
  const wkt = value.wkt ? boundedString(value.wkt, 65_536, "CRS WKT", "unsupported-crs", true) : undefined;
  if ((authority && !code) || (!authority && code) || (!wkt && !(authority && code))) {
    throw new HonuaCogError("unsupported-crs", "The COG CRS must provide an authority/code pair or bounded WKT.");
  }
  const normalized: CogKnownCrs = Object.freeze({
    kind: "known",
    ...(authority ? { authority } : {}),
    ...(code ? { code } : {}),
    ...(name ? { name } : {}),
    ...(wkt ? { wkt } : {}),
  });
  return normalized;
}

function normalizeBand(value: CogBand): CogBand {
  if (!isObject(value)) throw new HonuaCogError("invalid-metadata", "The COG decoder returned an invalid band.");
  const index = positiveInteger(value.index, MAX_BANDS, "band index", "invalid-metadata");
  if (!DATA_TYPES.has(value.dataType)) {
    throw new HonuaCogError("invalid-metadata", `COG band ${index} has an unsupported data type.`);
  }
  const nodata = normalizeNoData(value.nodata);
  return Object.freeze({
    index,
    dataType: value.dataType,
    ...(value.name ? { name: boundedString(value.name, 512, "band name", "invalid-metadata") } : {}),
    ...(value.description
      ? { description: boundedString(value.description, 2048, "band description", "invalid-metadata", true) }
      : {}),
    ...(value.colorInterpretation
      ? {
          colorInterpretation: boundedString(
            value.colorInterpretation,
            128,
            "band color interpretation",
            "invalid-metadata",
          ),
        }
      : {}),
    ...(value.unit ? { unit: boundedString(value.unit, 128, "band unit", "invalid-metadata") } : {}),
    ...(value.nodata !== undefined ? { nodata } : {}),
    ...(value.scale !== undefined ? { scale: finiteNumber(value.scale, "band scale") } : {}),
    ...(value.offset !== undefined ? { offset: finiteNumber(value.offset, "band offset") } : {}),
  });
}

function normalizeNoData(value: CogBand["nodata"]): CogBand["nodata"] {
  if (value === undefined || value === null) return value;
  if (typeof value === "number") return finiteNumber(value, "band nodata");
  if (typeof value === "string") return boundedString(value, 256, "band nodata", "invalid-metadata");
  throw new HonuaCogError("invalid-metadata", "COG band nodata must be a finite number, string, or null.");
}

function normalizeFootprint(value: CogFootprint): CogFootprint {
  if (!isObject(value) || (value.type !== "Polygon" && value.type !== "MultiPolygon")) {
    throw new HonuaCogError("invalid-metadata", "The COG decoder returned an invalid footprint.");
  }
  let positions = 0;
  const polygon = (coordinates: unknown): CogPolygonCoordinates => {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      throw new HonuaCogError("invalid-metadata", "A COG footprint polygon must contain at least one ring.");
    }
    return Object.freeze(
      coordinates.map((ring): readonly CogPosition[] => {
        if (!Array.isArray(ring) || ring.length < 4) {
          throw new HonuaCogError("invalid-metadata", "A COG footprint ring must contain at least four positions.");
        }
        const normalized = ring.map((position): CogPosition => {
          positions += 1;
          if (positions > MAX_FOOTPRINT_POSITIONS) {
            throw new HonuaCogError(
              "invalid-metadata",
              `The COG footprint exceeds ${MAX_FOOTPRINT_POSITIONS} positions.`,
            );
          }
          if (!Array.isArray(position) || (position.length !== 2 && position.length !== 3)) {
            throw new HonuaCogError("invalid-metadata", "A COG footprint position must contain two or three numbers.");
          }
          const values = position.map((coordinate) => finiteNumber(coordinate, "footprint coordinate"));
          return values.length === 2
            ? Object.freeze([values[0]!, values[1]!] as const)
            : Object.freeze([values[0]!, values[1]!, values[2]!] as const);
        });
        const first = normalized[0]!;
        const last = normalized.at(-1)!;
        if (first.length !== last.length || first.some((coordinate, index) => coordinate !== last[index])) {
          throw new HonuaCogError("invalid-metadata", "A COG footprint ring must be closed.");
        }
        return Object.freeze(normalized);
      }),
    );
  };
  if (value.type === "Polygon") {
    return Object.freeze({ type: "Polygon", coordinates: polygon(value.coordinates) });
  }
  if (!Array.isArray(value.coordinates) || value.coordinates.length === 0) {
    throw new HonuaCogError("invalid-metadata", "A COG multipolygon footprint must contain a polygon.");
  }
  return Object.freeze({
    type: "MultiPolygon",
    coordinates: Object.freeze(value.coordinates.map((coordinates) => polygon(coordinates))),
  });
}

function normalizeOverviews(values: readonly number[] | undefined): readonly number[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > MAX_OVERVIEWS) {
    throw new HonuaCogError("invalid-metadata", `COG metadata may describe at most ${MAX_OVERVIEWS} overviews.`);
  }
  const normalized = values.map((value) => positiveFinite(value, "overview decimation"));
  let previous = 1;
  for (const value of normalized) {
    if (value <= previous) {
      throw new HonuaCogError("invalid-metadata", "COG overview decimations must be strictly increasing above one.");
    }
    previous = value;
  }
  return Object.freeze(normalized);
}

function cloneEvidence(value: StacAssetClassificationEvidence): StacAssetClassificationEvidence {
  if (
    !isObject(value) ||
    typeof value.kind !== "string" ||
    !EVIDENCE_KINDS.has(value.kind) ||
    typeof value.value !== "string"
  ) {
    throw new HonuaCogError("invalid-candidate", "The STAC candidate contains malformed classification evidence.");
  }
  const supports = value.supports
    ? Object.freeze(
        value.supports.map((kind) => {
          const normalized = boundedString(kind, 64, "supported asset kind");
          if (!ASSET_KINDS.has(normalized)) {
            throw new HonuaCogError("invalid-candidate", "The STAC candidate evidence names an unknown asset kind.");
          }
          return normalized;
        }),
      )
    : undefined;
  return Object.freeze({
    kind: value.kind,
    value: boundedString(value.value, 2048, "classification evidence"),
    ...(supports ? { supports } : {}),
  }) as StacAssetClassificationEvidence;
}

function cloneDiscoveryProvenance(value: DiscoveryProvenance): DiscoveryProvenance {
  if (!isObject(value) || typeof value.source !== "string") {
    throw new HonuaCogError("invalid-candidate", "The STAC candidate contains malformed discovery provenance.");
  }
  return Object.freeze({
    source: safeDocumentUrl(value.source),
    ...(value.retrievedAt ? { retrievedAt: boundedString(value.retrievedAt, 128, "retrieval time") } : {}),
    ...(value.validator ? { validator: boundedString(value.validator, 512, "document validator") } : {}),
  });
}

function isPositiveCogEvidence(value: StacAssetClassificationEvidence): boolean {
  return (
    isObject(value) &&
    POSITIVE_COG_EVIDENCE.has(value.kind) &&
    Array.isArray(value.supports) &&
    value.supports.includes("cog")
  );
}

function safeAssetUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new HonuaCogError("unsafe-asset-url", "The classified COG asset URL is invalid.", { cause });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HonuaCogError(
      "unsafe-asset-url",
      "COG asset URLs must be credential-free HTTP(S) URLs without query parameters or fragments.",
    );
  }
  return url.toString();
}

function safeDocumentUrl(value: string): string {
  return safeAssetUrl(boundedString(value, 8192, "STAC document URL"));
}

function positiveInteger(
  value: unknown,
  maximum: number,
  label: string,
  code: "invalid-metadata" | "invalid-window",
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new HonuaCogError(code, `${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HonuaCogError("invalid-window", `${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function positiveFinite(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new HonuaCogError("invalid-metadata", `${label} must be positive.`);
  return number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HonuaCogError("invalid-metadata", `${label} must be finite.`);
  }
  return value;
}

function boundedString(
  value: unknown,
  maximum: number,
  label: string,
  code: "invalid-candidate" | "invalid-metadata" | "unsupported-crs" = "invalid-candidate",
  allowLineWhitespace = false,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    hasForbiddenControl(value, allowLineWhitespace)
  ) {
    throw new HonuaCogError(code, `${label} must be a non-empty bounded string.`);
  }
  return value;
}

function hasForbiddenControl(value: string, allowLineWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 127 || (code < 32 && !(allowLineWhitespace && (code === 9 || code === 10 || code === 13)))) {
      return true;
    }
  }
  return false;
}

function isSampleArray(value: unknown): value is CogSampleArray {
  return (
    value instanceof Uint8Array ||
    value instanceof Int8Array ||
    value instanceof Uint16Array ||
    value instanceof Int16Array ||
    value instanceof Uint32Array ||
    value instanceof Int32Array ||
    value instanceof Float32Array ||
    value instanceof Float64Array
  );
}

function cloneSampleArray(values: CogSampleArray): CogSampleArray {
  return values.slice() as CogSampleArray;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
