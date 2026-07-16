import { HonuaAbortError } from "./core/errors.js";
import type { StacDiscoveryTransport } from "./stac-discovery-transport.js";
import type {
  StacAssetClassification,
  StacAssetClassificationEvidence,
  StacAssetFormat,
  StacCandidateSourceLocator,
} from "./stac-discovery-types.js";

export interface ClassifyStacAssetInput {
  readonly asset: Readonly<Record<string, unknown>>;
  readonly rawUrl: string;
  readonly direct: boolean;
  readonly roles: readonly string[];
  readonly mediaType?: string;
  readonly transport: StacDiscoveryTransport;
  readonly probe: boolean;
  readonly probeAllowed: boolean;
}

export interface ClassifiedStacAsset {
  readonly classification: StacAssetClassification;
  readonly source?: StacCandidateSourceLocator;
  readonly probeStatus: "not-needed" | "confirmed" | "skipped" | "failed";
}

interface MediaType {
  readonly base: string;
  readonly parameters: ReadonlyMap<string, string>;
}

interface ProbeOutcome {
  readonly confirmed: ReadonlySet<StacAssetFormat>;
  readonly contradicted: ReadonlySet<StacAssetFormat>;
  readonly evidence: readonly StacAssetClassificationEvidence[];
  readonly tileContent?: "vector" | "raster" | "unknown";
}

const PMTILES_MEDIA_TYPE = "application/vnd.pmtiles";
const GEOPARQUET_MEDIA_TYPE = "application/vnd.apache.parquet";
const TILEJSON_MEDIA_TYPES = new Set([
  "application/vnd.mapbox.tile+json",
  "application/vnd.mapbox.tilejson+json",
  "application/tilejson+json",
]);
const VECTOR_TILE_MEDIA_TYPES = new Set([
  "application/vnd.mapbox-vector-tile",
  "application/x-protobuf",
  "application/vnd.mapbox-vector-tile+protobuf",
]);
const RASTER_TILE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);
const METADATA_MEDIA_TYPES = new Set([
  "application/json",
  "application/geo+json",
  "application/xml",
  "text/xml",
  "text/csv",
  "text/plain",
]);

export async function classifyStacAsset(input: ClassifyStacAssetInput): Promise<ClassifiedStacAsset> {
  const evidence: StacAssetClassificationEvidence[] = [];
  const declared = new Set<StacAssetFormat>();
  const supporting = new Set<StacAssetFormat>();
  const media = parseMediaType(input.mediaType);
  const roles = new Set(input.roles.map((role) => role.toLowerCase()));
  const template = hasTileTemplate(input.rawUrl);
  let tileLayout: "tilejson" | "template" | undefined;
  let tileContent: "vector" | "raster" | "unknown" | undefined;

  if (media?.base === PMTILES_MEDIA_TYPE) {
    declared.add("pmtiles");
    evidence.push(formatEvidence("media-type", "pmtiles", "conclusive", "The asset declares the PMTiles media type."));
  }
  if (media?.base === GEOPARQUET_MEDIA_TYPE) {
    supporting.add("geoparquet");
    evidence.push(
      formatEvidence(
        "media-type",
        "geoparquet",
        "supporting",
        "The asset declares Parquet; GeoParquet metadata still requires verification.",
      ),
    );
  }
  if (isCogMediaType(media)) {
    declared.add("cog");
    evidence.push(
      formatEvidence(
        "media-type",
        "cog",
        "conclusive",
        "The GeoTIFF media type explicitly declares the cloud-optimized profile.",
      ),
    );
  } else if (isGeoTiffMediaType(media)) {
    supporting.add("cog");
    evidence.push(
      formatEvidence(
        "media-type",
        "cog",
        "supporting",
        "The asset declares GeoTIFF but does not declare cloud optimization.",
      ),
    );
  }
  if (media && TILEJSON_MEDIA_TYPES.has(media.base)) {
    declared.add("tiles");
    tileLayout = "tilejson";
    evidence.push(formatEvidence("media-type", "tiles", "conclusive", "The asset declares a TileJSON media type."));
  }
  if (template && media && VECTOR_TILE_MEDIA_TYPES.has(media.base)) {
    declared.add("tiles");
    tileLayout = "template";
    tileContent = "vector";
    evidence.push(formatEvidence("media-type", "tiles", "conclusive", "The asset is a vector-tile URL template."));
  }
  if (template && media && RASTER_TILE_MEDIA_TYPES.has(media.base)) {
    declared.add("tiles");
    tileLayout = "template";
    tileContent = "raster";
    evidence.push(formatEvidence("media-type", "tiles", "conclusive", "The asset is a raster-tile URL template."));
  }
  if (roles.has("metadata") && (!media || isMetadataMediaType(media.base))) {
    declared.add("metadata");
    evidence.push(
      formatEvidence("asset-role", "metadata", "conclusive", "The asset explicitly has the metadata role."),
    );
  }

  addRoleEvidence(roles, "cog", ["cog", "cloud-optimized-geotiff"], supporting, evidence);
  addRoleEvidence(roles, "geoparquet", ["geoparquet"], supporting, evidence);
  addRoleEvidence(roles, "pmtiles", ["pmtiles"], supporting, evidence);
  if (hasAnyRole(roles, ["tiles", "tilejson", "vector-tiles", "raster-tiles"])) {
    supporting.add("tiles");
    tileLayout ??= template ? "template" : "tilejson";
    tileContent ??= roles.has("vector-tiles") ? "vector" : roles.has("raster-tiles") ? "raster" : "unknown";
    evidence.push(formatEvidence("asset-role", "tiles", "supporting", "The asset declares a tile-oriented role."));
  }

  const extensionKeys = Object.keys(input.asset).filter((key) => key.includes(":"));
  if (extensionKeys.some((key) => key.startsWith("geoparquet:")) || input.asset["table:columns"] !== undefined) {
    supporting.add("geoparquet");
    evidence.push(
      formatEvidence("extension-field", "geoparquet", "supporting", "GeoParquet/table extension metadata is present."),
    );
  }
  if (input.asset["raster:bands"] !== undefined) {
    supporting.add("cog");
    evidence.push(formatEvidence("extension-field", "cog", "supporting", "Raster extension metadata is present."));
  }
  if (extensionKeys.some((key) => key.startsWith("pmtiles:"))) {
    supporting.add("pmtiles");
    evidence.push(formatEvidence("extension-field", "pmtiles", "supporting", "PMTiles extension metadata is present."));
  }
  if (extensionKeys.some((key) => key.startsWith("tiles:"))) {
    supporting.add("tiles");
    tileLayout ??= template ? "template" : "tilejson";
    evidence.push(formatEvidence("extension-field", "tiles", "supporting", "Tile extension metadata is present."));
  }
  if (template && (supporting.has("tiles") || declared.has("tiles"))) {
    tileLayout = "template";
    evidence.push(formatEvidence("tile-template", "tiles", "supporting", "The URL contains z/x/y tile placeholders."));
  }
  const explicitTileContent = input.asset["tiles:type"];
  if (explicitTileContent === "vector" || explicitTileContent === "raster") tileContent = explicitTileContent;

  const candidates = new Set<StacAssetFormat>([...declared, ...supporting]);
  const needsProbe = [...candidates].some(
    (format) => format !== "metadata" && !(format === "tiles" && tileLayout === "template"),
  );
  let probeOutcome: ProbeOutcome | undefined;
  let probeStatus: ClassifiedStacAsset["probeStatus"] = needsProbe ? "skipped" : "not-needed";
  if (needsProbe && input.probe && input.probeAllowed && input.direct) {
    try {
      probeOutcome = await probeCandidate(input, candidates, tileLayout);
      probeStatus = probeOutcome.confirmed.size > 0 ? "confirmed" : "failed";
      evidence.push(...probeOutcome.evidence);
      for (const format of probeOutcome.confirmed) candidates.add(format);
      tileContent = probeOutcome.tileContent ?? tileContent;
    } catch (cause) {
      if (cause instanceof HonuaAbortError) throw cause;
      probeStatus = "failed";
      evidence.push({
        code: "probe-skipped",
        strength: "informational",
        detail: "The bounded asset probe failed; metadata-only evidence was retained.",
      });
    }
  } else if (needsProbe) {
    evidence.push({
      code: "probe-skipped",
      strength: "informational",
      detail: !input.direct
        ? "The asset URL requires an execution-time resolver, so discovery did not probe it."
        : !input.probe
          ? "Asset probes are disabled by policy."
          : "The asset origin is not authorized for discovery probes.",
    });
  }

  const contradicted = probeOutcome?.contradicted ?? new Set<StacAssetFormat>();
  const viable = [...candidates].filter((format) => !contradicted.has(format)).sort();
  const conflicting = contradicted.size > 0 || viable.length > 1;
  let classification: StacAssetClassification;
  if (viable.length === 1 && !conflicting && isSufficientlyClassified(viable[0]!, declared, probeOutcome)) {
    const format = viable[0]!;
    classification = Object.freeze({
      state: "classified",
      format,
      candidates: Object.freeze([format]),
      confidence: probeOutcome?.confirmed.has(format) ? "verified" : "declared",
      ...(format === "tiles" && tileLayout ? { tileLayout } : {}),
      ...(format === "tiles" ? { tileContent: tileContent ?? "unknown" } : {}),
      evidence: Object.freeze(evidence),
      reason: probeOutcome?.confirmed.has(format)
        ? "Bounded content evidence confirms the declared format."
        : "Explicit STAC metadata identifies the format.",
    });
  } else if (candidates.size > 0) {
    classification = Object.freeze({
      state: "ambiguous",
      candidates: Object.freeze([...candidates].sort()),
      ...(candidates.has("tiles") && tileLayout ? { tileLayout } : {}),
      ...(candidates.has("tiles") ? { tileContent: tileContent ?? "unknown" } : {}),
      evidence: Object.freeze(evidence),
      reason:
        contradicted.size > 0
          ? "Declared metadata conflicts with bounded content evidence."
          : viable.length > 1
            ? "Multiple formats remain plausible."
            : "The available metadata is not specific enough to identify the format safely.",
    });
  } else {
    classification = Object.freeze({
      state: "unsupported",
      candidates: Object.freeze([]),
      evidence: Object.freeze(evidence),
      reason: "No reviewed media type, role, extension metadata, or probe trigger identifies a supported format.",
    });
  }

  const source =
    classification.state === "classified" && input.direct ? sourceLocator(classification, input.rawUrl) : undefined;
  return Object.freeze({ classification, ...(source ? { source } : {}), probeStatus });
}

async function probeCandidate(
  input: ClassifyStacAssetInput,
  candidates: ReadonlySet<StacAssetFormat>,
  tileLayout: "tilejson" | "template" | undefined,
): Promise<ProbeOutcome> {
  if (candidates.has("geoparquet")) {
    const response = await input.transport.probe(input.rawUrl, "suffix");
    return probeGeoParquet(response.bytes);
  }
  if (candidates.has("tiles") && tileLayout !== "template") {
    const response = await input.transport.probe(input.rawUrl, "prefix");
    return probeTileJson(response.bytes, response.truncated);
  }
  const response = await input.transport.probe(input.rawUrl, "prefix");
  return probePrefix(response.bytes, candidates);
}

function probePrefix(bytes: Uint8Array, candidates: ReadonlySet<StacAssetFormat>): ProbeOutcome {
  const confirmed = new Set<StacAssetFormat>();
  const contradicted = new Set<StacAssetFormat>();
  const evidence: StacAssetClassificationEvidence[] = [];
  const pmtiles = bytes.byteLength >= 8 && ascii(bytes.subarray(0, 7)) === "PMTiles" && bytes[7] === 3;
  const tiff = isTiff(bytes);
  if (pmtiles) {
    confirmed.add("pmtiles");
    evidence.push(formatEvidence("probe-magic", "pmtiles", "conclusive", "The bounded prefix has PMTiles v3 magic."));
    if (candidates.has("cog")) contradicted.add("cog");
  } else if (candidates.has("pmtiles")) {
    contradicted.add("pmtiles");
    evidence.push(
      formatEvidence(
        "probe-conflict",
        "pmtiles",
        "contradicting",
        "The bounded prefix does not have PMTiles v3 magic.",
      ),
    );
  }
  if (tiff) {
    evidence.push(formatEvidence("probe-magic", "cog", "supporting", "The bounded prefix has TIFF or BigTIFF magic."));
    if (candidates.has("cog")) confirmed.add("cog");
    if (candidates.has("pmtiles")) contradicted.add("pmtiles");
  } else if (candidates.has("cog")) {
    contradicted.add("cog");
    evidence.push(
      formatEvidence("probe-conflict", "cog", "contradicting", "The bounded prefix does not have TIFF magic."),
    );
  }
  return Object.freeze({ confirmed, contradicted, evidence: Object.freeze(evidence) });
}

function probeGeoParquet(bytes: Uint8Array): ProbeOutcome {
  const confirmed = new Set<StacAssetFormat>();
  const contradicted = new Set<StacAssetFormat>();
  const evidence: StacAssetClassificationEvidence[] = [];
  const parquet = bytes.byteLength >= 8 && ascii(bytes.subarray(bytes.byteLength - 4)) === "PAR1";
  const text = ascii(bytes);
  const geoMetadata =
    parquet && text.includes("geo") && text.includes('"primary_column"') && text.includes('"columns"');
  if (geoMetadata) {
    confirmed.add("geoparquet");
    evidence.push(
      formatEvidence(
        "probe-metadata",
        "geoparquet",
        "conclusive",
        "The bounded Parquet footer contains the required GeoParquet metadata structure.",
      ),
    );
  } else if (!parquet) {
    contradicted.add("geoparquet");
    evidence.push(
      formatEvidence(
        "probe-conflict",
        "geoparquet",
        "contradicting",
        "The bounded suffix does not end in Parquet magic.",
      ),
    );
  } else {
    evidence.push(
      formatEvidence(
        "probe-metadata",
        "geoparquet",
        "supporting",
        "The asset has Parquet magic, but the bounded footer does not expose GeoParquet metadata.",
      ),
    );
  }
  return Object.freeze({ confirmed, contradicted, evidence: Object.freeze(evidence) });
}

function probeTileJson(bytes: Uint8Array, truncated: boolean): ProbeOutcome {
  const confirmed = new Set<StacAssetFormat>();
  const contradicted = new Set<StacAssetFormat>();
  const evidence: StacAssetClassificationEvidence[] = [];
  if (truncated) {
    evidence.push(
      formatEvidence(
        "probe-metadata",
        "tiles",
        "supporting",
        "The TileJSON probe reached its byte limit before validation.",
      ),
    );
    return Object.freeze({ confirmed, contradicted, evidence: Object.freeze(evidence), tileContent: "unknown" });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    contradicted.add("tiles");
    evidence.push(
      formatEvidence("probe-conflict", "tiles", "contradicting", "The bounded response is not valid TileJSON."),
    );
    return Object.freeze({ confirmed, contradicted, evidence: Object.freeze(evidence), tileContent: "unknown" });
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { tilejson?: unknown }).tilejson === "string" &&
    Array.isArray((value as { tiles?: unknown }).tiles) &&
    (value as { tiles: unknown[] }).tiles.length > 0 &&
    (value as { tiles: unknown[] }).tiles.every((entry) => typeof entry === "string")
  ) {
    confirmed.add("tiles");
    const vector = Array.isArray((value as { vector_layers?: unknown }).vector_layers);
    evidence.push(
      formatEvidence(
        "probe-metadata",
        "tiles",
        "conclusive",
        "The bounded JSON has TileJSON version and tile templates.",
      ),
    );
    return Object.freeze({
      confirmed,
      contradicted,
      evidence: Object.freeze(evidence),
      tileContent: vector ? "vector" : "unknown",
    });
  }
  contradicted.add("tiles");
  evidence.push(
    formatEvidence("probe-conflict", "tiles", "contradicting", "The bounded JSON does not satisfy TileJSON structure."),
  );
  return Object.freeze({ confirmed, contradicted, evidence: Object.freeze(evidence), tileContent: "unknown" });
}

function sourceLocator(classification: StacAssetClassification, url: string): StacCandidateSourceLocator | undefined {
  if (classification.format === "pmtiles") {
    return Object.freeze({
      protocol: "pmtiles" as const,
      locator: Object.freeze({ url }),
      requirement: "pmtiles-runtime" as const,
    });
  }
  if (classification.format === "geoparquet") {
    return Object.freeze({
      protocol: "geoparquet" as const,
      locator: Object.freeze({ url }),
      requirement: "geoparquet-profiler" as const,
    });
  }
  if (classification.format === "tiles" && classification.tileContent !== "unknown") {
    return Object.freeze({
      protocol: classification.tileContent === "vector" ? ("maplibre-vector" as const) : ("maplibre-raster" as const),
      locator: Object.freeze({ url }),
    });
  }
  return undefined;
}

function isSufficientlyClassified(
  format: StacAssetFormat,
  declared: ReadonlySet<StacAssetFormat>,
  probe: ProbeOutcome | undefined,
): boolean {
  if (format === "geoparquet") return probe?.confirmed.has(format) === true;
  // A TIFF signature proves that an asset is a TIFF, but not that its internal
  // organization satisfies Cloud Optimized GeoTIFF requirements. Require an
  // explicit COG declaration instead of promoting generic GeoTIFFs by probe.
  if (format === "cog") return declared.has(format);
  return declared.has(format) || probe?.confirmed.has(format) === true;
}

function parseMediaType(value: string | undefined): MediaType | undefined {
  if (!value) return undefined;
  const parts = value.split(";");
  const base = parts.shift()?.trim().toLowerCase();
  if (!base || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) return undefined;
  const parameters = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals < 1) continue;
    const name = part.slice(0, equals).trim().toLowerCase();
    const parameter = part
      .slice(equals + 1)
      .trim()
      .replace(/^"|"$/g, "")
      .toLowerCase();
    if (name) parameters.set(name, parameter);
  }
  return Object.freeze({ base, parameters });
}

function isGeoTiffMediaType(media: MediaType | undefined): boolean {
  return media?.base === "image/tiff" && media.parameters.get("application") === "geotiff";
}

function isCogMediaType(media: MediaType | undefined): boolean {
  return isGeoTiffMediaType(media) && media?.parameters.get("profile") === "cloud-optimized";
}

function isMetadataMediaType(base: string): boolean {
  return METADATA_MEDIA_TYPES.has(base) || base.endsWith("+json") || base.endsWith("+xml");
}

function hasTileTemplate(url: string): boolean {
  const normalized = url.toLowerCase();
  return normalized.includes("{z}") && normalized.includes("{x}") && normalized.includes("{y}");
}

function hasAnyRole(roles: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => roles.has(candidate));
}

function addRoleEvidence(
  roles: ReadonlySet<string>,
  format: StacAssetFormat,
  names: readonly string[],
  supporting: Set<StacAssetFormat>,
  evidence: StacAssetClassificationEvidence[],
): void {
  if (!hasAnyRole(roles, names)) return;
  supporting.add(format);
  evidence.push(formatEvidence("asset-role", format, "supporting", `The asset declares a ${format} role.`));
}

function formatEvidence(
  code: StacAssetClassificationEvidence["code"],
  format: StacAssetFormat,
  strength: StacAssetClassificationEvidence["strength"],
  detail: string,
): StacAssetClassificationEvidence {
  return Object.freeze({ code, format, strength, detail });
}

function isTiff(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && (bytes[3] === 0x2a || bytes[3] === 0x2b))
  );
}

function ascii(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.byteLength; index += 1) output += String.fromCharCode(bytes[index]!);
  return output;
}
