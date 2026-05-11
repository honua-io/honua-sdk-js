/**
 * `HonuaMapRuntime` — the operational API surface `#22` mixed-protocol
 * composition and `#29` operator components compose on top of. The
 * runtime never instantiates a MapLibre `Map`; the host passes one in.
 *
 * Types use a duck-typed `MaplibreMap` so the SDK stays bundle-neutral
 * and does not hard-couple to a specific maplibre-gl version.
 *
 * @module
 */

import type { Dataset } from "../contract/index.js";
import type { FeatureId } from "../contract/types.js";
import type { ExplorationViewController, SourceQualifiedFeatureSelectionTarget } from "../exploration/types.js";
import { bindMapSelectionToExploration, syncFeatureStateSelection } from "../interactions/exploration-bindings.js";
import { createHoverHandler, createSelectionHandler } from "../interactions/feature-state.js";
import type { FeatureStateMap, HoverHandle, MapEventTarget, SelectionHandle } from "../interactions/feature-state.js";
import type { HonuaMap } from "../map/honua-map.js";
import type { HonuaStyleSpecification } from "../style/specification.js";
import { type MapPackageDiff, diffPackages } from "./diff.js";
import { HonuaMapPackageError } from "./errors.js";
import { type LegendEntry, buildLegend } from "./legend.js";
import type { HonuaMapPackage, HonuaMapPackageInitialView, HonuaMapPackagePopupBinding } from "./map-package.js";
import { type PopupBindingHandle, type PopupFactory, type PopupRenderer, bindPopup } from "./popups.js";
import {
  featureStateTargetFromSelection,
  materializeRuntimeLayer,
  materializeRuntimeSource,
  materializeStyleValue,
  rendererRuntimeDiagnosticError,
  resolveFeatureIdFromEventFeature,
  resolveRuntimeBeforeId,
  selectionTargetForLayer,
  sourceContextForLayer,
  throwRuntimeDiagnostics,
  validateRuntimeFilterExpression,
  validateRuntimeLayer,
  validateRuntimeSource,
  validateRuntimeStyleExpression,
} from "./style-interactions.js";
import type {
  HonuaRuntimeDiagnostic,
  RuntimeClickInteractionHandler,
  RuntimeClickInteractionOptions,
  RuntimeExplorationSelectionOptions,
  RuntimeFeatureStateTarget,
  RuntimeFilterExpression,
  RuntimeHoverInteractionOptions,
  RuntimeLayerOrder,
  RuntimeLayerSpecification,
  RuntimeLayerUpdate,
  RuntimeLayoutSpecification,
  RuntimePaintSpecification,
  RuntimeSelectionInteractionOptions,
  RuntimeSourceSpecification,
} from "./style-interactions.js";
import type { RuntimeStyleSpecValidationMode } from "./style-spec-validation.js";

/**
 * Minimal subset of `maplibre-gl.Map` required by the runtime. Mirrors
 * the duck-typed interface pattern used in `src/interactions/feature-state.ts`.
 * Any object implementing these methods — including a MapLibre-GL `Map`
 * instance — works.
 */
export interface MaplibreMap extends FeatureStateMap, MapEventTarget {
  setStyle(style: HonuaStyleSpecification | unknown, options?: { diff?: boolean }): unknown;
  getStyle?(): HonuaStyleSpecification | unknown;
  addSource?(id: string, source: unknown): void;
  removeSource?(id: string): void;
  addLayer?(layer: unknown, beforeId?: string): void;
  removeLayer?(id: string): void;
  moveLayer?(id: string, beforeId?: string): void;
  getLayer?(id: string): unknown;
  setLayoutProperty?(layerId: string, name: string, value: unknown): void;
  setPaintProperty?(layerId: string, name: string, value: unknown): void;
  setFilter?(layerId: string, filter: unknown): void;
  getSource?(id: string): unknown;

  fitBounds?(
    bounds: [[number, number], [number, number]] | [number, number, number, number],
    options?: Record<string, unknown>,
  ): void;
  jumpTo?(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void;
  easeTo?(options: Record<string, unknown>): void;
  flyTo?(options: Record<string, unknown>): void;
}

// ── Telemetry ────────────────────────────────────────────────

export interface HonuaRuntimeTelemetrySpan {
  kind: "load" | "update" | "dispose" | "source-bind" | "popup";
  packageId: string | undefined;
  startedAt: number;
  detail?: Record<string, unknown>;
}

export interface HonuaRuntimeTelemetrySpanResult extends HonuaRuntimeTelemetrySpan {
  finishedAt: number;
  durationMs: number;
  error?: unknown;
}

/** Before/after/error collector, matches `HonuaRequestInterceptor` shape. */
export interface HonuaRuntimeTelemetry {
  before?: (span: HonuaRuntimeTelemetrySpan) => void;
  after?: (span: HonuaRuntimeTelemetrySpanResult) => void;
  error?: (span: HonuaRuntimeTelemetrySpanResult) => void;
}

// ── Runtime events ───────────────────────────────────────────

export type HonuaRuntimeEvent =
  | { type: "package-loaded"; packageId: string }
  | { type: "package-updated"; packageId: string; diff: MapPackageDiff }
  | { type: "source-ready"; sourceId: string }
  | { type: "source-error"; sourceId: string; error: unknown }
  | { type: "layer-rendered"; layerId: string }
  | { type: "disposed"; packageId: string | undefined };

export type HonuaRuntimeEventListener = (event: HonuaRuntimeEvent) => void;

// ── Options ──────────────────────────────────────────────────

/**
 * Result of a reload pass produced by the loader. `updatePackage` uses
 * this to replace the runtime's dataset / honuaMap on structural
 * refresh, so `runtime.dataset` and `runtime.honuaMap` observe changes
 * to `sourceBindings[]` instead of going stale.
 *
 * `failedSources` carries any per-source binding failures the loader
 * absorbed under `"tolerant"` mode so the runtime can re-emit them as
 * `source-error` events after the new style takes effect, mirroring
 * the lifecycle ordering used at first load.
 */
export interface HonuaMapRuntimeReload {
  composed: HonuaStyleSpecification;
  dataset: Dataset;
  honuaMap: HonuaMap;
  failedSources?: ReadonlyArray<{ sourceId: string; error: unknown }>;
}

/** Options passed to the `HonuaMapRuntime` constructor; the loader fills these in. */
export interface HonuaMapRuntimeInternals {
  map: MaplibreMap;
  honuaMap: HonuaMap;
  dataset: Dataset;
  composedStyle: HonuaStyleSpecification;
  packageRef: { current: HonuaMapPackage };
  telemetry?: HonuaRuntimeTelemetry;
  popupFactory?: PopupFactory;
  popupRenderer?: PopupRenderer;
  styleSpecValidationMode: RuntimeStyleSpecValidationMode;
  reload: (next: HonuaMapPackage) => Promise<HonuaMapRuntimeReload>;
}

export interface SetViewStateInput {
  bbox?: readonly [number, number, number, number];
  center?: readonly [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  animate?: boolean;
}

interface ActivePopupBinding {
  handle: PopupBindingHandle;
  sourceId: string | undefined;
  binding: HonuaMapPackagePopupBinding;
  resolvedFromPackage: boolean;
}

// ── Runtime ──────────────────────────────────────────────────

export class HonuaMapRuntime {
  public readonly map: MaplibreMap;

  readonly #packageRef: { current: HonuaMapPackage };
  readonly #listeners = new Set<HonuaRuntimeEventListener>();
  readonly #telemetry: HonuaRuntimeTelemetry | undefined;
  readonly #popupFactory: PopupFactory | undefined;
  readonly #popupRenderer: PopupRenderer | undefined;
  readonly #styleSpecValidationMode: RuntimeStyleSpecValidationMode;
  readonly #popupBindings = new Map<string, ActivePopupBinding>();
  readonly #reload: (next: HonuaMapPackage) => Promise<HonuaMapRuntimeReload>;
  #honuaMap: HonuaMap;
  #dataset: Dataset;
  #composedStyle: HonuaStyleSpecification;
  #disposed = false;

  /** @internal — constructed by {@link loadMapPackage}. */
  public constructor(internals: HonuaMapRuntimeInternals) {
    this.map = internals.map;
    this.#honuaMap = internals.honuaMap;
    this.#dataset = internals.dataset;
    this.#composedStyle = internals.composedStyle;
    this.#packageRef = internals.packageRef;
    this.#telemetry = internals.telemetry;
    this.#popupFactory = internals.popupFactory;
    this.#popupRenderer = internals.popupRenderer;
    this.#styleSpecValidationMode = internals.styleSpecValidationMode;
    this.#reload = internals.reload;
  }

  /**
   * The `HonuaMap` owning the current package's sources and layers. The
   * reference is replaced on any structural `updatePackage` call so
   * consumers always observe the live source set rather than the one
   * captured at first load.
   */
  public get honuaMap(): HonuaMap {
    return this.#honuaMap;
  }

  /**
   * The `Dataset` bound to the current package's source bindings. The
   * reference is replaced on any structural `updatePackage` call so a
   * source-binding locator or filter change is visible through
   * `runtime.dataset.source(id)`.
   */
  public get dataset(): Dataset {
    return this.#dataset;
  }

  /** The currently applied package. */
  public get mapPackage(): HonuaMapPackage {
    return this.#packageRef.current;
  }

  /** The composed MapLibre style last handed to the underlying map. */
  public get composedStyle(): HonuaStyleSpecification {
    return this.#composedStyle;
  }

  // ── Operational API ─────────────────────────────────────────

  public getLegend(): LegendEntry[] {
    return buildLegend(this.#packageRef.current.legend, this.#composedStyle);
  }

  public setLayerVisibility(layerId: string, visible: boolean): void {
    this.#assertLive();
    this.map.setLayoutProperty?.(layerId, "visibility", visible ? "visible" : "none");
  }

  public validateStyleExpression(value: unknown): HonuaRuntimeDiagnostic[] {
    return validateRuntimeStyleExpression(value, {
      styleSpecValidationMode: this.#styleSpecValidationMode,
    });
  }

  public validateFilterExpression(filter: unknown, layerId?: string): HonuaRuntimeDiagnostic[] {
    const layerContext = layerId
      ? sourceContextForLayer(this.#composedStyle, this.#packageRef.current, layerId)
      : undefined;
    return validateRuntimeFilterExpression(filter, {
      ...(layerId ? { layerId, path: `layers.${layerId}.filter` } : {}),
      ...(layerContext
        ? {
            sourceId: layerContext.sourceId,
            protocol: layerContext.protocol,
          }
        : {}),
      styleSpecValidationMode: this.#styleSpecValidationMode,
    });
  }

  public addSource(sourceId: string, source: RuntimeSourceSpecification): void {
    this.#assertLive();
    const spec = materializeRuntimeSource(source);
    const diagnostics = [
      ...(Object.hasOwn(this.#composedStyle.sources, sourceId)
        ? [
            {
              code: "source-duplicate",
              severity: "error" as const,
              message: `Source "${sourceId}" already exists.`,
              path: `sources.${sourceId}`,
              sourceId,
              protocol: spec.type,
            },
          ]
        : []),
      ...validateRuntimeSource(sourceId, spec, {
        style: this.#composedStyle,
        mapPackage: this.#packageRef.current,
        operation: "addSource",
        styleSpecValidationMode: this.#styleSpecValidationMode,
      }),
    ];
    throwRuntimeDiagnostics(diagnostics, `Cannot add source "${sourceId}".`);

    const nextStyle = {
      ...this.#composedStyle,
      sources: { ...this.#composedStyle.sources, [sourceId]: spec },
    };

    try {
      this.#honuaMap.addSource(sourceId, spec);
      try {
        this.#applyRendererSourceAdd(sourceId, spec, nextStyle);
      } catch (error) {
        this.#honuaMap.removeSource(sourceId);
        throw error;
      }
      this.#composedStyle = nextStyle;
    } catch (error) {
      if (error instanceof Error && error.name === "HonuaRuntimeDiagnosticError") throw error;
      throw rendererRuntimeDiagnosticError(
        `addSource("${sourceId}") failed`,
        {
          code: "source-add-failed",
          message: errorMessage(error),
          path: `sources.${sourceId}`,
          sourceId,
          protocol: spec.type,
        },
        error,
      );
    }
  }

  public updateSource(sourceId: string, source: RuntimeSourceSpecification): void {
    this.#assertLive();
    const previous = this.#composedStyle.sources[sourceId];
    const spec = materializeRuntimeSource(source);
    const diagnostics = [
      ...(!previous
        ? [
            {
              code: "source-not-found",
              severity: "error" as const,
              message: `Source "${sourceId}" does not exist.`,
              path: `sources.${sourceId}`,
              sourceId,
              protocol: spec.type,
            },
          ]
        : []),
      ...validateRuntimeSource(sourceId, spec, {
        style: this.#composedStyle,
        mapPackage: this.#packageRef.current,
        operation: "updateSource",
        styleSpecValidationMode: this.#styleSpecValidationMode,
      }),
    ];
    throwRuntimeDiagnostics(diagnostics, `Cannot update source "${sourceId}".`);

    const nextStyle = {
      ...this.#composedStyle,
      sources: { ...this.#composedStyle.sources, [sourceId]: spec },
    };

    try {
      this.#honuaMap.updateSource(sourceId, spec);
      try {
        this.map.setStyle(nextStyle, { diff: true });
      } catch (error) {
        if (previous) this.#honuaMap.updateSource(sourceId, previous);
        throw error;
      }
      this.#composedStyle = nextStyle;
    } catch (error) {
      throw rendererRuntimeDiagnosticError(
        `updateSource("${sourceId}") failed`,
        {
          code: "source-update-failed",
          message: errorMessage(error),
          path: `sources.${sourceId}`,
          sourceId,
          protocol: spec.type,
        },
        error,
      );
    }
  }

  public removeSource(sourceId: string): string[] {
    this.#assertLive();
    if (!Object.hasOwn(this.#composedStyle.sources, sourceId)) {
      return [];
    }

    const removedLayerIds = this.#composedStyle.layers
      .filter((layer) => layer.source === sourceId)
      .map((layer) => layer.id);
    const nextSources = { ...this.#composedStyle.sources };
    delete nextSources[sourceId];
    const nextStyle = {
      ...this.#composedStyle,
      sources: nextSources,
      layers: this.#composedStyle.layers.filter((layer) => layer.source !== sourceId),
    };

    try {
      this.#applyRendererSourceRemove(sourceId, removedLayerIds, nextStyle);
      this.#honuaMap.removeSource(sourceId);
      this.#composedStyle = nextStyle;
      return removedLayerIds;
    } catch (error) {
      throw rendererRuntimeDiagnosticError(
        `removeSource("${sourceId}") failed`,
        {
          code: "source-remove-failed",
          message: errorMessage(error),
          path: `sources.${sourceId}`,
          sourceId,
        },
        error,
      );
    }
  }

  public addLayer(layer: RuntimeLayerSpecification, order?: RuntimeLayerOrder): void {
    this.#assertLive();
    const spec = materializeRuntimeLayer(layer);
    const orderResult = resolveRuntimeBeforeId(this.#composedStyle, order);
    const diagnostics = [
      ...(this.#composedStyle.layers.some((entry) => entry.id === spec.id)
        ? [
            {
              code: "layer-duplicate",
              severity: "error" as const,
              message: `Layer "${spec.id}" already exists.`,
              path: `layers.${spec.id}`,
              layerId: spec.id,
              sourceId: spec.source,
            },
          ]
        : []),
      ...orderResult.diagnostics,
      ...validateRuntimeLayer(spec, {
        style: this.#composedStyle,
        mapPackage: this.#packageRef.current,
        operation: "addLayer",
        styleSpecValidationMode: this.#styleSpecValidationMode,
      }),
    ];
    throwRuntimeDiagnostics(diagnostics, `Cannot add layer "${spec.id}".`);

    const nextStyle = insertLayer(this.#composedStyle, spec, orderResult.beforeId);
    try {
      this.#honuaMap.addLayer(spec, orderResult.beforeId);
      try {
        this.#applyRendererLayerAdd(spec, orderResult.beforeId, nextStyle);
      } catch (error) {
        this.#honuaMap.removeLayer(spec.id);
        throw error;
      }
      this.#composedStyle = nextStyle;
    } catch (error) {
      throw rendererRuntimeDiagnosticError(
        `addLayer("${spec.id}") failed`,
        {
          code: "layer-add-failed",
          message: errorMessage(error),
          path: `layers.${spec.id}`,
          sourceId: spec.source,
          layerId: spec.id,
          protocol: sourceContextForLayer(nextStyle, this.#packageRef.current, spec.id)?.protocol,
        },
        error,
      );
    }
  }

  public updateLayer(layerId: string, update: RuntimeLayerUpdate): void {
    this.#assertLive();
    const previous = this.#composedStyle.layers.find((layer) => layer.id === layerId);
    if (!previous) {
      throwRuntimeDiagnostics(
        [
          {
            code: "layer-not-found",
            severity: "error",
            message: `Layer "${layerId}" does not exist.`,
            path: `layers.${layerId}`,
            layerId,
          },
        ],
        `Cannot update layer "${layerId}".`,
      );
      return;
    }

    const { order, ...rawPatch } = update;
    const patch = materializeStyleValue(rawPatch) as Partial<Omit<RuntimeLayerSpecification, "id">>;
    const nextLayer: HonuaStyleSpecification["layers"][number] = { ...previous, ...patch, id: layerId };
    const orderResult = resolveRuntimeBeforeId(this.#composedStyle, order, layerId);
    const diagnostics = [
      ...orderResult.diagnostics,
      ...validateRuntimeLayer(nextLayer, {
        style: this.#composedStyle,
        mapPackage: this.#packageRef.current,
        operation: "updateLayer",
        styleSpecValidationMode: this.#styleSpecValidationMode,
      }),
    ];
    throwRuntimeDiagnostics(diagnostics, `Cannot update layer "${layerId}".`);

    const nextStyle = replaceLayer(
      this.#composedStyle,
      nextLayer,
      order === undefined ? undefined : orderResult.beforeId,
      order === undefined,
    );
    const incremental = order === undefined && canPatchLayerWithMap(this.map, previous, nextLayer);
    try {
      if (incremental) {
        this.#patchLayer(layerId, previous, nextLayer);
      } else {
        this.map.setStyle(nextStyle, { diff: true });
      }
      this.#honuaMap.updateLayer(layerId, patch as Partial<Omit<HonuaStyleSpecification["layers"][number], "id">>);
      if (order !== undefined) {
        this.#honuaMap.moveLayer(layerId, orderResult.beforeId);
      }
      this.#composedStyle = nextStyle;
    } catch (error) {
      throw rendererRuntimeDiagnosticError(
        `updateLayer("${layerId}") failed`,
        {
          code: "layer-update-failed",
          message: errorMessage(error),
          path: `layers.${layerId}`,
          sourceId: nextLayer.source,
          layerId,
          protocol: sourceContextForLayer(nextStyle, this.#packageRef.current, layerId)?.protocol,
        },
        error,
      );
    }
  }

  public removeLayer(layerId: string): boolean {
    this.#assertLive();
    const existing = this.#composedStyle.layers.find((layer) => layer.id === layerId);
    if (!existing) return false;

    const nextStyle = {
      ...this.#composedStyle,
      layers: this.#composedStyle.layers.filter((layer) => layer.id !== layerId),
    };
    try {
      if (this.map.removeLayer) {
        this.map.removeLayer(layerId);
      } else {
        this.map.setStyle(nextStyle, { diff: true });
      }
      this.#honuaMap.removeLayer(layerId);
      this.#composedStyle = nextStyle;
      return true;
    } catch (error) {
      throw rendererRuntimeDiagnosticError(
        `removeLayer("${layerId}") failed`,
        {
          code: "layer-remove-failed",
          message: errorMessage(error),
          path: `layers.${layerId}`,
          sourceId: existing.source,
          layerId,
          protocol: sourceContextForLayer(this.#composedStyle, this.#packageRef.current, layerId)?.protocol,
        },
        error,
      );
    }
  }

  public moveLayer(layerId: string, order?: RuntimeLayerOrder): void {
    this.#assertLive();
    const existing = this.#composedStyle.layers.find((layer) => layer.id === layerId);
    if (!existing) {
      throwRuntimeDiagnostics(
        [
          {
            code: "layer-not-found",
            severity: "error",
            message: `Layer "${layerId}" does not exist.`,
            path: `layers.${layerId}`,
            layerId,
          },
        ],
        `Cannot move layer "${layerId}".`,
      );
      return;
    }

    const orderResult = resolveRuntimeBeforeId(this.#composedStyle, order, layerId);
    throwRuntimeDiagnostics(orderResult.diagnostics, `Cannot move layer "${layerId}".`);
    const nextStyle = replaceLayer(this.#composedStyle, existing, orderResult.beforeId, false);
    try {
      if (this.map.moveLayer) {
        this.map.moveLayer(layerId, orderResult.beforeId);
      } else {
        this.map.setStyle(nextStyle, { diff: true });
      }
      this.#honuaMap.moveLayer(layerId, orderResult.beforeId);
      this.#composedStyle = nextStyle;
    } catch (error) {
      throw rendererRuntimeDiagnosticError(
        `moveLayer("${layerId}") failed`,
        {
          code: "layer-move-failed",
          message: errorMessage(error),
          path: `layers.${layerId}`,
          sourceId: existing.source,
          layerId,
          protocol: sourceContextForLayer(this.#composedStyle, this.#packageRef.current, layerId)?.protocol,
        },
        error,
      );
    }
  }

  public setLayerPaint(layerId: string, paint: RuntimePaintSpecification): void {
    this.updateLayer(layerId, { paint });
  }

  public setLayerLayout(layerId: string, layout: RuntimeLayoutSpecification): void {
    this.updateLayer(layerId, { layout });
  }

  public setLayerFilter(layerId: string, filter: RuntimeFilterExpression | undefined): void {
    this.updateLayer(layerId, { filter });
  }

  public layerSelectionTarget(layerId: string, id: FeatureId): SourceQualifiedFeatureSelectionTarget {
    const target = selectionTargetForLayer(this.#composedStyle, layerId, id);
    if (!target) {
      throwRuntimeDiagnostics(
        [
          {
            code: "layer-source-missing",
            severity: "error",
            message: `Layer "${layerId}" does not have a source for feature selection.`,
            path: `layers.${layerId}.source`,
            layerId,
          },
        ],
        `Cannot build a source-qualified selection target for layer "${layerId}".`,
      );
      throw new Error("unreachable");
    }
    return target;
  }

  public setFeatureStateForTarget(
    target: RuntimeFeatureStateTarget | SourceQualifiedFeatureSelectionTarget,
    state: Record<string, unknown>,
  ): void {
    this.#assertLive();
    this.map.setFeatureState(normalizeFeatureStateTarget(target), state);
  }

  public getFeatureStateForTarget(
    target: RuntimeFeatureStateTarget | SourceQualifiedFeatureSelectionTarget,
  ): Record<string, unknown> {
    this.#assertLive();
    return this.map.getFeatureState(normalizeFeatureStateTarget(target));
  }

  public removeFeatureStateForTarget(
    target: RuntimeFeatureStateTarget | SourceQualifiedFeatureSelectionTarget,
    key?: string,
  ): void {
    this.#assertLive();
    this.map.removeFeatureState(normalizeFeatureStateTarget(target), key);
  }

  public bindHover(layerId: string, options: RuntimeHoverInteractionOptions = {}): HoverHandle {
    this.#assertLive();
    const context = this.#interactionContext(layerId, options.sourceId, options.sourceLayer);
    return createHoverHandler(this.map, {
      source: context.sourceId,
      sourceLayer: context.sourceLayer,
      layer: layerId,
      stateKey: options.stateKey,
    });
  }

  public bindClick(
    layerId: string,
    handler: RuntimeClickInteractionHandler,
    options: RuntimeClickInteractionOptions = {},
  ): { remove(): void } {
    this.#assertLive();
    const context = this.#interactionContext(layerId, options.sourceId, options.sourceLayer);

    const onClick = (event: unknown): void => {
      const feature = firstEventFeature(event);
      const featureId = feature ? resolveFeatureIdFromEventFeature(feature, event, options) : undefined;
      handler({
        type: "click",
        layerId,
        sourceId: context.sourceId,
        sourceLayer: context.sourceLayer,
        feature,
        featureId,
        ...(featureId !== undefined
          ? {
              selectionTarget: {
                sourceId: context.sourceId,
                id: featureId,
                ...(context.sourceLayer !== undefined ? { sourceLayer: context.sourceLayer } : {}),
              },
            }
          : {}),
        originalEvent: event,
      });
    };

    this.map.on("click", layerId, onClick);
    return {
      remove: () => this.map.off("click", layerId, onClick),
    };
  }

  public bindSelect(layerId: string, options: RuntimeSelectionInteractionOptions = {}): SelectionHandle {
    this.#assertLive();
    const context = this.#interactionContext(layerId, options.sourceId, options.sourceLayer);
    return createSelectionHandler(this.map, {
      source: context.sourceId,
      sourceLayer: context.sourceLayer,
      layer: layerId,
      stateKey: options.stateKey,
      multiSelect: options.multiSelect,
      onChange: options.onChange,
      onSelectionTargetsChange: options.onSelectionTargetsChange,
    });
  }

  public bindSelectionToExploration(
    layerId: string,
    view: ExplorationViewController,
    options: RuntimeExplorationSelectionOptions = {},
  ): SelectionHandle {
    this.#assertLive();
    const context = this.#interactionContext(layerId, options.sourceId, options.sourceLayer);
    return bindMapSelectionToExploration(this.map, view, {
      source: context.sourceId,
      sourceLayer: context.sourceLayer,
      layer: layerId,
      stateKey: options.stateKey,
      multiSelect: options.multiSelect,
      onChange: options.onChange,
      onSelectionTargetsChange: options.onSelectionTargetsChange,
      replaceSelection: options.replaceSelection,
    });
  }

  public syncSelectionFromExploration(
    layerId: string,
    view: ExplorationViewController,
    options: Omit<RuntimeExplorationSelectionOptions, "multiSelect" | "onChange" | "onSelectionTargetsChange"> = {},
  ): { remove(): void } {
    this.#assertLive();
    const context = this.#interactionContext(layerId, options.sourceId, options.sourceLayer);
    return syncFeatureStateSelection(this.map, view, {
      source: context.sourceId,
      sourceLayer: context.sourceLayer,
      stateKey: options.stateKey,
    });
  }

  public bindPopup(layerId: string, binding?: HonuaMapPackagePopupBinding): { remove(): void } {
    this.#assertLive();
    if (!this.#popupFactory) {
      throw new HonuaMapPackageError("bindPopup requires opts.popupFactory to be set on loadMapPackage", {
        packageId: this.#packageRef.current.mapPackageId,
        stage: "popup",
        detail: { layerId },
      });
    }
    const sourceId = layerIdToSource(this.#composedStyle, layerId);
    const resolvedFromPackage = binding === undefined;
    const resolved = binding ?? popupBindingForSource(this.#packageRef.current, sourceId);
    if (!resolved) {
      throw new HonuaMapPackageError(
        `no popupBinding found for layer "${layerId}"; supply a binding argument or add one to MapPackage.popupBindings`,
        { packageId: this.#packageRef.current.mapPackageId, stage: "popup", detail: { layerId } },
      );
    }

    this.#popupBindings.get(layerId)?.handle.remove();
    const handle = bindPopup(this.map, {
      binding: resolved,
      layerId,
      popupFactory: this.#popupFactory,
      render: this.#popupRenderer,
    });
    this.#popupBindings.set(layerId, { handle, sourceId, binding: resolved, resolvedFromPackage });
    return {
      remove: () => {
        handle.remove();
        if (this.#popupBindings.get(layerId)?.handle === handle) {
          this.#popupBindings.delete(layerId);
        }
      },
    };
  }

  public setViewState(view: SetViewStateInput): void {
    this.#assertLive();
    const bbox = view.bbox ?? this.#packageRef.current.initialView?.bbox;
    if (view.bbox && this.map.fitBounds) {
      const [west, south, east, north] = view.bbox;
      this.map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        {
          animate: view.animate ?? false,
          ...(view.padding !== undefined ? { padding: view.padding } : {}),
        },
      );
      return;
    }
    if (view.center) {
      this.map.jumpTo?.({
        center: view.center as [number, number],
        ...(view.zoom !== undefined ? { zoom: view.zoom } : {}),
        ...(view.bearing !== undefined ? { bearing: view.bearing } : {}),
        ...(view.pitch !== undefined ? { pitch: view.pitch } : {}),
      });
      return;
    }
    if (bbox && this.map.fitBounds) {
      const [west, south, east, north] = bbox;
      this.map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { animate: false },
      );
    }
  }

  /**
   * Diff the current package against `next`. Applies the change
   * incrementally when safe; falls back to `map.setStyle` for structural
   * changes. Preserves unknown fields from `next` on round-trip.
   */
  public async updatePackage(next: HonuaMapPackage): Promise<void> {
    this.#assertLive();
    const span = this.#startSpan("update", next.mapPackageId, { previousId: this.#packageRef.current.mapPackageId });
    try {
      if (next.format !== this.#packageRef.current.format) {
        throw new HonuaMapPackageError(
          `updatePackage: format "${next.format}" is incompatible with "${this.#packageRef.current.format}"`,
          {
            packageId: next.mapPackageId,
            stage: "update",
            detail: { expected: this.#packageRef.current.format, received: next.format },
          },
        );
      }

      let diff = diffPackages(this.#packageRef.current, next);

      const reload = await this.#reload(next);
      const composedStructuralReason = diff.incremental
        ? detectUnpatchableLayerChange(this.#composedStyle, reload.composed)
        : undefined;
      if (composedStructuralReason) {
        diff = {
          ...diff,
          incremental: false,
          structuralReason: composedStructuralReason,
        };
      }

      if (!diff.incremental) {
        // setStyle first so a host-map failure leaves the previous
        // runtime state intact. Only after it succeeds do we clear the
        // old HonuaMap, swap in the new dataset / honuaMap, and tear
        // down popup bindings whose layer, source, or package binding
        // changed.
        const previousHonuaMap = this.#honuaMap;
        this.map.setStyle(reload.composed);
        previousHonuaMap.clear();
        this.#honuaMap = reload.honuaMap;
        this.#dataset = reload.dataset;
        this.#packageRef.current = next;
        this.#composedStyle = reload.composed;
        this.#reapPopupBindings(reload.composed, next);
        this.#emit({ type: "package-updated", packageId: next.mapPackageId, diff });
        this.#emitReloadFailures(reload.failedSources);
        this.#finishSpan(span);
        return;
      }

      this.#applyIncremental(reload.composed, diff);
      this.#packageRef.current = next;
      this.#composedStyle = reload.composed;
      this.#reapPopupBindings(reload.composed, next);
      this.#emit({ type: "package-updated", packageId: next.mapPackageId, diff });
      this.#emitReloadFailures(reload.failedSources);
      this.#finishSpan(span);
    } catch (error) {
      this.#finishSpan(span, error);
      if (error instanceof HonuaMapPackageError) throw error;
      throw new HonuaMapPackageError("updatePackage failed", {
        packageId: next.mapPackageId,
        stage: "update",
        cause: error,
      });
    }
  }

  public on(listener: HonuaRuntimeEventListener): { remove(): void } {
    this.#listeners.add(listener);
    return {
      remove: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /** @internal used by the loader to emit `package-loaded`. */
  public _emit(event: HonuaRuntimeEvent): void {
    this.#emit(event);
  }

  /**
   * Surface a per-source failure detected outside the loader path —
   * typically a query / stream rejection in a mixed-source fan-out
   * (the canonical consumer is `#29`'s operator components). Emits the
   * existing `source-error` runtime event so listeners do not have to
   * subscribe to a parallel error channel and pipes the failure
   * through {@link HonuaRuntimeTelemetry.error} as a `source-bind`
   * span if the consumer wired one up.
   *
   * Idempotent and side-effect-free outside listener / telemetry
   * fan-out: the runtime does not retry, suppress, or reshape the
   * underlying source. Disposed runtimes silently no-op so a late
   * rejection from a stream never throws inside an event handler.
   */
  public reportSourceError(sourceId: string, error: unknown): void {
    if (this.#disposed) return;
    if (this.#telemetry?.error) {
      const startedAt = Date.now();
      this.#telemetry.error({
        kind: "source-bind",
        packageId: this.#packageRef.current.mapPackageId,
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        detail: { sourceId },
        error,
      });
    }
    this.#emit({ type: "source-error", sourceId, error });
  }

  public dispose(): void {
    if (this.#disposed) return;
    const span = this.#startSpan("dispose", this.#packageRef.current.mapPackageId);
    try {
      for (const binding of this.#popupBindings.values()) binding.handle.remove();
      this.#popupBindings.clear();

      for (const layer of this.#composedStyle.layers) {
        this.map.removeLayer?.(layer.id);
      }
      for (const sourceId of Object.keys(this.#composedStyle.sources)) {
        this.map.removeSource?.(sourceId);
      }
      this.#honuaMap.clear();
      this.#emit({ type: "disposed", packageId: this.#packageRef.current.mapPackageId });
      this.#listeners.clear();
      this.#disposed = true;
      this.#finishSpan(span);
    } catch (error) {
      this.#finishSpan(span, error);
      throw error;
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  #applyRendererSourceAdd(
    sourceId: string,
    source: RuntimeSourceSpecification,
    nextStyle: HonuaStyleSpecification,
  ): void {
    if (this.map.addSource) {
      this.map.addSource(sourceId, source);
      return;
    }
    this.map.setStyle(nextStyle, { diff: true });
  }

  #applyRendererSourceRemove(
    sourceId: string,
    removedLayerIds: readonly string[],
    nextStyle: HonuaStyleSpecification,
  ): void {
    if (!this.map.removeLayer || !this.map.removeSource) {
      this.map.setStyle(nextStyle, { diff: true });
      return;
    }
    for (const layerId of [...removedLayerIds].reverse()) {
      this.map.removeLayer(layerId);
    }
    this.map.removeSource(sourceId);
  }

  #applyRendererLayerAdd(
    layer: HonuaStyleSpecification["layers"][number],
    beforeId: string | undefined,
    nextStyle: HonuaStyleSpecification,
  ): void {
    if (this.map.addLayer) {
      this.map.addLayer(layer, beforeId);
      return;
    }
    this.map.setStyle(nextStyle, { diff: true });
  }

  #interactionContext(
    layerId: string,
    sourceIdOverride: string | undefined,
    sourceLayerOverride: string | undefined,
  ): { sourceId: string; sourceLayer: string | undefined; protocol: string | undefined } {
    const context = sourceContextForLayer(this.#composedStyle, this.#packageRef.current, layerId);
    const sourceId = sourceIdOverride ?? context?.sourceId;
    if (!sourceId) {
      throwRuntimeDiagnostics(
        [
          {
            code: "layer-source-missing",
            severity: "error",
            message: `Layer "${layerId}" does not have a source for interactions.`,
            path: `layers.${layerId}.source`,
            layerId,
          },
        ],
        `Cannot bind interactions for layer "${layerId}".`,
      );
      throw new Error("unreachable");
    }
    return {
      sourceId,
      sourceLayer: sourceLayerOverride ?? context?.sourceLayer,
      protocol: context?.protocol,
    };
  }

  #applyIncremental(composed: HonuaStyleSpecification, diff: MapPackageDiff): void {
    const prevStyle = this.#composedStyle;

    for (const layerId of diff.removedLayerIds) {
      this.#honuaMap.removeLayer(layerId);
      this.map.removeLayer?.(layerId);
    }

    const prevLayers = new Map(prevStyle.layers.map((l) => [l.id, l]));
    const nextLayers = new Map(composed.layers.map((l) => [l.id, l]));

    for (const layerId of diff.changedLayerIds) {
      const nextLayer = nextLayers.get(layerId);
      const prevLayer = prevLayers.get(layerId);
      if (!nextLayer || !prevLayer) continue;
      this.#patchLayer(layerId, prevLayer, nextLayer);
    }

    for (const layerId of prevLayers.keys()) {
      if (diff.removedLayerIds.includes(layerId) || diff.changedLayerIds.includes(layerId)) continue;
      const nextLayer = nextLayers.get(layerId);
      const prevLayer = prevLayers.get(layerId);
      if (!nextLayer || !prevLayer) continue;
      if (!shallowPaintLayoutEqual(prevLayer, nextLayer)) {
        this.#patchLayer(layerId, prevLayer, nextLayer);
      }
    }
  }

  #patchLayer(
    layerId: string,
    prev: Readonly<{ paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>,
    next: Readonly<{ paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>,
  ): void {
    const prevPaint = prev.paint ?? {};
    const nextPaint = next.paint ?? {};
    if (this.map.setPaintProperty) {
      const keys = unionKeys(prevPaint, nextPaint);
      for (const key of keys) {
        const prevValue = prevPaint[key];
        const nextValue = Object.hasOwn(nextPaint, key) ? nextPaint[key] : undefined;
        if (prevValue === nextValue) continue;
        this.map.setPaintProperty(layerId, key, nextValue);
      }
    }

    const prevLayout = prev.layout ?? {};
    const nextLayout = next.layout ?? {};
    if (this.map.setLayoutProperty) {
      const keys = unionKeys(prevLayout, nextLayout);
      for (const key of keys) {
        const prevValue = prevLayout[key];
        const nextValue = Object.hasOwn(nextLayout, key) ? nextLayout[key] : undefined;
        if (prevValue === nextValue) continue;
        this.map.setLayoutProperty(layerId, key, nextValue);
      }
    }

    if (this.map.setFilter && JSON.stringify(prev.filter) !== JSON.stringify(next.filter)) {
      this.map.setFilter(layerId, next.filter);
    }
  }

  #reapPopupBindings(composed: HonuaStyleSpecification, pkg: HonuaMapPackage): void {
    if (this.#popupBindings.size === 0) return;
    for (const [layerId, active] of Array.from(this.#popupBindings)) {
      const nextSourceId = layerIdToSource(composed, layerId);
      const packageBindingChanged =
        active.resolvedFromPackage && !sameJson(active.binding, popupBindingForSource(pkg, nextSourceId));
      if (!nextSourceId || nextSourceId !== active.sourceId || packageBindingChanged) {
        active.handle.remove();
        this.#popupBindings.delete(layerId);
      }
    }
  }

  #emit(event: HonuaRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #emitReloadFailures(failures: ReadonlyArray<{ sourceId: string; error: unknown }> | undefined): void {
    if (!failures || failures.length === 0) return;
    for (const failure of failures) {
      this.#emit({ type: "source-error", sourceId: failure.sourceId, error: failure.error });
    }
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new HonuaMapPackageError("runtime is disposed", {
        packageId: this.#packageRef.current.mapPackageId,
        stage: "dispose",
      });
    }
  }

  #startSpan(
    kind: HonuaRuntimeTelemetrySpan["kind"],
    packageId: string | undefined,
    detail?: Record<string, unknown>,
  ): HonuaRuntimeTelemetrySpan {
    const span: HonuaRuntimeTelemetrySpan = { kind, packageId, startedAt: Date.now(), detail };
    this.#telemetry?.before?.(span);
    return span;
  }

  #finishSpan(span: HonuaRuntimeTelemetrySpan, error?: unknown): void {
    const finishedAt = Date.now();
    const result: HonuaRuntimeTelemetrySpanResult = {
      ...span,
      finishedAt,
      durationMs: finishedAt - span.startedAt,
    };
    if (error !== undefined) {
      result.error = error;
      this.#telemetry?.error?.(result);
    } else {
      this.#telemetry?.after?.(result);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

function insertLayer(
  style: HonuaStyleSpecification,
  layer: HonuaStyleSpecification["layers"][number],
  beforeId: string | undefined,
): HonuaStyleSpecification {
  const layers = [...style.layers];
  if (beforeId) {
    const index = layers.findIndex((entry) => entry.id === beforeId);
    if (index >= 0) {
      layers.splice(index, 0, layer);
    } else {
      layers.push(layer);
    }
  } else {
    layers.push(layer);
  }
  return { ...style, layers };
}

function replaceLayer(
  style: HonuaStyleSpecification,
  layer: HonuaStyleSpecification["layers"][number],
  beforeId: string | undefined,
  preserveIndexWhenNoBefore = true,
): HonuaStyleSpecification {
  const layers = style.layers.filter((entry) => entry.id !== layer.id);
  if (beforeId) {
    const index = layers.findIndex((entry) => entry.id === beforeId);
    if (index >= 0) {
      layers.splice(index, 0, layer);
    } else {
      layers.push(layer);
    }
  } else {
    const previousIndex = style.layers.findIndex((entry) => entry.id === layer.id);
    if (preserveIndexWhenNoBefore && previousIndex >= 0 && previousIndex < layers.length) {
      layers.splice(previousIndex, 0, layer);
    } else {
      layers.push(layer);
    }
  }
  return { ...style, layers };
}

function normalizeFeatureStateTarget(
  target: RuntimeFeatureStateTarget | SourceQualifiedFeatureSelectionTarget,
): RuntimeFeatureStateTarget {
  if ("sourceId" in target) {
    return featureStateTargetFromSelection(target);
  }
  return target;
}

function firstEventFeature(event: unknown): unknown {
  if (typeof event !== "object" || event === null || !("features" in event)) {
    return undefined;
  }
  const features = (event as { features?: unknown }).features;
  return Array.isArray(features) ? features[0] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function layerIdToSource(style: HonuaStyleSpecification, layerId: string): string | undefined {
  return style.layers.find((l) => l.id === layerId)?.source;
}

function popupBindingForSource(
  pkg: HonuaMapPackage,
  sourceId: string | undefined,
): HonuaMapPackagePopupBinding | undefined {
  if (!sourceId) return undefined;
  return pkg.popupBindings?.find((binding) => binding.sourceId === sourceId);
}

function detectUnpatchableLayerChange(
  previous: HonuaStyleSpecification,
  next: HonuaStyleSpecification,
): string | undefined {
  // Tolerant source failure / recovery on reload can change the composed
  // layer or source set without showing up in the raw package diff
  // (which is computed from `mapSpec`, not the post-filter composed
  // style). Force structural fallback whenever the composed shape
  // differs so `#applyIncremental` does not leave stale MapLibre layers
  // or sources behind.
  const previousLayerIds = previous.layers.map((layer) => layer.id);
  const nextLayerIds = next.layers.map((layer) => layer.id);
  if (previousLayerIds.length !== nextLayerIds.length) {
    return "composed layer set changed (tolerant source failure or recovery)";
  }
  for (let i = 0; i < previousLayerIds.length; i++) {
    if (previousLayerIds[i] !== nextLayerIds[i]) {
      return "composed layer set or order changed (tolerant source failure or recovery)";
    }
  }
  const previousSourceIds = Object.keys(previous.sources).sort();
  const nextSourceIds = Object.keys(next.sources).sort();
  if (previousSourceIds.length !== nextSourceIds.length) {
    return "composed source set changed (tolerant source failure or recovery)";
  }
  for (let i = 0; i < previousSourceIds.length; i++) {
    if (previousSourceIds[i] !== nextSourceIds[i]) {
      return "composed source set changed (tolerant source failure or recovery)";
    }
  }

  const previousLayers = new Map(previous.layers.map((layer) => [layer.id, layer]));
  for (const nextLayer of next.layers) {
    const previousLayer = previousLayers.get(nextLayer.id);
    if (!previousLayer) continue;
    if (!patchableLayerShapeEqual(previousLayer, nextLayer)) {
      return `layer "${nextLayer.id}" changed outside paint/layout/filter`;
    }
  }
  return undefined;
}

function patchableLayerShapeEqual(
  a: HonuaStyleSpecification["layers"][number],
  b: HonuaStyleSpecification["layers"][number],
): boolean {
  return (
    a.type === b.type &&
    (a.source ?? "") === (b.source ?? "") &&
    a["source-layer"] === b["source-layer"] &&
    a.minzoom === b.minzoom &&
    a.maxzoom === b.maxzoom &&
    sameJson(a.metadata, b.metadata)
  );
}

function canPatchLayerWithMap(
  map: MaplibreMap,
  previous: HonuaStyleSpecification["layers"][number],
  next: HonuaStyleSpecification["layers"][number],
): boolean {
  if (!patchableLayerShapeEqual(previous, next)) return false;
  if (!sameJson(previous.paint ?? {}, next.paint ?? {}) && !map.setPaintProperty) return false;
  if (!sameJson(previous.layout ?? {}, next.layout ?? {}) && !map.setLayoutProperty) return false;
  if (!sameJson(previous.filter, next.filter) && !map.setFilter) return false;
  return true;
}

function shallowPaintLayoutEqual(
  a: Readonly<{ paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>,
  b: Readonly<{ paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>,
): boolean {
  return (
    sameJson(a.paint ?? {}, b.paint ?? {}) && sameJson(a.layout ?? {}, b.layout ?? {}) && sameJson(a.filter, b.filter)
  );
}

function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const key of Object.keys(a)) seen.add(key);
  for (const key of Object.keys(b)) seen.add(key);
  return [...seen];
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ── Re-exports for barrel ────────────────────────────────────

export type { MapPackageDiff } from "./diff.js";
export type { PopupFactory, PopupRenderer, PopupBindingHandle } from "./popups.js";
export type { LegendEntry } from "./legend.js";
