/**
 * Structural contract for the optional Kepler.gl analytics-workspace bridge.
 *
 * Nothing in this module imports `kepler.gl`, `react`, `react-dom`, or
 * `redux`. Every Kepler-facing value is described by a minimal structural
 * interface so the SDK can project a Honua result into Kepler's ingestion and
 * configuration model without pulling an analytics UI stack into any Honua
 * entrypoint. Callers (or {@link loadKeplerPeers}) supply the real peers.
 *
 * @experimental
 * @module
 */

/** Bridge contract version. Bumped when the projection shapes change. */
export const KEPLER_BRIDGE_CONTRACT_VERSION = "1.0" as const;

/**
 * Declared Kepler.gl compatibility range (NFR-001). The bridge targets the
 * Kepler 3.x ingestion model (`addDataToMap` proto datasets with
 * `{ fields, rows }`, `timeRange`/`range`/`select`/`multiSelect` filters,
 * `mapState`, and `mapStyle.mapStyles`).
 */
export const KEPLER_COMPATIBILITY_RANGE = Object.freeze({
  minimum: "3.0.0",
  exclusiveMaximum: "4.0.0",
});

// ── Kepler structural shapes ──────────────────────────────────

/**
 * Kepler field types the bridge emits. Kepler's own vocabulary is wider
 * (`h3`, `geoarrow`, …); anything absent here is reported as an unsupported
 * mapping rather than guessed at.
 */
export type KeplerFieldType = "boolean" | "date" | "geojson" | "integer" | "point" | "real" | "string" | "timestamp";

/** Minimal Kepler field descriptor accepted by `addDataToMap`. */
export interface KeplerField {
  readonly name: string;
  readonly type: KeplerFieldType;
  /** Kepler's display/parse format hint. Empty string for untyped columns. */
  readonly format: string;
  readonly analyzerType?: string;
  readonly displayName?: string;
}

/** Row-major tabular payload — Kepler's native `{ fields, rows }` ingestion shape. */
export interface KeplerDatasetData {
  readonly fields: readonly KeplerField[];
  readonly rows: ReadonlyArray<readonly unknown[]>;
}

export interface KeplerDatasetInfo {
  readonly id: string;
  readonly label: string;
}

/**
 * Kepler `ProtoDataset`. `metadata` carries the Honua provenance record; it is
 * deliberately credential-free (see {@link KeplerSourceProvenance}).
 */
export interface KeplerProtoDataset {
  readonly info: KeplerDatasetInfo;
  readonly data: KeplerDatasetData;
  readonly metadata: KeplerDatasetMetadata;
}

/** Kepler map state (`mapState` in a saved map / `updateMap` payload). */
export interface KeplerMapState {
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
  readonly bearing: number;
  readonly pitch: number;
}

/** Kepler filter value shapes the bridge round-trips. */
export type KeplerFilterType = "range" | "select" | "multiSelect" | "timeRange";

export interface KeplerFilter {
  readonly id: string;
  readonly dataId: readonly string[];
  readonly name: readonly string[];
  readonly type: KeplerFilterType;
  readonly value: unknown;
}

/** Opaque plain-object Redux action produced by a Kepler action creator. */
export interface KeplerAction {
  readonly type: unknown;
}

// ── Provenance, CRS, attribution (REQ-003) ────────────────────

/**
 * CRS decision recorded for every projection. Kepler renders in WGS84
 * lon/lat only, so the bridge never silently reprojects: a non-WGS84 input
 * is rejected with `unsupported-crs`.
 */
export interface KeplerCrsDecision {
  /** Caller-declared input CRS, verbatim. */
  readonly requested: string;
  /** CRS of the emitted rows. Always `"EPSG:4326"` when geometry is projected. */
  readonly applied: string;
  readonly reprojected: boolean;
  readonly reason: string;
}

/** Freshness validators carried through to the workspace. */
export interface KeplerFreshness {
  readonly observedAt: string;
  readonly staleAfter?: string;
  readonly validator?: string;
  readonly generation?: string;
}

/**
 * Source, plan, schema, and authorization identity retained alongside every
 * projected dataset.
 *
 * `authorizationScope` is an opaque, non-secret scope fingerprint — never a
 * bearer token, cookie, API key, or signed URL. The bridge validates this and
 * refuses credential-shaped values.
 */
export interface KeplerSourceProvenance {
  readonly sourceId: string;
  readonly sourceVersion?: string;
  readonly schemaVersion?: string;
  readonly planId?: string;
  readonly planFingerprint?: string;
  readonly authorizationScope?: string;
  readonly attribution?: string;
  readonly protocol?: string;
  readonly freshness?: KeplerFreshness;
  /** Capability degradations reported by the source that produced the rows. */
  readonly degraded?: readonly KeplerDegradedNote[];
}

export interface KeplerDegradedNote {
  readonly capability: string;
  readonly reason: string;
}

/** Kepler `ProtoDataset.metadata` written by the bridge. */
export interface KeplerDatasetMetadata {
  readonly honuaBridgeVersion: typeof KEPLER_BRIDGE_CONTRACT_VERSION;
  readonly provenance: KeplerSourceProvenance;
  readonly crs: KeplerCrsDecision;
  readonly ingestion: KeplerIngestionDiagnostic;
  /** Temporal fields Kepler can animate/filter, in field order. */
  readonly temporalFields: readonly string[];
  /** Field carrying stable row identity, when one was declared. */
  readonly rowIdentityField?: string;
  /** Columns a Kepler point layer should bind to, when geometry arrived as a lon/lat pair. */
  readonly pointColumns?: { readonly longitude: string; readonly latitude: string };
}

// ── Ingestion strategies + diagnostics (REQ-002) ──────────────

/**
 * How a projection reached Kepler's ingestion model.
 *
 * - `row-object-direct` — attribute/aggregate rows straight into
 *   `{ fields, rows }`. No geometry, no GeoJSON.
 * - `point-columns-direct` — point geometry split into `longitude`/`latitude`
 *   real columns. No GeoJSON.
 * - `columnar-columns-direct` — a columnar artifact transposed column-wise
 *   into rows. No GeoJSON.
 * - `geojson-column` — non-point geometry serialized into a Kepler `geojson`
 *   column. This is the measured fallback.
 * - `remote-basemap-style` — a remote raster/style source projected into a
 *   Kepler custom `mapStyles` entry.
 * - `remote-vector-tileset` — a remote vector tile source projected into a
 *   Kepler tileset dataset descriptor.
 */
export type KeplerIngestionStrategy =
  | "row-object-direct"
  | "point-columns-direct"
  | "columnar-columns-direct"
  | "geojson-column"
  | "remote-basemap-style"
  | "remote-vector-tileset";

export type KeplerFidelityLossKind =
  | "geometry-serialized-to-geojson"
  | "unsupported-field-type"
  | "unsupported-column-layout"
  | "numeric-precision-narrowed"
  | "nested-value-stringified"
  | "row-limit-truncated"
  | "null-geometry-dropped";

export interface KeplerFidelityLoss {
  readonly kind: KeplerFidelityLossKind;
  readonly field?: string;
  readonly detail: string;
}

/**
 * Per-projection execution record. `geoJsonBytes` is the measured evidence
 * for REQ-002: `0` proves the direct path performed no GeoJSON round trip.
 */
export interface KeplerIngestionDiagnostic {
  readonly strategy: KeplerIngestionStrategy;
  readonly geoJsonRoundTrip: boolean;
  /** UTF-8 bytes of serialized GeoJSON. Always `0` on a direct path. */
  readonly geoJsonBytes: number;
  readonly fidelity: "exact" | "lossy";
  readonly rows: number;
  readonly fields: number;
  readonly losses: readonly KeplerFidelityLoss[];
  readonly reason: string;
}

/** Declared support for one ingestion strategy. */
export interface KeplerBridgeCapability {
  readonly strategy: KeplerIngestionStrategy | "arrow-columns-zero-copy";
  readonly supported: boolean;
  readonly geoJsonRoundTrip: boolean;
  readonly reason: string;
}

// ── Projection requests ───────────────────────────────────────

/** Row identity + geometry declarations shared by the tabular projections. */
export interface KeplerProjectionShape {
  readonly datasetId: string;
  readonly label?: string;
  /** Input CRS. Only `EPSG:4326` / `CRS84` / `OGC:CRS84` are accepted. */
  readonly crs?: string;
  /** Attribute field holding stable row identity, used by delta reconciliation. */
  readonly rowIdentityField?: string;
  /** Attribute fields to treat as temporal (Kepler `timestamp`). */
  readonly temporalFields?: readonly string[];
}

/** Minimal structural view of a Honua `Result` — features plus optional schema. */
export interface KeplerResultInput {
  readonly features: ReadonlyArray<{
    readonly attributes: Readonly<Record<string, unknown>>;
    readonly geometry?: unknown;
  }>;
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly type: string; readonly alias?: string }>;
  readonly aggregateRows?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly degraded?: ReadonlyArray<{ readonly capability: string; readonly reason: string }>;
  readonly exceededTransferLimit?: boolean;
}

export interface KeplerResultProjectionRequest extends KeplerProjectionShape {
  readonly result: KeplerResultInput;
  readonly provenance: KeplerSourceProvenance;
  /**
   * Force the `geojson-column` fallback even for point geometry. Useful when
   * a Kepler layer config is already bound to `_geojson`.
   */
  readonly forceGeoJsonColumn?: boolean;
}

/** Column-oriented artifact input (Honua columnar batch or any typed-array set). */
export interface KeplerColumnInput {
  readonly name: string;
  /** Adapter-declared logical type name, for example `float64` or `utf8`. */
  readonly type: string;
  readonly nullable?: boolean;
  /**
   * Column values in row order. Typed arrays are read in place; the bridge
   * never mutates or retains the caller's buffers.
   */
  readonly values: ArrayLike<unknown>;
}

export interface KeplerColumnarProjectionRequest extends KeplerProjectionShape {
  readonly rowCount: number;
  readonly columns: readonly KeplerColumnInput[];
  readonly provenance: KeplerSourceProvenance;
  /** Longitude/latitude column names, projected into a Kepler point pair. */
  readonly pointColumns?: { readonly longitude: string; readonly latitude: string };
}

/** Supported remote source kinds. */
export type KeplerRemoteSourceKind = "raster-tiles" | "style" | "vector-tiles";

export interface KeplerRemoteSourceInput {
  readonly kind: KeplerRemoteSourceKind;
  /** Tile template URLs (`raster-tiles`) — must be credential-free. */
  readonly tiles?: readonly string[];
  /** Style or tileset metadata URL (`style` / `vector-tiles`). */
  readonly url?: string;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly tileSize?: number;
}

export interface KeplerRemoteSourceProjectionRequest {
  readonly datasetId: string;
  readonly label?: string;
  readonly source: KeplerRemoteSourceInput;
  readonly provenance: KeplerSourceProvenance;
}

/** A Kepler custom basemap entry (`mapStyle.mapStyles[id]`). */
export interface KeplerMapStyleEntry {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly custom: true;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

/** A Kepler tileset dataset descriptor (`info.type: "vectorTile"`). */
export interface KeplerTilesetDescriptor {
  readonly info: KeplerDatasetInfo & { readonly type: "vectorTile" };
  readonly metadata: KeplerDatasetMetadata & {
    readonly tilesetMetadataUrl?: string;
    readonly tilesetDataUrl?: string;
  };
}

export type KeplerRemoteSourceProjection =
  | {
      readonly target: "map-style";
      readonly mapStyle: KeplerMapStyleEntry;
      readonly diagnostic: KeplerIngestionDiagnostic;
    }
  | {
      readonly target: "tileset";
      readonly tileset: KeplerTilesetDescriptor;
      readonly diagnostic: KeplerIngestionDiagnostic;
    };

// ── Projection results ────────────────────────────────────────

/** A projected, bounded dataset ready for `addDataToMap`. */
export interface KeplerDatasetProjection {
  readonly contractVersion: typeof KEPLER_BRIDGE_CONTRACT_VERSION;
  readonly dataset: KeplerProtoDataset;
  readonly diagnostic: KeplerIngestionDiagnostic;
  readonly metrics: KeplerProjectionMetrics;
}

export interface KeplerProjectionMetrics {
  readonly rows: number;
  readonly fields: number;
  readonly cells: number;
  /** Serialized GeoJSON bytes. `0` on every direct path. */
  readonly geoJsonBytes: number;
  /** Approximate retained bytes for the emitted rows, used for the memory budget. */
  readonly estimatedRowBytes: number;
}

// ── Budgets (NFR-001) ────────────────────────────────────────

export interface KeplerBridgeLimits {
  readonly maxDatasets: number;
  readonly maxRowsPerDataset: number;
  readonly maxFieldsPerDataset: number;
  /** Approximate ceiling on retained row bytes across every open dataset. */
  readonly maxRetainedRowBytes: number;
  /** Ceiling on rows a single bounded delta may touch before a rebuild is required. */
  readonly maxDeltaRows: number;
}

// ── Peers (REQ-001 / NFR-001) ────────────────────────────────

export type KeplerModuleImporter = (specifier: string) => Promise<unknown>;

/**
 * Kepler action creators the bridge can use when a host is attached. Every
 * member is optional except `addDataToMap`; a missing creator downgrades the
 * corresponding operation to "payload only" rather than throwing late.
 */
export interface KeplerPeers {
  /** Kepler.gl version the peers came from; validated against {@link KEPLER_COMPATIBILITY_RANGE}. */
  readonly version: string;
  readonly addDataToMap: (payload: unknown) => KeplerAction;
  readonly replaceDataInMap?: (payload: unknown) => KeplerAction;
  readonly removeDataset?: (datasetId: string) => KeplerAction;
  readonly setFilter?: (index: number, prop: string, value: unknown) => KeplerAction;
  readonly updateMap?: (mapState: unknown) => KeplerAction;
  readonly wrapTo?: (instanceId: string, action: KeplerAction) => KeplerAction;
}

export interface LoadKeplerPeersOptions {
  /**
   * Kepler.gl version present in the host application. Required because
   * `@kepler.gl/actions` does not export its own version.
   */
  readonly version: string;
  readonly importModule?: KeplerModuleImporter;
}

/** Redux-ish dispatch target for an attached Kepler instance. */
export interface KeplerWorkspaceHost {
  dispatch(action: KeplerAction): void;
  /** Kepler instance id used with `wrapTo`. */
  readonly instanceId?: string;
}

export interface KeplerCompatibility {
  readonly declaredVersion: string;
  readonly range: typeof KEPLER_COMPATIBILITY_RANGE;
  readonly supported: boolean;
  readonly reason: string;
}

// ── Errors ────────────────────────────────────────────────────

export type HonuaKeplerBridgeErrorCode =
  | "missing-peer"
  | "unsupported-kepler-version"
  | "invalid-request"
  | "unsupported-crs"
  | "unsupported-geometry"
  | "credential-leak"
  | "limit-exceeded"
  | "unknown-dataset"
  | "duplicate-dataset"
  | "disposed";

export class HonuaKeplerBridgeError extends Error {
  public constructor(
    public readonly code: HonuaKeplerBridgeErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaKeplerBridgeError";
  }
}
