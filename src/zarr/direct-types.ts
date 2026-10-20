import type { CogSampleArray } from "../cog/types.js";

/** Reviewed direct-reader bounds. Callers may only tighten these up to the hard caps. */
export interface ZarrDirectLimits {
  /** Metadata documents fetched while discovering the store. */
  readonly maxMetadataRequests: number;
  /** Chunk objects fetched for one subset. */
  readonly maxChunkRequests: number;
  /** Metadata plus chunk HTTP requests for the session. */
  readonly maxRequests: number;
  /** One metadata document, in bytes. */
  readonly maxMetadataBytes: number;
  /** One range or chunk response, in bytes. */
  readonly maxRangeBytes: number;
  /** Cumulative response bytes for the session. */
  readonly maxTotalBytes: number;
  /** Decoded payload bytes for one subset, including every selected chunk. */
  readonly maxDecodedBytes: number;
  /** Spatial samples, width times height times selected bands. */
  readonly maxPixels: number;
  /** Chunks touched by one subset. */
  readonly maxChunks: number;
}

export type ZarrDirectLimitOptions = Partial<ZarrDirectLimits>;

export type ZarrAxisRole = "x" | "y" | "time" | "band" | "other";
export type ZarrDirectFormat = 2 | 3;
export type ZarrCodecStatus = "supported" | "injected" | "unsupported";
export type ZarrLayoutStatus = "supported" | "unsupported";

/**
 * Structural support is the reviewed version, layout, and codec matrix.
 * An array can be structurally versioned and still be refused for its codec or layout.
 * Server-facade planning and live execution are not this reader.
 */
export interface ZarrDirectCapability {
  readonly versions: readonly ZarrDirectFormat[];
  readonly layouts: readonly string[];
  readonly codecs: readonly string[];
  readonly refusedCodecs: readonly string[];
  readonly refusedLayouts: readonly string[];
  readonly serverExecution: "separately-owned";
  readonly selected?: {
    readonly variable: string;
    readonly structural: "supported";
    readonly layout: ZarrLayoutStatus;
    readonly codec: ZarrCodecStatus;
  };
}

export interface ZarrChunkCodec {
  /** Codec id matched against a v2 compressor or filter, or a v3 codec name. */
  readonly id: string;
  /** Returns the chunk's uncompressed little-endian payload. */
  decode(input: Uint8Array, signal: AbortSignal): Uint8Array | Promise<Uint8Array>;
}

export interface ZarrDirectDimension {
  readonly name: string;
  readonly size: number;
  readonly chunk: number;
  readonly role: ZarrAxisRole;
  readonly unit?: string;
  readonly coordinates?: readonly number[];
}

export interface ZarrDirectBand {
  /** One-based band index. */
  readonly index: number;
  readonly name: string;
  readonly variable: string;
  readonly dtype: string;
  readonly nodata: number | null;
}

export interface ZarrDirectVariable {
  readonly name: string;
  readonly dtype: string;
  readonly shape: readonly number[];
  readonly chunks: readonly number[];
  readonly dimensions: readonly string[];
  readonly compressor: string | null;
  readonly nodata: number | null;
  readonly codec: ZarrCodecStatus;
  readonly layout: ZarrLayoutStatus;
}

export interface ZarrDirectTemporal {
  readonly dimension: string;
  readonly start: string;
  readonly end: string | null;
  readonly stepSeconds: number;
  readonly size: number;
}

export interface ZarrTransferRecord {
  readonly sequence: number;
  readonly purpose: "metadata" | "chunk";
  /** Store-relative key. Query credentials are never recorded. */
  readonly key: string;
  readonly range: string;
  readonly bytesReceived: number;
  readonly outcome: "success" | "missing" | "rejected" | "aborted";
  readonly status?: number;
}

/** Deterministic transfer ledger. It has no wall-clock fields and no credential-bearing URLs. */
export interface ZarrTransferLedger {
  readonly requests: number;
  readonly bytesFetched: number;
  readonly metadataRequests: number;
  readonly metadataBytes: number;
  readonly chunkRequests: number;
  readonly chunkBytes: number;
  readonly ranges: readonly ZarrTransferRecord[];
}

export interface ZarrDirectProgress {
  readonly phase: "metadata" | "planned" | "chunk" | "refused" | "completed" | "aborted";
  readonly requests: number;
  readonly bytesFetched: number;
  readonly chunksPlanned: number;
  readonly chunksFetched: number;
}

export interface ZarrDirectInspection {
  readonly format: ZarrDirectFormat;
  /** Redacted store URL. Userinfo is rejected and secret query parameters are removed. */
  readonly url: string;
  readonly cacheIdentity: string;
  readonly crs: { readonly authority: "EPSG" | "OGC"; readonly code: string } | null;
  readonly extent: readonly [number, number, number, number] | null;
  readonly primaryVariable: string;
  readonly variables: readonly ZarrDirectVariable[];
  readonly dimensions: readonly ZarrDirectDimension[];
  readonly bands: readonly ZarrDirectBand[];
  readonly temporal: ZarrDirectTemporal | null;
  readonly transfer: ZarrTransferLedger;
  readonly capability: ZarrDirectCapability;
}

export interface ZarrPixelWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ZarrTimeIndex {
  readonly index: number;
}

export interface ZarrTimeRange {
  readonly start: string;
  readonly stop?: string;
}

export interface ZarrDirectWindowRequest {
  readonly variable?: string;
  /** One-based. Required when the selected variable has more than one band. */
  readonly bands?: readonly number[];
  readonly pixel?: ZarrPixelWindow;
  readonly bbox?: readonly [number, number, number, number];
  /** Inclusive start and exclusive stop along every array axis, in index space. */
  readonly index?: { readonly start: readonly number[]; readonly stop: readonly number[] };
  readonly time?: ZarrTimeIndex | ZarrTimeRange;
}

export interface ZarrDirectSubsetRequest {
  readonly variable?: string;
  readonly start: readonly number[];
  readonly stop: readonly number[];
}

/** Native samples are little-endian. The MapLibre PNG is a separate lossy presentation. */
export interface ZarrFidelity {
  readonly source: "zarr-direct";
  readonly samples: "native";
  readonly dtype: string;
  readonly nodata: number | null;
  readonly resampling: "nearest";
  readonly presentation: "uint8-png";
  readonly lossyPresentation: true;
  readonly crs: string | null;
}

export interface ZarrProvenance {
  readonly storeUrl: string;
  readonly cacheIdentity: string;
  readonly variable: string;
  readonly zarrFormat: ZarrDirectFormat;
  readonly chunks: readonly string[];
  readonly bytesFetched: number;
  readonly requests: number;
}

export interface ZarrDirectWindowBand {
  readonly band: number;
  readonly values: CogSampleArray;
}

export interface ZarrDirectWindowResult {
  readonly request: ZarrDirectWindowRequest;
  readonly variable: string;
  readonly width: number;
  readonly height: number;
  readonly dtype: string;
  readonly nodata: number | null;
  readonly bands: readonly ZarrDirectWindowBand[];
  /** Resolved index window. Row 0 is the northern row when an extent is present. */
  readonly pixel: ZarrPixelWindow;
  readonly fidelity: ZarrFidelity;
  readonly provenance: ZarrProvenance;
  readonly transfer: ZarrTransferLedger;
  readonly cacheIdentity: string;
}

export interface ZarrDirectSubsetResult {
  readonly variable: string;
  readonly shape: readonly number[];
  readonly dtype: string;
  readonly nodata: number | null;
  readonly bytes: Uint8Array;
  readonly chunks: readonly string[];
  readonly fidelity: ZarrFidelity;
  readonly provenance: ZarrProvenance;
  readonly transfer: ZarrTransferLedger;
  readonly cacheIdentity: string;
}

export type ZarrMapLibreCoordinates = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

export interface ZarrMapLibreHandoff {
  readonly type: "image";
  readonly url: string;
  readonly coordinates: ZarrMapLibreCoordinates;
  readonly fidelity: ZarrFidelity;
  readonly provenance: ZarrProvenance;
}

export interface ZarrDirectOperationOptions {
  readonly signal?: AbortSignal;
}

export interface OpenDirectZarrStoreOptions {
  readonly url: string;
  readonly fetchFn?: typeof fetch;
  readonly limits?: ZarrDirectLimitOptions;
  readonly codecs?: readonly ZarrChunkCodec[];
  /** Caller cache key mixed into the cache identity. It is not sent to storage. */
  readonly cacheKey?: string;
  readonly variable?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ZarrDirectProgress) => void;
}
