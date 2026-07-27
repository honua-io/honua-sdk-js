/** Bounded PMTiles static-asset discovery for the top-level connect() workflow. */

import type { ConnectDiscoverySourceSnapshot, ConnectOptions } from "./connect.js";
import type {
  DiscoveryCacheIdentity,
  DiscoveryCapabilityEvidence,
  DiscoverySourceMetadata,
} from "./contract/discovery.js";
import {
  type PmtilesArchiveDescription,
  type PmtilesRangeResponse,
  type PmtilesSourceLike,
  type PmtilesTileKind,
  type PmtilesVectorLayerInfo,
  describePmtilesArchive,
} from "./contract/pmtiles.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError, isHonuaError } from "./core/errors.js";

const PMTILES_HEADER_REQUEST_BYTES = 16_384;
export const PMTILES_RETAINED_METADATA_JSON_BYTES = 1_000_000;
export const PMTILES_RETAINED_VECTOR_LAYER_ENTRIES = 2_048;
export const PMTILES_RETAINED_VECTOR_LAYER_NODES = 8_000;
export const PMTILES_VALIDATOR_CODE_UNITS = 4_096;
export const PMTILES_UNKNOWN_TILE_KIND_REASON =
  "The PMTiles header uses a tile payload kind this SDK cannot classify; tiles remain disabled.";
const STRONG_ETAG_PATTERN = /^"[\u0021\u0023-\u007e\u0080-\u00ff]*"$/u;
const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;

/** SDK hard ceilings for direct PMTiles discovery. Caller overrides may only lower them. */
export const DEFAULT_PM_TILES_DISCOVERY_LIMITS = Object.freeze({
  maxRequests: 2,
  maxRangeBytes: 512 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxDecompressedBytes: 4 * 1024 * 1024,
});

export interface PmtilesDiscoveryLimits {
  readonly maxRequests: number;
  readonly maxRangeBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDecompressedBytes: number;
}

export interface PmtilesDiscoveryRangeRecord {
  readonly offset: number;
  readonly length: number;
  readonly bytesReceived: number;
  readonly status: 206;
  readonly contentRange: string;
  readonly validator?: string;
}

export interface PmtilesDiscoveryTransfer {
  readonly requests: number;
  readonly bytesFetched: number;
  /** Cumulative bytes admitted after internal metadata/directory decompression. */
  readonly decompressedBytes: number;
  readonly ranges: readonly PmtilesDiscoveryRangeRecord[];
}

export interface PmtilesDiscoveryMetadata {
  readonly specVersion: number;
  readonly tileKind: PmtilesTileKind;
  readonly bounds: readonly [number, number, number, number];
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly center: readonly [number, number, number];
  readonly vectorLayers: readonly PmtilesVectorLayerInfo[];
  readonly attribution?: string;
  /** Canonical JSON encoding of the bounded raw archive metadata document. */
  readonly metadataJson: string;
  readonly validator?: string;
  readonly transfer: PmtilesDiscoveryTransfer;
}

export interface PmtilesDiscoveryResult {
  readonly retrievedAt: string;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

interface MutableRangeRecord {
  offset: number;
  length: number;
  bytesReceived: number;
  status: 206;
  contentRange: string;
  validator?: string;
}

interface AcceptedRange {
  readonly record: MutableRangeRecord;
  readonly bytes: Uint8Array;
  readonly etag?: string;
}

interface PreparedRangeResponse {
  readonly bytes: Uint8Array;
  readonly contentRange: string;
  readonly validator?: string;
  readonly etag?: string;
}

export interface PmtilesDiscoveryValidator {
  readonly identity: string;
  readonly kind: "etag" | "last-modified";
  readonly value: string;
}

/** Normalize caller ceilings without allowing them to widen the SDK hard bounds. */
export function normalizePmtilesDiscoveryLimits(
  input: NonNullable<ConnectOptions["pmtiles"]>["limits"] = {},
): PmtilesDiscoveryLimits {
  return Object.freeze({
    maxRequests: lowerPositiveInteger(input.maxRequests, DEFAULT_PM_TILES_DISCOVERY_LIMITS.maxRequests),
    maxRangeBytes: lowerPositiveInteger(input.maxRangeBytes, DEFAULT_PM_TILES_DISCOVERY_LIMITS.maxRangeBytes),
    maxTotalBytes: lowerPositiveInteger(input.maxTotalBytes, DEFAULT_PM_TILES_DISCOVERY_LIMITS.maxTotalBytes),
    maxDecompressedBytes: lowerPositiveInteger(
      input.maxDecompressedBytes,
      DEFAULT_PM_TILES_DISCOVERY_LIMITS.maxDecompressedBytes,
    ),
  });
}

/** Stable cache discriminator for the exact bounded PMTiles admission policy. */
export function pmtilesDiscoveryPolicyIdentity(limits: PmtilesDiscoveryLimits): string {
  return `pmtiles-discovery:v4:${limits.maxRequests}:${limits.maxRangeBytes}:${limits.maxTotalBytes}:${limits.maxDecompressedBytes}`;
}

/**
 * Inspect one explicitly classified PMTiles archive through the same authenticated
 * client pipeline as every other connect() adapter. Only exact HTTP byte ranges
 * are accepted; whole-file, redirect, compressed, overflowing, and version-mixed
 * responses fail closed.
 */
export async function discoverPmtilesSources(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  options: ConnectOptions,
  limits: PmtilesDiscoveryLimits,
): Promise<PmtilesDiscoveryResult> {
  const source = new PipelinePmtilesSource(
    client,
    identity.endpoint,
    identity.authorizationScopeDigest,
    limits,
    options.signal,
  );

  const decompressor = createBoundedPmtilesDecompressor(limits.maxDecompressedBytes, options.signal);
  let description: PmtilesArchiveDescription;
  try {
    description = await describePmtilesArchive(identity.endpoint, {
      source,
      decompress: decompressor.decompress,
    });
  } catch (cause) {
    if (options.signal?.aborted) throw new HonuaAbortError();
    if (isHonuaError(cause)) throw cause;
    if (isMissingPeerDependency(cause)) {
      throw new HonuaDiscoveryError(
        "unsupported-protocol",
        'PMTiles discovery requires the optional "pmtiles" peer dependency; install pmtiles alongside @honua/sdk-js.',
        { protocol: "pmtiles", reason: "missing-peer-dependency" },
        { cause },
      );
    }
    throw new HonuaDiscoveryError(
      "protocol-mismatch",
      "The classified asset did not contain a readable PMTiles v3 header and metadata document.",
      {
        protocol: "pmtiles",
        reason: cause instanceof SyntaxError ? "invalid-metadata" : "invalid-archive",
        alternateProtocolProbing: false,
      },
      { cause },
    );
  }

  const normalized = normalizeDescription(description, source, decompressor.bytesConsumed());
  const retrievedAt = new Date().toISOString();
  const provenance = Object.freeze([
    Object.freeze({
      source: identity.endpoint,
      retrievedAt,
      ...(normalized.validator ? { validator: normalized.validator } : {}),
    }),
  ]);
  const supported = normalized.tileKind !== "unknown";
  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: Object.freeze(supported ? (["tiles"] as const) : []),
      scope: Object.freeze(["tiles"] as const),
      provenance,
    }),
  ]);
  const metadata: DiscoverySourceMetadata = Object.freeze({
    extent: Object.freeze({
      spatial: Object.freeze({
        bbox: Object.freeze([normalized.bounds]),
        crs: "OGC:CRS84",
      }),
    }),
    pmtiles: normalized,
    ...(!supported
      ? {
          partialReasons: Object.freeze([PMTILES_UNKNOWN_TILE_KIND_REASON]),
        }
      : {}),
  });
  const sourceSnapshot: ConnectDiscoverySourceSnapshot = Object.freeze({
    id: "pmtiles",
    locator: Object.freeze({
      url: identity.endpoint,
      ...(normalized.tileKind === "mvt"
        ? { sourceType: "vector" as const }
        : normalized.tileKind !== "unknown"
          ? { sourceType: "raster" as const }
          : {}),
    }),
    ...(normalized.attribution ? { title: normalized.attribution } : {}),
    extent: metadata.extent,
    metadata,
    evidence,
  });

  return Object.freeze({
    retrievedAt,
    evidence,
    sources: Object.freeze([sourceSnapshot]),
  });
}

class PipelinePmtilesSource implements PmtilesSourceLike {
  readonly #client: HonuaClient;
  readonly #url: string;
  readonly #key: string;
  readonly #limits: PmtilesDiscoveryLimits;
  readonly #signal: AbortSignal | undefined;
  readonly #records: MutableRangeRecord[] = [];
  readonly #acceptedRanges: AcceptedRange[] = [];
  #requestsStarted = 0;
  #bytesBudgeted = 0;
  #bytesFetched = 0;
  #validator: string | undefined;
  #validatorObserved = false;
  #archiveLength: number | undefined;

  public constructor(
    client: HonuaClient,
    url: string,
    authorizationScopeDigest: string,
    limits: PmtilesDiscoveryLimits,
    signal: AbortSignal | undefined,
  ) {
    this.#client = client;
    this.#url = url;
    this.#key = `${url}#${authorizationScopeDigest}`;
    this.#limits = limits;
    this.#signal = signal;
  }

  public getKey(): string {
    return this.#key;
  }

  public validator(): string | undefined {
    return this.#validator;
  }

  public snapshot(decompressedBytes: number): PmtilesDiscoveryTransfer {
    return Object.freeze({
      requests: this.#requestsStarted,
      bytesFetched: this.#bytesFetched,
      decompressedBytes,
      ranges: Object.freeze(this.#records.map((record) => Object.freeze({ ...record }))),
    });
  }

  public async getBytes(
    offset: number,
    length: number,
    passedSignal?: AbortSignal,
    expectedEtag?: string,
  ): Promise<PmtilesRangeResponse> {
    validateRange(offset, length, this.#limits.maxRangeBytes);
    const signal = passedSignal ?? this.#signal;
    throwIfAborted(signal);

    const cached = this.#acceptedRanges.find(
      ({ record }) => record.offset <= offset && record.offset + record.length >= offset + length,
    );
    if (cached) {
      if (expectedEtag !== undefined && cached.etag !== expectedEtag) {
        throw discoveryRangeError("archive-version-changed", "PMTiles ETag changed during discovery.");
      }
      const relativeOffset = offset - cached.record.offset;
      return {
        data: cached.bytes.slice(relativeOffset, relativeOffset + length).buffer as ArrayBuffer,
        ...(cached.etag ? { etag: cached.etag } : {}),
      };
    }

    if (this.#records.length > 0 && this.#validator === undefined) {
      throw discoveryRangeError(
        "validator-required",
        "A strong ETag or canonical Last-Modified validator is required before fetching another PMTiles range.",
      );
    }
    if (this.#archiveLength !== undefined) {
      if (offset + length > this.#archiveLength) {
        throw discoveryRangeError("range-outside-archive", "PMTiles discovery requested bytes outside the archive.");
      }
      if (pmtilesRangesCoverWholeArchive([...this.#records, { offset, length }], this.#archiveLength)) {
        throw discoveryRangeError(
          "whole-file-disallowed",
          "PMTiles discovery will not materialize an entire archive across multiple ranges.",
        );
      }
    }

    let attemptsForRange = 0;
    let accepted: PreparedRangeResponse | undefined;
    await this.#client.pipelineFetch(
      "GET",
      this.#url,
      {
        headers: {
          Accept: "application/vnd.pmtiles, application/octet-stream;q=0.9",
          Range: `bytes=${offset}-${offset + length - 1}`,
        },
        cache: "no-store",
      },
      signal,
      {
        okStatuses: [200, 206, 416],
        redirect: "error",
        discardErrorBody: true,
        beforeAttempt: (request) => {
          throwIfAborted(signal);
          if (attemptsForRange > 0) {
            throw discoveryRangeError(
              "range-replay-disallowed",
              "PMTiles discovery does not replay a byte range after a retryable or authentication response.",
            );
          }
          if (
            request.method !== "GET" ||
            canonicalUrl(request.url) !== canonicalUrl(this.#url) ||
            new Headers(request.init.headers).get("range") !== `bytes=${offset}-${offset + length - 1}` ||
            request.init.cache !== "no-store"
          ) {
            throw discoveryRangeError(
              "request-mutated",
              "A client interceptor changed the bounded PMTiles request method, URL, range, or cache policy.",
            );
          }
          attemptsForRange += 1;
          this.#reservePhysicalAttempt(length);
        },
        beforeReplay: () => {
          throw discoveryRangeError(
            "range-replay-disallowed",
            "PMTiles discovery does not replay a byte range after a retryable or authentication response.",
          );
        },
        prepareResponse: async (response, deadlineSignal) => {
          accepted = await this.#prepareRangeResponse(response, offset, length, expectedEtag, deadlineSignal ?? signal);
          return boundedInterceptorResponse(response, accepted.bytes);
        },
      },
    );
    if (!accepted) {
      throw discoveryRangeError(
        "invalid-range-response",
        "PMTiles discovery did not retain its prepared bounded range response.",
      );
    }

    const { bytes, contentRange, validator, etag } = accepted;
    if (offset === 0 && (bytes[0] !== 0x50 || bytes[1] !== 0x4d)) {
      throw new HonuaDiscoveryError(
        "protocol-mismatch",
        "The classified asset does not have the PMTiles magic header.",
        { protocol: "pmtiles", reason: "invalid-magic", alternateProtocolProbing: false },
      );
    }
    const record: MutableRangeRecord = {
      offset,
      length,
      bytesReceived: bytes.byteLength,
      status: 206,
      contentRange,
      ...(validator ? { validator } : {}),
    };
    this.#records.push(record);
    this.#acceptedRanges.push(
      Object.freeze({
        record,
        bytes,
        ...(etag ? { etag } : {}),
      }),
    );
    this.#bytesFetched += bytes.byteLength;
    return {
      data: bytes.buffer as ArrayBuffer,
      ...(etag ? { etag } : {}),
    };
  }

  async #prepareRangeResponse(
    response: Response,
    offset: number,
    length: number,
    expectedEtag: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<PreparedRangeResponse> {
    if (response.type === "opaque" || response.type === "opaqueredirect") {
      await cancelBody(response);
      throw discoveryRangeError("unreadable-response", "PMTiles discovery requires readable CORS range responses.");
    }
    if (response.url && canonicalUrl(response.url) !== canonicalUrl(this.#url)) {
      await cancelBody(response);
      throw discoveryRangeError("redirect-disallowed", "PMTiles range requests must not redirect.");
    }
    if (response.status === 200 || response.status === 416) {
      await cancelBody(response);
      throw discoveryRangeError(
        response.status === 200 ? "range-unsupported" : "range-rejected",
        response.status === 200
          ? "The PMTiles host ignored the Range header; whole-file fallback is disabled."
          : "The PMTiles host rejected the requested byte range.",
      );
    }
    if (response.status !== 206) {
      await cancelBody(response);
      throw discoveryRangeError("invalid-range-response", `PMTiles discovery received HTTP ${response.status}.`);
    }

    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
      await cancelBody(response);
      throw discoveryRangeError(
        "compressed-range-response",
        "Compressed PMTiles range responses are not accepted because byte offsets would be ambiguous.",
      );
    }
    const contentRange = response.headers.get("content-range");
    const parsed = parseContentRange(contentRange);
    const expectedEnd = offset + length - 1;
    if (!parsed || parsed.start !== offset || parsed.end !== expectedEnd || parsed.total <= parsed.end) {
      await cancelBody(response);
      throw discoveryRangeError(
        "invalid-content-range",
        "PMTiles discovery requires the exact requested Content-Range and total archive size.",
      );
    }
    if (parsed.start === 0 && parsed.end + 1 === parsed.total) {
      await cancelBody(response);
      throw discoveryRangeError("whole-file-disallowed", "PMTiles discovery will not materialize an entire archive.");
    }
    if (this.#archiveLength !== undefined && this.#archiveLength !== parsed.total) {
      await cancelBody(response);
      throw discoveryRangeError("archive-version-changed", "PMTiles archive length changed during discovery.");
    }
    this.#archiveLength = parsed.total;
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== length)) {
      await cancelBody(response);
      throw discoveryRangeError(
        "invalid-content-length",
        "PMTiles range Content-Length does not match the requested byte range.",
      );
    }

    const validator = responseValidator(response.headers);
    if (this.#validatorObserved && validator?.identity !== this.#validator) {
      await cancelBody(response);
      throw discoveryRangeError("archive-version-changed", "PMTiles validator changed during discovery.");
    }
    if (expectedEtag !== undefined && (validator?.kind !== "etag" || validator.value !== expectedEtag)) {
      await cancelBody(response);
      throw discoveryRangeError("archive-version-changed", "PMTiles ETag changed during discovery.");
    }
    this.#validatorObserved = true;
    this.#validator = validator?.identity ?? this.#validator;

    const bytes = await readExactBody(response, length, signal);
    const etag = validator?.kind === "etag" ? validator.value : undefined;
    return Object.freeze({
      bytes,
      contentRange: contentRange!,
      ...(validator ? { validator: validator.identity } : {}),
      ...(etag ? { etag } : {}),
    });
  }

  #reservePhysicalAttempt(length: number): void {
    if (this.#requestsStarted >= this.#limits.maxRequests) {
      throw discoveryRangeError(
        "request-limit-exceeded",
        `PMTiles discovery exceeded its ${this.#limits.maxRequests}-request ceiling.`,
      );
    }
    if (this.#bytesBudgeted + length > this.#limits.maxTotalBytes) {
      throw discoveryRangeError(
        "byte-limit-exceeded",
        `PMTiles discovery would exceed its ${this.#limits.maxTotalBytes}-byte transfer ceiling.`,
      );
    }
    this.#requestsStarted += 1;
    this.#bytesBudgeted += length;
  }
}

function normalizeDescription(
  description: PmtilesArchiveDescription,
  source: PipelinePmtilesSource,
  decompressedBytes: number,
): PmtilesDiscoveryMetadata {
  const specVersion = description.specVersion;
  if (!Number.isSafeInteger(specVersion) || specVersion !== 3) {
    throw new HonuaDiscoveryError(
      "protocol-mismatch",
      "PMTiles discovery currently accepts only specification version 3 archives.",
      { protocol: "pmtiles", reason: "unsupported-spec-version", specVersion },
    );
  }
  const bounds = finiteTuple(description.bounds, 4, "bounds") as [number, number, number, number];
  if (
    bounds[0] < -180 ||
    bounds[2] > 180 ||
    bounds[1] < -90 ||
    bounds[3] > 90 ||
    bounds[0] > bounds[2] ||
    bounds[1] > bounds[3]
  ) {
    throw discoveryRangeError("invalid-header", "PMTiles bounds are outside OGC:CRS84.");
  }
  const minZoom = zoom(description.minZoom, "minZoom");
  const maxZoom = zoom(description.maxZoom, "maxZoom");
  if (minZoom > maxZoom) throw discoveryRangeError("invalid-header", "PMTiles minZoom exceeds maxZoom.");
  const center = finiteTuple(description.center, 3, "center") as [number, number, number];
  if (
    center[0] < -180 ||
    center[0] > 180 ||
    center[1] < -90 ||
    center[1] > 90 ||
    !Number.isInteger(center[2]) ||
    center[2] < 0 ||
    center[2] > 255
  ) {
    throw discoveryRangeError(
      "invalid-header",
      "PMTiles center must contain bounded longitude/latitude and an unsigned 8-bit display zoom.",
    );
  }
  if (description.vectorLayers.length > PMTILES_RETAINED_VECTOR_LAYER_ENTRIES) {
    throw discoveryRangeError(
      "invalid-metadata",
      `PMTiles metadata may describe at most ${PMTILES_RETAINED_VECTOR_LAYER_ENTRIES} vector layers.`,
    );
  }
  const vectorLayers = Object.freeze(description.vectorLayers.map(normalizeVectorLayer));
  if (pmtilesVectorLayerStructuralNodes(vectorLayers) > PMTILES_RETAINED_VECTOR_LAYER_NODES) {
    throw discoveryRangeError(
      "invalid-metadata",
      `PMTiles normalized vector-layer metadata exceeds its ${PMTILES_RETAINED_VECTOR_LAYER_NODES}-node retained-structure ceiling.`,
    );
  }
  const metadataJson = boundedMetadataJson(description.metadata, decompressedBytes);
  const transfer = source.snapshot(decompressedBytes);
  if (
    transfer.requests === 0 ||
    transfer.requests > DEFAULT_PM_TILES_DISCOVERY_LIMITS.maxRequests ||
    transfer.requests !== transfer.ranges.length ||
    transfer.bytesFetched !== transfer.ranges.reduce((total, range) => total + range.bytesReceived, 0) ||
    transfer.ranges[0]?.offset !== 0 ||
    transfer.ranges[0]?.length !== PMTILES_HEADER_REQUEST_BYTES
  ) {
    throw discoveryRangeError(
      "invalid-transfer",
      "PMTiles discovery did not produce the expected bounded header evidence.",
    );
  }
  return Object.freeze({
    specVersion,
    tileKind: description.tileKind,
    bounds: Object.freeze(bounds),
    minZoom,
    maxZoom,
    center: Object.freeze(center),
    vectorLayers,
    ...(description.attribution ? { attribution: boundedString(description.attribution, "attribution", 4096) } : {}),
    metadataJson,
    ...(source.validator() ? { validator: source.validator() } : {}),
    transfer,
  });
}

function boundedMetadataJson(value: Readonly<Record<string, unknown>>, maximumBytes: number): string {
  let serialized: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    serialized = JSON.stringify(value);
    const decoded: unknown = serialized === undefined ? undefined : JSON.parse(serialized);
    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      parsed = decoded as Record<string, unknown>;
    }
  } catch (cause) {
    throw discoveryRangeError("invalid-metadata", "PMTiles raw metadata must be JSON serializable.", cause);
  }
  if (serialized === undefined || parsed === undefined) {
    throw discoveryRangeError("invalid-metadata", "PMTiles raw metadata must be a JSON object.");
  }
  if (Array.isArray(parsed.vector_layers) && parsed.vector_layers.length > PMTILES_RETAINED_VECTOR_LAYER_ENTRIES) {
    throw discoveryRangeError(
      "invalid-metadata",
      `PMTiles raw metadata may contain at most ${PMTILES_RETAINED_VECTOR_LAYER_ENTRIES} vector layers.`,
    );
  }
  const retainedCeiling = Math.min(
    maximumBytes,
    DEFAULT_PM_TILES_DISCOVERY_LIMITS.maxDecompressedBytes,
    PMTILES_RETAINED_METADATA_JSON_BYTES,
  );
  if (new TextEncoder().encode(serialized).byteLength > retainedCeiling) {
    throw discoveryRangeError(
      "invalid-metadata",
      `PMTiles raw metadata exceeds its ${retainedCeiling}-byte retained-document ceiling.`,
    );
  }
  return serialized;
}

function normalizeVectorLayer(value: PmtilesVectorLayerInfo): PmtilesVectorLayerInfo {
  if (value.fields !== undefined && Object.keys(value.fields).length > 4096) {
    throw discoveryRangeError("invalid-metadata", "A PMTiles vector layer may describe at most 4096 fields.");
  }
  const fields =
    value.fields === undefined
      ? undefined
      : Object.freeze(
          Object.fromEntries(
            Object.entries(value.fields).map(([name, type]) => [
              boundedString(name, "vector layer field name", 1024),
              boundedString(type, "vector layer field type", 1024),
            ]),
          ),
        );
  const minZoom = value.minZoom !== undefined ? zoom(value.minZoom, "vector layer minZoom") : undefined;
  const maxZoom = value.maxZoom !== undefined ? zoom(value.maxZoom, "vector layer maxZoom") : undefined;
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
    throw discoveryRangeError("invalid-metadata", "PMTiles vector layer minZoom exceeds maxZoom.");
  }
  return Object.freeze({
    id: boundedString(value.id, "vector layer id", 1024),
    ...(value.description ? { description: boundedString(value.description, "vector layer description", 4096) } : {}),
    ...(minZoom !== undefined ? { minZoom } : {}),
    ...(maxZoom !== undefined ? { maxZoom } : {}),
    ...(fields ? { fields } : {}),
  });
}

/**
 * Count the exact values/containers the generic cache clone retains for the
 * normalized vector-layer subtree. The protocol-specific ceiling leaves
 * headroom inside the complete 10,000-node discovery-snapshot envelope.
 */
export function pmtilesVectorLayerStructuralNodes(layers: readonly PmtilesVectorLayerInfo[]): number {
  let nodes = 1;
  for (const layer of layers) {
    nodes += 2;
    if (layer.description !== undefined) nodes += 1;
    if (layer.minZoom !== undefined) nodes += 1;
    if (layer.maxZoom !== undefined) nodes += 1;
    if (layer.fields !== undefined) nodes += 1 + Object.keys(layer.fields).length;
  }
  return nodes;
}

function finiteTuple(value: readonly number[], length: number, label: string): number[] {
  if (value.length !== length || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw discoveryRangeError("invalid-header", `PMTiles ${label} must contain ${length} finite numbers.`);
  }
  return [...value];
}

function zoom(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 30) {
    throw discoveryRangeError("invalid-header", `PMTiles ${label} must be an integer from 0 through 30.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw discoveryRangeError("invalid-metadata", `PMTiles ${label} must contain 1-${maximum} characters.`);
  }
  return value;
}

function lowerPositiveInteger(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "PMTiles discovery limits must be positive safe integers no greater than their SDK ceilings.",
      { maximum, value },
    );
  }
  return value;
}

function validateRange(offset: number, length: number, maximum: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > maximum ||
    !Number.isSafeInteger(offset + length - 1)
  ) {
    throw discoveryRangeError(
      "range-limit-exceeded",
      `PMTiles byte ranges require a non-negative safe offset and a 1-${maximum} byte length.`,
    );
  }
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | undefined {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= 0) return undefined;
  return { start, end, total };
}

/** @internal Shared with cache replay validation. */
export function pmtilesRangesCoverWholeArchive(
  ranges: readonly { readonly offset: number; readonly length: number }[],
  archiveLength: number,
): boolean {
  const intervals = ranges
    .map(({ offset, length }) => ({ start: offset, end: offset + length }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (intervals[0]?.start !== 0) return false;
  let coveredUntil = 0;
  for (const interval of intervals) {
    if (interval.start > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, interval.end);
    if (coveredUntil >= archiveLength) return true;
  }
  return false;
}

interface BoundedPmtilesDecompressor {
  readonly decompress: (buffer: ArrayBuffer, compression: number) => Promise<ArrayBuffer>;
  bytesConsumed(): number;
}

function createBoundedPmtilesDecompressor(
  maximum: number,
  signal: AbortSignal | undefined,
): BoundedPmtilesDecompressor {
  let consumed = 0;
  const reserve = (length: number): void => {
    if (consumed + length > maximum) {
      throw discoveryRangeError(
        "decompression-limit-exceeded",
        `PMTiles internal metadata exceeds its ${maximum}-byte decompression ceiling.`,
      );
    }
    consumed += length;
  };

  const decompress = async (buffer: ArrayBuffer, compression: number): Promise<ArrayBuffer> => {
    throwIfAborted(signal);
    if (compression === 1) {
      reserve(buffer.byteLength);
      return buffer;
    }
    if (compression !== 2) {
      throw discoveryRangeError(
        "unsupported-internal-compression",
        "PMTiles discovery supports only uncompressed or gzip-compressed internal metadata.",
      );
    }
    if (typeof DecompressionStream === "undefined") {
      throw discoveryRangeError(
        "unsupported-internal-compression",
        "This runtime cannot safely stream gzip-compressed PMTiles metadata.",
      );
    }

    const body = new Response(buffer).body;
    if (!body) throw discoveryRangeError("invalid-compressed-metadata", "PMTiles gzip metadata has no readable body.");
    const reader = body.pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const abort = () => void reader.cancel().catch(() => undefined);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) throw new HonuaAbortError();
        const next = await reader.read();
        if (signal?.aborted) throw new HonuaAbortError();
        if (next.done) break;
        reserve(next.value.byteLength);
        total += next.value.byteLength;
        chunks.push(next.value);
      }
    } catch (cause) {
      await reader.cancel().catch(() => undefined);
      if (signal?.aborted) throw new HonuaAbortError();
      if (isHonuaError(cause)) throw cause;
      throw discoveryRangeError(
        "invalid-compressed-metadata",
        "PMTiles gzip metadata could not be decompressed.",
        cause,
      );
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output.buffer as ArrayBuffer;
  };
  return Object.freeze({
    decompress,
    bytesConsumed: () => consumed,
  });
}

function boundedInterceptorResponse(response: Response, bytes: Uint8Array): Response {
  return new Response(bytes.slice(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readExactBody(
  response: Response,
  expectedLength: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (!response.body) throw discoveryRangeError("invalid-range-response", "PMTiles range response has no body.");
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const output = new Uint8Array(expectedLength);
  let written = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new HonuaAbortError();
      const next = await reader.read();
      if (signal?.aborted) throw new HonuaAbortError();
      if (next.done) break;
      if (written + next.value.byteLength > expectedLength) {
        await reader.cancel().catch(() => undefined);
        throw discoveryRangeError(
          "range-overflow",
          `PMTiles range response exceeded its ${expectedLength}-byte ceiling.`,
        );
      }
      output.set(next.value, written);
      written += next.value.byteLength;
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    if (signal?.aborted) throw new HonuaAbortError();
    if (isHonuaError(cause)) throw cause;
    throw discoveryRangeError("invalid-range-response", "PMTiles range response stream failed.", cause);
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (written !== expectedLength) {
    throw discoveryRangeError(
      "invalid-range-response",
      `PMTiles range response ended after ${written} bytes; ${expectedLength} bytes were required.`,
    );
  }
  return output;
}

function responseValidator(headers: Headers): PmtilesDiscoveryValidator | undefined {
  const etag = headers.get("etag");
  const strongEtag = etag ? parsePmtilesValidatorIdentity(`etag:${etag}`) : undefined;
  if (strongEtag) return strongEtag;
  const lastModified = headers.get("last-modified");
  return lastModified ? parsePmtilesValidatorIdentity(`last-modified:${lastModified}`) : undefined;
}

/** Parse the only byte-identity validators direct PMTiles discovery retains. */
export function parsePmtilesValidatorIdentity(value: unknown): PmtilesDiscoveryValidator | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > PMTILES_VALIDATOR_CODE_UNITS) {
    return undefined;
  }
  if (value.startsWith("etag:")) {
    const etag = value.slice("etag:".length);
    if (!STRONG_ETAG_PATTERN.test(etag)) return undefined;
    return Object.freeze({ identity: value, kind: "etag" as const, value: etag });
  }
  if (value.startsWith("last-modified:")) {
    const lastModified = value.slice("last-modified:".length);
    const timestamp = Date.parse(lastModified);
    if (
      !IMF_FIXDATE_PATTERN.test(lastModified) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toUTCString() !== lastModified
    ) {
      return undefined;
    }
    return Object.freeze({ identity: value, kind: "last-modified" as const, value: lastModified });
  }
  return undefined;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function discoveryRangeError(reason: string, message: string, cause?: unknown): HonuaDiscoveryError {
  return new HonuaDiscoveryError(
    "invalid-endpoint",
    message,
    { protocol: "pmtiles", reason, alternateProtocolProbing: false },
    cause === undefined ? {} : { cause },
  );
}

function isMissingPeerDependency(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const code = "code" in cause ? String(cause.code) : "";
  const message = "message" in cause ? String(cause.message) : "";
  return code === "ERR_MODULE_NOT_FOUND" || /Cannot find (?:package|module).*pmtiles/i.test(message);
}
