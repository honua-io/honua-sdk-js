export const DECK_GL_ADAPTER_CONTRACT_VERSION = "1.0" as const;

export type DeckGlLayerKind =
  | "scatterplot"
  | "feature-path"
  | "feature-polygon"
  | "vector-tile"
  | "h3"
  | "quadbin"
  | "heatmap"
  | "cluster"
  | "contour"
  | "trips";

export interface DeckGlCapability {
  readonly layer: DeckGlLayerKind;
  readonly supported: boolean;
  readonly execution: "gpu-binary" | "not-implemented";
  readonly reason: string;
}

export interface DeckGlBinaryAttribute {
  readonly value: Exclude<ArrayBufferView, DataView>;
  readonly size: 1 | 2 | 3 | 4;
  readonly offset?: number;
  readonly stride?: number;
  readonly normalized?: boolean;
}

export interface DeckGlBinaryData {
  /**
   * For `scatterplot`: the feature/row count. For `feature-path` and
   * `feature-polygon`: the total addressed vertex count across every path or
   * ring, matching the deck.gl binary geometry contract (path/polygon feature
   * count is `startIndices.length - 1`).
   */
  readonly length: number;
  /** deck.gl binary accessor names, for example `getPosition` and `getFillColor`. */
  readonly attributes: Readonly<Record<string, DeckGlBinaryAttribute>>;
  /**
   * Required for `feature-path` (`getPath`) and `feature-polygon`
   * (`getPolygon`); forbidden otherwise. One vertex-index boundary per
   * feature plus a trailing boundary, i.e. length `featureCount + 1`,
   * `startIndices[0] === 0`, non-decreasing, and
   * `startIndices[featureCount] === length`.
   */
  readonly startIndices?: ArrayLike<number>;
}

export interface DeckGlSelectionIdentity {
  readonly sourceId: string;
  readonly planId: string;
  readonly sourceVersion?: string;
  /** One stable scalar per logical row. Values are read only when a row is picked. */
  readonly featureIds: ArrayLike<string | number | bigint>;
}

export interface DeckGlProjectionRequest {
  readonly layer: DeckGlLayerKind;
  readonly layerId: string;
  readonly data: DeckGlBinaryData;
  readonly identity: DeckGlSelectionIdentity;
  /** Forwarded to the peer constructor. `id`, `data`, and `pickable` are reserved. */
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface DeckGlProjectionLimits {
  readonly maxRows: number;
  readonly maxAttributes: number;
  readonly maxProps: number;
  /** Unique `ArrayBuffer` backing allocations, not the sum of overlapping views. */
  readonly maxBackingBytes: number;
}

export interface DeckGlProjectionMetrics {
  readonly rows: number;
  readonly attributes: number;
  readonly logicalViewBytes: number;
  readonly uniqueBackingBytes: number;
  /** Binary attribute payload bytes copied by the SDK; excludes scalar picking identity. */
  readonly copiedBytes: 0;
}

/** Runtime evidence for a constructed binary layer accepted by the optional peer. */
export interface DeckGlGpuLayerContract {
  readonly contractVersion: typeof DECK_GL_ADAPTER_CONTRACT_VERSION;
  readonly layer: Extract<DeckGlLayerKind, "scatterplot" | "feature-path" | "feature-polygon">;
  readonly peer: "ScatterplotLayer" | "PathLayer" | "SolidPolygonLayer";
  readonly execution: "gpu-binary";
  readonly fallback: "none";
  readonly layerId: string;
  readonly featureCount: number;
  readonly vertexCount: number;
  readonly attributes: number;
  readonly copiedBytes: 0;
}

export interface DeckGlExecutionDiagnostic {
  readonly strategy: "gpu-binary";
  readonly fidelity: "exact-input";
  readonly precision: "input-array";
  readonly fallback: "none";
  readonly message: string;
}

export interface DeckGlPickedSelection {
  readonly sourceId: string;
  readonly planId: string;
  readonly sourceVersion?: string;
  readonly featureId: string | number | bigint;
  readonly rowIndex: number;
}

export interface DeckGlLayer {
  readonly id?: string;
}

export interface DeckGlLayerConstructor {
  new (props: Readonly<Record<string, unknown>>): DeckGlLayer;
}

export interface DeckGlPeers {
  readonly ScatterplotLayer: DeckGlLayerConstructor;
  /** Required only to `project()` a `"feature-path"` request. */
  readonly PathLayer?: DeckGlLayerConstructor;
  /** Required only to `project()` a `"feature-polygon"` request. */
  readonly SolidPolygonLayer?: DeckGlLayerConstructor;
}

export type DeckGlModuleImporter = (specifier: string) => Promise<unknown>;

export interface LoadDeckGlPeersOptions {
  readonly importModule?: DeckGlModuleImporter;
}

/** Options for creating an adapter by loading the optional deck.gl layers peer. */
export interface LoadDeckGlAdapterOptions extends LoadDeckGlPeersOptions {
  readonly limits?: Partial<DeckGlProjectionLimits>;
}

export interface DeckGlLayerHost {
  addLayer(layer: DeckGlLayer): void;
  removeLayer(layer: DeckGlLayer): void;
}

/**
 * Common shape for every disposable Honua deck.gl binding — mounted
 * projections, camera/view-state sync, and combined lifecycles all expose
 * this. `dispose()` is idempotent after success; `disposed` stays `false`
 * while a failed disposal remains retryable.
 */
export interface DeckGlDisposalHandle {
  readonly disposed: boolean;
  dispose(): void;
}

export interface DeckGlMountedProjection extends DeckGlDisposalHandle {
  readonly layer: DeckGlLayer;
  /** False while removal has failed and remains retryable. */
  readonly disposed: boolean;
  /** Idempotent after success; a failed removal can be retried. */
  dispose(): void;
}

export interface DeckGlProjection {
  readonly contractVersion: typeof DECK_GL_ADAPTER_CONTRACT_VERSION;
  readonly layer: DeckGlLayer;
  readonly metrics: DeckGlProjectionMetrics;
  /** Fail-closed evidence that the optional peer returned the requested GPU layer. */
  readonly gpuContract: DeckGlGpuLayerContract;
  readonly diagnostic: DeckGlExecutionDiagnostic;
  selectionForPick(index: number): DeckGlPickedSelection;
  mount(host: DeckGlLayerHost): DeckGlMountedProjection;
}

export interface DeckGlAdapter {
  readonly capabilities: readonly DeckGlCapability[];
  readonly limits: DeckGlProjectionLimits;
  readonly disposed: boolean;
  project(request: DeckGlProjectionRequest): DeckGlProjection;
  dispose(): void;
}

export type HonuaDeckGlAdapterErrorCode =
  | "missing-peer"
  | "invalid-data"
  | "limit-exceeded"
  | "unsupported-layer"
  | "invalid-layer"
  | "dispose-failed"
  | "disposed";

export class HonuaDeckGlAdapterError extends Error {
  public constructor(
    public readonly code: HonuaDeckGlAdapterErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaDeckGlAdapterError";
  }
}
