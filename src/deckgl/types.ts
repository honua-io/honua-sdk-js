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
  readonly length: number;
  /** deck.gl binary accessor names, for example `getPosition` and `getFillColor`. */
  readonly attributes: Readonly<Record<string, DeckGlBinaryAttribute>>;
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
  /** Unique `ArrayBuffer` backing allocations, not the sum of overlapping views. */
  readonly maxBackingBytes: number;
}

export interface DeckGlProjectionMetrics {
  readonly rows: number;
  readonly attributes: number;
  readonly logicalViewBytes: number;
  readonly uniqueBackingBytes: number;
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
}

export type DeckGlModuleImporter = (specifier: string) => Promise<unknown>;

export interface LoadDeckGlPeersOptions {
  readonly importModule?: DeckGlModuleImporter;
}

export interface DeckGlLayerHost {
  addLayer(layer: DeckGlLayer): void;
  removeLayer(layer: DeckGlLayer): void;
}

export interface DeckGlMountedProjection {
  readonly layer: DeckGlLayer;
  readonly disposed: boolean;
  dispose(): void;
}

export interface DeckGlProjection {
  readonly contractVersion: typeof DECK_GL_ADAPTER_CONTRACT_VERSION;
  readonly layer: DeckGlLayer;
  readonly metrics: DeckGlProjectionMetrics;
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
