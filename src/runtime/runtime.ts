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
import type { FeatureStateMap, MapEventTarget } from "../interactions/feature-state.js";
import type { HonuaMap } from "../map/honua-map.js";
import type { HonuaStyleSpecification } from "../style/specification.js";
import { diffPackages, type MapPackageDiff } from "./diff.js";
import { HonuaMapPackageError } from "./errors.js";
import { buildLegend, type LegendEntry } from "./legend.js";
import type { HonuaMapPackage, HonuaMapPackageInitialView, HonuaMapPackagePopupBinding } from "./map-package.js";
import {
  bindPopup,
  type PopupBindingHandle,
  type PopupFactory,
  type PopupRenderer,
} from "./popups.js";

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
  getLayer?(id: string): unknown;
  setLayoutProperty?(layerId: string, name: string, value: unknown): void;
  setPaintProperty?(layerId: string, name: string, value: unknown): void;
  setFilter?(layerId: string, filter: unknown): void;
  getSource?(id: string): unknown;

  fitBounds?(bounds: [[number, number], [number, number]] | [number, number, number, number], options?: Record<string, unknown>): void;
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
  reload: (next: HonuaMapPackage) => Promise<HonuaStyleSpecification>;
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

// ── Runtime ──────────────────────────────────────────────────

export class HonuaMapRuntime {
  public readonly map: MaplibreMap;
  public readonly honuaMap: HonuaMap;
  public readonly dataset: Dataset;

  readonly #packageRef: { current: HonuaMapPackage };
  readonly #listeners = new Set<HonuaRuntimeEventListener>();
  readonly #telemetry: HonuaRuntimeTelemetry | undefined;
  readonly #popupFactory: PopupFactory | undefined;
  readonly #popupRenderer: PopupRenderer | undefined;
  readonly #popupBindings = new Map<string, PopupBindingHandle>();
  readonly #reload: (next: HonuaMapPackage) => Promise<HonuaStyleSpecification>;
  #composedStyle: HonuaStyleSpecification;
  #disposed = false;

  /** @internal — constructed by {@link loadMapPackage}. */
  public constructor(internals: HonuaMapRuntimeInternals) {
    this.map = internals.map;
    this.honuaMap = internals.honuaMap;
    this.dataset = internals.dataset;
    this.#composedStyle = internals.composedStyle;
    this.#packageRef = internals.packageRef;
    this.#telemetry = internals.telemetry;
    this.#popupFactory = internals.popupFactory;
    this.#popupRenderer = internals.popupRenderer;
    this.#reload = internals.reload;
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

  public bindPopup(layerId: string, binding?: HonuaMapPackagePopupBinding): { remove(): void } {
    this.#assertLive();
    if (!this.#popupFactory) {
      throw new HonuaMapPackageError(
        "bindPopup requires opts.popupFactory to be set on loadMapPackage",
        { packageId: this.#packageRef.current.mapPackageId, stage: "popup", detail: { layerId } },
      );
    }
    const resolved =
      binding ?? this.#packageRef.current.popupBindings?.find((b) => b.sourceId === layerIdToSource(this.#composedStyle, layerId));
    if (!resolved) {
      throw new HonuaMapPackageError(
        `no popupBinding found for layer "${layerId}"; supply a binding argument or add one to MapPackage.popupBindings`,
        { packageId: this.#packageRef.current.mapPackageId, stage: "popup", detail: { layerId } },
      );
    }

    this.#popupBindings.get(layerId)?.remove();
    const handle = bindPopup(this.map, {
      binding: resolved,
      layerId,
      popupFactory: this.#popupFactory,
      render: this.#popupRenderer,
    });
    this.#popupBindings.set(layerId, handle);
    return {
      remove: () => {
        handle.remove();
        this.#popupBindings.delete(layerId);
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
          { packageId: next.mapPackageId, stage: "update", detail: { expected: this.#packageRef.current.format, received: next.format } },
        );
      }

      const diff = diffPackages(this.#packageRef.current, next);

      const composed = await this.#reload(next);

      if (!diff.incremental) {
        this.map.setStyle(composed);
        this.#packageRef.current = next;
        this.#composedStyle = composed;
        this.#emit({ type: "package-updated", packageId: next.mapPackageId, diff });
        this.#finishSpan(span);
        return;
      }

      this.#applyIncremental(composed, diff);
      this.#packageRef.current = next;
      this.#composedStyle = composed;
      this.#emit({ type: "package-updated", packageId: next.mapPackageId, diff });
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

  public dispose(): void {
    if (this.#disposed) return;
    const span = this.#startSpan("dispose", this.#packageRef.current.mapPackageId);
    try {
      for (const handle of this.#popupBindings.values()) handle.remove();
      this.#popupBindings.clear();

      for (const layer of this.#composedStyle.layers) {
        this.map.removeLayer?.(layer.id);
      }
      for (const sourceId of Object.keys(this.#composedStyle.sources)) {
        this.map.removeSource?.(sourceId);
      }
      this.honuaMap.clear();
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

  #applyIncremental(composed: HonuaStyleSpecification, diff: MapPackageDiff): void {
    const prevStyle = this.#composedStyle;

    for (const sourceId of diff.removedSourceIds) {
      this.honuaMap.removeSource(sourceId);
      this.map.removeSource?.(sourceId);
    }
    for (const layerId of diff.removedLayerIds) {
      this.honuaMap.removeLayer(layerId);
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

  #patchLayer(layerId: string, prev: Readonly<{ paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>, next: Readonly<{ paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>): void {
    if (this.map.setPaintProperty) {
      for (const [key, value] of Object.entries(next.paint ?? {})) {
        if (!prev.paint || prev.paint[key] !== value) this.map.setPaintProperty(layerId, key, value);
      }
    }
    if (this.map.setLayoutProperty) {
      for (const [key, value] of Object.entries(next.layout ?? {})) {
        if (!prev.layout || prev.layout[key] !== value) this.map.setLayoutProperty(layerId, key, value);
      }
    }
    if (this.map.setFilter && JSON.stringify(prev.filter) !== JSON.stringify(next.filter)) {
      this.map.setFilter(layerId, next.filter);
    }
  }

  #emit(event: HonuaRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
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

function layerIdToSource(style: HonuaStyleSpecification, layerId: string): string | undefined {
  return style.layers.find((l) => l.id === layerId)?.source;
}

function shallowPaintLayoutEqual(
  a: Readonly<{ paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>,
  b: Readonly<{ paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown }>,
): boolean {
  return (
    JSON.stringify(a.paint ?? {}) === JSON.stringify(b.paint ?? {}) &&
    JSON.stringify(a.layout ?? {}) === JSON.stringify(b.layout ?? {}) &&
    JSON.stringify(a.filter) === JSON.stringify(b.filter)
  );
}

// ── Re-exports for barrel ────────────────────────────────────

export type { MapPackageDiff } from "./diff.js";
export type { PopupFactory, PopupRenderer, PopupBindingHandle } from "./popups.js";
export type { LegendEntry } from "./legend.js";
