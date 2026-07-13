/**
 * First-class renderer objects (issue #497): serializable, renderer-neutral
 * descriptions of smart-mapping styles (class breaks, unique values, heatmap,
 * clustering) that compile deterministically to MapLibre style fragments
 * through the `/expr` builder.
 *
 * A renderer object is a pure value: construct it from options (or revive it
 * from JSON with {@link rendererFromJSON}), read legend metadata with
 * `legendItems()`, and compile MapLibre layer fragments with
 * `toMapLibre(geometryType)`. Compilation is a pure function of the
 * descriptor — no caching, no map access — so the same descriptor always
 * produces byte-identical style JSON.
 *
 * The WebMap JSON converter (`src/webmap/convert-renderer.ts`) and the
 * esri-compat renderer shims emit these objects instead of private
 * transforms, so there is exactly one class-breaks/unique-value compiler in
 * the SDK.
 *
 * @module
 */

import {
  type Expr,
  concat,
  get,
  heatmapDensity,
  interpolate,
  linear,
  matchExpr,
  step,
  toNumber,
} from "../expr/expression.js";
import type { Resolvable } from "../expr/expression.js";

// ── Shared contracts ─────────────────────────────────────────────

/** Coarse geometry classification a renderer compiles against. @experimental */
export type RendererGeometryType = "point" | "line" | "polygon";

/**
 * Advanced multi-property style override for one renderer class. When
 * present it replaces the single `color` shorthand and may carry any
 * MapLibre paint/layout properties (this is how WebMap symbols round-trip
 * through renderer objects without loss).
 *
 * @experimental
 */
export interface RendererStyle {
  readonly paint?: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
}

/**
 * One MapLibre layer fragment compiled from a renderer. `paint`/`layout`
 * values are plain MapLibre style JSON (expressions included) that
 * `map.addLayer` accepts verbatim; the caller owns layer ids and source
 * wiring.
 *
 * @experimental
 */
export interface RendererLayerFragment {
  /**
   * Which part of the renderer this fragment draws. Single-layer renderers
   * emit one `"symbolizer"` fragment; the cluster renderer emits
   * `"clusters"`, `"cluster-count"`, and `"unclustered"` fragments.
   */
  readonly role: "symbolizer" | "clusters" | "cluster-count" | "unclustered";
  /** MapLibre layer type (`circle`, `line`, `fill`, `heatmap`, `symbol`). */
  readonly type: string;
  readonly paint: Record<string, unknown>;
  readonly layout: Record<string, unknown>;
  /** Optional MapLibre filter expression the fragment requires. */
  readonly filter?: unknown;
}

/**
 * One legend entry derived from a renderer descriptor. This is a stable
 * contract (issue #497 REQ-005): `label` and `color` are always present;
 * `value` is set for unique-value entries, `minValue`/`maxValue` for ranged
 * entries (class breaks, cluster steps), and heatmap stops carry the ramp
 * position in `value`.
 *
 * @experimental
 */
export interface RendererLegendItem {
  readonly kind: "class-break" | "unique-value" | "heatmap-stop" | "cluster-step" | "default";
  readonly label: string;
  /** CSS color for the legend swatch. */
  readonly color: string;
  readonly value?: string | number | boolean | null;
  readonly minValue?: number;
  readonly maxValue?: number;
}

/** Union of the serializable renderer descriptors. @experimental */
export type RendererDescriptor =
  | ClassBreaksRendererDescriptor
  | UniqueValueRendererDescriptor
  | HeatmapRendererDescriptor
  | ClusterRendererDescriptor;

/** Union of the four renderer object kinds. @experimental */
export type Renderer = ClassBreaksRenderer | UniqueValueRenderer | HeatmapRenderer | ClusterRenderer;

interface RendererBase<D extends RendererDescriptor> {
  readonly kind: D["kind"];
  /** Serializable descriptor — `rendererFromJSON(renderer.toJSON())` revives it. */
  toJSON(): D;
  /** Legend metadata derived from the descriptor (stable contract, REQ-005). */
  legendItems(): readonly RendererLegendItem[];
  /** Compile MapLibre layer fragments for one geometry kind. Pure and deterministic. */
  toMapLibre(geometry: RendererGeometryType): readonly RendererLayerFragment[];
}

// ── Class breaks ─────────────────────────────────────────────────

/** One graduated class. @experimental */
export interface ClassBreakEntry {
  /** Inclusive lower bound; used as the MapLibre `step` threshold (`min ?? max`). */
  readonly min?: number;
  readonly max?: number;
  /** Swatch color shorthand; positional `colors` apply when omitted. */
  readonly color?: string;
  readonly label?: string;
  /** Advanced multi-property override; replaces the color shorthand. */
  readonly style?: RendererStyle;
}

/** Options for {@link classBreaksRenderer}. @experimental */
export interface ClassBreaksRendererOptions {
  /** Numeric feature property driving the classification. */
  readonly field: string;
  /** Ordered class breaks (ascending thresholds). */
  readonly breaks: readonly ClassBreakEntry[];
  /** Positional palette applied to breaks without an explicit `color`. */
  readonly colors?: readonly string[];
  /** Color for values below the first threshold (and legend default swatch). */
  readonly defaultColor?: string;
  readonly defaultLabel?: string;
  /** Advanced default override; replaces `defaultColor`. */
  readonly defaultStyle?: RendererStyle;
  /** Force a MapLibre layer type instead of deriving it from geometry. */
  readonly layerType?: string;
}

/** Serializable class-breaks descriptor. @experimental */
export interface ClassBreaksRendererDescriptor extends ClassBreaksRendererOptions {
  readonly kind: "class-breaks";
}

/** Class-breaks renderer object. @experimental */
export interface ClassBreaksRenderer extends RendererBase<ClassBreaksRendererDescriptor> {}

/**
 * Create a graduated (class-breaks) renderer: a `step` expression over a
 * numeric field.
 *
 * @example
 * ```ts
 * const renderer = classBreaksRenderer({
 *   field: "magnitude",
 *   breaks: [
 *     { min: 0, max: 3, label: "Minor" },
 *     { min: 3, max: 5, label: "Moderate" },
 *     { min: 5, label: "Strong" },
 *   ],
 *   colors: ["#fed976", "#fd8d3c", "#b10026"],
 *   defaultColor: "#cccccc",
 * });
 * const [fragment] = renderer.toMapLibre("point");
 * // fragment.paint["circle-color"] → ["step", ["get", "magnitude"], "#cccccc", 0, "#fed976", …]
 * ```
 *
 * @experimental
 */
export function classBreaksRenderer(options: ClassBreaksRendererOptions): ClassBreaksRenderer {
  const descriptor = cloneDescriptor<ClassBreaksRendererDescriptor>({ ...options, kind: "class-breaks" });
  if (typeof descriptor.field !== "string" || descriptor.field.length === 0) {
    throw new TypeError("classBreaksRenderer requires a non-empty field.");
  }
  if (!Array.isArray(descriptor.breaks) || descriptor.breaks.length === 0) {
    throw new TypeError("classBreaksRenderer requires at least one break.");
  }
  descriptor.breaks.forEach((entry, index) => {
    if (entry.style !== undefined) return; // advanced entries are trusted as-is
    if (entry.min === undefined && entry.max === undefined) {
      throw new TypeError(`breaks[${index}] needs a min or max threshold.`);
    }
    if (entry.color === undefined && descriptor.colors?.[index] === undefined) {
      throw new TypeError(`breaks[${index}] needs a color, a positional colors[] entry, or a style override.`);
    }
  });
  return Object.freeze({
    kind: "class-breaks" as const,
    toJSON: () => cloneDescriptor(descriptor),
    legendItems: () => classBreaksLegend(descriptor),
    toMapLibre: (geometry: RendererGeometryType) => {
      const type = descriptor.layerType ?? layerTypeFor(geometry);
      const colorProperty = colorPropertyFor(type);
      const entries = descriptor.breaks.map((entry, index) => ({
        key: entry.min ?? entry.max,
        style: resolveEntryStyle(entry, index, descriptor.colors, colorProperty),
      }));
      const defaultStyle = resolveDefaultStyle(descriptor, colorProperty);
      const compiled = compileDataDrivenStyle("step", get(descriptor.field), entries, defaultStyle);
      return Object.freeze([
        Object.freeze({ role: "symbolizer" as const, type, paint: compiled.paint, layout: compiled.layout }),
      ]);
    },
  });
}

function classBreaksLegend(descriptor: ClassBreaksRendererDescriptor): readonly RendererLegendItem[] {
  const items: RendererLegendItem[] = descriptor.breaks.map((entry, index) =>
    Object.freeze({
      kind: "class-break" as const,
      label: entry.label ?? formatRange(entry.min, entry.max),
      color: legendColor(entry.color, index, descriptor.colors, entry.style),
      ...(entry.min !== undefined ? { minValue: entry.min } : {}),
      ...(entry.max !== undefined ? { maxValue: entry.max } : {}),
    }),
  );
  const defaultItem = legendDefaultItem(descriptor);
  if (defaultItem) items.push(defaultItem);
  return Object.freeze(items);
}

// ── Unique values ────────────────────────────────────────────────

/** One categorical class. @experimental */
export interface UniqueValueEntry {
  readonly value: string | number | boolean;
  readonly color?: string;
  readonly label?: string;
  /** Advanced multi-property override; replaces the color shorthand. */
  readonly style?: RendererStyle;
}

/** Options for {@link uniqueValueRenderer}. @experimental */
export interface UniqueValueRendererOptions {
  /** Feature property driving the categories. */
  readonly field: string;
  /** Optional second/third fields concatenated with `fieldDelimiter`. */
  readonly field2?: string;
  readonly field3?: string;
  /** Delimiter for multi-field matching. @default "," */
  readonly fieldDelimiter?: string;
  readonly values: readonly UniqueValueEntry[];
  /** Fallback color for unmatched values (and legend default swatch). */
  readonly defaultColor?: string;
  readonly defaultLabel?: string;
  /** Advanced default override; replaces `defaultColor`. */
  readonly defaultStyle?: RendererStyle;
  /** Force a MapLibre layer type instead of deriving it from geometry. */
  readonly layerType?: string;
}

/** Serializable unique-value descriptor. @experimental */
export interface UniqueValueRendererDescriptor extends UniqueValueRendererOptions {
  readonly kind: "unique-value";
}

/** Unique-value renderer object. @experimental */
export interface UniqueValueRenderer extends RendererBase<UniqueValueRendererDescriptor> {}

/**
 * Create a categorical (unique-value) renderer: a `match` expression over a
 * feature property (or a delimited concatenation of up to three).
 *
 * @example
 * ```ts
 * const renderer = uniqueValueRenderer({
 *   field: "priority",
 *   values: [
 *     { value: "high", color: "#b91c1c", label: "High priority" },
 *     { value: "low", color: "#0f766e", label: "Low priority" },
 *   ],
 *   defaultColor: "#334155",
 * });
 * renderer.legendItems(); // [{ kind: "unique-value", label: "High priority", … }, …]
 * ```
 *
 * @experimental
 */
export function uniqueValueRenderer(options: UniqueValueRendererOptions): UniqueValueRenderer {
  const descriptor = cloneDescriptor<UniqueValueRendererDescriptor>({ ...options, kind: "unique-value" });
  if (typeof descriptor.field !== "string") {
    throw new TypeError("uniqueValueRenderer requires a field.");
  }
  if (!Array.isArray(descriptor.values) || descriptor.values.length === 0) {
    throw new TypeError("uniqueValueRenderer requires at least one value entry.");
  }
  descriptor.values.forEach((entry, index) => {
    if (entry.value === undefined) throw new TypeError(`values[${index}] needs a value.`);
    if (entry.color === undefined && entry.style === undefined) {
      throw new TypeError(`values[${index}] needs a color or a style override.`);
    }
  });
  return Object.freeze({
    kind: "unique-value" as const,
    toJSON: () => cloneDescriptor(descriptor),
    legendItems: () => uniqueValueLegend(descriptor),
    toMapLibre: (geometry: RendererGeometryType) => {
      const type = descriptor.layerType ?? layerTypeFor(geometry);
      const colorProperty = colorPropertyFor(type);
      const entries = descriptor.values.map((entry) => ({
        key: entry.value,
        style: resolveEntryStyle(entry, undefined, undefined, colorProperty),
      }));
      const defaultStyle = resolveDefaultStyle(descriptor, colorProperty);
      const compiled = compileDataDrivenStyle("match", uniqueValueFieldExpression(descriptor), entries, defaultStyle);
      return Object.freeze([
        Object.freeze({ role: "symbolizer" as const, type, paint: compiled.paint, layout: compiled.layout }),
      ]);
    },
  });
}

function uniqueValueFieldExpression(descriptor: UniqueValueRendererDescriptor): Expr<unknown> {
  if (!descriptor.field2 && !descriptor.field3) return get(descriptor.field);
  const delimiter = descriptor.fieldDelimiter ?? ",";
  const parts: Resolvable[] = [];
  if (descriptor.field) parts.push(get(descriptor.field));
  if (descriptor.field2) {
    parts.push(delimiter);
    parts.push(get(descriptor.field2));
  }
  if (descriptor.field3) {
    parts.push(delimiter);
    parts.push(get(descriptor.field3));
  }
  return concat(...parts);
}

function uniqueValueLegend(descriptor: UniqueValueRendererDescriptor): readonly RendererLegendItem[] {
  const items: RendererLegendItem[] = descriptor.values.map((entry) =>
    Object.freeze({
      kind: "unique-value" as const,
      label: entry.label ?? String(entry.value),
      color: legendColor(entry.color, undefined, undefined, entry.style),
      value: entry.value,
    }),
  );
  const defaultItem = legendDefaultItem(descriptor);
  if (defaultItem) items.push(defaultItem);
  return Object.freeze(items);
}

// ── Heatmap ──────────────────────────────────────────────────────

/** One kernel-density ramp stop (density is 0..1). @experimental */
export interface HeatmapColorStop {
  readonly stop: number;
  readonly color: string;
}

/** Options for {@link heatmapRenderer}. @experimental */
export interface HeatmapRendererOptions {
  /** Numeric property weighting each point (defaults to weight 1). */
  readonly weightField?: string;
  /** Kernel radius in pixels. @default 30 */
  readonly radius?: number;
  /** Global intensity multiplier. @default 1 */
  readonly intensity?: number;
  /** Layer opacity (0..1). */
  readonly opacity?: number;
  /**
   * Density → color ramp. Either explicit stops or a color list spread
   * evenly across 0..1 (the first color should usually be transparent).
   */
  readonly colorRamp?: readonly HeatmapColorStop[] | readonly string[];
}

/** Serializable heatmap descriptor. @experimental */
export interface HeatmapRendererDescriptor extends HeatmapRendererOptions {
  readonly kind: "heatmap";
}

/** Heatmap renderer object. @experimental */
export interface HeatmapRenderer extends RendererBase<HeatmapRendererDescriptor> {}

const DEFAULT_HEATMAP_RAMP: readonly HeatmapColorStop[] = Object.freeze([
  Object.freeze({ stop: 0, color: "rgba(33,102,172,0)" }),
  Object.freeze({ stop: 0.2, color: "rgb(103,169,207)" }),
  Object.freeze({ stop: 0.4, color: "rgb(209,229,240)" }),
  Object.freeze({ stop: 0.6, color: "rgb(253,219,199)" }),
  Object.freeze({ stop: 0.8, color: "rgb(239,138,98)" }),
  Object.freeze({ stop: 1, color: "rgb(178,24,43)" }),
]);

/**
 * Create a MapLibre-native heatmap renderer. Compiles to a single `heatmap`
 * layer fragment regardless of the requested geometry (heatmaps render
 * point data).
 *
 * @experimental
 */
export function heatmapRenderer(options: HeatmapRendererOptions = {}): HeatmapRenderer {
  const descriptor = cloneDescriptor<HeatmapRendererDescriptor>({ ...options, kind: "heatmap" });
  const ramp = normalizeHeatmapRamp(descriptor.colorRamp);
  return Object.freeze({
    kind: "heatmap" as const,
    toJSON: () => cloneDescriptor(descriptor),
    legendItems: () =>
      Object.freeze(
        ramp.map((entry) =>
          Object.freeze({
            kind: "heatmap-stop" as const,
            label: String(entry.stop),
            color: entry.color,
            value: entry.stop,
          }),
        ),
      ),
    toMapLibre: () => {
      const paint: Record<string, unknown> = {
        "heatmap-radius": descriptor.radius ?? 30,
        "heatmap-intensity": descriptor.intensity ?? 1,
        "heatmap-color": interpolate(
          linear(),
          heatmapDensity(),
          ...ramp.map((entry): [number, Resolvable] => [entry.stop, entry.color]),
        ).toJSON(),
      };
      if (descriptor.weightField !== undefined) {
        paint["heatmap-weight"] = toNumber(get(descriptor.weightField), 0).toJSON();
      }
      if (descriptor.opacity !== undefined) paint["heatmap-opacity"] = descriptor.opacity;
      return Object.freeze([Object.freeze({ role: "symbolizer" as const, type: "heatmap", paint, layout: {} })]);
    },
  });
}

function normalizeHeatmapRamp(
  ramp: readonly HeatmapColorStop[] | readonly string[] | undefined,
): readonly HeatmapColorStop[] {
  if (ramp === undefined || ramp.length === 0) return DEFAULT_HEATMAP_RAMP;
  if (typeof ramp[0] === "string") {
    const colors = ramp as readonly string[];
    if (colors.length === 1) return [{ stop: 1, color: colors[0] }];
    return colors.map((color, index) => ({
      stop: roundStop(index / (colors.length - 1)),
      color,
    }));
  }
  const stops = [...(ramp as readonly HeatmapColorStop[])];
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].stop <= stops[i - 1].stop) {
      throw new TypeError("heatmapRenderer colorRamp stops must be strictly ascending.");
    }
  }
  return stops;
}

function roundStop(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ── Cluster ──────────────────────────────────────────────────────

/** One cluster size class (thresholds are feature counts). @experimental */
export interface ClusterStep {
  /** Inclusive minimum count for this class; the first step is the base class. */
  readonly threshold: number;
  readonly color: string;
  /** Cluster circle radius in pixels. Defaults to `14 + 6 * index`. */
  readonly radius?: number;
  readonly label?: string;
}

/** Options for {@link clusterRenderer}. @experimental */
export interface ClusterRendererOptions {
  /** Cluster radius in pixels (GeoJSON source `clusterRadius`). @default 50 */
  readonly radius?: number;
  /** Max zoom to cluster at (GeoJSON source `clusterMaxZoom`). @default 14 */
  readonly maxZoom?: number;
  /**
   * Numeric property summed per cluster instead of the raw point count.
   * Adds a `<countField>_sum` cluster property and drives the step/count
   * expressions from it.
   */
  readonly countField?: string;
  /** Ascending count classes driving cluster color/size. */
  readonly steps: readonly ClusterStep[];
  /** Style for unclustered points. @default "#16735b" */
  readonly unclusteredColor?: string;
  /** @default 5 */
  readonly unclusteredRadius?: number;
}

/** Serializable cluster descriptor. @experimental */
export interface ClusterRendererDescriptor extends ClusterRendererOptions {
  readonly kind: "cluster";
}

/** Cluster renderer object. @experimental */
export interface ClusterRenderer extends RendererBase<ClusterRendererDescriptor> {
  /**
   * GeoJSON source options enabling MapLibre-native clustering
   * (`cluster`, `clusterRadius`, `clusterMaxZoom`, `clusterProperties`).
   * Merge these into the GeoJSON source spec that feeds the layers.
   */
  toMapLibreSource(): Record<string, unknown>;
}

/**
 * Create a MapLibre-native cluster renderer. Compiles to three fragments —
 * cluster circles, cluster count labels, and unclustered points — plus
 * GeoJSON source cluster options via {@link ClusterRenderer.toMapLibreSource}.
 *
 * @experimental
 */
export function clusterRenderer(options: ClusterRendererOptions): ClusterRenderer {
  const descriptor = cloneDescriptor<ClusterRendererDescriptor>({ ...options, kind: "cluster" });
  if (!Array.isArray(descriptor.steps) || descriptor.steps.length === 0) {
    throw new TypeError("clusterRenderer requires at least one step.");
  }
  for (let i = 1; i < descriptor.steps.length; i++) {
    if (descriptor.steps[i].threshold <= descriptor.steps[i - 1].threshold) {
      throw new TypeError("clusterRenderer steps must have strictly ascending thresholds.");
    }
  }
  const sumProperty = descriptor.countField !== undefined ? `${descriptor.countField}_sum` : undefined;
  const countExpression = (): Expr<unknown> => get(sumProperty ?? "point_count");
  return Object.freeze({
    kind: "cluster" as const,
    toJSON: () => cloneDescriptor(descriptor),
    toMapLibreSource: () => ({
      cluster: true,
      clusterRadius: descriptor.radius ?? 50,
      clusterMaxZoom: descriptor.maxZoom ?? 14,
      ...(descriptor.countField !== undefined && sumProperty !== undefined
        ? { clusterProperties: { [sumProperty]: ["+", ["get", descriptor.countField]] } }
        : {}),
    }),
    legendItems: () => clusterLegend(descriptor),
    toMapLibre: () => {
      const steps = descriptor.steps;
      const color =
        steps.length === 1
          ? steps[0].color
          : step(
              countExpression(),
              steps[0].color,
              ...steps.slice(1).map((entry): [number, Resolvable] => [entry.threshold, entry.color]),
            ).toJSON();
      const radiusFor = (entry: ClusterStep, index: number): number => entry.radius ?? 14 + 6 * index;
      const radius =
        steps.length === 1
          ? radiusFor(steps[0], 0)
          : step(
              countExpression(),
              radiusFor(steps[0], 0),
              ...steps
                .slice(1)
                .map((entry, index): [number, Resolvable] => [entry.threshold, radiusFor(entry, index + 1)]),
            ).toJSON();
      const clusters = Object.freeze({
        role: "clusters" as const,
        type: "circle",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": color,
          "circle-radius": radius,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
        layout: {},
      });
      const count = Object.freeze({
        role: "cluster-count" as const,
        type: "symbol",
        filter: ["has", "point_count"],
        paint: { "text-color": "#ffffff" },
        layout: {
          "text-field":
            sumProperty !== undefined ? ["to-string", ["get", sumProperty]] : ["get", "point_count_abbreviated"],
          "text-size": 12,
        },
      });
      const unclustered = Object.freeze({
        role: "unclustered" as const,
        type: "circle",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": descriptor.unclusteredColor ?? "#16735b",
          "circle-radius": descriptor.unclusteredRadius ?? 5,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
        layout: {},
      });
      return Object.freeze([clusters, count, unclustered]);
    },
  });
}

function clusterLegend(descriptor: ClusterRendererDescriptor): readonly RendererLegendItem[] {
  const items: RendererLegendItem[] = descriptor.steps.map((entry, index) => {
    const next = descriptor.steps[index + 1];
    return Object.freeze({
      kind: "cluster-step" as const,
      label: entry.label ?? (next ? `${entry.threshold}–${next.threshold}` : `≥ ${entry.threshold}`),
      color: entry.color,
      minValue: entry.threshold,
      ...(next ? { maxValue: next.threshold } : {}),
    });
  });
  items.push(
    Object.freeze({
      kind: "default" as const,
      label: "Individual features",
      color: descriptor.unclusteredColor ?? "#16735b",
    }),
  );
  return Object.freeze(items);
}

// ── JSON revival ─────────────────────────────────────────────────

/**
 * Revive a renderer object from its serializable descriptor
 * (`renderer.toJSON()` output).
 *
 * @experimental
 */
export function rendererFromJSON(descriptor: RendererDescriptor): Renderer {
  switch (descriptor.kind) {
    case "class-breaks":
      return classBreaksRenderer(descriptor);
    case "unique-value":
      return uniqueValueRenderer(descriptor);
    case "heatmap":
      return heatmapRenderer(descriptor);
    case "cluster":
      return clusterRenderer(descriptor);
    default:
      throw new TypeError(`Unknown renderer kind "${String((descriptor as { kind?: unknown }).kind)}".`);
  }
}

/** True when a value looks like a renderer object from this module. @experimental */
export function isRenderer(value: unknown): value is Renderer {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Renderer>;
  return (
    typeof candidate.toMapLibre === "function" &&
    typeof candidate.legendItems === "function" &&
    (candidate.kind === "class-breaks" ||
      candidate.kind === "unique-value" ||
      candidate.kind === "heatmap" ||
      candidate.kind === "cluster")
  );
}

// ── Shared compilation core (single implementation, REQ-002) ─────

/**
 * MapLibre properties that live in `layout` rather than `paint`. Shared with
 * the WebMap converter so both route properties identically.
 *
 * @internal
 */
export const RENDERER_LAYOUT_PROPERTIES: ReadonlySet<string> = new Set([
  "icon-image",
  "icon-size",
  "icon-offset",
  "icon-anchor",
  "icon-rotate",
  "text-field",
  "text-font",
  "text-size",
  "text-offset",
  "text-anchor",
  "text-max-width",
  "text-letter-spacing",
  "text-justify",
  "text-rotate",
  "symbol-placement",
  "symbol-spacing",
  "visibility",
]);

/** Resolved per-class style used by the shared compiler. @internal */
export interface ResolvedRendererStyle {
  readonly paint: Record<string, unknown>;
  readonly layout: Record<string, unknown>;
}

/** One class entry for the shared compiler. @internal */
export interface DataDrivenStyleEntry {
  /** Match value (unique value) or step threshold (class breaks). */
  readonly key: unknown;
  readonly style: ResolvedRendererStyle;
}

/**
 * The single class-breaks/unique-value property compiler (issue #497
 * REQ-002). For every paint/layout property present on any class it builds
 * one `match` (categorical) or `step` (graduated) expression through the
 * `/expr` builder. When `defaultStyle` is omitted the first entry's style
 * provides per-property defaults; missing values fall back to
 * `"transparent"`.
 *
 * @internal
 */
export function compileDataDrivenStyle(
  mode: "match" | "step",
  input: Expr<unknown>,
  entries: readonly DataDrivenStyleEntry[],
  defaultStyle: ResolvedRendererStyle | undefined,
): { paint: Record<string, unknown>; layout: Record<string, unknown> } {
  const paint: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};
  if (entries.length === 0) return { paint, layout };

  const keys = new Set<string>();
  for (const entry of entries) {
    for (const key of Object.keys(entry.style.paint)) keys.add(key);
    for (const key of Object.keys(entry.style.layout)) keys.add(key);
  }

  const fallbackStyle = defaultStyle ?? entries[0].style;
  for (const key of keys) {
    const defaultValue = (fallbackStyle.paint[key] ?? fallbackStyle.layout[key] ?? "transparent") as Resolvable;
    let expression: unknown;
    if (mode === "match") {
      expression = matchExpr(
        input,
        ...entries.map((entry): [Resolvable, Resolvable] => [
          entry.key as Resolvable,
          (entry.style.paint[key] ?? entry.style.layout[key]) as Resolvable,
        ]),
        defaultValue,
      ).toJSON();
    } else {
      expression = step(
        input,
        defaultValue,
        ...entries.map((entry): [number, Resolvable] => [
          entry.key as number,
          (entry.style.paint[key] ?? entry.style.layout[key]) as Resolvable,
        ]),
      ).toJSON();
    }
    if (RENDERER_LAYOUT_PROPERTIES.has(key)) layout[key] = expression;
    else paint[key] = expression;
  }
  return { paint, layout };
}

// ── Internal helpers ─────────────────────────────────────────────

function layerTypeFor(geometry: RendererGeometryType): string {
  return geometry === "point" ? "circle" : geometry === "line" ? "line" : "fill";
}

function colorPropertyFor(layerType: string): string {
  switch (layerType) {
    case "circle":
      return "circle-color";
    case "line":
      return "line-color";
    case "fill":
      return "fill-color";
    case "symbol":
      return "icon-color";
    default:
      return `${layerType}-color`;
  }
}

function resolveEntryStyle(
  entry: { readonly color?: string; readonly style?: RendererStyle },
  index: number | undefined,
  colors: readonly string[] | undefined,
  colorProperty: string,
): ResolvedRendererStyle {
  if (entry.style !== undefined) {
    return { paint: { ...(entry.style.paint ?? {}) }, layout: { ...(entry.style.layout ?? {}) } };
  }
  const color = entry.color ?? (index !== undefined ? colors?.[index] : undefined);
  return { paint: color !== undefined ? { [colorProperty]: color } : {}, layout: {} };
}

function resolveDefaultStyle(
  descriptor: {
    readonly defaultColor?: string;
    readonly defaultStyle?: RendererStyle;
  },
  colorProperty: string,
): ResolvedRendererStyle | undefined {
  if (descriptor.defaultStyle !== undefined) {
    return {
      paint: { ...(descriptor.defaultStyle.paint ?? {}) },
      layout: { ...(descriptor.defaultStyle.layout ?? {}) },
    };
  }
  if (descriptor.defaultColor !== undefined) {
    return { paint: { [colorProperty]: descriptor.defaultColor }, layout: {} };
  }
  return undefined;
}

function legendColor(
  color: string | undefined,
  index: number | undefined,
  colors: readonly string[] | undefined,
  style: RendererStyle | undefined,
): string {
  const resolved = color ?? (index !== undefined ? colors?.[index] : undefined) ?? styleColor(style);
  return resolved ?? "transparent";
}

function styleColor(style: RendererStyle | undefined): string | undefined {
  if (!style) return undefined;
  for (const bag of [style.paint, style.layout]) {
    if (!bag) continue;
    for (const [key, value] of Object.entries(bag)) {
      if (key.endsWith("-color") && typeof value === "string") return value;
    }
  }
  return undefined;
}

function legendDefaultItem(descriptor: {
  readonly defaultColor?: string;
  readonly defaultLabel?: string;
  readonly defaultStyle?: RendererStyle;
}): RendererLegendItem | undefined {
  if (
    descriptor.defaultColor === undefined &&
    descriptor.defaultLabel === undefined &&
    descriptor.defaultStyle === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "default" as const,
    label: descriptor.defaultLabel ?? "Other",
    color: descriptor.defaultColor ?? styleColor(descriptor.defaultStyle) ?? "transparent",
  });
}

function formatRange(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${min}–${max}`;
  if (min !== undefined) return `≥ ${min}`;
  if (max !== undefined) return `≤ ${max}`;
  return "";
}

function cloneDescriptor<T>(value: T): T {
  return structuredClone(value) as T;
}
