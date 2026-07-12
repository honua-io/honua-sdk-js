/**
 * Incremental integration surface for an automatic Source → MapLibre mount.
 *
 * REQ-004 of #390: wire the filter registry, interactions/hit-test, edits, and
 * realtime feature state into the automatic mount **without a full reload**
 * where MapLibre supports incremental change (`setFilter`, `setFeatureState`,
 * source `setData` through {@link MountedAutomaticMapLibreSource.refresh}).
 *
 * This module is peer-injected and safe to import in Node/SSR/worker code: it
 * never imports `maplibre-gl`. Every renderer touch point is duck-typed so any
 * object exposing the small surface below — including a real MapLibre `Map` —
 * satisfies it.
 */

import type { FeatureId } from "../contract/types.js";
import {
  type FilterClause,
  type FilterRegistry,
  type FilterRegistryProjectionOptions,
  type FilterRegistryUnsubscribe,
  type RuntimeStyleFilterExpression,
  compileRuntimeStyleFilter,
  selectActiveFilterClauses,
} from "../filter-registry/index.js";
import type {
  HonuaHitTestMap,
  HonuaHitTestResult,
  HonuaNormalizeHitTestOptions,
  HonuaPointerInput,
} from "../interactions/hit-test.js";
import { hitTestMap } from "../interactions/hit-test.js";
import type { ExecuteQueryPlanOptions } from "../query-planner/types.js";
import type { AutomaticMapLibrePlan, MountedAutomaticMapLibreSource } from "./automatic-source-strategy.js";

/** A stable, machine-readable integration failure. */
export type AutomaticMapLibreIntegrationErrorCode = "disposed" | "invalid-target";

export class HonuaAutomaticMapLibreIntegrationError extends Error {
  public constructor(
    public readonly code: AutomaticMapLibreIntegrationErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "HonuaAutomaticMapLibreIntegrationError";
  }
}

/**
 * Minimal MapLibre-shaped surface the integration mutates incrementally. A real
 * `maplibregl.Map` satisfies this; feature-state, filters, and hit-test are all
 * optional so a raster-only mount still attaches cleanly (it simply has no
 * interactive layers to bind).
 */
export interface AutomaticMapLibreIntegrationMap extends HonuaHitTestMap {
  /** Replace a layer filter in place (incremental; no style reload). */
  setFilter?(layerId: string, filter?: unknown): void;
  /** Read the current layer filter so baked-in geometry filters are preserved. */
  getFilter?(layerId: string): unknown;
  setFeatureState?(
    target: { source: string; id: FeatureId; sourceLayer?: string },
    state: Record<string, unknown>,
  ): void;
  getFeatureState?(target: { source: string; id: FeatureId; sourceLayer?: string }): Record<string, unknown>;
  removeFeatureState?(target: { source: string; id: FeatureId; sourceLayer?: string }, key?: string): void;
  on?(event: string, layer: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, layer: string, handler: (...args: unknown[]) => void): void;
}

export type AutomaticMapLibreIntegrationDiagnosticCode =
  | "filter-applied"
  | "filter-registry-bound"
  | "selection-changed"
  | "hover-changed"
  | "realtime-feature-state"
  | "edit-refreshed"
  | "capability-unavailable";

export interface AutomaticMapLibreIntegrationDiagnostic {
  readonly code: AutomaticMapLibreIntegrationDiagnosticCode;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** A single realtime feature-state delta targeting a mounted feature. */
export interface RealtimeFeatureStateDelta {
  readonly id: FeatureId;
  readonly state: Record<string, unknown>;
  readonly sourceLayer?: string;
}

export interface AutomaticMapLibreIntegrationOptions {
  /** Feature-state key toggled on click. @default "selected" */
  readonly selectionStateKey?: string;
  /** Feature-state key toggled on hover. @default "hover" */
  readonly hoverStateKey?: string;
  /** Enable single-click selection wiring. @default true */
  readonly selection?: boolean;
  /** Enable pointer hover wiring. @default true */
  readonly hover?: boolean;
  /** Allow multiple simultaneously selected features. @default false */
  readonly multiSelect?: boolean;
  /** Vector-tile source layer for feature-state targets. */
  readonly sourceLayer?: string;
  /** Observe selection changes. */
  readonly onSelectionChange?: (selectedIds: ReadonlySet<FeatureId>) => void;
}

export interface BindFilterRegistryOptions extends FilterRegistryProjectionOptions {
  /** Apply the current registry snapshot immediately. @default true */
  readonly fireImmediately?: boolean;
}

/** Cohesive incremental-integration controller for one automatic mount. */
export interface AutomaticMapLibreIntegration {
  readonly sourceId: string;
  readonly layerIds: readonly string[];
  readonly selectedIds: ReadonlySet<FeatureId>;
  readonly hoveredId: FeatureId | undefined;
  readonly appliedFilter: RuntimeStyleFilterExpression | undefined;
  readonly diagnostics: readonly AutomaticMapLibreIntegrationDiagnostic[];
  /** Apply a compiled runtime style filter across all mounted layers in place. */
  setRuntimeFilter(filter: RuntimeStyleFilterExpression | undefined): void;
  /** Subscribe to a filter registry and project active clauses to the layers. */
  bindFilterRegistry(registry: FilterRegistry, options?: BindFilterRegistryOptions): FilterRegistryUnsubscribe;
  /** Apply realtime feature-state deltas incrementally (no reload). */
  applyRealtimeFeatureState(deltas: readonly RealtimeFeatureStateDelta[]): void;
  /** Remove a realtime feature-state key (or all state) from a feature. */
  clearRealtimeFeatureState(id: FeatureId, key?: string): void;
  /** Programmatically select a feature. */
  select(id: FeatureId): void;
  /** Programmatically deselect a feature. */
  deselect(id: FeatureId): void;
  /** Clear all selected features. */
  clearSelection(): void;
  /** Renderer-neutral hit-test scoped to the mounted layers. */
  hitTest(input: HonuaPointerInput, options?: HonuaNormalizeHitTestOptions): Promise<HonuaHitTestResult>;
  /** Refresh mounted data in place (materialized edits flow through setData). */
  refresh(options?: ExecuteQueryPlanOptions): Promise<AutomaticMapLibrePlan>;
  /** Remove every listener/subscription and clear feature state. Leak-free. */
  dispose(): void;
}

/**
 * Attach an incremental-integration controller to a mounted automatic source.
 *
 * @example
 * ```ts
 * const plan = explainAutomaticSourceToMapLibre(source, { queryPlan });
 * const mounted = await mountAutomaticSourceToMapLibre(map, source, plan, { queryPlan });
 * const integration = attachAutomaticMapLibreInteractions(map, mounted, {
 *   onSelectionChange: (ids) => sidebar.render([...ids]),
 * });
 * integration.bindFilterRegistry(registry, { sourceId: source.descriptor.id });
 * // realtime delta, no reload:
 * integration.applyRealtimeFeatureState([{ id: 42, state: { status: "active" } }]);
 * ```
 */
export function attachAutomaticMapLibreInteractions(
  map: AutomaticMapLibreIntegrationMap,
  mounted: MountedAutomaticMapLibreSource,
  options: AutomaticMapLibreIntegrationOptions = {},
): AutomaticMapLibreIntegration {
  const {
    selectionStateKey = "selected",
    hoverStateKey = "hover",
    selection = true,
    hover = true,
    multiSelect = false,
    sourceLayer,
    onSelectionChange,
  } = options;
  const sourceId = mounted.sourceId;
  const layerIds = [...mounted.layerIds];
  const diagnostics: AutomaticMapLibreIntegrationDiagnostic[] = [];
  const selected = new Set<FeatureId>();
  let hoveredId: FeatureId | undefined;
  let appliedFilter: RuntimeStyleFilterExpression | undefined;
  let disposed = false;
  let registryUnsubscribe: FilterRegistryUnsubscribe | undefined;

  // Capture each layer's baked-in filter (e.g. the geojson geometry-type
  // matrix) so runtime filters compose instead of clobbering them.
  const baseFilters = new Map<string, unknown>();
  if (typeof map.getFilter === "function") {
    for (const layerId of layerIds) {
      try {
        baseFilters.set(layerId, map.getFilter(layerId));
      } catch {
        /* layer without a readable filter */
      }
    }
  }

  const featureStateCapable = typeof map.setFeatureState === "function" && typeof map.removeFeatureState === "function";
  const filterCapable = typeof map.setFilter === "function";
  const eventCapable = typeof map.on === "function" && typeof map.off === "function";

  const assertLive = (): void => {
    if (disposed)
      throw new HonuaAutomaticMapLibreIntegrationError("disposed", "The automatic MapLibre integration was disposed.");
  };

  const setFeatureStateSafe = (id: FeatureId, state: Record<string, unknown>, layer?: string): void => {
    map.setFeatureState?.(featureTarget(sourceId, id, layer ?? sourceLayer), state);
  };
  const removeFeatureStateSafe = (id: FeatureId, key?: string): void => {
    map.removeFeatureState?.(featureTarget(sourceId, id, sourceLayer), key);
  };

  const applyFilterToLayers = (filter: RuntimeStyleFilterExpression | undefined): void => {
    appliedFilter = filter;
    if (!filterCapable) {
      diagnostics.push({
        code: "capability-unavailable",
        severity: "warning",
        message: "The renderer does not expose setFilter; runtime filter was recorded but not applied.",
      });
      return;
    }
    for (const layerId of layerIds) {
      const base = baseFilters.get(layerId);
      const composed = composeFilter(base, filter);
      map.setFilter?.(layerId, composed);
    }
    diagnostics.push({
      code: "filter-applied",
      severity: "info",
      message: filter ? "Applied a runtime style filter across mounted layers." : "Cleared the runtime style filter.",
      detail: { layerCount: layerIds.length },
    });
  };

  const notifySelection = (): void => onSelectionChange?.(selected);

  const selectInternal = (id: FeatureId): void => {
    if (!featureStateCapable) return;
    if (!multiSelect) clearSelectionInternal();
    map.setFeatureState?.(featureTarget(sourceId, id, sourceLayer), { [selectionStateKey]: true });
    selected.add(id);
  };
  const deselectInternal = (id: FeatureId): void => {
    if (!selected.has(id)) return;
    map.setFeatureState?.(featureTarget(sourceId, id, sourceLayer), { [selectionStateKey]: false });
    selected.delete(id);
  };
  const clearSelectionInternal = (): void => {
    for (const id of selected)
      map.setFeatureState?.(featureTarget(sourceId, id, sourceLayer), { [selectionStateKey]: false });
    selected.clear();
  };

  const onLayerClick = (...args: unknown[]): void => {
    const id = firstFeatureId(args[0]);
    if (id === undefined) return;
    if (selected.has(id)) deselectInternal(id);
    else selectInternal(id);
    diagnostics.push({ code: "selection-changed", severity: "info", message: "Selection toggled from a click." });
    notifySelection();
  };
  const onLayerMove = (...args: unknown[]): void => {
    const id = firstFeatureId(args[0]);
    if (id === undefined) return;
    if (hoveredId !== undefined && hoveredId !== id)
      map.setFeatureState?.(featureTarget(sourceId, hoveredId, sourceLayer), { [hoverStateKey]: false });
    hoveredId = id;
    map.setFeatureState?.(featureTarget(sourceId, id, sourceLayer), { [hoverStateKey]: true });
  };
  const onLayerLeave = (): void => {
    if (hoveredId === undefined) return;
    map.setFeatureState?.(featureTarget(sourceId, hoveredId, sourceLayer), { [hoverStateKey]: false });
    hoveredId = undefined;
  };

  // Wire pointer interactions per layer (the geojson auto mount installs one
  // layer per geometry kind, so a single source can carry several layers).
  const wiredClick = selection && featureStateCapable && eventCapable;
  const wiredHover = hover && featureStateCapable && eventCapable;
  if (wiredClick) for (const layerId of layerIds) map.on?.("click", layerId, onLayerClick);
  if (wiredHover)
    for (const layerId of layerIds) {
      map.on?.("mousemove", layerId, onLayerMove);
      map.on?.("mouseleave", layerId, onLayerLeave);
    }
  if ((selection || hover) && !featureStateCapable) {
    diagnostics.push({
      code: "capability-unavailable",
      severity: "warning",
      message: "The renderer does not expose feature-state; selection and hover wiring were skipped.",
    });
  }

  return {
    sourceId,
    layerIds,
    get selectedIds() {
      return selected;
    },
    get hoveredId() {
      return hoveredId;
    },
    get appliedFilter() {
      return appliedFilter;
    },
    get diagnostics() {
      return diagnostics;
    },
    setRuntimeFilter(filter) {
      assertLive();
      applyFilterToLayers(filter);
    },
    bindFilterRegistry(registry, bindOptions = {}) {
      assertLive();
      const project = (clauses: readonly FilterClause[]): void =>
        applyFilterToLayers(compileRuntimeStyleFilter(clauses));
      registryUnsubscribe?.();
      const unsubscribe = registry.subscribe((event) => {
        project(selectActiveFilterClauses(event.snapshot, bindOptions));
      });
      registryUnsubscribe = unsubscribe;
      if (bindOptions.fireImmediately !== false) project(selectActiveFilterClauses(registry.snapshot, bindOptions));
      diagnostics.push({
        code: "filter-registry-bound",
        severity: "info",
        message: "Bound the filter registry to the mounted layers.",
      });
      return () => {
        unsubscribe();
        if (registryUnsubscribe === unsubscribe) registryUnsubscribe = undefined;
      };
    },
    applyRealtimeFeatureState(deltas) {
      assertLive();
      if (!featureStateCapable) {
        diagnostics.push({
          code: "capability-unavailable",
          severity: "warning",
          message: "The renderer does not expose setFeatureState; realtime deltas were dropped.",
        });
        return;
      }
      for (const delta of deltas) {
        if (delta.id === undefined || delta.id === null)
          throw new HonuaAutomaticMapLibreIntegrationError("invalid-target", "Realtime deltas require a feature id.");
        setFeatureStateSafe(delta.id, delta.state, delta.sourceLayer);
      }
      diagnostics.push({
        code: "realtime-feature-state",
        severity: "info",
        message: "Applied realtime feature-state deltas in place.",
        detail: { count: deltas.length },
      });
    },
    clearRealtimeFeatureState(id, key) {
      assertLive();
      removeFeatureStateSafe(id, key);
    },
    select(id) {
      assertLive();
      selectInternal(id);
      diagnostics.push({ code: "selection-changed", severity: "info", message: "Feature selected programmatically." });
      notifySelection();
    },
    deselect(id) {
      assertLive();
      deselectInternal(id);
      diagnostics.push({
        code: "selection-changed",
        severity: "info",
        message: "Feature deselected programmatically.",
      });
      notifySelection();
    },
    clearSelection() {
      assertLive();
      clearSelectionInternal();
      diagnostics.push({ code: "selection-changed", severity: "info", message: "Selection cleared programmatically." });
      notifySelection();
    },
    hitTest(input, hitOptions = {}) {
      assertLive();
      return hitTestMap(map, input, { layers: layerIds, ...hitOptions });
    },
    async refresh(refreshOptions) {
      assertLive();
      const plan = await mounted.refresh(refreshOptions);
      diagnostics.push({ code: "edit-refreshed", severity: "info", message: "Refreshed mounted data in place." });
      return plan;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      registryUnsubscribe?.();
      registryUnsubscribe = undefined;
      if (wiredClick) for (const layerId of layerIds) map.off?.("click", layerId, onLayerClick);
      if (wiredHover)
        for (const layerId of layerIds) {
          map.off?.("mousemove", layerId, onLayerMove);
          map.off?.("mouseleave", layerId, onLayerLeave);
        }
      if (featureStateCapable) {
        onLayerLeave();
        clearSelectionInternal();
      }
    },
  };
}

function composeFilter(base: unknown, runtime: RuntimeStyleFilterExpression | undefined): unknown {
  const hasBase = Array.isArray(base) && base.length > 0;
  if (runtime === undefined) return hasBase ? base : undefined;
  if (!hasBase) return runtime;
  return ["all", base, runtime];
}

function featureTarget(
  source: string,
  id: FeatureId,
  sourceLayer?: string,
): {
  source: string;
  id: FeatureId;
  sourceLayer?: string;
} {
  return sourceLayer ? { source, id, sourceLayer } : { source, id };
}

function firstFeatureId(event: unknown): FeatureId | undefined {
  if (!event || typeof event !== "object") return undefined;
  const features = (event as { features?: ReadonlyArray<{ id?: FeatureId }> }).features;
  const id = features?.[0]?.id;
  return id === undefined || id === null ? undefined : id;
}
