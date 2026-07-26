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
 *   `temporal-brush` / `range-brush` interactions and cursor movement becomes
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
  AnalyticsPresentationAdapter,
  AnalyticsPresentationHandle,
  AnalyticsSupportDecision,
  AnalyticsTimeSeriesArtifact,
} from "../types.js";

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
  readonly select: UplotSelectBox;
  readonly cursor: { readonly idx?: number | null };
  readonly over?: {
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener(type: string, listener: (event: unknown) => void): void;
  };
  setData(data: ReadonlyArray<ReadonlyArray<number | null>>, resetScales?: boolean): void;
  setSelect(box: UplotSelectBox, fireHook?: boolean): void;
  posToVal(position: number, scaleKey: string): number;
  valToPos(value: number, scaleKey: string): number;
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
  readonly points?: { readonly show?: boolean };
  readonly value?: unknown;
}

/** One µPlot scale definition (the subset this adapter emits). */
export interface UplotScaleOptions {
  readonly time?: boolean;
  readonly range?: readonly [number, number];
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
  readonly xUnit: "epoch-seconds" | "bucket-midpoint";
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

/**
 * Project a time-series or histogram artifact into µPlot options and aligned
 * data. Pure and DOM-free, so the whole projection is unit-testable and can be
 * asserted against without a canvas.
 *
 * Time-series x values are epoch **seconds** (µPlot's `scales.x.time`
 * convention). Histogram x values are bin midpoints on a linear scale. Null
 * measures stay `null` so µPlot renders a gap rather than a false zero.
 */
export function projectAnalyticsArtifactToUplot(
  artifact: AnalyticsTimeSeriesArtifact | AnalyticsHistogramArtifact,
  options: UplotProjectionOptions = {},
): UplotProjection {
  const model = analyticsTableModel(artifact, options.locale);
  const isTemporal = artifact.kind === "time-series";
  const xs: number[] = [];
  const ys: Array<number | null> = [];
  const markKeys: string[] = [];

  for (const mark of artifact.marks) {
    if (isTemporal) {
      // Bucket start, in seconds — the same instant the mark key denotes.
      xs.push(Math.floor(Date.parse((mark as AnalyticsTimeSeriesArtifact["marks"][number]).start) / 1000));
    } else {
      const bin = mark as AnalyticsHistogramArtifact["marks"][number];
      xs.push((bin.min + bin.max) / 2);
    }
    ys.push(mark.value);
    markKeys.push(mark.key);
  }

  const measureLabel = artifact.measure.label ?? artifact.measure.field;
  const generated: UplotOptions = {
    title: model.caption,
    width: options.width ?? 640,
    height: options.height ?? 240,
    series: [
      { label: isTemporal ? "Time" : artifact.dimension },
      {
        label: measureLabel,
        stroke: options.stroke ?? "#2563eb",
        width: 2,
        points: { show: artifact.marks.length <= 100 },
      },
    ],
    scales: { x: isTemporal ? { time: true } : { time: false } },
  };

  const { hooks: _ignoredHooks, ...overrides } = options.optionOverrides ?? {};
  return {
    options: { ...generated, ...overrides } as UplotOptions,
    data: [xs, ys],
    markKeys,
    xUnit: isTemporal ? "epoch-seconds" : "bucket-midpoint",
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
): artifact is AnalyticsTimeSeriesArtifact | AnalyticsHistogramArtifact {
  return artifact.kind === "time-series" || artifact.kind === "histogram";
}

/**
 * Create the µPlot analytics presentation adapter.
 *
 * Supports `time-series` and `histogram` artifacts. Category and aggregate
 * artifacts are declined with `kind-not-supported` so the registry falls back
 * to a truthful presentation instead of misrendering them on a numeric axis.
 */
export function createUplotAnalyticsAdapter(
  adapterOptions: CreateUplotAnalyticsAdapterOptions = {},
): AnalyticsPresentationAdapter {
  return {
    id: UPLOT_ANALYTICS_ADAPTER_ID,
    contractVersion: ANALYTICS_CONTRACT_VERSION,
    kinds: ["time-series", "histogram"],
    channels: ["range-brush", "temporal-brush", "hover", "mark-select"],
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
      return { supported: true, notes: ["µPlot is an optional peer loaded on mount."] };
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

      let projection = projectAnalyticsArtifactToUplot(artifact, adapterOptions);
      let lastHoverKey: string | undefined;
      let instance: UplotInstanceLike | undefined;
      let clickRelease: (() => void) | undefined;

      const artifactId = (): string => artifact.identity.artifactId;

      function emitBrush(self: UplotInstanceLike): void {
        const box = self.select;
        if (!box || box.width <= 0) return;
        const from = self.posToVal(box.left, "x");
        const to = self.posToVal(box.left + box.width, "x");
        const min = Math.min(from, to);
        const max = Math.max(from, to);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return;

        if (artifact.kind === "time-series") {
          request.host.emit({
            kind: "temporal-brush",
            adapterId: UPLOT_ANALYTICS_ADAPTER_ID,
            artifactId: artifactId(),
            window: {
              start: new Date(Math.round(min * 1000)).toISOString(),
              end: new Date(Math.round(max * 1000)).toISOString(),
            },
          });
          return;
        }
        request.host.emit({
          kind: "range-brush",
          adapterId: UPLOT_ANALYTICS_ADAPTER_ID,
          artifactId: artifactId(),
          range: { min, max },
        });
      }

      function emitHover(self: UplotInstanceLike): void {
        const index = self.cursor?.idx;
        const key = typeof index === "number" && index >= 0 ? projection.markKeys[index] : undefined;
        if (key === lastHoverKey) return;
        lastHoverKey = key;
        request.host.emit({
          kind: "hover",
          adapterId: UPLOT_ANALYTICS_ADAPTER_ID,
          artifactId: artifactId(),
          ...(key ? { markKey: key } : {}),
        });
      }

      function build(): void {
        const options: UplotOptions = {
          ...projection.options,
          hooks: { setSelect: [emitBrush], setCursor: [emitHover] },
        };
        instance = new Uplot(options, projection.data, request.target);

        const over = instance.over;
        if (over) {
          const onClick = (): void => {
            const index = instance?.cursor?.idx;
            if (typeof index !== "number" || index < 0) return;
            const key = projection.markKeys[index];
            if (!key) return;
            request.host.emit({
              kind: "mark-select",
              adapterId: UPLOT_ANALYTICS_ADAPTER_ID,
              artifactId: artifactId(),
              markKeys: [key],
              replace: true,
            });
          };
          over.addEventListener("click", onClick);
          clickRelease = () => over.removeEventListener("click", onClick);
        }
      }

      function teardown(): void {
        clickRelease?.();
        clickRelease = undefined;
        try {
          instance?.destroy();
        } finally {
          instance = undefined;
        }
      }

      build();

      return createDisposableHandle({
        adapterId: UPLOT_ANALYTICS_ADAPTER_ID,
        artifact,
        describe: (current) => analyticsTableModel(current, request.locale).description,
        onInvalidate(): void {
          // A lineage / plan / shape change invalidates the axes too, so the
          // peer instance is rebuilt rather than patched.
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
          projection = projectAnalyticsArtifactToUplot(next, adapterOptions);
          lastHoverKey = undefined;
          if (instance) {
            // Patch: keep the live instance, swap the data. Focus, cursor, and
            // the user's zoom survive a realtime delta.
            instance.setData(projection.data, false);
            return;
          }
          build();
        },
        onLinkedState(state: AnalyticsLinkedState): void {
          if (!instance) return;
          const window = state.temporalWindow;
          const range = state.range;
          if (artifact.kind === "time-series" && window) {
            paintSelection(instance, Date.parse(window.start) / 1000, Date.parse(window.end) / 1000);
            return;
          }
          if (artifact.kind === "histogram" && range) {
            paintSelection(instance, range.min, range.max);
            return;
          }
          instance.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        },
        onDispose: teardown,
        extra: {
          /** The live µPlot instance, for hosts that need library-specific APIs. */
          get chart(): UplotInstanceLike | undefined {
            return instance;
          },
          get projection(): UplotProjection {
            return projection;
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
  instance.setSelect({ left: Math.min(left, right), top: 0, width: Math.abs(right - left), height: 0 }, false);
}
