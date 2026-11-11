/**
 * `@honua/sdk-js/analytics/uplot` — the reference third-party chart adapter.
 *
 * [µPlot](https://github.com/leeoniya/uPlot) is a small (~50 KB), MIT-licensed,
 * widely deployed canvas time-series library. This module proves the analytics
 * presentation contract against a real library without Honua growing a chart
 * engine:
 *
 * - `uplot` is an **optional peer**, reached only through a dynamic import with
 *   a variable specifier, so no bundler ever pulls it into a Honua entrypoint.
 *   `createUplotAnalyticsAdapter()` accepts an injected `module` or
 *   `importModule`, following the same seam as `loadApacheArrow` and
 *   `loadDeckGlPeers`.
 * - Nothing µPlot-shaped crosses back into SDK core: brushes become
 *   `temporal-brush` / `range-brush` / `rectangle-brush` interactions and cursor movement becomes
 *   `hover`, all keyed by stable mark keys.
 * - `dispose()` calls `destroy()`, removes the click listener, and drops the
 *   instance, so an unmounted chart holds no DOM or hook references.
 *
 * This file is intentionally *not* re-exported from `@honua/sdk-js/analytics`:
 * the barrel must stay free of every adapter so the core bundle guard can
 * prove that an unused chart peer costs nothing.
 *
 * @experimental
 * @packageDocumentation
 */

import { analyticsTableModel } from "../accessible-table.js";
import { createDisposableHandle } from "../handle.js";
import { ANALYTICS_CONTRACT_VERSION, HonuaAnalyticsError } from "../types.js";
import type {
  AnalyticsArtifact,
  AnalyticsHistogramArtifact,
  AnalyticsLinkedState,
  AnalyticsMountRequest,
  AnalyticsNumericRectangle,
  AnalyticsPresentationAdapter,
  AnalyticsPresentationHandle,
  AnalyticsScatterArtifact,
  AnalyticsSupportDecision,
  AnalyticsTimeSeriesArtifact,
} from "../types.js";

const SCATTER_POINT_SELECTED = "#9a3412";
const SCATTER_SELECTED_RADIUS = 6;

/** Adapter id, stable across releases. */
export const UPLOT_ANALYTICS_ADAPTER_ID = "honua.uplot";

const UPLOT_PACKAGE = "uplot";

// ── Minimal structural slice of the µPlot surface ─────────────
// Modelled as the smallest slice of `typeof import("uplot")` this adapter
// touches, so a stub module in a unit test satisfies it and the real peer is
// never required at typecheck time.

/** Bounding box µPlot reports for a completed selection. */
export interface UplotSelectBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The µPlot instance members this adapter uses. */
export interface UplotInstanceLike {
  readonly data?: UplotAlignedData;
  readonly select: UplotSelectBox;
  readonly cursor: {
    readonly event?: Event | null;
    readonly idx?: number | null;
    readonly left?: number;
    readonly top?: number;
  };
  readonly over?: {
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
  };
  setData(data: ReadonlyArray<ReadonlyArray<number | null>>, resetScales?: boolean): void;
  setSelect(box: UplotSelectBox, fireHook?: boolean): void;
  posToVal(position: number, scaleKey: string): number;
  valToPos(value: number, scaleKey: string, canvasPixels?: boolean): number;
  redraw?(rebuildPaths?: boolean): void;
  /** Canvas-pixel plot rectangle. Real µPlot sets this before drawing. */
  readonly bbox?: { left: number; top: number; width: number; height: number };
  /** Present only while the chart is drawing. Real µPlot sets this before `hooks.draw`. */
  readonly ctx?: {
    fillStyle: string;
    beginPath(): void;
    rect(x: number, y: number, width: number, height: number): void;
    moveTo(x: number, y: number): void;
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
    clip(): void;
    fill(): void;
    save(): void;
    restore(): void;
  };
  destroy(): void;
}

/** The `uPlot` constructor shape. */
export interface UplotConstructorLike {
  new (options: UplotOptions, data: ReadonlyArray<ReadonlyArray<number | null>>, target?: unknown): UplotInstanceLike;
}

/** Either a namespace with a default export or the constructor itself. */
export type UplotModuleLike = UplotConstructorLike | { readonly default: UplotConstructorLike };

/** One µPlot series definition (the subset this adapter emits). */
export interface UplotSeriesOptions {
  readonly label?: string;
  readonly stroke?: string;
  readonly fill?: string;
  readonly width?: number;
  readonly points?: {
    readonly show?: boolean;
    readonly stroke?: string;
  };
  readonly value?: unknown;
  readonly paths?: () => null;
}

/** One µPlot scale definition (the subset this adapter emits). */
export interface UplotScaleOptions {
  readonly time?: boolean;
  readonly auto?: (self: UplotInstanceLike) => boolean;
  readonly range?:
    | readonly [number, number]
    | ((self: UplotInstanceLike, min: number, max: number) => readonly [number, number]);
}

/**
 * The µPlot options object this adapter produces. Structurally assignable to
 * `uPlot.Options` for the fields it sets; a host may spread extra props in via
 * `optionOverrides`.
 */
export interface UplotOptions {
  readonly title?: string;
  readonly width: number;
  readonly height: number;
  readonly series: readonly UplotSeriesOptions[];
  readonly scales?: Readonly<Record<string, UplotScaleOptions>>;
  readonly cursor?: Readonly<Record<string, unknown>>;
  readonly hooks?: {
    readonly setSelect?: ReadonlyArray<(self: UplotInstanceLike) => void>;
    readonly setCursor?: ReadonlyArray<(self: UplotInstanceLike) => void>;
    readonly setScale?: ReadonlyArray<(self: UplotInstanceLike) => void>;
    readonly draw?: ReadonlyArray<(self: UplotInstanceLike) => void>;
  };
  readonly [extra: string]: unknown;
}

/** µPlot's aligned-data layout: `[xs, ...series]`. */
export type UplotAlignedData = ReadonlyArray<ReadonlyArray<number | null>>;

/** Module importer seam, matching `DeckGlModuleImporter`. */
export type UplotModuleImporter = (specifier: string) => Promise<unknown>;

const defaultImportModule: UplotModuleImporter = (specifier) => import(specifier);

/** Options for {@link loadUplot}. */
export interface LoadUplotOptions {
  readonly importModule?: UplotModuleImporter;
}

function asConstructor(module: unknown): UplotConstructorLike {
  if (typeof module === "function") return module as UplotConstructorLike;
  if (typeof module === "object" && module !== null) {
    const candidate = (module as { default?: unknown }).default;
    if (typeof candidate === "function") return candidate as UplotConstructorLike;
  }
  throw new HonuaAnalyticsError(
    "missing-peer",
    `The loaded "${UPLOT_PACKAGE}" module does not expose a uPlot constructor.`,
    { package: UPLOT_PACKAGE },
  );
}

/**
 * Load the optional µPlot peer. Only called from `mount()`, so importing the
 * adapter module costs nothing until a chart is actually rendered.
 */
export async function loadUplot(options: LoadUplotOptions = {}): Promise<UplotConstructorLike> {
  let module: unknown;
  try {
    module = await (options.importModule ?? defaultImportModule)(UPLOT_PACKAGE);
  } catch (cause) {
    throw new HonuaAnalyticsError(
      "missing-peer",
      `The µPlot analytics adapter requires the optional peer "${UPLOT_PACKAGE}". Install it with \`npm i uplot\` or inject a module.`,
      { package: UPLOT_PACKAGE },
      { cause: cause instanceof Error ? cause : undefined },
    );
  }
  return asConstructor(module);
}

// ── Artifact → µPlot projection (pure) ────────────────────────

/** Result of projecting an artifact into µPlot inputs. */
export interface UplotProjection {
  readonly options: UplotOptions;
  readonly data: UplotAlignedData;
  /**
   * Mark key per x index, so a cursor index or a brushed x-range maps back to
   * stable mark keys without µPlot state entering SDK core.
   */
  readonly markKeys: readonly string[];
  /** The x-axis unit the projection used. */
  readonly xUnit: "epoch-seconds" | "bucket-midpoint" | "numeric";
}

/** Options for {@link projectAnalyticsArtifactToUplot}. */
export interface UplotProjectionOptions {
  /** @default 640 */
  readonly width?: number;
  /** @default 240 */
  readonly height?: number;
  readonly locale?: string;
  /** Series stroke colour. @default `"#2563eb"` */
  readonly stroke?: string;
  /** Merged over the generated options (never overrides `hooks`). */
  readonly optionOverrides?: Readonly<Record<string, unknown>>;
}

function nearestPointIndex(self: UplotInstanceLike, data: UplotAlignedData): number | null {
  const { idx, left, top } = self.cursor;
  if (left === undefined || top === undefined) return idx ?? null;
  if (!Number.isFinite(left) || !Number.isFinite(top) || left < 0 || top < 0) return null;
  let nearest: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < data[0].length; index++) {
    const x = data[0][index];
    const y = data[1][index];
    if (x == null || y == null) continue;
    const squared = (self.valToPos(x, "x") - left) ** 2 + (self.valToPos(y, "y") - top) ** 2;
    if (squared < distance) {
      distance = squared;
      nearest = index;
    }
  }
  return nearest;
}

const scatterInitialized = new WeakSet<UplotInstanceLike>();
const scatterAutoscaling = new WeakSet<UplotInstanceLike>();
const scatterScaleResetEvents = new WeakSet<Event>();

function scatterXAuto(self: UplotInstanceLike): boolean {
  scatterAutoscaling.add(self);
  return true;
}

function scatterXRange(self: UplotInstanceLike, min: number, max: number): readonly [number, number] {
  const autoscaling = scatterAutoscaling.delete(self);
  const event = self.cursor.event;
  const resetting = event?.type === "dblclick" && !scatterScaleResetEvents.has(event);
  if (resetting) scatterScaleResetEvents.add(event);
  // µPlot calls auto() for data-driven resets and records double-click events
  // for user resets; redraws and explicit zoom bounds need no extra padding.
  if (scatterInitialized.has(self) && !autoscaling && !resetting) return [min, max];
  scatterInitialized.add(self);
  const padding = Math.max((max - min) * 0.05, Math.abs(max) * Number.EPSILON * 4, Number.EPSILON);
  return [min - padding, max + padding];
}

function projectedColumns(
  artifact: AnalyticsTimeSeriesArtifact | AnalyticsHistogramArtifact | AnalyticsScatterArtifact,
): { xs: number[]; ys: Array<number | null>; markKeys: string[] } {
  const xs: number[] = [];
  const ys: Array<number | null> = [];
  const markKeys: string[] = [];
  const marks = artifact.kind === "scatter" ? [...artifact.marks].sort((a, b) => a.x - b.x) : artifact.marks;
  for (const mark of marks) {
    if (artifact.kind === "time-series") {
      xs.push(Math.floor(Date.parse((mark as AnalyticsTimeSeriesArtifact["marks"][number]).start) / 1000));
    } else if (artifact.kind === "scatter") {
      xs.push((mark as AnalyticsScatterArtifact["marks"][number]).x);
    } else {
      const bin = mark as AnalyticsHistogramArtifact["marks"][number];
      xs.push((bin.min + bin.max) / 2);
    }
    ys.push(mark.value);
    markKeys.push(mark.key);
  }
  return { xs, ys, markKeys };
}

/**
 * Project a time-series, histogram or scatter artifact into µPlot options and aligned
 * data. Pure and DOM-free, so the whole projection is unit-testable and can be
 * asserted against without a canvas.
 *
 * Time-series x values are epoch **seconds** (µPlot's `scales.x.time`
 * convention). Histogram x values are bin midpoints on a linear scale. Scatter
 * points use numeric axes, retain their mark keys when sorted, and draw no lines. Null
 * measures stay `null` so µPlot renders a gap rather than a false zero.
 */
export function projectAnalyticsArtifactToUplot(
  artifact: AnalyticsTimeSeriesArtifact | AnalyticsHistogramArtifact | AnalyticsScatterArtifact,
  options: UplotProjectionOptions = {},
): UplotProjection {
  const model = analyticsTableModel(artifact, options.locale);
  const isTemporal = artifact.kind === "time-series";
  const { xs, ys, markKeys } = projectedColumns(artifact);

  const measureLabel =
    artifact.kind === "scatter" ? artifact.yDimension : (artifact.measure.label ?? artifact.measure.field);
  const generated: UplotOptions = {
    title: model.caption,
    width: options.width ?? 640,
    height: options.height ?? 240,
    series: [
      { label: isTemporal ? "Time" : artifact.dimension },
      {
        label: measureLabel,
        stroke: options.stroke ?? "#2563eb",
        width: artifact.kind === "scatter" ? 0 : 2,
        ...(artifact.kind === "scatter" ? { paths: () => null } : {}),
        points: {
          show: artifact.kind === "scatter" || artifact.marks.length <= 100,
        },
      },
    ],
    scales: {
      x: isTemporal
        ? { time: true }
        : { time: false, ...(artifact.kind === "scatter" ? { auto: scatterXAuto, range: scatterXRange } : {}) },
    },
    ...(artifact.kind === "scatter"
      ? {
          cursor: {
            drag: { x: true, y: true, setScale: false },
            dataIdx: (self: UplotInstanceLike) => nearestPointIndex(self, self.data ?? [xs, ys]),
          },
        }
      : {}),
  };

  const { hooks: _ignoredHooks, ...overrides } = options.optionOverrides ?? {};
  return {
    options: { ...generated, ...overrides } as UplotOptions,
    data: [xs, ys],
    markKeys,
    xUnit: isTemporal ? "epoch-seconds" : artifact.kind === "scatter" ? "numeric" : "bucket-midpoint",
  };
}

// ── Adapter ───────────────────────────────────────────────────

/** Options for {@link createUplotAnalyticsAdapter}. */
export interface CreateUplotAnalyticsAdapterOptions extends UplotProjectionOptions, LoadUplotOptions {
  /** Inject the peer directly and skip loading entirely. */
  readonly module?: UplotModuleLike;
}

function isSupportedKind(
  artifact: AnalyticsArtifact,
): artifact is AnalyticsTimeSeriesArtifact | AnalyticsHistogramArtifact | AnalyticsScatterArtifact {
  return artifact.kind === "time-series" || artifact.kind === "histogram" || artifact.kind === "scatter";
}

interface UplotChartSession {
  request: AnalyticsMountRequest;
  artifact: AnalyticsTimeSeriesArtifact | AnalyticsHistogramArtifact | AnalyticsScatterArtifact;
  projection: UplotProjection;
  lastHoverKey: string | undefined;
  paintedRectangle: string | undefined;
  paintedMarkKeys: string;
  activeRectangle: AnalyticsNumericRectangle | undefined;
  highlightedMarkKeys: Set<string>;
  instance: UplotInstanceLike | undefined;
  clickRelease: (() => void) | undefined;
  brushed: boolean;
  painting: boolean;
}

function uplotEventBase(
  artifact: AnalyticsTimeSeriesArtifact | AnalyticsHistogramArtifact | AnalyticsScatterArtifact,
): {
  adapterId: typeof UPLOT_ANALYTICS_ADAPTER_ID;
  artifactId: string;
  artifactSequence: number;
  artifactSourceId: string;
  artifactPlanFingerprint: string;
  artifactKind: typeof artifact.kind;
  artifactDimension?: string;
  artifactYDimension?: string;
} {
  return {
    adapterId: UPLOT_ANALYTICS_ADAPTER_ID,
    artifactId: artifact.identity.artifactId,
    artifactSequence: artifact.identity.sequence,
    artifactSourceId: artifact.identity.sourceId,
    artifactPlanFingerprint: artifact.identity.planFingerprint ?? "",
    artifactKind: artifact.kind,
    ...(artifact.kind === "scatter"
      ? { artifactDimension: artifact.dimension, artifactYDimension: artifact.yDimension }
      : { artifactDimension: artifact.dimension }),
  };
}

function emitScatterRectangle(session: UplotChartSession, self: UplotInstanceLike): void {
  const box = self.select;
  if (!box || box.width <= 0 || box.height <= 0) return;
  const min = Math.min(self.posToVal(box.left, "x"), self.posToVal(box.left + box.width, "x"));
  const max = Math.max(self.posToVal(box.left, "x"), self.posToVal(box.left + box.width, "x"));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  const y0 = self.posToVal(box.top, "y");
  const y1 = self.posToVal(box.top + box.height, "y");
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return;
  session.brushed = true;
  session.activeRectangle = {
    x: { min, max },
    y: { min: Math.min(y0, y1), max: Math.max(y0, y1) },
  };
  session.request.host.emit({
    kind: "rectangle-brush",
    ...uplotEventBase(session.artifact),
    rectangle: session.activeRectangle,
  });
}

function emitUplotBrush(session: UplotChartSession, self: UplotInstanceLike): void {
  const box = self.select;
  if (!box || box.width <= 0) return;
  const from = self.posToVal(box.left, "x");
  const to = self.posToVal(box.left + box.width, "x");
  const min = Math.min(from, to);
  const max = Math.max(from, to);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (session.artifact.kind === "scatter") {
    emitScatterRectangle(session, self);
    return;
  }
  if (session.artifact.kind === "time-series") {
    session.request.host.emit({
      kind: "temporal-brush",
      ...uplotEventBase(session.artifact),
      window: {
        start: new Date(Math.round(min * 1000)).toISOString(),
        end: new Date(Math.round(max * 1000)).toISOString(),
      },
    });
    return;
  }
  session.request.host.emit({
    kind: "range-brush",
    ...uplotEventBase(session.artifact),
    range: { min, max },
  });
}

function cursorMarkKey(session: UplotChartSession, self: UplotInstanceLike): string | undefined {
  const index =
    session.artifact.kind === "scatter" ? nearestPointIndex(self, session.projection.data) : self.cursor.idx;
  return typeof index === "number" && index >= 0 ? session.projection.markKeys[index] : undefined;
}

function emitUplotHover(session: UplotChartSession, self: UplotInstanceLike): void {
  const key = cursorMarkKey(session, self);
  if (key === session.lastHoverKey) return;
  session.lastHoverKey = key;
  session.request.host.emit({
    kind: "hover",
    ...uplotEventBase(session.artifact),
    ...(key ? { markKey: key } : {}),
  });
}

function paintUplotRectangle(session: UplotChartSession, rectangle: AnalyticsNumericRectangle): void {
  const instance = session.instance;
  if (!instance || session.painting) return;
  const left = instance.valToPos(rectangle.x.min, "x");
  const right = instance.valToPos(rectangle.x.max, "x");
  const top = instance.valToPos(rectangle.y.min, "y");
  const bottom = instance.valToPos(rectangle.y.max, "y");
  if (![left, right, top, bottom].every(Number.isFinite)) return;
  session.painting = true;
  try {
    instance.setSelect(
      {
        left: Math.min(left, right),
        top: Math.min(top, bottom),
        width: Math.abs(right - left),
        height: Math.abs(bottom - top),
      },
      false,
    );
  } finally {
    session.painting = false;
  }
}

function drawSelectedScatterPoints(session: UplotChartSession, self: UplotInstanceLike): void {
  if (session.artifact.kind !== "scatter" || session.highlightedMarkKeys.size === 0) return;
  const ctx = self.ctx;
  const bounds = self.bbox;
  const data = self.data ?? session.projection.data;
  if (!ctx || !bounds || data.length < 2) return;
  const xs = data[0];
  const ys = data[1];
  ctx.save();
  ctx.beginPath();
  ctx.rect(bounds.left, bounds.top, bounds.width, bounds.height);
  ctx.clip();
  ctx.beginPath();
  for (let index = 0; index < xs.length; index += 1) {
    const key = session.projection.markKeys[index];
    const x = xs[index];
    const y = ys[index];
    if (key === undefined || !session.highlightedMarkKeys.has(key) || x == null || y == null) continue;
    const px = self.valToPos(x, "x", true);
    const py = self.valToPos(y, "y", true);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    ctx.moveTo(px + SCATTER_SELECTED_RADIUS, py);
    ctx.arc(px, py, SCATTER_SELECTED_RADIUS, 0, Math.PI * 2);
  }
  ctx.fillStyle = SCATTER_POINT_SELECTED;
  ctx.fill();
  ctx.restore();
}

function bindUplotPointer(session: UplotChartSession): void {
  const over = session.instance?.over;
  if (!over) return;
  let dragOrigin: { x: number; y: number } | undefined;
  const pointer = (event: unknown): { x: number; y: number } | undefined => {
    if (typeof event !== "object" || event === null) return undefined;
    const point = event as { clientX?: unknown; clientY?: unknown };
    if (typeof point.clientX !== "number" || typeof point.clientY !== "number") return undefined;
    return { x: point.clientX, y: point.clientY };
  };
  const onMouseDown = (event: unknown): void => {
    dragOrigin = pointer(event);
    session.brushed = false;
  };
  const onMouseMove = (event: unknown): void => {
    const point = pointer(event);
    if (!dragOrigin || !point) return;
    if (point.x !== dragOrigin.x || point.y !== dragOrigin.y) session.brushed = true;
  };
  const onDoubleClick = (): void => {
    if (session.artifact.kind === "scatter" && session.activeRectangle) paintUplotRectangle(session, session.activeRectangle);
  };
  const onClick = (): void => {
    dragOrigin = undefined;
    if (session.brushed) {
      session.brushed = false;
      return;
    }
    const key = session.instance ? cursorMarkKey(session, session.instance) : undefined;
    if (!key) return;
    session.request.host.emit({
      kind: "mark-select",
      ...uplotEventBase(session.artifact),
      markKeys: [key],
      replace: true,
    });
  };
  over.addEventListener("click", onClick);
  over.addEventListener("mousedown", onMouseDown);
  over.addEventListener("mousemove", onMouseMove);
  over.addEventListener("dblclick", onDoubleClick);
  session.clickRelease = () => {
    over.removeEventListener("click", onClick);
    over.removeEventListener("mousedown", onMouseDown);
    over.removeEventListener("mousemove", onMouseMove);
    over.removeEventListener("dblclick", onDoubleClick);
  };
}

function applyUplotLinkedState(session: UplotChartSession, state: AnalyticsLinkedState): void {
  const instance = session.instance;
  if (!instance) return;
  if (session.artifact.kind === "scatter") {
    const nextKeys = state.selectedMarkKeys.join("\0");
    if (nextKeys !== session.paintedMarkKeys) {
      session.paintedMarkKeys = nextKeys;
      session.highlightedMarkKeys.clear();
      for (const key of state.selectedMarkKeys) session.highlightedMarkKeys.add(key);
      instance.redraw?.();
    }
    const rectangle = JSON.stringify(state.rectangle ?? null);
    if (rectangle === session.paintedRectangle) return;
    session.paintedRectangle = rectangle;
    session.activeRectangle = state.rectangle;
    if (state.rectangle) {
      paintUplotRectangle(session, state.rectangle);
      return;
    }
    instance.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    return;
  }
  const window = state.temporalWindow;
  const range = state.range;
  if (session.artifact.kind === "time-series" && window) {
    paintSelection(instance, Date.parse(window.start) / 1000, Date.parse(window.end) / 1000);
    return;
  }
  if (session.artifact.kind === "histogram" && range) {
    paintSelection(instance, range.min, range.max);
    return;
  }
  instance.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
}

/**
 * Create the µPlot analytics presentation adapter.
 *
 * Supports `time-series`, `histogram` and `scatter` artifacts. Category and aggregate
 * artifacts are declined with `kind-not-supported` so the registry falls back
 * to a truthful presentation instead of misrendering them on a numeric axis.
 */
export function createUplotAnalyticsAdapter(
  adapterOptions: CreateUplotAnalyticsAdapterOptions = {},
): AnalyticsPresentationAdapter {
  return {
    id: UPLOT_ANALYTICS_ADAPTER_ID,
    contractVersion: ANALYTICS_CONTRACT_VERSION,
    kinds: ["time-series", "histogram", "scatter"],
    channels: ["rectangle-brush", "range-brush", "temporal-brush", "hover", "mark-select"],
    library: "uPlot",
    requiresDom: true,

    describeSupport(artifact: AnalyticsArtifact): AnalyticsSupportDecision {
      if (!isSupportedKind(artifact)) {
        return {
          supported: false,
          reason: "kind-not-supported",
          message: `The µPlot adapter renders numeric and temporal axes; "${artifact.kind}" artifacts need a categorical presentation.`,
        };
      }
      if (artifact.status === "unsupported" || artifact.status === "error") {
        return {
          supported: false,
          reason: "artifact-invalid",
          message: `A ${artifact.status} artifact has no marks to plot; present the accessible fallback instead.`,
        };
      }
      return {
        supported: true,
        notes: ["µPlot is an optional peer loaded on mount."],
      };
    },

    async mount(request: AnalyticsMountRequest): Promise<AnalyticsPresentationHandle> {
      let artifact = request.artifact;
      if (!isSupportedKind(artifact)) {
        throw new HonuaAnalyticsError(
          "adapter-unsupported",
          `The µPlot adapter cannot mount a "${artifact.kind}" artifact.`,
          { adapterId: UPLOT_ANALYTICS_ADAPTER_ID, kind: artifact.kind },
        );
      }

      const Uplot = adapterOptions.module ? asConstructor(adapterOptions.module) : await loadUplot(adapterOptions);
      const session: UplotChartSession = {
        request,
        artifact,
        projection: projectAnalyticsArtifactToUplot(artifact, adapterOptions),
        lastHoverKey: undefined,
        paintedRectangle: undefined,
        paintedMarkKeys: "",
        activeRectangle: undefined,
        highlightedMarkKeys: new Set<string>(),
        instance: undefined,
        clickRelease: undefined,
        brushed: false,
        painting: false,
      };

      function restoreRectangle(): void {
        if (session.artifact.kind !== "scatter" || !session.activeRectangle) return;
        paintUplotRectangle(session, session.activeRectangle);
      }

      function build(): void {
        const options: UplotOptions = {
          ...session.projection.options,
          hooks: {
            setSelect: [(self: UplotInstanceLike) => emitUplotBrush(session, self)],
            setCursor: [(self: UplotInstanceLike) => emitUplotHover(session, self)],
            setScale: [restoreRectangle],
            ...(session.artifact.kind === "scatter"
              ? { draw: [(self: UplotInstanceLike) => drawSelectedScatterPoints(session, self)] }
              : {}),
          },
        };
        session.instance = new Uplot(options, session.projection.data, request.target);
        bindUplotPointer(session);
      }

      function teardown(): void {
        session.clickRelease?.();
        session.clickRelease = undefined;
        try {
          session.instance?.destroy();
        } finally {
          session.instance = undefined;
        }
      }

      build();

      return createDisposableHandle({
        adapterId: UPLOT_ANALYTICS_ADAPTER_ID,
        artifact,
        describe: (current) => analyticsTableModel(current, request.locale).description,
        onInvalidate(): void {
          teardown();
        },
        onUpdate(next): void {
          if (!isSupportedKind(next)) {
            request.host.reportWarning?.(
              `The µPlot adapter received a "${next.kind}" artifact and stopped updating; remount with a categorical presentation.`,
              { adapterId: UPLOT_ANALYTICS_ADAPTER_ID },
            );
            teardown();
            return;
          }
          artifact = next;
          session.artifact = next;
          session.projection = projectAnalyticsArtifactToUplot(next, adapterOptions);
          session.lastHoverKey = undefined;
          session.paintedRectangle = undefined;
          session.paintedMarkKeys = "";
          session.activeRectangle = undefined;
          session.highlightedMarkKeys.clear();
          if (session.instance) {
            session.instance.setData(session.projection.data, false);
            return;
          }
          build();
        },
        onLinkedState(state: AnalyticsLinkedState): void {
          applyUplotLinkedState(session, state);
        },
        onDispose: teardown,
        extra: {
          get chart(): UplotInstanceLike | undefined {
            return session.instance;
          },
          get projection(): UplotProjection {
            return session.projection;
          },
        },
      });
    },
  };
}

function paintSelection(instance: UplotInstanceLike, min: number, max: number): void {
  const left = instance.valToPos(min, "x");
  const right = instance.valToPos(max, "x");
  if (!Number.isFinite(left) || !Number.isFinite(right)) return;
  instance.setSelect(
    {
      left: Math.min(left, right),
      top: 0,
      width: Math.abs(right - left),
      height: 0,
    },
    false,
  );
}
