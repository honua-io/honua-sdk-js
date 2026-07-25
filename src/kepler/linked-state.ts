/**
 * Bidirectional linked state between the shared Honua exploration context and
 * a Kepler workspace (REQ-004).
 *
 * State is mapped **only** where the two models mean the same thing. Every
 * channel declares its supported direction and whether the mapping is exact or
 * lossy in {@link KEPLER_LINKED_STATE_MAPPINGS}, and
 * {@link createKeplerLinkedStateSync} reports each unsupported or lossy
 * mapping it actually encounters instead of silently degrading.
 *
 * Feedback loops are prevented by two independent guards:
 *
 * 1. The exploration view controller ignores its own notifications, so a
 *    Kepler-originated intent never bounces straight back out.
 * 2. Every channel memoizes the last value pushed in each direction; an echo
 *    carrying an already-applied value is counted and dropped.
 *
 * @experimental
 * @module
 */

import { sourceFeatureSelectionTarget } from "../exploration/selection.js";
import type {
  ExplorationViewController,
  FeatureSelectionTarget,
  FilterClause,
  SourceQualifiedFeatureSelectionTarget,
} from "../exploration/types.js";
import type { KeplerFilter, KeplerFilterType, KeplerMapState } from "./types.js";
import { HonuaKeplerBridgeError } from "./types.js";

// ── Declared mapping table ────────────────────────────────────

export type KeplerLinkedStateChannel =
  | "viewport"
  | "temporal-window"
  | "selection"
  | "selection-as-filter"
  | "value-filter"
  | "hover"
  | "spatial-filter"
  | "sort"
  | "pagination"
  | "grouping"
  | "aggregation"
  | "visible-fields";

export type KeplerLinkedStateDirection = "bidirectional" | "honua-to-kepler" | "kepler-to-honua" | "unsupported";

export interface KeplerLinkedStateMapping {
  readonly channel: KeplerLinkedStateChannel;
  readonly direction: KeplerLinkedStateDirection;
  readonly equivalence: "exact" | "lossy" | "none";
  /** Inputs the mapping needs beyond the two states, for example the viewport pixel size. */
  readonly requires?: readonly string[];
  readonly reason: string;
}

/** The complete, honest mapping table between exploration state and Kepler state. */
export const KEPLER_LINKED_STATE_MAPPINGS: readonly KeplerLinkedStateMapping[] = Object.freeze([
  Object.freeze({
    channel: "viewport",
    direction: "bidirectional",
    equivalence: "lossy",
    requires: Object.freeze(["viewportSize"]),
    reason:
      "Honua carries an axis-aligned extent; Kepler carries center/zoom/bearing/pitch. The conversion needs the viewport pixel size and cannot represent bearing or pitch as an extent.",
  }),
  Object.freeze({
    channel: "temporal-window",
    direction: "bidirectional",
    equivalence: "exact",
    reason:
      "A Honua `between` clause on a temporal field and a Kepler `timeRange` filter are both closed epoch-millisecond intervals over one field.",
  }),
  Object.freeze({
    channel: "selection",
    direction: "kepler-to-honua",
    equivalence: "exact",
    reason:
      "A Kepler click/pick resolves to one row identity, which maps exactly onto a source-qualified exploration selection target.",
  }),
  Object.freeze({
    channel: "selection-as-filter",
    direction: "honua-to-kepler",
    equivalence: "lossy",
    reason:
      "Kepler has no selection concept. A Honua selection can only be expressed as a `multiSelect` filter on the identity field, which hides unselected rows instead of highlighting selected ones.",
  }),
  Object.freeze({
    channel: "value-filter",
    direction: "bidirectional",
    equivalence: "exact",
    reason:
      "Honua `=`, `in`, and `between` clauses map onto Kepler `select`, `multiSelect`, and `range` filters. Other operators are reported unsupported.",
  }),
  Object.freeze({
    channel: "hover",
    direction: "unsupported",
    equivalence: "none",
    reason:
      "ExplorationState has no hover slice, so a Kepler hovered object has no equivalent shared state. Keep hover in application state.",
  }),
  Object.freeze({
    channel: "spatial-filter",
    direction: "unsupported",
    equivalence: "none",
    reason:
      "Kepler's polygon filter is a client-side mask over loaded rows; a Honua spatial filter is a server-evaluated predicate with a declared relationship. The semantics are not equivalent.",
  }),
  ...(["sort", "pagination", "grouping", "aggregation", "visible-fields"] as const).map((channel) =>
    Object.freeze({
      channel,
      direction: "unsupported" as const,
      equivalence: "none" as const,
      reason: `Kepler owns its own exploratory presentation; ${channel} is a Honua query concern with no equivalent Kepler workspace state.`,
    }),
  ),
]);

/** Look up one declared mapping. */
export function keplerLinkedStateMapping(channel: KeplerLinkedStateChannel): KeplerLinkedStateMapping {
  const mapping = KEPLER_LINKED_STATE_MAPPINGS.find((entry) => entry.channel === channel);
  if (mapping === undefined) {
    throw new HonuaKeplerBridgeError("invalid-request", `Unknown Kepler linked-state channel "${channel}".`);
  }
  return mapping;
}

// ── Viewport conversion ───────────────────────────────────────

export interface KeplerViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface KeplerExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

const KEPLER_TILE_SIZE = 512;
const MAX_MERCATOR_LATITUDE = 85.051129;

function clampLatitude(latitude: number): number {
  return Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, latitude));
}

/** Normalized (0..1) Web Mercator Y for a latitude in degrees. */
function mercatorY(latitude: number): number {
  const sine = Math.sin((clampLatitude(latitude) * Math.PI) / 180);
  return 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
}

function latitudeFromMercatorY(y: number): number {
  const n = Math.PI - 2 * Math.PI * y;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function requireViewportSize(size: KeplerViewportSize | undefined, operation: string): KeplerViewportSize {
  if (
    typeof size !== "object" ||
    size === null ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      `${operation} requires a positive viewport size; extent and Kepler zoom are not interconvertible without it.`,
      { operation },
    );
  }
  return size;
}

function requireMapState(mapState: KeplerMapState): KeplerMapState {
  if (
    typeof mapState !== "object" ||
    mapState === null ||
    !Number.isFinite(mapState.longitude) ||
    !Number.isFinite(mapState.latitude) ||
    !Number.isFinite(mapState.zoom)
  ) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "A Kepler map state requires finite longitude, latitude, and zoom.",
    );
  }
  return mapState;
}

/**
 * Convert a Kepler `mapState` into a Honua extent. Bearing and pitch are not
 * representable in an axis-aligned extent and are dropped — this is the `lossy`
 * half of the declared `viewport` mapping.
 */
export function keplerMapStateToExtent(mapState: KeplerMapState, viewportSize: KeplerViewportSize): KeplerExtent {
  const state = requireMapState(mapState);
  const size = requireViewportSize(viewportSize, "keplerMapStateToExtent");
  const worldSize = KEPLER_TILE_SIZE * 2 ** state.zoom;
  const halfLonSpan = (360 * size.width) / worldSize / 2;
  const centerY = mercatorY(state.latitude);
  const halfYSpan = size.height / worldSize / 2;
  return Object.freeze({
    xmin: state.longitude - halfLonSpan,
    xmax: state.longitude + halfLonSpan,
    ymin: latitudeFromMercatorY(Math.min(1, centerY + halfYSpan)),
    ymax: latitudeFromMercatorY(Math.max(0, centerY - halfYSpan)),
  });
}

/**
 * Convert a Honua extent into a Kepler `mapState`. Bearing and pitch are
 * carried over from `current` (default `0`) because an extent cannot express
 * them.
 */
export function extentToKeplerMapState(
  extent: KeplerExtent,
  viewportSize: KeplerViewportSize,
  current?: Pick<KeplerMapState, "bearing" | "pitch">,
): KeplerMapState {
  const size = requireViewportSize(viewportSize, "extentToKeplerMapState");
  if (
    typeof extent !== "object" ||
    extent === null ||
    !Number.isFinite(extent.xmin) ||
    !Number.isFinite(extent.xmax) ||
    !Number.isFinite(extent.ymin) ||
    !Number.isFinite(extent.ymax) ||
    extent.xmax <= extent.xmin ||
    extent.ymax <= extent.ymin
  ) {
    throw new HonuaKeplerBridgeError("invalid-request", "extentToKeplerMapState requires a non-degenerate extent.");
  }
  const lonSpan = extent.xmax - extent.xmin;
  const ySpan = Math.abs(mercatorY(extent.ymin) - mercatorY(extent.ymax));
  const zoomForLon = Math.log2((360 * size.width) / (KEPLER_TILE_SIZE * lonSpan));
  const zoomForLat = ySpan === 0 ? zoomForLon : Math.log2(size.height / (KEPLER_TILE_SIZE * ySpan));
  const zoom = Math.max(0, Math.min(24, Math.min(zoomForLon, zoomForLat)));
  const centerY = (mercatorY(extent.ymin) + mercatorY(extent.ymax)) / 2;
  return Object.freeze({
    longitude: (extent.xmin + extent.xmax) / 2,
    latitude: latitudeFromMercatorY(centerY),
    zoom,
    bearing: current?.bearing ?? 0,
    pitch: current?.pitch ?? 0,
  });
}

// ── Temporal window conversion ────────────────────────────────

export interface KeplerTemporalWindow {
  readonly field: string;
  /** Inclusive epoch milliseconds. */
  readonly start: number;
  readonly end: number;
}

function epochMillis(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Read a Honua `between` clause on a temporal field as an epoch-millisecond window. */
export function honuaClauseToTemporalWindow(field: string, clause: FilterClause): KeplerTemporalWindow | undefined {
  if (clause.operator !== "between" || !Array.isArray(clause.value) || clause.value.length < 2) return undefined;
  const start = epochMillis(clause.value[0]);
  const end = epochMillis(clause.value[1]);
  if (start === undefined || end === undefined || end < start) return undefined;
  return Object.freeze({ field, start, end });
}

/** Build the Honua clause equivalent to a Kepler `timeRange` filter value. */
export function temporalWindowToHonuaClause(window: KeplerTemporalWindow): FilterClause {
  return { field: window.field, operator: "between", value: [window.start, window.end] };
}

/** Read a Kepler `timeRange` filter as an epoch-millisecond window. */
export function keplerTimeRangeToTemporalWindow(filter: KeplerFilter): KeplerTemporalWindow | undefined {
  if (filter?.type !== "timeRange" || !Array.isArray(filter.value) || filter.value.length < 2) return undefined;
  const field = filter.name?.[0];
  const start = epochMillis(filter.value[0]);
  const end = epochMillis(filter.value[1]);
  if (typeof field !== "string" || start === undefined || end === undefined || end < start) return undefined;
  return Object.freeze({ field, start, end });
}

// ── Value-filter conversion ───────────────────────────────────

export interface KeplerFilterProjection {
  readonly supported: boolean;
  readonly type?: KeplerFilterType;
  readonly value?: unknown;
  readonly reason: string;
}

/** Project a Honua filter clause onto a Kepler filter type + value. */
export function honuaClauseToKeplerFilter(clause: FilterClause): KeplerFilterProjection {
  switch (clause.operator) {
    case "=":
      return {
        supported: true,
        type: "select",
        value: clause.value,
        reason: "Equality maps onto a Kepler select filter.",
      };
    case "in":
      return Array.isArray(clause.value)
        ? {
            supported: true,
            type: "multiSelect",
            value: [...clause.value],
            reason: "Set membership maps onto a Kepler multiSelect filter.",
          }
        : { supported: false, reason: "An `in` clause requires an array value to become a Kepler multiSelect filter." };
    case "between": {
      if (!Array.isArray(clause.value) || clause.value.length < 2) {
        return { supported: false, reason: "A `between` clause requires a two-element value." };
      }
      const start = epochMillis(clause.value[0]);
      const end = epochMillis(clause.value[1]);
      const numeric = typeof clause.value[0] === "number" && typeof clause.value[1] === "number";
      if (numeric) {
        return {
          supported: true,
          type: "range",
          value: [clause.value[0], clause.value[1]],
          reason: "A numeric `between` clause maps onto a Kepler range filter.",
        };
      }
      if (start !== undefined && end !== undefined) {
        return {
          supported: true,
          type: "timeRange",
          value: [start, end],
          reason: "A temporal `between` clause maps onto a Kepler timeRange filter in epoch milliseconds.",
        };
      }
      return { supported: false, reason: "A `between` clause must carry numeric or temporal bounds." };
    }
    default:
      return {
        supported: false,
        reason: `Kepler has no filter equivalent for the "${clause.operator}" operator; the clause stays Honua-side only.`,
      };
  }
}

/** Project a Kepler filter back onto a Honua filter clause. */
export function keplerFilterToHonuaClause(filter: KeplerFilter): FilterClause | undefined {
  const field = filter?.name?.[0];
  if (typeof field !== "string") return undefined;
  switch (filter.type) {
    case "select":
      return { field, operator: "=", value: filter.value };
    case "multiSelect":
      return Array.isArray(filter.value) ? { field, operator: "in", value: [...filter.value] } : undefined;
    case "range":
    case "timeRange":
      return Array.isArray(filter.value) && filter.value.length >= 2
        ? { field, operator: "between", value: [filter.value[0], filter.value[1]] }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Express a Honua selection as the only Kepler equivalent that exists: a
 * `multiSelect` filter over the identity field. Declared lossy — Kepler hides
 * unselected rows rather than highlighting selected ones.
 */
export function keplerSelectionFilterValue(
  selection: ReadonlyArray<FeatureSelectionTarget>,
  sourceId: string,
): readonly (string | number)[] {
  const ids: (string | number)[] = [];
  for (const target of selection) {
    if (typeof target === "string" || typeof target === "number") ids.push(target);
    else if (target.sourceId === sourceId) ids.push(target.id);
  }
  return Object.freeze(ids);
}

// ── Sync controller ───────────────────────────────────────────

export type KeplerLinkedStateUpdateKind = "map-state" | "time-range" | "selection-filter";

export type KeplerLinkedStateUpdate =
  | { readonly kind: "map-state"; readonly mapState: KeplerMapState }
  | { readonly kind: "time-range"; readonly field: string; readonly value: readonly [number, number] }
  | { readonly kind: "selection-filter"; readonly field: string; readonly value: readonly (string | number)[] };

export interface KeplerLinkedStateDiagnostic {
  readonly channel: KeplerLinkedStateChannel;
  readonly direction: KeplerLinkedStateDirection;
  readonly outcome: "applied" | "echo-suppressed" | "unsupported" | "lossy";
  readonly detail: string;
}

export interface CreateKeplerLinkedStateSyncOptions {
  /** Bound exploration view controller — supply one connected with role `"map"`. */
  readonly view: ExplorationViewController;
  /** Honua source id the Kepler dataset was projected from. */
  readonly sourceId: string;
  /** Exploration filter-clause id used for the shared temporal window. */
  readonly temporalFilterId?: string;
  /** Temporal field name shared with Kepler's `timeRange` filter. */
  readonly temporalField?: string;
  /** Required for any viewport mapping. */
  readonly viewportSize?: KeplerViewportSize;
  /** Identity field used for the lossy selection-as-filter projection. */
  readonly selectionFilterField?: string;
  /** Called with each update the Kepler side should apply. */
  readonly applyToKepler: (update: KeplerLinkedStateUpdate) => void;
}

export interface KeplerLinkedStateSync {
  readonly mappings: readonly KeplerLinkedStateMapping[];
  readonly diagnostics: readonly KeplerLinkedStateDiagnostic[];
  readonly appliedToKepler: number;
  readonly appliedToHonua: number;
  readonly suppressedEchoes: number;
  readonly disposed: boolean;
  /** Kepler → Honua: the user moved the Kepler map. */
  receiveMapState(mapState: KeplerMapState): void;
  /** Kepler → Honua: the user moved the Kepler time-range filter (epoch ms). */
  receiveTimeRange(value: readonly [number, number]): void;
  /** Kepler → Honua: the user clicked a row. Pass `undefined` to clear. */
  receiveSelection(rowIdentity: string | number | undefined): void;
  /** Report the outcome for a channel the app asked about but the bridge cannot map. */
  reportUnsupported(channel: KeplerLinkedStateChannel): KeplerLinkedStateDiagnostic;
  dispose(): void;
}

function sameNumericPair(left: readonly [number, number] | undefined, right: readonly [number, number]): boolean {
  return left !== undefined && left[0] === right[0] && left[1] === right[1];
}

function sameMapState(left: KeplerMapState | undefined, right: KeplerMapState): boolean {
  return (
    left !== undefined &&
    left.longitude === right.longitude &&
    left.latitude === right.latitude &&
    left.zoom === right.zoom &&
    left.bearing === right.bearing &&
    left.pitch === right.pitch
  );
}

function sameIdList(left: readonly (string | number)[] | undefined, right: readonly (string | number)[]): boolean {
  if (left === undefined || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * Wire an exploration view controller to a Kepler workspace over the declared
 * channels only. Deterministic and loop-free: an echo of an already-applied
 * value is counted in `suppressedEchoes` and dropped.
 */
export function createKeplerLinkedStateSync(options: CreateKeplerLinkedStateSyncOptions): KeplerLinkedStateSync {
  const { view, sourceId } = options;
  if (
    typeof view !== "object" ||
    view === null ||
    typeof view.subscribe !== "function" ||
    typeof view.select !== "function"
  ) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "createKeplerLinkedStateSync requires an ExplorationViewController.",
    );
  }
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new HonuaKeplerBridgeError("invalid-request", "createKeplerLinkedStateSync requires a sourceId.");
  }
  if (typeof options.applyToKepler !== "function") {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "createKeplerLinkedStateSync requires an applyToKepler callback.",
    );
  }
  const temporalFilterId = options.temporalFilterId ?? "kepler-temporal-window";
  const diagnostics: KeplerLinkedStateDiagnostic[] = [];
  let appliedToKepler = 0;
  let appliedToHonua = 0;
  let suppressedEchoes = 0;
  let disposed = false;
  let pushingToKepler = false;

  let lastMapStateToKepler: KeplerMapState | undefined;
  let lastMapStateFromKepler: KeplerMapState | undefined;
  let lastWindowToKepler: readonly [number, number] | undefined;
  let lastWindowFromKepler: readonly [number, number] | undefined;
  let lastSelectionToKepler: readonly (string | number)[] | undefined;

  function record(diagnostic: KeplerLinkedStateDiagnostic): KeplerLinkedStateDiagnostic {
    diagnostics.push(diagnostic);
    return diagnostic;
  }

  function push(update: KeplerLinkedStateUpdate): void {
    pushingToKepler = true;
    try {
      options.applyToKepler(update);
      appliedToKepler += 1;
    } finally {
      pushingToKepler = false;
    }
  }

  function pushMapState(): void {
    if (options.viewportSize === undefined) {
      record({
        channel: "viewport",
        direction: "honua-to-kepler",
        outcome: "unsupported",
        detail: "No viewportSize was supplied, so a Honua extent cannot be converted into a Kepler zoom.",
      });
      return;
    }
    const extent = view.state.extent;
    if (extent === undefined) return;
    const mapState = extentToKeplerMapState(extent, options.viewportSize, lastMapStateFromKepler);
    if (sameMapState(lastMapStateToKepler, mapState) || sameMapState(lastMapStateFromKepler, mapState)) {
      suppressedEchoes += 1;
      record({
        channel: "viewport",
        direction: "honua-to-kepler",
        outcome: "echo-suppressed",
        detail: "The derived Kepler map state matches the last applied value.",
      });
      return;
    }
    lastMapStateToKepler = mapState;
    push({ kind: "map-state", mapState });
    record({
      channel: "viewport",
      direction: "honua-to-kepler",
      outcome: "lossy",
      detail: "Extent converted to center/zoom; bearing and pitch were carried over, not derived.",
    });
  }

  function pushTemporalWindow(): void {
    const field = options.temporalField;
    if (field === undefined) return;
    const clause = view.state.filters[temporalFilterId];
    if (clause === undefined) return;
    const window = honuaClauseToTemporalWindow(field, clause);
    if (window === undefined) {
      record({
        channel: "temporal-window",
        direction: "honua-to-kepler",
        outcome: "unsupported",
        detail: `Filter "${temporalFilterId}" is not a two-bound temporal between clause.`,
      });
      return;
    }
    const value: readonly [number, number] = [window.start, window.end];
    if (sameNumericPair(lastWindowToKepler, value) || sameNumericPair(lastWindowFromKepler, value)) {
      suppressedEchoes += 1;
      record({
        channel: "temporal-window",
        direction: "honua-to-kepler",
        outcome: "echo-suppressed",
        detail: "The derived Kepler time range matches the last applied value.",
      });
      return;
    }
    lastWindowToKepler = value;
    push({ kind: "time-range", field, value });
    record({
      channel: "temporal-window",
      direction: "honua-to-kepler",
      outcome: "applied",
      detail: "Temporal window applied as a Kepler timeRange filter value.",
    });
  }

  function pushSelectionFilter(): void {
    const field = options.selectionFilterField;
    if (field === undefined) {
      record({
        channel: "selection-as-filter",
        direction: "honua-to-kepler",
        outcome: "unsupported",
        detail: "No selectionFilterField was supplied, so a Honua selection has no Kepler representation.",
      });
      return;
    }
    const value = keplerSelectionFilterValue(view.state.selection, sourceId);
    if (sameIdList(lastSelectionToKepler, value)) {
      suppressedEchoes += 1;
      record({
        channel: "selection-as-filter",
        direction: "honua-to-kepler",
        outcome: "echo-suppressed",
        detail: "The derived Kepler selection filter matches the last applied value.",
      });
      return;
    }
    lastSelectionToKepler = value;
    push({ kind: "selection-filter", field, value });
    record({
      channel: "selection-as-filter",
      direction: "honua-to-kepler",
      outcome: "lossy",
      detail: "Kepler has no selection state; the selection was expressed as a multiSelect filter.",
    });
  }

  const unsubscribe = view.subscribe(["extent", "filters", "selection"], (event) => {
    if (disposed || pushingToKepler) return;
    if (event.changedSlices.has("extent")) pushMapState();
    if (event.changedSlices.has("filters")) pushTemporalWindow();
    if (event.changedSlices.has("selection")) pushSelectionFilter();
  });

  return {
    mappings: KEPLER_LINKED_STATE_MAPPINGS,
    get diagnostics() {
      return Object.freeze([...diagnostics]);
    },
    get appliedToKepler() {
      return appliedToKepler;
    },
    get appliedToHonua() {
      return appliedToHonua;
    },
    get suppressedEchoes() {
      return suppressedEchoes;
    },
    get disposed() {
      return disposed;
    },
    receiveMapState(mapState) {
      if (disposed) return;
      const state = requireMapState(mapState);
      if (sameMapState(lastMapStateFromKepler, state) || sameMapState(lastMapStateToKepler, state)) {
        suppressedEchoes += 1;
        record({
          channel: "viewport",
          direction: "kepler-to-honua",
          outcome: "echo-suppressed",
          detail: "The incoming Kepler map state matches the last exchanged value.",
        });
        return;
      }
      lastMapStateFromKepler = Object.freeze({ ...state });
      if (options.viewportSize === undefined) {
        record({
          channel: "viewport",
          direction: "kepler-to-honua",
          outcome: "unsupported",
          detail: "No viewportSize was supplied, so a Kepler map state cannot be converted into a Honua extent.",
        });
        return;
      }
      const extent = keplerMapStateToExtent(state, options.viewportSize);
      view.setExtent(extent);
      appliedToHonua += 1;
      record({
        channel: "viewport",
        direction: "kepler-to-honua",
        outcome: "lossy",
        detail: "Kepler center/zoom converted to an extent; bearing and pitch are not representable.",
      });
    },
    receiveTimeRange(value) {
      if (disposed) return;
      if (!Array.isArray(value) || value.length < 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
        throw new HonuaKeplerBridgeError("invalid-request", "receiveTimeRange requires a finite [start, end] pair.");
      }
      const field = options.temporalField;
      if (field === undefined) {
        record({
          channel: "temporal-window",
          direction: "kepler-to-honua",
          outcome: "unsupported",
          detail: "No temporalField was declared, so a Kepler time range has no shared Honua clause.",
        });
        return;
      }
      const pair: readonly [number, number] = [value[0], value[1]];
      if (sameNumericPair(lastWindowFromKepler, pair) || sameNumericPair(lastWindowToKepler, pair)) {
        suppressedEchoes += 1;
        record({
          channel: "temporal-window",
          direction: "kepler-to-honua",
          outcome: "echo-suppressed",
          detail: "The incoming Kepler time range matches the last exchanged value.",
        });
        return;
      }
      lastWindowFromKepler = pair;
      view.setFilter(temporalFilterId, temporalWindowToHonuaClause({ field, start: pair[0], end: pair[1] }));
      appliedToHonua += 1;
      record({
        channel: "temporal-window",
        direction: "kepler-to-honua",
        outcome: "applied",
        detail: "Kepler time range applied as a Honua between clause in epoch milliseconds.",
      });
    },
    receiveSelection(rowIdentity) {
      if (disposed) return;
      if (rowIdentity === undefined) {
        lastSelectionToKepler = undefined;
        view.deselect();
        appliedToHonua += 1;
        record({
          channel: "selection",
          direction: "kepler-to-honua",
          outcome: "applied",
          detail: "Kepler cleared its picked object; the shared selection was cleared.",
        });
        return;
      }
      const target: SourceQualifiedFeatureSelectionTarget = sourceFeatureSelectionTarget(sourceId, rowIdentity);
      lastSelectionToKepler = Object.freeze([rowIdentity]);
      view.select([target], { replace: true });
      appliedToHonua += 1;
      record({
        channel: "selection",
        direction: "kepler-to-honua",
        outcome: "applied",
        detail: "Kepler pick applied as a source-qualified exploration selection.",
      });
    },
    reportUnsupported(channel) {
      const mapping = keplerLinkedStateMapping(channel);
      return record({
        channel,
        direction: mapping.direction,
        outcome: mapping.direction === "unsupported" ? "unsupported" : "lossy",
        detail: mapping.reason,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
