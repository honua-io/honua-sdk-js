import type { FeatureId, SourceId } from "../contract/index.js";
import type { HonuaExtent } from "../core/types.js";
import {
  createExplorationContext,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "../exploration/index.js";
import type {
  ExplorationContext,
  ExplorationStateSnapshot,
  FeatureSelectionTarget,
  SourceQualifiedFeatureSelectionTarget,
  Unsubscribe,
} from "../exploration/index.js";
import type { HonuaMapPackage, LegendEntry, MaplibreMap, SetViewStateInput } from "../runtime/index.js";
import type { HonuaStyleSpecification } from "../style/index.js";

export const HONUA_CONTROLLER_SNAPSHOT_VERSION = 1 as const;

export type HonuaControllerErrorCode =
  | "disposed"
  | "invalid-runtime"
  | "invalid-viewport"
  | "invalid-selection"
  | "invalid-overlay"
  | "invalid-annotation"
  | "invalid-snapshot";

export class HonuaControllerError extends Error {
  public readonly code: HonuaControllerErrorCode;

  public constructor(code: HonuaControllerErrorCode, message: string) {
    super(message);
    this.name = "HonuaControllerError";
    this.code = code;
  }
}

export type HonuaCoordinate = readonly [number, number] | readonly [number, number, number];
export type HonuaBounds = readonly [number, number, number, number];

export interface HonuaViewport {
  readonly bbox?: HonuaBounds;
  readonly center?: readonly [number, number];
  readonly zoom?: number;
  readonly pitch?: number;
  readonly bearing?: number;
  readonly crs?: string;
}

export interface HonuaViewportOptions {
  readonly animate?: boolean;
  readonly padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
}

export interface HonuaFitBoundsOptions extends HonuaViewportOptions {
  readonly maxZoom?: number;
  readonly bearing?: number;
  readonly pitch?: number;
}

export type HonuaVisibilityTargetKind = "layer" | "layer-group" | "legend-item";

export interface HonuaVisibilityTarget {
  readonly kind: HonuaVisibilityTargetKind;
  readonly id: string;
}

export type HonuaVisibilityTargetInput = string | HonuaVisibilityTarget;

export interface HonuaVisibilityChangeSet {
  readonly show?: ReadonlyArray<string>;
  readonly hide?: ReadonlyArray<string>;
}

export interface HonuaVisibilityUpdate {
  readonly show?: ReadonlyArray<HonuaVisibilityTargetInput>;
  readonly hide?: ReadonlyArray<HonuaVisibilityTargetInput>;
}

export interface HonuaVisibilitySnapshot {
  readonly layers: Readonly<Record<string, boolean>>;
  readonly layerGroups: Readonly<Record<string, boolean>>;
  readonly legendItems: Readonly<Record<string, boolean>>;
}

export interface HonuaOverlayStyle {
  readonly color?: string;
  readonly fillColor?: string;
  readonly fillOpacity?: number;
  readonly lineColor?: string;
  readonly lineWidth?: number;
  readonly pointColor?: string;
  readonly pointRadius?: number;
  readonly opacity?: number;
}

export type HonuaGeoJsonGeometry =
  | { readonly type: "Point"; readonly coordinates: HonuaCoordinate }
  | { readonly type: "MultiPoint"; readonly coordinates: ReadonlyArray<HonuaCoordinate> }
  | { readonly type: "LineString"; readonly coordinates: ReadonlyArray<HonuaCoordinate> }
  | { readonly type: "MultiLineString"; readonly coordinates: ReadonlyArray<ReadonlyArray<HonuaCoordinate>> }
  | { readonly type: "Polygon"; readonly coordinates: ReadonlyArray<ReadonlyArray<HonuaCoordinate>> }
  | {
      readonly type: "MultiPolygon";
      readonly coordinates: ReadonlyArray<ReadonlyArray<ReadonlyArray<HonuaCoordinate>>>;
    }
  | { readonly type: "GeometryCollection"; readonly geometries: ReadonlyArray<HonuaGeoJsonGeometry> };

export interface HonuaGeoJsonFeature {
  readonly type: "Feature";
  readonly id?: string | number;
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly geometry: HonuaGeoJsonGeometry | null;
}

export interface HonuaGeoJsonFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: ReadonlyArray<HonuaGeoJsonFeature>;
}

export type HonuaGeoJson = HonuaGeoJsonGeometry | HonuaGeoJsonFeature | HonuaGeoJsonFeatureCollection;

export type HonuaTemporaryOverlay =
  | {
      readonly id: string;
      readonly kind: "geojson";
      readonly data: HonuaGeoJson;
      readonly title?: string;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly style?: HonuaOverlayStyle;
    }
  | {
      readonly id: string;
      readonly kind: "point";
      readonly coordinate: HonuaCoordinate;
      readonly title?: string;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly style?: HonuaOverlayStyle;
    }
  | {
      readonly id: string;
      readonly kind: "line";
      readonly coordinates: ReadonlyArray<HonuaCoordinate>;
      readonly title?: string;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly style?: HonuaOverlayStyle;
    }
  | {
      readonly id: string;
      readonly kind: "polygon";
      readonly rings: ReadonlyArray<ReadonlyArray<HonuaCoordinate>>;
      readonly title?: string;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly style?: HonuaOverlayStyle;
    };

export type HonuaTemporaryOverlayInput =
  | (Omit<Extract<HonuaTemporaryOverlay, { kind: "geojson" }>, "id"> & { readonly id?: string })
  | (Omit<Extract<HonuaTemporaryOverlay, { kind: "point" }>, "id"> & { readonly id?: string })
  | (Omit<Extract<HonuaTemporaryOverlay, { kind: "line" }>, "id"> & { readonly id?: string })
  | (Omit<Extract<HonuaTemporaryOverlay, { kind: "polygon" }>, "id"> & { readonly id?: string });

export interface HonuaAnnotationStyle {
  readonly color?: string;
  readonly haloColor?: string;
  readonly haloWidth?: number;
  readonly size?: number;
  readonly anchor?:
    | "center"
    | "left"
    | "right"
    | "top"
    | "bottom"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right";
}

export type HonuaTemporaryAnnotation =
  | {
      readonly id: string;
      readonly kind: "text";
      readonly coordinate: HonuaCoordinate;
      readonly text: string;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly style?: HonuaAnnotationStyle;
    }
  | {
      readonly id: string;
      readonly kind: "note";
      readonly text: string;
      readonly coordinate?: HonuaCoordinate;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly style?: HonuaAnnotationStyle;
    };

export type HonuaTemporaryAnnotationInput =
  | (Omit<Extract<HonuaTemporaryAnnotation, { kind: "text" }>, "id"> & { readonly id?: string })
  | (Omit<Extract<HonuaTemporaryAnnotation, { kind: "note" }>, "id"> & { readonly id?: string });

export type HonuaControllerEventSource = "controller" | "exploration" | "adapter" | "snapshot";

export interface HonuaControllerEventBase {
  readonly source: HonuaControllerEventSource;
}

export interface HonuaControllerViewportEvent extends HonuaControllerEventBase {
  readonly type: "viewport-move" | "viewport-move-end";
  readonly viewport: HonuaViewport;
  readonly previous: HonuaViewport | undefined;
}

export interface HonuaControllerIdleEvent extends HonuaControllerEventBase {
  readonly type: "idle";
  readonly snapshot: HonuaControllerSnapshot;
}

export interface HonuaControllerSelectionChangeEvent extends HonuaControllerEventBase {
  readonly type: "selection-change";
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly previous: ReadonlyArray<FeatureSelectionTarget>;
}

export interface HonuaControllerVisibilityChangeEvent extends HonuaControllerEventBase {
  readonly type: "visibility-change";
  readonly visibility: HonuaVisibilitySnapshot;
  readonly previous: HonuaVisibilitySnapshot;
  readonly show: ReadonlyArray<HonuaVisibilityTarget>;
  readonly hide: ReadonlyArray<HonuaVisibilityTarget>;
}

export interface HonuaControllerOverlayChangeEvent extends HonuaControllerEventBase {
  readonly type: "overlay-change";
  readonly action: "added" | "updated" | "removed" | "cleared" | "restored";
  readonly overlays: ReadonlyArray<HonuaTemporaryOverlay>;
  readonly overlay?: HonuaTemporaryOverlay;
  readonly overlayId?: string;
}

export interface HonuaControllerAnnotationChangeEvent extends HonuaControllerEventBase {
  readonly type: "annotation-change";
  readonly action: "added" | "updated" | "removed" | "cleared" | "restored";
  readonly annotations: ReadonlyArray<HonuaTemporaryAnnotation>;
  readonly annotation?: HonuaTemporaryAnnotation;
  readonly annotationId?: string;
}

export interface HonuaControllerDisposedEvent {
  readonly type: "disposed";
}

export type HonuaControllerEvent =
  | HonuaControllerViewportEvent
  | HonuaControllerIdleEvent
  | HonuaControllerSelectionChangeEvent
  | HonuaControllerVisibilityChangeEvent
  | HonuaControllerOverlayChangeEvent
  | HonuaControllerAnnotationChangeEvent
  | HonuaControllerDisposedEvent;

export type HonuaControllerEventType = HonuaControllerEvent["type"];

export type HonuaControllerEventFor<TType extends HonuaControllerEventType> = HonuaControllerEvent extends infer TEvent
  ? TEvent extends { readonly type: infer TEventType }
    ? TType extends TEventType
      ? TEvent
      : never
    : never
  : never;

export type HonuaControllerEventListener<TType extends HonuaControllerEventType = HonuaControllerEventType> = (
  event: HonuaControllerEventFor<TType>,
) => void;

export interface HonuaControllerSnapshot {
  readonly version: typeof HONUA_CONTROLLER_SNAPSHOT_VERSION;
  readonly viewport: HonuaViewport;
  readonly exploration: ExplorationStateSnapshot;
  readonly visibility: HonuaVisibilitySnapshot;
  readonly overlays: ReadonlyArray<HonuaTemporaryOverlay>;
  readonly annotations: ReadonlyArray<HonuaTemporaryAnnotation>;
}

export interface HonuaControllerAdapterSubscription {
  remove(): void;
}

export interface HonuaControllerAdapter {
  readonly id?: string;
  getViewport?(): HonuaViewport | undefined;
  setViewport?(viewport: HonuaViewport, options?: HonuaViewportOptions): void;
  fitBounds?(bounds: HonuaBounds, options?: HonuaFitBoundsOptions): void;
  setLayerVisibility?(layerId: string, visible: boolean): void;
  addOverlay?(overlay: HonuaTemporaryOverlay): void;
  removeOverlay?(overlayId: string): void;
  addAnnotation?(annotation: HonuaTemporaryAnnotation): void;
  removeAnnotation?(annotationId: string): void;
  onViewportMove?(
    listener: (viewport: HonuaViewport | undefined) => void,
  ): Unsubscribe | HonuaControllerAdapterSubscription;
  onViewportMoveEnd?(
    listener: (viewport: HonuaViewport | undefined) => void,
  ): Unsubscribe | HonuaControllerAdapterSubscription;
  onIdle?(listener: () => void): Unsubscribe | HonuaControllerAdapterSubscription;
  dispose?(): void;
}

export interface HonuaControllerRuntimeLike {
  readonly map: MaplibreMap;
  readonly mapPackage: HonuaMapPackage;
  readonly composedStyle: HonuaStyleSpecification;
  setViewState(view: SetViewStateInput): void;
  setLayerVisibility(layerId: string, visible: boolean): void;
  getLegend?(): LegendEntry[];
  dispose?(): void;
}

export interface HonuaGeneratedAppRuntimeLike {
  readonly context: ExplorationContext;
  readonly mapRuntime?: HonuaControllerRuntimeLike;
  readonly manifest?: { readonly appId?: string };
  dispose?(): void;
}

export type HonuaControllerRuntime = HonuaControllerRuntimeLike | HonuaGeneratedAppRuntimeLike;

export interface HonuaControllerOptions {
  readonly runtime?: HonuaControllerRuntime;
  readonly explorationContext?: ExplorationContext;
  readonly adapter?: HonuaControllerAdapter;
  readonly datasetId?: string;
  readonly sourceIds?: ReadonlyArray<SourceId>;
  readonly initialViewport?: HonuaViewport;
  readonly initialVisibility?: Partial<HonuaVisibilitySnapshot>;
  readonly layerGroups?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly legendItemLayers?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly disposeRuntime?: boolean;
  readonly disposeAdapter?: boolean;
}

interface ControllerInternals {
  readonly context: ExplorationContext;
  readonly ownsContext: boolean;
  readonly runtime?: HonuaControllerRuntimeLike;
  readonly adapter?: HonuaControllerAdapter;
  readonly disposeRuntime: boolean;
  readonly disposeAdapter: boolean;
  readonly initialViewport: HonuaViewport;
  readonly initialVisibility: HonuaVisibilitySnapshot;
}

type ControllerListener = (event: HonuaControllerEvent) => void;
type ListenerMap = Map<HonuaControllerEventType, Set<ControllerListener>>;

let generatedOverlayId = 0;
let generatedAnnotationId = 0;

export function createHonuaController(
  runtimeOrOptions: HonuaControllerRuntime | HonuaControllerOptions = {},
): HonuaController {
  return new HonuaController(isControllerOptions(runtimeOrOptions) ? runtimeOrOptions : { runtime: runtimeOrOptions });
}

export class HonuaController {
  public readonly context: ExplorationContext;

  readonly #runtime: HonuaControllerRuntimeLike | undefined;
  readonly #adapter: HonuaControllerAdapter | undefined;
  readonly #ownsContext: boolean;
  readonly #disposeRuntime: boolean;
  readonly #disposeAdapter: boolean;
  readonly #listeners: ListenerMap = new Map();
  readonly #subscriptions: Unsubscribe[] = [];
  readonly #layerGroups: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly #legendItemLayers: Readonly<Record<string, ReadonlyArray<string>>>;
  #visibility: HonuaVisibilitySnapshot;
  #viewport: HonuaViewport;
  #overlays = new Map<string, HonuaTemporaryOverlay>();
  #annotations = new Map<string, HonuaTemporaryAnnotation>();
  #disposed = false;
  #suppressExtentEvent = false;

  public constructor(options: HonuaControllerOptions = {}) {
    const internals = resolveInternals(options);
    this.context = internals.context;
    this.#runtime = internals.runtime;
    this.#adapter = internals.adapter;
    this.#ownsContext = internals.ownsContext;
    this.#disposeRuntime = internals.disposeRuntime;
    this.#disposeAdapter = internals.disposeAdapter;
    this.#layerGroups = structuredClone(options.layerGroups ?? {});
    this.#legendItemLayers = structuredClone(options.legendItemLayers ?? {});
    this.#visibility = cloneVisibility(internals.initialVisibility);
    this.#viewport = normalizeViewport(internals.initialViewport);

    const initialExtent = viewportToExtent(this.#viewport);
    if (initialExtent && !this.context.state.extent) {
      this.context.dispatch({ kind: "set-extent", extent: initialExtent });
    }

    this.#subscriptions.push(
      this.context.subscribe("extent", (event) => {
        if (this.#suppressExtentEvent) return;
        const previous = this.#viewport;
        this.#viewport = normalizeViewport({
          ...this.#viewport,
          ...extentToViewport(event.state.extent),
        });
        if (!viewportsEqual(previous, this.#viewport)) {
          this.#emit({ type: "viewport-move", viewport: this.getViewport(), previous, source: "exploration" });
        }
      }),
    );

    this.#subscriptions.push(
      this.context.subscribe("selection", (event) => {
        this.#emit({
          type: "selection-change",
          selection: cloneSelection(event.state.selection),
          previous: cloneSelection(event.previous.selection),
          source: "exploration",
        });
      }),
    );

    if (this.#adapter?.onViewportMove) {
      this.#subscriptions.push(
        removeAdapterSubscription(
          this.#adapter.onViewportMove((viewport) => {
            if (!viewport) return;
            this.#commitViewport(viewport, "adapter");
          }),
        ),
      );
    }
    if (this.#adapter?.onViewportMoveEnd) {
      this.#subscriptions.push(
        removeAdapterSubscription(
          this.#adapter.onViewportMoveEnd((viewport) => {
            const previous = this.#viewport;
            if (viewport) this.#commitViewport(viewport, "adapter", { emitMove: false });
            this.#emit({ type: "viewport-move-end", viewport: this.getViewport(), previous, source: "adapter" });
          }),
        ),
      );
    }
    if (this.#adapter?.onIdle) {
      this.#subscriptions.push(
        removeAdapterSubscription(
          this.#adapter.onIdle(() => {
            this.#emit({ type: "idle", snapshot: this.snapshot(), source: "adapter" });
          }),
        ),
      );
    }
  }

  public getViewport(): HonuaViewport {
    this.#assertLive("getViewport");
    return cloneViewport({
      ...this.#adapter?.getViewport?.(),
      ...this.#viewport,
      ...extentToViewport(this.context.state.extent),
    });
  }

  public setViewport(viewport: HonuaViewport, options: HonuaViewportOptions = {}): void {
    this.#assertLive("setViewport");
    const normalized = normalizeViewport(viewport);
    const previous = this.getViewport();
    this.#adapter?.setViewport?.(normalized, options);
    this.#commitViewport(normalized, "controller");
    this.#emit({ type: "viewport-move-end", viewport: this.getViewport(), previous, source: "controller" });
    this.#queueIdle("controller");
  }

  public fitBounds(bounds: HonuaBounds, options: HonuaFitBoundsOptions = {}): void {
    this.#assertLive("fitBounds");
    assertBounds(bounds);
    const previous = this.getViewport();
    this.#adapter?.fitBounds?.(bounds, options);
    this.#commitViewport({ bbox: [...bounds] as unknown as HonuaBounds }, "controller");
    this.#emit({ type: "viewport-move-end", viewport: this.getViewport(), previous, source: "controller" });
    this.#queueIdle("controller");
  }

  public onViewportMove(listener: HonuaControllerEventListener<"viewport-move">): Unsubscribe {
    return this.on("viewport-move", listener);
  }

  public onViewportMoveEnd(listener: HonuaControllerEventListener<"viewport-move-end">): Unsubscribe {
    return this.on("viewport-move-end", listener);
  }

  public onIdle(listener: HonuaControllerEventListener<"idle">): Unsubscribe {
    return this.on("idle", listener);
  }

  public getSelection(options: { readonly sourceId?: SourceId } = {}): ReadonlyArray<FeatureSelectionTarget> {
    this.#assertLive("getSelection");
    const selection = this.context.state.selection;
    if (!options.sourceId) return cloneSelection(selection);
    return cloneSelection(
      selection.filter((target) => isSourceQualifiedSelectionTarget(target) && target.sourceId === options.sourceId),
    );
  }

  public selectFeature(
    sourceId: SourceId,
    id: FeatureId,
    options?: { readonly replace?: boolean; readonly sourceLayer?: string },
  ): void;
  public selectFeature(target: SourceQualifiedFeatureSelectionTarget, options?: { readonly replace?: boolean }): void;
  public selectFeature(
    sourceOrTarget: SourceId | SourceQualifiedFeatureSelectionTarget,
    idOrOptions?: FeatureId | { readonly replace?: boolean },
    maybeOptions: { readonly replace?: boolean; readonly sourceLayer?: string } = {},
  ): void {
    this.#assertLive("selectFeature");
    const target =
      typeof sourceOrTarget === "object"
        ? sourceOrTarget
        : sourceFeatureSelectionTarget(sourceOrTarget, idOrOptions as FeatureId, {
            sourceLayer: maybeOptions.sourceLayer,
          });
    const replace = typeof idOrOptions === "object" ? idOrOptions.replace : maybeOptions.replace;
    this.selectFeatures([target], { replace: replace ?? true });
  }

  public selectFeatures(
    targets: ReadonlyArray<FeatureSelectionTarget>,
    options: { readonly replace?: boolean } = {},
  ): void {
    this.#assertLive("selectFeatures");
    if (targets.length === 0) return;
    this.context.dispatch({ kind: "select", ids: cloneSelection(targets), replace: options.replace ?? true });
  }

  public clearSelection(targets?: ReadonlyArray<FeatureSelectionTarget>): void {
    this.#assertLive("clearSelection");
    this.context.dispatch({ kind: "deselect", ids: targets ? cloneSelection(targets) : undefined });
  }

  public onSelectionChange(listener: HonuaControllerEventListener<"selection-change">): Unsubscribe {
    return this.on("selection-change", listener);
  }

  public getVisibility(): HonuaVisibilitySnapshot {
    this.#assertLive("getVisibility");
    return cloneVisibility(this.#visibility);
  }

  public setVisibility(update: HonuaVisibilityUpdate): void {
    this.#assertLive("setVisibility");
    this.#applyVisibilityUpdate(normalizeVisibilityUpdate(update), "controller");
  }

  public setLayerVisibility(layerId: string, visible: boolean): void;
  public setLayerVisibility(update: HonuaVisibilityChangeSet): void;
  public setLayerVisibility(layerOrUpdate: string | HonuaVisibilityChangeSet, visible?: boolean): void {
    this.#assertLive("setLayerVisibility");
    if (typeof layerOrUpdate === "string") {
      this.#applyVisibilityUpdate(
        {
          show: visible ? [{ kind: "layer", id: layerOrUpdate }] : [],
          hide: visible ? [] : [{ kind: "layer", id: layerOrUpdate }],
        },
        "controller",
      );
      return;
    }
    this.#applyVisibilityUpdate(targetsFromChangeSet("layer", layerOrUpdate), "controller");
  }

  public setLayerGroupVisibility(update: HonuaVisibilityChangeSet): void {
    this.#assertLive("setLayerGroupVisibility");
    this.#applyVisibilityUpdate(targetsFromChangeSet("layer-group", update), "controller");
  }

  public setLegendItemVisibility(update: HonuaVisibilityChangeSet): void {
    this.#assertLive("setLegendItemVisibility");
    this.#applyVisibilityUpdate(targetsFromChangeSet("legend-item", update), "controller");
  }

  public onVisibilityChange(listener: HonuaControllerEventListener<"visibility-change">): Unsubscribe {
    return this.on("visibility-change", listener);
  }

  public addOverlay(input: HonuaTemporaryOverlayInput): HonuaTemporaryOverlay {
    this.#assertLive("addOverlay");
    const overlay = normalizeOverlay(input);
    const action = this.#overlays.has(overlay.id) ? "updated" : "added";
    if (action === "updated") this.#adapter?.removeOverlay?.(overlay.id);
    this.#overlays.set(overlay.id, overlay);
    this.#adapter?.addOverlay?.(overlay);
    this.#emit({
      type: "overlay-change",
      action,
      overlay,
      overlays: this.getOverlays(),
      source: "controller",
    });
    return structuredClone(overlay) as HonuaTemporaryOverlay;
  }

  public removeOverlay(id: string): boolean {
    this.#assertLive("removeOverlay");
    if (!this.#overlays.has(id)) return false;
    this.#overlays.delete(id);
    this.#adapter?.removeOverlay?.(id);
    this.#emit({
      type: "overlay-change",
      action: "removed",
      overlayId: id,
      overlays: this.getOverlays(),
      source: "controller",
    });
    return true;
  }

  public clearOverlays(): void {
    this.#assertLive("clearOverlays");
    if (this.#overlays.size === 0) return;
    for (const id of this.#overlays.keys()) this.#adapter?.removeOverlay?.(id);
    this.#overlays.clear();
    this.#emit({ type: "overlay-change", action: "cleared", overlays: [], source: "controller" });
  }

  public getOverlays(): ReadonlyArray<HonuaTemporaryOverlay> {
    this.#assertLive("getOverlays");
    return structuredClone([...this.#overlays.values()]) as HonuaTemporaryOverlay[];
  }

  public addAnnotation(input: HonuaTemporaryAnnotationInput): HonuaTemporaryAnnotation {
    this.#assertLive("addAnnotation");
    const annotation = normalizeAnnotation(input);
    const action = this.#annotations.has(annotation.id) ? "updated" : "added";
    if (action === "updated") this.#adapter?.removeAnnotation?.(annotation.id);
    this.#annotations.set(annotation.id, annotation);
    this.#adapter?.addAnnotation?.(annotation);
    this.#emit({
      type: "annotation-change",
      action,
      annotation,
      annotations: this.getAnnotations(),
      source: "controller",
    });
    return structuredClone(annotation) as HonuaTemporaryAnnotation;
  }

  public removeAnnotation(id: string): boolean {
    this.#assertLive("removeAnnotation");
    if (!this.#annotations.has(id)) return false;
    this.#annotations.delete(id);
    this.#adapter?.removeAnnotation?.(id);
    this.#emit({
      type: "annotation-change",
      action: "removed",
      annotationId: id,
      annotations: this.getAnnotations(),
      source: "controller",
    });
    return true;
  }

  public clearAnnotations(): void {
    this.#assertLive("clearAnnotations");
    if (this.#annotations.size === 0) return;
    for (const id of this.#annotations.keys()) this.#adapter?.removeAnnotation?.(id);
    this.#annotations.clear();
    this.#emit({ type: "annotation-change", action: "cleared", annotations: [], source: "controller" });
  }

  public getAnnotations(): ReadonlyArray<HonuaTemporaryAnnotation> {
    this.#assertLive("getAnnotations");
    return structuredClone([...this.#annotations.values()]) as HonuaTemporaryAnnotation[];
  }

  public snapshot(): HonuaControllerSnapshot {
    this.#assertLive("snapshot");
    return {
      version: HONUA_CONTROLLER_SNAPSHOT_VERSION,
      viewport: this.getViewport(),
      exploration: this.context.snapshot(),
      visibility: this.getVisibility(),
      overlays: this.getOverlays(),
      annotations: this.getAnnotations(),
    };
  }

  public restore(snapshot: HonuaControllerSnapshot): void {
    this.#assertLive("restore");
    if (snapshot.version !== HONUA_CONTROLLER_SNAPSHOT_VERSION) {
      throw new HonuaControllerError(
        "invalid-snapshot",
        `HonuaController cannot restore snapshot version ${String(snapshot.version)}`,
      );
    }

    this.setViewport(snapshot.viewport);
    this.context.restore(snapshot.exploration);
    this.#restoreVisibility(snapshot.visibility);

    for (const id of this.#overlays.keys()) this.#adapter?.removeOverlay?.(id);
    this.#overlays.clear();
    for (const overlay of snapshot.overlays) {
      const normalized = normalizeOverlay(overlay);
      this.#overlays.set(normalized.id, normalized);
      this.#adapter?.addOverlay?.(normalized);
    }
    this.#emit({
      type: "overlay-change",
      action: "restored",
      overlays: this.getOverlays(),
      source: "snapshot",
    });

    for (const id of this.#annotations.keys()) this.#adapter?.removeAnnotation?.(id);
    this.#annotations.clear();
    for (const annotation of snapshot.annotations) {
      const normalized = normalizeAnnotation(annotation);
      this.#annotations.set(normalized.id, normalized);
      this.#adapter?.addAnnotation?.(normalized);
    }
    this.#emit({
      type: "annotation-change",
      action: "restored",
      annotations: this.getAnnotations(),
      source: "snapshot",
    });
  }

  public on<TType extends HonuaControllerEventType>(
    type: TType,
    listener: HonuaControllerEventListener<TType>,
  ): Unsubscribe {
    this.#assertLive("on");
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    const controllerListener = listener as unknown as ControllerListener;
    listeners.add(controllerListener);
    return () => {
      const set = this.#listeners.get(type);
      if (!set) return;
      set.delete(controllerListener);
      if (set.size === 0) this.#listeners.delete(type);
    };
  }

  public dispose(): void {
    if (this.#disposed) return;
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    for (const id of this.#overlays.keys()) this.#adapter?.removeOverlay?.(id);
    for (const id of this.#annotations.keys()) this.#adapter?.removeAnnotation?.(id);
    this.#overlays.clear();
    this.#annotations.clear();
    if (this.#disposeAdapter) this.#adapter?.dispose?.();
    if (this.#disposeRuntime) this.#runtime?.dispose?.();
    if (this.#ownsContext) this.context.dispose();
    this.#disposed = true;
    this.#emit({ type: "disposed" });
    this.#listeners.clear();
  }

  #commitViewport(
    viewport: HonuaViewport,
    source: HonuaControllerEventSource,
    options: { readonly emitMove?: boolean } = {},
  ): void {
    const previous = this.#viewport;
    this.#viewport = normalizeViewport({ ...this.#viewport, ...viewport });
    const extent = viewportToExtent(this.#viewport);
    if (extent) {
      this.#suppressExtentEvent = true;
      try {
        this.context.dispatch({ kind: "set-extent", extent });
      } finally {
        this.#suppressExtentEvent = false;
      }
    }
    if (options.emitMove === false || viewportsEqual(previous, this.#viewport)) return;
    this.#emit({ type: "viewport-move", viewport: this.getViewport(), previous, source });
  }

  #applyVisibilityUpdate(update: NormalizedVisibilityUpdate, source: HonuaControllerEventSource): void {
    if (update.show.length === 0 && update.hide.length === 0) return;
    const previous = cloneVisibility(this.#visibility);
    const next = cloneVisibility(this.#visibility);
    const rendererChanges = new Map<string, boolean>();

    for (const target of update.hide)
      applyVisibilityTarget(next, target, false, this.#layerGroups, this.#legendItemLayers, rendererChanges);
    for (const target of update.show)
      applyVisibilityTarget(next, target, true, this.#layerGroups, this.#legendItemLayers, rendererChanges);

    if (visibilityEqual(previous, next)) return;
    for (const [layerId, visible] of rendererChanges) this.#adapter?.setLayerVisibility?.(layerId, visible);

    this.#visibility = next;
    this.#emit({
      type: "visibility-change",
      visibility: cloneVisibility(next),
      previous,
      show: update.show,
      hide: update.hide,
      source,
    });
  }

  #restoreVisibility(visibility: HonuaVisibilitySnapshot): void {
    const previous = cloneVisibility(this.#visibility);
    const next = cloneVisibility(visibility);
    if (visibilityEqual(previous, next)) return;
    const layerIds = new Set([...Object.keys(previous.layers), ...Object.keys(next.layers)]);
    for (const layerId of layerIds) {
      const visible = next.layers[layerId] ?? true;
      if ((previous.layers[layerId] ?? true) !== visible) {
        this.#adapter?.setLayerVisibility?.(layerId, visible);
      }
    }
    this.#visibility = next;
    this.#emit({
      type: "visibility-change",
      visibility: cloneVisibility(next),
      previous,
      show: [],
      hide: [],
      source: "snapshot",
    });
  }

  #queueIdle(source: HonuaControllerEventSource): void {
    queueMicrotask(() => {
      if (this.#disposed) return;
      this.#emit({ type: "idle", snapshot: this.snapshot(), source });
    });
  }

  #emit(event: HonuaControllerEvent): void {
    const listeners = this.#listeners.get(event.type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  #assertLive(operation: string): void {
    if (this.#disposed) {
      throw new HonuaControllerError("disposed", `HonuaController cannot ${operation} after dispose()`);
    }
  }
}

interface NormalizedVisibilityUpdate {
  readonly show: ReadonlyArray<HonuaVisibilityTarget>;
  readonly hide: ReadonlyArray<HonuaVisibilityTarget>;
}

function resolveInternals(options: HonuaControllerOptions): ControllerInternals {
  const generatedRuntime = options.runtime && isGeneratedAppRuntimeLike(options.runtime) ? options.runtime : undefined;
  const runtime =
    options.runtime && isMapRuntimeLike(options.runtime)
      ? options.runtime
      : generatedRuntime?.mapRuntime && isMapRuntimeLike(generatedRuntime.mapRuntime)
        ? generatedRuntime.mapRuntime
        : undefined;
  if (options.runtime && !generatedRuntime && !runtime) {
    throw new HonuaControllerError(
      "invalid-runtime",
      "HonuaController runtime must be a HonuaMapRuntime-like or generated-app-runtime-like object",
    );
  }
  const context = options.explorationContext ?? generatedRuntime?.context;
  const adapter = options.adapter ?? (runtime ? createMapRuntimeControllerAdapter(runtime) : undefined);
  const initialViewport =
    options.initialViewport ??
    adapter?.getViewport?.() ??
    runtime?.mapPackage.initialView ??
    extentToViewport(context?.state.extent);

  if (context) {
    const visibility = mergeVisibility(
      initialVisibilityFromRuntime(runtime, options.layerGroups, options.legendItemLayers),
      options.initialVisibility,
    );
    return {
      context,
      ownsContext: false,
      runtime,
      adapter,
      disposeRuntime: options.disposeRuntime ?? false,
      disposeAdapter: options.disposeAdapter ?? false,
      initialViewport: normalizeViewport(initialViewport),
      initialVisibility: visibility,
    };
  }

  const sourceIds = options.sourceIds ?? runtime?.mapPackage.sourceBindings.map((binding) => binding.sourceId) ?? [];
  const datasetId = options.datasetId ?? runtime?.mapPackage.mapPackageId ?? "honua-controller";
  const ownedContext = createExplorationContext({
    datasetId,
    sourceIds,
    initialState: viewportToExtent(initialViewport) ? { extent: viewportToExtent(initialViewport) } : undefined,
  });
  const visibility = mergeVisibility(
    initialVisibilityFromRuntime(runtime, options.layerGroups, options.legendItemLayers),
    options.initialVisibility,
  );
  return {
    context: ownedContext,
    ownsContext: true,
    runtime,
    adapter,
    disposeRuntime: options.disposeRuntime ?? false,
    disposeAdapter: options.disposeAdapter ?? false,
    initialViewport: normalizeViewport(initialViewport),
    initialVisibility: visibility,
  };
}

function isControllerOptions(value: HonuaControllerRuntime | HonuaControllerOptions): value is HonuaControllerOptions {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as HonuaControllerRuntime;
  return !isMapRuntimeLike(runtime) && !isGeneratedAppRuntimeLike(runtime);
}

function isGeneratedAppRuntimeLike(value: HonuaControllerRuntime): value is HonuaGeneratedAppRuntimeLike {
  return typeof value === "object" && value !== null && "context" in value;
}

function isMapRuntimeLike(
  value: HonuaControllerRuntime | HonuaControllerRuntimeLike | undefined,
): value is HonuaControllerRuntimeLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "map" in value &&
    "mapPackage" in value &&
    "setViewState" in value &&
    "setLayerVisibility" in value
  );
}

interface RuntimeMap extends MaplibreMap {
  getBounds?(): RuntimeBounds;
  getCenter?(): { lng: number; lat: number } | { lon: number; lat: number } | readonly [number, number];
  getZoom?(): number;
  getPitch?(): number;
  getBearing?(): number;
}

interface RuntimeBounds {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}

function createMapRuntimeControllerAdapter(runtime: HonuaControllerRuntimeLike): HonuaControllerAdapter {
  const map = runtime.map as RuntimeMap;
  const overlayLayers = new Map<string, string[]>();
  const annotationLayers = new Map<string, string[]>();
  const supportsTemporaryLayers =
    typeof map.addSource === "function" &&
    typeof map.addLayer === "function" &&
    typeof map.removeLayer === "function" &&
    typeof map.removeSource === "function";

  const adapter: HonuaControllerAdapter = {
    id: `map-runtime:${runtime.mapPackage.mapPackageId}`,
    getViewport(): HonuaViewport | undefined {
      return readMapViewport(map) ?? normalizeViewport(runtime.mapPackage.initialView ?? {});
    },
    setViewport(viewport, options): void {
      runtime.setViewState({
        ...viewport,
        ...(viewport.bbox ? { bbox: viewport.bbox } : {}),
        animate: options?.animate,
        padding: options?.padding,
      });
    },
    fitBounds(bounds, options): void {
      runtime.setViewState({
        bbox: bounds,
        animate: options?.animate,
        padding: options?.padding,
        ...(options?.bearing !== undefined ? { bearing: options.bearing } : {}),
        ...(options?.pitch !== undefined ? { pitch: options.pitch } : {}),
      });
    },
    setLayerVisibility(layerId, visible): void {
      runtime.setLayerVisibility(layerId, visible);
    },
    onViewportMove(listener): Unsubscribe {
      return subscribeMapEvent(map, "move", () => listener(readMapViewport(map)));
    },
    onViewportMoveEnd(listener): Unsubscribe {
      return subscribeMapEvent(map, "moveend", () => listener(readMapViewport(map)));
    },
    onIdle(listener): Unsubscribe {
      return subscribeMapEvent(map, "idle", listener);
    },
  };

  if (supportsTemporaryLayers) {
    adapter.addOverlay = (overlay): void => {
      removeTemporaryMapItem(map, "overlay", overlay.id, overlayLayers);
      const sourceId = temporarySourceId("overlay", overlay.id);
      map.addSource?.(sourceId, { type: "geojson", data: overlayToGeoJson(overlay) });
      const layers = overlayLayerSpecs(sourceId, overlay);
      for (const layer of layers) map.addLayer?.(layer);
      overlayLayers.set(
        overlay.id,
        layers.map((layer) => String(layer.id)),
      );
    };
    adapter.removeOverlay = (overlayId): void => {
      removeTemporaryMapItem(map, "overlay", overlayId, overlayLayers);
    };
    adapter.addAnnotation = (annotation): void => {
      removeTemporaryMapItem(map, "annotation", annotation.id, annotationLayers);
      const geojson = annotationToGeoJson(annotation);
      if (!geojson) return;
      const sourceId = temporarySourceId("annotation", annotation.id);
      map.addSource?.(sourceId, { type: "geojson", data: geojson });
      const layers = annotationLayerSpecs(sourceId, annotation);
      for (const layer of layers) map.addLayer?.(layer);
      annotationLayers.set(
        annotation.id,
        layers.map((layer) => String(layer.id)),
      );
    };
    adapter.removeAnnotation = (annotationId): void => {
      removeTemporaryMapItem(map, "annotation", annotationId, annotationLayers);
    };
  }

  return adapter;
}

function readMapViewport(map: RuntimeMap): HonuaViewport | undefined {
  const viewport: {
    bbox?: HonuaBounds;
    center?: readonly [number, number];
    zoom?: number;
    pitch?: number;
    bearing?: number;
    crs?: string;
  } = {};
  const bounds = map.getBounds?.();
  if (bounds) {
    viewport.bbox = [
      Math.min(bounds.getWest(), bounds.getEast()),
      Math.min(bounds.getSouth(), bounds.getNorth()),
      Math.max(bounds.getWest(), bounds.getEast()),
      Math.max(bounds.getSouth(), bounds.getNorth()),
    ];
  }
  const center = map.getCenter?.();
  if (Array.isArray(center)) {
    viewport.center = [center[0], center[1]];
  } else if (center && "lng" in center) {
    viewport.center = [center.lng, center.lat];
  } else if (center && "lon" in center) {
    viewport.center = [center.lon, center.lat];
  }
  const zoom = map.getZoom?.();
  if (zoom !== undefined) viewport.zoom = zoom;
  const pitch = map.getPitch?.();
  if (pitch !== undefined) viewport.pitch = pitch;
  const bearing = map.getBearing?.();
  if (bearing !== undefined) viewport.bearing = bearing;
  return Object.keys(viewport).length > 0 ? viewport : undefined;
}

function subscribeMapEvent(map: RuntimeMap, event: string, listener: () => void): Unsubscribe {
  map.on?.(event, listener);
  return () => map.off?.(event, listener);
}

function removeAdapterSubscription(subscription: Unsubscribe | HonuaControllerAdapterSubscription): Unsubscribe {
  if (typeof subscription === "function") return subscription;
  return () => subscription.remove();
}

function normalizeViewport(viewport: HonuaViewport | undefined): HonuaViewport {
  if (!viewport) return {};
  if (viewport.bbox) assertBounds(viewport.bbox);
  if (viewport.center) assertCoordinate2d(viewport.center, "center");
  for (const [key, value] of Object.entries({
    zoom: viewport.zoom,
    pitch: viewport.pitch,
    bearing: viewport.bearing,
  })) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new HonuaControllerError("invalid-viewport", `viewport.${key} must be a finite number`);
    }
  }
  return structuredClone(viewport) as HonuaViewport;
}

function assertBounds(bounds: HonuaBounds): void {
  if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
    throw new HonuaControllerError("invalid-viewport", "viewport bounds must be [west, south, east, north]");
  }
  if (bounds[0] > bounds[2] || bounds[1] > bounds[3]) {
    throw new HonuaControllerError("invalid-viewport", "viewport bounds must be ordered west,south,east,north");
  }
}

function assertCoordinate2d(coordinate: readonly [number, number], label: string): void {
  if (coordinate.length < 2 || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
    throw new HonuaControllerError("invalid-viewport", `${label} must contain finite longitude and latitude values`);
  }
}

function viewportToExtent(viewport: HonuaViewport | undefined): HonuaExtent | undefined {
  if (!viewport?.bbox) return undefined;
  const [xmin, ymin, xmax, ymax] = viewport.bbox;
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReference:
      viewport.crs === undefined || viewport.crs === "EPSG:4326" ? { wkid: 4326 } : { wkt: viewport.crs },
  };
}

function extentToViewport(extent: HonuaExtent | undefined): HonuaViewport {
  if (!extent) return {};
  return {
    bbox: [extent.xmin, extent.ymin, extent.xmax, extent.ymax],
    crs:
      extent.spatialReference?.wkid !== undefined
        ? `EPSG:${extent.spatialReference.wkid}`
        : extent.spatialReference?.wkt,
  };
}

function cloneViewport(viewport: HonuaViewport): HonuaViewport {
  return structuredClone(viewport) as HonuaViewport;
}

function viewportsEqual(a: HonuaViewport | undefined, b: HonuaViewport | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function cloneSelection(selection: ReadonlyArray<FeatureSelectionTarget>): ReadonlyArray<FeatureSelectionTarget> {
  return structuredClone(selection) as FeatureSelectionTarget[];
}

function initialVisibilityFromRuntime(
  runtime: HonuaControllerRuntimeLike | undefined,
  layerGroups: HonuaControllerOptions["layerGroups"],
  legendItemLayers: HonuaControllerOptions["legendItemLayers"],
): HonuaVisibilitySnapshot {
  const layers: Record<string, boolean> = {};
  const style = runtime?.composedStyle ?? runtime?.mapPackage.mapSpec;
  for (const layer of style?.layers ?? []) {
    layers[layer.id] = (layer.layout?.visibility ?? "visible") !== "none";
  }
  const layerGroupVisibility: Record<string, boolean> = {};
  for (const [groupId, layerIds] of Object.entries(layerGroups ?? {})) {
    layerGroupVisibility[groupId] = layerIds.every((layerId) => layers[layerId] ?? true);
  }
  const legendItems: Record<string, boolean> = {};
  for (const entry of runtime?.getLegend?.() ?? []) {
    legendItems[entry.id] = true;
  }
  for (const itemId of Object.keys(legendItemLayers ?? {})) {
    legendItems[itemId] = legendItems[itemId] ?? true;
  }
  return { layers, layerGroups: layerGroupVisibility, legendItems };
}

function mergeVisibility(
  base: HonuaVisibilitySnapshot,
  override: Partial<HonuaVisibilitySnapshot> | undefined,
): HonuaVisibilitySnapshot {
  return {
    layers: { ...base.layers, ...(override?.layers ?? {}) },
    layerGroups: { ...base.layerGroups, ...(override?.layerGroups ?? {}) },
    legendItems: { ...base.legendItems, ...(override?.legendItems ?? {}) },
  };
}

function cloneVisibility(visibility: HonuaVisibilitySnapshot): HonuaVisibilitySnapshot {
  return structuredClone(visibility) as HonuaVisibilitySnapshot;
}

function visibilityEqual(a: HonuaVisibilitySnapshot, b: HonuaVisibilitySnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function targetsFromChangeSet(
  kind: HonuaVisibilityTargetKind,
  update: HonuaVisibilityChangeSet,
): NormalizedVisibilityUpdate {
  return {
    show: (update.show ?? []).map((id) => ({ kind, id })),
    hide: (update.hide ?? []).map((id) => ({ kind, id })),
  };
}

function normalizeVisibilityUpdate(update: HonuaVisibilityUpdate): NormalizedVisibilityUpdate {
  return {
    show: (update.show ?? []).map((target) => normalizeVisibilityTarget(target)),
    hide: (update.hide ?? []).map((target) => normalizeVisibilityTarget(target)),
  };
}

function normalizeVisibilityTarget(target: HonuaVisibilityTargetInput): HonuaVisibilityTarget {
  return typeof target === "string" ? { kind: "layer", id: target } : { kind: target.kind, id: target.id };
}

function applyVisibilityTarget(
  visibility: HonuaVisibilitySnapshot,
  target: HonuaVisibilityTarget,
  visible: boolean,
  layerGroups: Readonly<Record<string, ReadonlyArray<string>>>,
  legendItemLayers: Readonly<Record<string, ReadonlyArray<string>>>,
  rendererChanges: Map<string, boolean>,
): void {
  const layers = { ...visibility.layers };
  const layerGroupState = { ...visibility.layerGroups };
  const legendItemState = { ...visibility.legendItems };

  switch (target.kind) {
    case "layer":
      layers[target.id] = visible;
      rendererChanges.set(target.id, visible);
      break;
    case "layer-group":
      layerGroupState[target.id] = visible;
      for (const layerId of layerGroups[target.id] ?? []) {
        layers[layerId] = visible;
        rendererChanges.set(layerId, visible);
      }
      break;
    case "legend-item":
      legendItemState[target.id] = visible;
      for (const layerId of legendItemLayers[target.id] ?? []) {
        layers[layerId] = visible;
        rendererChanges.set(layerId, visible);
      }
      break;
  }

  (visibility as { layers: Readonly<Record<string, boolean>> }).layers = layers;
  (visibility as { layerGroups: Readonly<Record<string, boolean>> }).layerGroups = layerGroupState;
  (visibility as { legendItems: Readonly<Record<string, boolean>> }).legendItems = legendItemState;
}

function normalizeOverlay(input: HonuaTemporaryOverlayInput | HonuaTemporaryOverlay): HonuaTemporaryOverlay {
  const id = input.id?.trim() || `overlay-${++generatedOverlayId}`;
  if (!id) throw new HonuaControllerError("invalid-overlay", "overlay.id must not be empty");
  switch (input.kind) {
    case "geojson":
      return structuredClone({ ...input, id }) as HonuaTemporaryOverlay;
    case "point":
      assertCoordinate(input.coordinate, "overlay.coordinate", "invalid-overlay");
      return structuredClone({ ...input, id }) as HonuaTemporaryOverlay;
    case "line":
      if (input.coordinates.length < 2) {
        throw new HonuaControllerError("invalid-overlay", "line overlay requires at least two coordinates");
      }
      for (const coordinate of input.coordinates)
        assertCoordinate(coordinate, "overlay.coordinates", "invalid-overlay");
      return structuredClone({ ...input, id }) as HonuaTemporaryOverlay;
    case "polygon":
      if (input.rings.length === 0 || input.rings[0].length < 4) {
        throw new HonuaControllerError("invalid-overlay", "polygon overlay requires at least one closed ring");
      }
      for (const ring of input.rings) {
        for (const coordinate of ring) assertCoordinate(coordinate, "overlay.rings", "invalid-overlay");
      }
      return structuredClone({ ...input, id }) as HonuaTemporaryOverlay;
  }
}

function normalizeAnnotation(
  input: HonuaTemporaryAnnotationInput | HonuaTemporaryAnnotation,
): HonuaTemporaryAnnotation {
  const id = input.id?.trim() || `annotation-${++generatedAnnotationId}`;
  if (!id) throw new HonuaControllerError("invalid-annotation", "annotation.id must not be empty");
  if (!input.text.trim()) throw new HonuaControllerError("invalid-annotation", "annotation.text must not be empty");
  if ("coordinate" in input && input.coordinate) {
    assertCoordinate(input.coordinate, "annotation.coordinate", "invalid-annotation");
  }
  return structuredClone({ ...input, id }) as HonuaTemporaryAnnotation;
}

function assertCoordinate(
  coordinate: HonuaCoordinate,
  label: string,
  code: "invalid-overlay" | "invalid-annotation",
): void {
  if (coordinate.length < 2 || coordinate.length > 3 || coordinate.some((value) => !Number.isFinite(value))) {
    throw new HonuaControllerError(code, `${label} must contain two or three finite numeric values`);
  }
}

function temporarySourceId(kind: "overlay" | "annotation", id: string): string {
  return `honua-controller-${kind}-${safeMapId(id)}`;
}

function safeMapId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function removeTemporaryMapItem(
  map: RuntimeMap,
  kind: "overlay" | "annotation",
  id: string,
  layersById: Map<string, string[]>,
): void {
  for (const layerId of [...(layersById.get(id) ?? [])].reverse()) map.removeLayer?.(layerId);
  layersById.delete(id);
  map.removeSource?.(temporarySourceId(kind, id));
}

function overlayToGeoJson(
  overlay: HonuaTemporaryOverlay,
): HonuaGeoJsonFeature | HonuaGeoJsonFeatureCollection | HonuaGeoJsonGeometry {
  switch (overlay.kind) {
    case "geojson":
      return overlay.data;
    case "point":
      return {
        type: "Feature",
        id: overlay.id,
        properties: overlay.properties ?? {},
        geometry: { type: "Point", coordinates: overlay.coordinate },
      };
    case "line":
      return {
        type: "Feature",
        id: overlay.id,
        properties: overlay.properties ?? {},
        geometry: { type: "LineString", coordinates: overlay.coordinates },
      };
    case "polygon":
      return {
        type: "Feature",
        id: overlay.id,
        properties: overlay.properties ?? {},
        geometry: { type: "Polygon", coordinates: overlay.rings },
      };
  }
}

function annotationToGeoJson(annotation: HonuaTemporaryAnnotation): HonuaGeoJsonFeature | undefined {
  if (!annotation.coordinate) return undefined;
  return {
    type: "Feature",
    id: annotation.id,
    properties: { ...(annotation.properties ?? {}), text: annotation.text, kind: annotation.kind },
    geometry: { type: "Point", coordinates: annotation.coordinate },
  };
}

function overlayLayerSpecs(sourceId: string, overlay: HonuaTemporaryOverlay): Array<Record<string, unknown>> {
  const id = temporarySourceId("overlay", overlay.id);
  const style = overlay.style ?? {};
  const color = style.color ?? "#2563eb";
  const pointLayer = {
    id: `${id}-point`,
    type: "circle",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": style.pointColor ?? color,
      "circle-radius": style.pointRadius ?? 6,
      "circle-opacity": style.opacity ?? 0.9,
    },
  };
  const lineLayer = {
    id: `${id}-line`,
    type: "line",
    source: sourceId,
    filter: ["in", ["geometry-type"], "LineString", "Polygon"],
    paint: {
      "line-color": style.lineColor ?? color,
      "line-width": style.lineWidth ?? 2,
      "line-opacity": style.opacity ?? 0.95,
    },
  };
  const fillLayer = {
    id: `${id}-fill`,
    type: "fill",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": style.fillColor ?? color,
      "fill-opacity": style.fillOpacity ?? 0.18,
    },
  };
  if (overlay.kind === "point") return [pointLayer];
  if (overlay.kind === "line") return [lineLayer];
  if (overlay.kind === "polygon") return [fillLayer, lineLayer];
  return [fillLayer, lineLayer, pointLayer];
}

function annotationLayerSpecs(sourceId: string, annotation: HonuaTemporaryAnnotation): Array<Record<string, unknown>> {
  const id = temporarySourceId("annotation", annotation.id);
  const style = annotation.style ?? {};
  return [
    {
      id: `${id}-text`,
      type: "symbol",
      source: sourceId,
      layout: {
        "text-field": ["get", "text"],
        "text-size": style.size ?? 13,
        "text-anchor": style.anchor ?? "top",
      },
      paint: {
        "text-color": style.color ?? "#111827",
        "text-halo-color": style.haloColor ?? "#ffffff",
        "text-halo-width": style.haloWidth ?? 1,
      },
    },
  ];
}
