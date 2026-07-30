import type { ColumnarBatchIdentityV1, ColumnarBatchLimits, ColumnarBatchV1 } from "./types.js";

export type { ColumnarBatchIdentityV1 } from "./types.js";

/** Honua's dependency-free mapping over GeoArrow format 0.2. */
export const HONUA_GEOARROW_LAYOUT_VERSION = "1.0" as const;

/** GeoArrow specification version implemented by this mapping. */
export const GEOARROW_SPEC_VERSION = "0.2" as const;

export type GeoArrowGeometryKind = "point" | "linestring" | "polygon";
export type GeoArrowDimensions = "xy" | "xyz" | "xym" | "xyzm";
export type GeoArrowCoordinateLayout = "interleaved" | "separated";
export type GeoArrowEdges = "planar" | "spherical" | "vincenty" | "thomas" | "andoyer" | "karney";
export type GeoArrowTimestampUnit = "second" | "millisecond" | "microsecond" | "nanosecond";

/** CRS metadata accepted by GeoArrow: preferably PROJJSON, or an opaque serialized CRS string. */
export type GeoArrowCrs = string | Readonly<Record<string, unknown>>;

/** Coordinate dimensions are ordered x, y, then z and/or m according to `dimensions`. */
export type GeoArrowPosition = readonly number[];
export type GeoArrowPoint = GeoArrowPosition;
export type GeoArrowLineString = readonly GeoArrowPosition[];
export type GeoArrowPolygon = readonly (readonly GeoArrowPosition[])[];

export interface GeoArrowGeometryColumnBase {
  readonly field?: string;
  readonly dimensions?: GeoArrowDimensions;
  /** Both official layouts are supported; separated is the GeoArrow-recommended default. */
  readonly coordinateLayout?: GeoArrowCoordinateLayout;
  readonly crs?: GeoArrowCrs;
  readonly edges?: GeoArrowEdges;
}

export interface GeoArrowPointColumnInput extends GeoArrowGeometryColumnBase {
  readonly kind: "point";
  readonly values: readonly (GeoArrowPoint | null)[];
}

export interface GeoArrowLineStringColumnInput extends GeoArrowGeometryColumnBase {
  readonly kind: "linestring";
  readonly values: readonly (GeoArrowLineString | null)[];
}

export interface GeoArrowPolygonColumnInput extends GeoArrowGeometryColumnBase {
  readonly kind: "polygon";
  readonly values: readonly (GeoArrowPolygon | null)[];
}

export type GeoArrowGeometryColumnInput =
  | GeoArrowPointColumnInput
  | GeoArrowLineStringColumnInput
  | GeoArrowPolygonColumnInput;

export interface GeoArrowTemporalColumnInput {
  readonly field: string;
  readonly unit: GeoArrowTimestampUnit;
  readonly timezone?: string;
  /** Signed Arrow timestamp values in the declared unit. */
  readonly values: readonly (bigint | null)[];
}

export interface GeoArrowDictionaryColumnInput {
  readonly field: string;
  readonly ordered?: boolean;
  readonly values: readonly (string | null)[];
}

export interface GeoArrowFeatureIdColumnInput {
  readonly field: string;
  readonly values: ArrayLike<number>;
}

/** Semantic input converted into one normative, independently transferable batch. */
export interface CreateGeoArrowBatchInput {
  readonly id: string;
  readonly sequence: number;
  readonly rowOffset?: number;
  readonly schemaId: string;
  readonly identity: ColumnarBatchIdentityV1;
  readonly geometry: GeoArrowGeometryColumnInput;
  readonly temporal?: GeoArrowTemporalColumnInput;
  readonly dictionary?: GeoArrowDictionaryColumnInput;
  readonly featureIds?: GeoArrowFeatureIdColumnInput;
}

/** Every semantic conversion is bounded; there is no opt-out or unbounded sentinel. */
export interface GeoArrowConversionLimits extends ColumnarBatchLimits {
  readonly maxVertices?: number;
  readonly maxRings?: number;
  readonly maxDictionaryValues?: number;
  /** Exact ceiling for newly allocated payload buffers. */
  readonly maxCopiedBytes?: number;
}

export interface GeoArrowConversionMetrics {
  readonly rows: number;
  readonly vertices: number;
  readonly rings: number;
  readonly dictionaryValues: number;
  /** Exact bytes allocated and populated by semantic-to-columnar conversion. */
  readonly copiedBytes: number;
  readonly backingBytes: number;
}

export interface CreatedGeoArrowBatch {
  readonly batch: ColumnarBatchV1;
  readonly metrics: GeoArrowConversionMetrics;
}

export interface DecodedGeoArrowRow {
  readonly geometry: GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon | null;
  readonly timestamp?: bigint | null;
  readonly dictionaryValue?: string | null;
  readonly featureId?: number;
}

export interface DecodedGeoArrowBatch {
  readonly rows: readonly DecodedGeoArrowRow[];
  readonly metrics: Omit<GeoArrowConversionMetrics, "copiedBytes" | "backingBytes"> & {
    /** No payload buffer is copied; this count makes row-object materialization explicit. */
    readonly materializedRows: number;
  };
}

export interface GeoArrowGeometryBuffers {
  readonly kind: GeoArrowGeometryKind;
  readonly field: string;
  readonly dimensions: GeoArrowDimensions;
  readonly coordinateLayout: GeoArrowCoordinateLayout;
  readonly crs?: GeoArrowCrs;
  readonly edges: GeoArrowEdges;
  readonly validity?: Uint8Array;
  readonly offsets?: Int32Array;
  readonly ringOffsets?: Int32Array;
  readonly coordinates: Readonly<Record<"x" | "y" | "z" | "m" | "interleaved", Float64Array | undefined>>;
}

export interface GeoArrowTemporalBuffers {
  readonly field: string;
  readonly unit: GeoArrowTimestampUnit;
  readonly timezone?: string;
  readonly validity?: Uint8Array;
  readonly values: BigInt64Array;
}

export interface GeoArrowDictionaryBuffers {
  readonly field: string;
  readonly ordered: boolean;
  readonly validity?: Uint8Array;
  readonly indices: Int32Array;
  readonly offsets: Int32Array;
  readonly values: Uint8Array;
}

/** Validated typed views that alias the batch's own backing buffers. */
export interface GeoArrowBatchInspection {
  readonly batch: ColumnarBatchV1;
  readonly geometry: GeoArrowGeometryBuffers;
  readonly temporal?: GeoArrowTemporalBuffers;
  readonly dictionary?: GeoArrowDictionaryBuffers;
  readonly featureIds?: { readonly field: string; readonly values: Uint32Array };
  readonly metrics: GeoArrowConversionMetrics;
}

/** Structural Apache Arrow data node used without importing peer declarations. */
export interface ApacheArrowDataLike {
  readonly length: number;
  readonly offset: number;
  readonly values?: ArrayBufferView;
  readonly nullBitmap?: Uint8Array;
  readonly valueOffsets?: Int32Array;
  readonly children: readonly ApacheArrowDataLike[];
  readonly dictionary?: ApacheArrowVectorLike;
}

/** Structural Apache Arrow vector used by the optional adapter. */
export interface ApacheArrowVectorLike {
  readonly length: number;
  readonly data: readonly ApacheArrowDataLike[];
}

export interface ApacheArrowFieldLike {
  readonly name: string;
  readonly nullable: boolean;
  readonly metadata: ReadonlyMap<string, string>;
  readonly type: ApacheArrowTypeLike;
}

/** Structural Arrow type metadata needed for schema-safe zero-copy import. */
export interface ApacheArrowTypeLike {
  toString(): string;
  readonly children?: readonly ApacheArrowFieldLike[];
  readonly isOrdered?: boolean;
}

/** Minimum RecordBatch surface accepted and returned by the adapter. */
export interface ApacheArrowRecordBatchLike {
  readonly numRows: number;
  readonly schema: {
    readonly fields: readonly ApacheArrowFieldLike[];
    readonly metadata: ReadonlyMap<string, string>;
  };
  getChildAt(index: number): ApacheArrowVectorLike | null;
}

/** Opaque module namespace for an injected Apache Arrow implementation. */
export type ApacheArrowModuleLike = Readonly<Record<string, unknown>>;
export type ApacheArrowModuleImporter = (specifier: string) => Promise<unknown>;

export interface LoadApacheArrowOptions {
  readonly importModule?: ApacheArrowModuleImporter;
}

export interface ApacheArrowAdapterOptions extends LoadApacheArrowOptions {
  readonly module?: ApacheArrowModuleLike;
}

export interface ApacheArrowAdapterMetrics {
  readonly rows: number;
  readonly backingBytes: number;
  readonly referencedBytes: number;
  /** Exact payload bytes copied to isolate a foreign shared/padded backing. */
  readonly copiedBytes: number;
}

export interface ApacheArrowRecordBatchResult {
  readonly recordBatch: ApacheArrowRecordBatchLike;
  readonly metrics: ApacheArrowAdapterMetrics;
}

export interface FromApacheArrowRecordBatchOptions {
  /** Required with `schemaId` and `identity` when importing a non-Honua RecordBatch. */
  readonly id?: string;
  readonly sequence?: number;
  readonly rowOffset?: number;
  /** Required with `id` and `identity` when importing a non-Honua RecordBatch. */
  readonly schemaId?: string;
  /** Required with `id` and `schemaId` when importing a non-Honua RecordBatch. */
  readonly identity?: ColumnarBatchIdentityV1;
  readonly limits?: GeoArrowConversionLimits;
}

export interface GeoArrowBatchFromApacheResult {
  readonly batch: ColumnarBatchV1;
  readonly metrics: ApacheArrowAdapterMetrics;
}

export type HonuaGeoArrowErrorCode =
  | "invalid-input"
  | "invalid-batch"
  | "unsupported-layout"
  | "row-limit-exceeded"
  | "vertex-limit-exceeded"
  | "ring-limit-exceeded"
  | "dictionary-limit-exceeded"
  | "copy-limit-exceeded"
  | "missing-peer";

/** Typed failures for layout drift, conversion bounds, and optional peers. */
export class HonuaGeoArrowError extends Error {
  public constructor(
    public readonly code: HonuaGeoArrowErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaGeoArrowError";
  }
}
