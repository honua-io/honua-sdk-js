/**
 * The accessible projection every analytics presentation shares.
 *
 * `analyticsTableModel()` is the renderer-neutral truth: a caption, a status
 * banner, column headers, and one row per mark with a formatted value and an
 * explicit null rendering. The DOM default presentation renders it, a chart
 * adapter uses it for its `accessibleDescription` and its offscreen table
 * equivalent, and an unsupported artifact still produces the same model — so
 * "we cannot chart this" degrades to a truthful table rather than an empty box.
 *
 * @experimental
 * @module
 */

import { createDisposableHandle } from "./handle.js";
import type {
  AnalyticsArtifact,
  AnalyticsArtifactStatus,
  AnalyticsMark,
  AnalyticsMountRequest,
  AnalyticsPresentationAdapter,
  AnalyticsPresentationHandle,
  AnalyticsSupportDecision,
} from "./types.js";
import { ANALYTICS_CONTRACT_VERSION } from "./types.js";

/** One rendered row of the accessible table. */
export interface AnalyticsTableRow {
  readonly key: string;
  readonly label: string;
  /** Formatted value, or the explicit null rendering. */
  readonly value: string;
  /** True when the underlying measure was `null`. */
  readonly isNull: boolean;
  /** `value / max`, clamped to `[0, 1]`. `0` for null measures. */
  readonly fraction: number;
  /** Formatted row count when it differs from the value. */
  readonly count?: string;
  /** Bucket / interval description for histogram and time-series marks. */
  readonly extent?: string;
}

/** The renderer-neutral accessible presentation model. */
export interface AnalyticsTableModel {
  readonly artifactId: string;
  readonly caption: string;
  /** Column headers, in row-field order. */
  readonly columns: readonly string[];
  readonly rows: readonly AnalyticsTableRow[];
  readonly status: AnalyticsArtifactStatus;
  /**
   * One-sentence honesty banner. Empty string only when the artifact is
   * `ready` and complete.
   */
  readonly statusMessage: string;
  /** Provenance sentence a presentation must surface (compute site, freshness). */
  readonly provenanceMessage: string;
  /** Attribution lines that must be displayed verbatim. */
  readonly attribution: readonly string[];
  /** Formatted total, when the artifact carries one. */
  readonly total?: string;
  /** Full text equivalent of the visual encoding. */
  readonly description: string;
}

/** How a null measure is rendered. Never `"0"`. */
export const ANALYTICS_NULL_RENDERING = "no data";

function formatNumber(value: number, measure: AnalyticsArtifact["measure"], locale?: string): string {
  const digits = measure.precision;
  const formatted = new Intl.NumberFormat(locale, {
    ...(digits !== undefined ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : {}),
  }).format(value);
  return measure.unit && measure.unit !== "count" ? `${formatted} ${measure.unit}` : formatted;
}

function extentOf(mark: AnalyticsMark, locale?: string): string | undefined {
  if ("min" in mark && "max" in mark) {
    const closing = mark.boundary === "inclusive" ? "]" : ")";
    return `[${new Intl.NumberFormat(locale).format(mark.min)}, ${new Intl.NumberFormat(locale).format(mark.max)}${closing}`;
  }
  if ("start" in mark && "end" in mark) return `${mark.start} – ${mark.end}`;
  return undefined;
}

function statusMessageFor(artifact: AnalyticsArtifact): string {
  const bounds = artifact.provenance.bounds;
  switch (artifact.status) {
    case "unsupported":
      return artifact.message ?? "This analytic is not supported by the source.";
    case "error":
      return artifact.message ?? "This analytic failed to compute.";
    case "partial": {
      const detail = bounds.truncated
        ? `Only ${artifact.marks.length} of the matching buckets were computed${
            bounds.rowBudget !== undefined ? ` within a ${bounds.rowBudget}-row budget` : ""
          }.`
        : "The source degraded this aggregation.";
      return `Partial results — do not treat these numbers as complete. ${detail}`;
    }
    case "stale":
      return `Stale results — last observed ${artifact.identity.freshness.observedAt}.`;
    default:
      return "";
  }
}

function provenanceMessageFor(artifact: AnalyticsArtifact): string {
  const { computedBy, pushdown, bounds } = artifact.provenance;
  const where =
    computedBy === "server"
      ? pushdown
        ? "aggregated by the source"
        : "returned by the source without pushdown"
      : computedBy === "worker"
        ? "aggregated in a worker"
        : `reduced in the browser${bounds.rowBudget !== undefined ? ` from at most ${bounds.rowBudget} rows` : ""}`;
  return `${artifact.marks.length} ${artifact.marks.length === 1 ? "bucket" : "buckets"} ${where}; freshness ${artifact.identity.freshness.authority}, observed ${artifact.identity.freshness.observedAt}.`;
}

/**
 * Project an artifact into its accessible table model. Pure: safe to call on
 * every render and in a non-DOM environment.
 */
export function analyticsTableModel(artifact: AnalyticsArtifact, locale?: string): AnalyticsTableModel {
  const marks = artifact.marks as readonly AnalyticsMark[];
  const values = marks.map((mark) => mark.value).filter((value): value is number => value !== null);
  const max = values.length > 0 ? Math.max(...values.map((value) => Math.abs(value))) : 0;

  const rows: AnalyticsTableRow[] = marks.map((mark) => {
    const isNull = mark.value === null;
    const measure = "measure" in mark ? mark.measure : artifact.measure;
    return {
      key: mark.key,
      label: mark.label,
      value: isNull ? ANALYTICS_NULL_RENDERING : formatNumber(mark.value as number, measure, locale),
      isNull,
      fraction: isNull || max === 0 ? 0 : Math.min(1, Math.abs(mark.value as number) / max),
      ...(mark.count !== undefined && mark.count !== mark.value
        ? { count: new Intl.NumberFormat(locale).format(mark.count) }
        : {}),
      ...(extentOf(mark, locale) ? { extent: extentOf(mark, locale) as string } : {}),
    };
  });

  const dimensionLabel =
    artifact.kind === "aggregate" ? "Measure" : artifact.kind === "time-series" ? "Interval" : artifact.dimension;
  const columns =
    artifact.kind === "aggregate"
      ? [dimensionLabel, artifact.measure.label ?? "Value"]
      : [dimensionLabel, artifact.measure.label ?? artifact.measure.field, "Range"];

  const caption = artifact.title ?? defaultCaption(artifact);
  const statusMessage = statusMessageFor(artifact);
  const provenanceMessage = provenanceMessageFor(artifact);

  const description = [
    caption,
    statusMessage,
    provenanceMessage,
    rows.length === 0
      ? "No buckets."
      : rows.map((row) => `${row.label}: ${row.value}${row.extent ? ` (${row.extent})` : ""}`).join("; "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  return {
    artifactId: artifact.identity.artifactId,
    caption,
    columns,
    rows,
    status: artifact.status,
    statusMessage,
    provenanceMessage,
    attribution: artifact.provenance.attribution ?? [],
    ...(artifact.total !== undefined && artifact.total !== null
      ? { total: formatNumber(artifact.total, artifact.measure, locale) }
      : {}),
    description,
  };
}

function defaultCaption(artifact: AnalyticsArtifact): string {
  switch (artifact.kind) {
    case "category":
      return `${artifact.measure.label ?? artifact.measure.field} by ${artifact.dimension}`;
    case "histogram":
      return `Distribution of ${artifact.dimension}`;
    case "time-series":
      return `${artifact.measure.label ?? artifact.measure.field} over ${artifact.dimension}`;
    default:
      return artifact.measure.label ?? "Summary";
  }
}

/**
 * The always-available headless adapter.
 *
 * It supports every artifact kind and every status, requires no DOM, and emits
 * no interactions. `resolveAnalyticsPresentation()` falls back to it whenever
 * no registered chart adapter can honestly present an artifact, which is how
 * an unsupported visualization request still produces a truthful, inspectable
 * result.
 */
export function createAccessibleTableAdapter(): AnalyticsPresentationAdapter {
  return {
    id: "honua.accessible-table",
    contractVersion: ANALYTICS_CONTRACT_VERSION,
    kinds: ["category", "histogram", "aggregate", "time-series"],
    channels: [],
    library: undefined,
    requiresDom: false,
    describeSupport(): AnalyticsSupportDecision {
      return { supported: true, notes: ["Text-only fallback; no interactions."] };
    },
    mount(request: AnalyticsMountRequest): AnalyticsPresentationHandle {
      let model = analyticsTableModel(request.artifact, request.locale);
      return createDisposableHandle({
        adapterId: "honua.accessible-table",
        artifact: request.artifact,
        describe: () => model.description,
        onUpdate(next) {
          model = analyticsTableModel(next, request.locale);
        },
        onDispose() {
          /* no resources held */
        },
        /** Exposed so a host can render the table without recomputing it. */
        extra: {
          get model(): AnalyticsTableModel {
            return model;
          },
        },
      });
    },
  };
}

/**
 * The table model a mounted accessible-table handle currently renders.
 * Returns `undefined` for handles from other adapters.
 */
export function analyticsTableModelOf(handle: AnalyticsPresentationHandle): AnalyticsTableModel | undefined {
  const candidate = (handle as { model?: AnalyticsTableModel }).model;
  return candidate && typeof candidate === "object" && "rows" in candidate ? candidate : undefined;
}
