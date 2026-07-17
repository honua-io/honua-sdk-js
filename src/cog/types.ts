import type {
  StacAssetClassificationEvidence,
  StacAssetConfidence,
  StacStaticObjectType,
} from "../connect-stac-static.js";
import type { DiscoveryProvenance } from "../contract/discovery.js";

/** Numeric raster storage types accepted at the decoder boundary. */
export type CogDataType = "uint8" | "int8" | "uint16" | "int16" | "uint32" | "int32" | "float32" | "float64";

/** Typed arrays a decoder may return for one raster band. */
export type CogSampleArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

export type CogNoDataValue = number | string | null;

export interface CogBand {
  /** One-based band index. */
  readonly index: number;
  readonly dataType: CogDataType;
  readonly name?: string;
  readonly description?: string;
  readonly colorInterpretation?: string;
  readonly unit?: string;
  readonly nodata?: CogNoDataValue;
  readonly scale?: number;
  readonly offset?: number;
}

/** Known CRS information returned by the injected decoder. */
export interface CogKnownCrs {
  readonly kind: "known";
  readonly authority?: string;
  readonly code?: string;
  readonly name?: string;
  readonly wkt?: string;
}

/** Explicit decoder signal that the CRS cannot be represented safely. */
export interface CogUnsupportedCrs {
  readonly kind: "unsupported";
  readonly description: string;
}

export type CogDecodedCrs = CogKnownCrs | CogUnsupportedCrs;
export type CogCrs = CogKnownCrs;

export interface CogResolution {
  /** Positive pixel width in CRS units. */
  readonly x: number;
  /** Positive pixel height in CRS units. */
  readonly y: number;
  readonly unit?: string;
}

export type CogPosition = readonly [number, number] | readonly [number, number, number];
export type CogLinearRing = readonly CogPosition[];
export type CogPolygonCoordinates = readonly CogLinearRing[];

export type CogFootprint =
  | {
      readonly type: "Polygon";
      readonly coordinates: CogPolygonCoordinates;
    }
  | {
      readonly type: "MultiPolygon";
      readonly coordinates: readonly CogPolygonCoordinates[];
    };

/** A single bounded byte range requested from the asset. */
export interface CogByteRangeRequest {
  readonly offset: number;
  readonly length: number;
}

/** Decoder-visible byte reader. Honua owns and bounds its HTTP implementation. */
export type CogRangeReader = (request: CogByteRangeRequest) => Promise<Uint8Array>;

/** Metadata returned by an injected COG decoder before Honua validation. */
export interface CogDecodedMetadata {
  /** `geotiff` and `unsupported` are explicit fail-closed outcomes. */
  readonly format: "cog" | "geotiff" | "unsupported";
  readonly width: number;
  readonly height: number;
  readonly crs: CogDecodedCrs;
  readonly bands: readonly CogBand[];
  readonly resolution: CogResolution;
  readonly footprint: CogFootprint;
  /** Full-resolution is level zero; values must be positive and strictly increasing. */
  readonly overviewDecimations?: readonly number[];
}

export interface CogWindowRequest {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** One-based band indices. Omission means every inspected band. */
  readonly bands?: readonly number[];
  /**
   * Optional bounded decoder output. The native pixel window remains
   * `x`/`y`/`width`/`height`; this contract lets an injected decoder select an
   * advertised overview and return only the requested render-sized pixels.
   */
  readonly sampling?: CogWindowSampling;
}

export type CogResampling = "nearest" | "bilinear";

export interface CogWindowSampling {
  readonly width: number;
  readonly height: number;
  readonly resampling: CogResampling;
  /** `1` means the full-resolution image; larger values must be advertised overviews. */
  readonly overviewDecimation: number;
}

export interface CogDecodedBandWindow {
  readonly band: number;
  readonly values: CogSampleArray;
}

/** Window payload returned by an injected decoder before Honua validation. */
export interface CogDecodedWindow {
  readonly width: number;
  readonly height: number;
  readonly bands: readonly CogDecodedBandWindow[];
}

export interface CogDecoderInspectContext {
  readonly signal: AbortSignal;
  readonly readRange: CogRangeReader;
}

export interface CogDecoderReadContext {
  readonly signal: AbortSignal;
  readonly readRange: CogRangeReader;
  readonly metadata: CogDecodedMetadata;
}

/**
 * Minimal structurally typed decoder contract. A GeoTIFF implementation can be
 * adapted here without becoming a static dependency of the SDK.
 */
export interface CogDecoder {
  inspect(context: CogDecoderInspectContext): Promise<CogDecodedMetadata>;
  readWindow(request: CogWindowRequest, context: CogDecoderReadContext): Promise<CogDecodedWindow>;
  dispose?(): void | Promise<void>;
}

export interface CogDecoderFactoryContext {
  readonly assetUrl: string;
  /** Session-lifecycle signal; per-operation signals are supplied to decoder methods. */
  readonly signal: AbortSignal;
}

export type CogDecoderFactory = (context: CogDecoderFactoryContext) => CogDecoder | Promise<CogDecoder>;

export interface CogTransferLimits {
  readonly maxMetadataRequests: number;
  readonly maxWindowRequests: number;
  readonly maxRangeBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxWindowBytes: number;
  readonly maxTotalBytes: number;
  readonly maxWindowPixels: number;
  readonly maxDecodedBytes: number;
}

export type CogTransferLimitOptions = Partial<CogTransferLimits>;

export type CogRangePurpose = "metadata" | "window";

export interface CogRangeRecord {
  /** Monotonic request-start order; stable even when requests complete out of order. */
  readonly sequence: number;
  readonly purpose: CogRangePurpose;
  readonly offset: number;
  readonly length: number;
  readonly bytesReceived: number;
  readonly outcome: "success" | "rejected" | "aborted";
  readonly status?: number;
  readonly contentRange?: string;
  readonly validator?: string;
  readonly errorCode?: string;
}

/** Deterministic transfer ledger. It intentionally contains no wall-clock fields. */
export interface CogTransferLedger {
  readonly requests: number;
  readonly bytesFetched: number;
  readonly metadataRequests: number;
  readonly metadataBytes: number;
  readonly windowRequests: number;
  readonly windowBytes: number;
  readonly ranges: readonly CogRangeRecord[];
}

export interface CogStacProvenance {
  readonly candidateId: string;
  readonly assetUrl: string;
  readonly documentUrl: string;
  readonly objectType: StacStaticObjectType;
  readonly objectId: string;
  readonly assetKey: string;
  readonly collectionId?: string;
  readonly itemId?: string;
  readonly mediaType?: string;
  readonly confidence: StacAssetConfidence;
  readonly roles: readonly string[];
  readonly evidence: readonly StacAssetClassificationEvidence[];
  readonly discovery: readonly DiscoveryProvenance[];
}

export interface CogProvenance {
  readonly stac: CogStacProvenance;
  /** Stable validator observed across successful range responses, when exposed. */
  readonly assetValidator?: string;
}

export interface CogInspection {
  readonly format: "cog";
  readonly width: number;
  readonly height: number;
  readonly crs: CogCrs;
  readonly bands: readonly CogBand[];
  readonly resolution: CogResolution;
  readonly footprint: CogFootprint;
  readonly overviewDecimations: readonly number[];
  readonly provenance: CogProvenance;
  readonly transfer: CogTransferLedger;
}

export interface CogBandWindow {
  readonly band: number;
  readonly values: CogSampleArray;
}

export interface CogWindowResult {
  readonly window: CogWindowRequest;
  readonly width: number;
  readonly height: number;
  readonly bands: readonly CogBandWindow[];
  readonly provenance: CogProvenance;
  readonly transfer: CogTransferLedger;
}

export interface CogOperationOptions {
  readonly signal?: AbortSignal;
}

export interface OpenStacCogAssetOptions {
  readonly decoderFactory: CogDecoderFactory;
  readonly fetchFn?: typeof fetch;
  readonly limits?: CogTransferLimitOptions;
}
