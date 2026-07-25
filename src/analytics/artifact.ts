/**
 * Accepting, validating, and re-accepting analytics artifacts.
 *
 * The host accepts an artifact exactly once per update and shares that frozen
 * value with every linked presentation. Nothing in this module caches: the
 * accept functions are pure projections from an already-fetched widget /
 * aggregate result plus caller-supplied identity.
 *
 * @experimental
 * @module
 */

import type { AggregationTimeIntervalSpec } from "../contract/types.js";
import { ANALYTICS_CONTRACT_VERSION, HonuaAnalyticsError } from "./types.js";
import type {
  AnalyticsAggregateArtifact,
  AnalyticsAggregateMark,
  AnalyticsArtifact,
  AnalyticsArtifactIdentity,
  AnalyticsArtifactKind,
  AnalyticsArtifactStatus,
  AnalyticsBounds,
  AnalyticsCategoryArtifact,
  AnalyticsCategoryMark,
  AnalyticsComputeSite,
  AnalyticsDegradation,
  AnalyticsFreshnessState,
  AnalyticsHistogramArtifact,
  AnalyticsHistogramMark,
  AnalyticsMark,
  AnalyticsMeasure,
  AnalyticsNullPolicy,
  AnalyticsOrdering,
  AnalyticsProvenance,
  AnalyticsTemporalWindow,
  AnalyticsTimeSeriesArtifact,
  AnalyticsTimeSeriesMark,
  AnalyticsUpdateDecision,
  HonuaAnalyticsErrorCode,
} from "./types.js";

/** Default ordering for category artifacts: descending value, key tie-break. */
export const DEFAULT_CATEGORY_ORDERING: AnalyticsOrdering = Object.freeze({
  by: "value",
  direction: "desc",
  tieBreak: "key",
} as const);

/** Bucket order is the only honest order for histograms and time series. */
export const DEFAULT_BUCKET_ORDERING: AnalyticsOrdering = Object.freeze({
  by: "bucket",
  direction: "asc",
} as const);

/** Chronological order for time-series artifacts. */
export const DEFAULT_TIME_ORDERING: AnalyticsOrdering = Object.freeze({
  by: "time",
  direction: "asc",
} as const);

/** Empty, un-truncated bounds. */
export const UNBOUNDED: AnalyticsBounds = Object.freeze({ truncated: false } as const);

/**
 * Ceiling on marks a single artifact may carry. A presentation seam is not a
 * data-transfer channel: a widget that needs more rows than this is asking for
 * a table or a tile, not a chart.
 */
export const MAX_ANALYTICS_MARKS = 2_000;

// ── Guards ────────────────────────────────────────────────────

function fail(code: HonuaAnalyticsErrorCode, message: string, detail?: Readonly<Record<string, unknown>>): never {
  throw new HonuaAnalyticsError(code, message, detail);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("artifact-invalid", `${path} must be a non-empty string.`, { path });
  }
  return value;
}

/**
 * Dimension fields are required for real artifacts, but an `unsupported` or
 * `error` artifact may legitimately not know which field it would have grouped
 * by — the request never reached a plan.
 */
function requireDimension(value: unknown, status: AnalyticsArtifactStatus | undefined): string {
  if ((status === "unsupported" || status === "error") && (value === undefined || value === "")) return "";
  return requireString(value, "dimension");
}

function requireInstant(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    fail("artifact-invalid", `${path} must be an RFC-3339 / ISO-8601 instant.`, { path, value: text });
  }
  return text;
}

function requireFiniteOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("artifact-invalid", `${path} must be a finite number or null.`, { path });
  }
  return value;
}

/**
 * Assert that an adapter was written against a compatible contract version.
 * Major versions must match exactly; a newer minor on either side is accepted
 * because the contract only ever adds optional fields within a major.
 */
export function assertAnalyticsContractVersion(adapterVersion: string, adapterId: string): void {
  const [adapterMajor] = adapterVersion.split(".");
  const [contractMajor] = ANALYTICS_CONTRACT_VERSION.split(".");
  if (adapterMajor !== contractMajor) {
    fail(
      "contract-version-mismatch",
      `Adapter "${adapterId}" targets analytics contract ${adapterVersion}, which is incompatible with ${ANALYTICS_CONTRACT_VERSION}.`,
      { adapterId, adapterVersion, contractVersion: ANALYTICS_CONTRACT_VERSION },
    );
  }
}

/**
 * Validate an artifact's invariants and return it frozen. Called by every
 * accept function; call it directly when constructing an artifact by hand.
 *
 * Enforced: contract version, identity shape, unique mark keys, the mark
 * ceiling, `message` presence for `unsupported` / `error`, declared ordering
 * actually holding, and histogram/time-series bucket monotonicity.
 */
export function validateAnalyticsArtifact<T extends AnalyticsArtifact>(artifact: T): T {
  if (artifact.contractVersion !== ANALYTICS_CONTRACT_VERSION) {
    fail("contract-version-mismatch", `Artifact declares contract version ${artifact.contractVersion}.`, {
      contractVersion: artifact.contractVersion,
      expected: ANALYTICS_CONTRACT_VERSION,
    });
  }

  const identity = artifact.identity;
  requireString(identity?.artifactId, "identity.artifactId");
  requireString(identity?.sourceId, "identity.sourceId");
  requireInstant(identity?.acceptedAt, "identity.acceptedAt");
  requireInstant(identity?.freshness?.observedAt, "identity.freshness.observedAt");
  if (!Number.isSafeInteger(identity.sequence) || identity.sequence < 0) {
    fail("artifact-invalid", "identity.sequence must be a non-negative safe integer.", {
      sequence: identity.sequence,
    });
  }

  if ((artifact.status === "unsupported" || artifact.status === "error") && !artifact.message) {
    fail("artifact-invalid", `A ${artifact.status} artifact must carry a message explaining why.`, {
      status: artifact.status,
    });
  }

  const marks: readonly AnalyticsMark[] = artifact.marks;
  if (!Array.isArray(marks)) fail("artifact-invalid", "artifact.marks must be an array.");
  if (marks.length > MAX_ANALYTICS_MARKS) {
    fail(
      "row-budget-exceeded",
      `An analytics artifact may carry at most ${MAX_ANALYTICS_MARKS} marks; received ${marks.length}. Aggregate further or bind a table instead.`,
      { marks: marks.length, ceiling: MAX_ANALYTICS_MARKS },
    );
  }

  const keys = new Set<string>();
  for (const [index, mark] of marks.entries()) {
    requireString(mark.key, `marks[${index}].key`);
    requireString(mark.label, `marks[${index}].label`);
    requireFiniteOrNull(mark.value, `marks[${index}].value`);
    if (keys.has(mark.key)) {
      fail("artifact-invalid", `Duplicate mark key "${mark.key}" at marks[${index}].`, { key: mark.key, index });
    }
    keys.add(mark.key);
  }

  if (artifact.kind === "histogram") {
    validateHistogramMarks(artifact.marks);
  } else if (artifact.kind === "time-series") {
    validateTimeSeriesMarks(artifact.marks);
  }

  assertOrdering(artifact);
  return Object.freeze(artifact);
}

function validateHistogramMarks(marks: readonly AnalyticsHistogramMark[]): void {
  let previousBucket = -1;
  for (const [index, mark] of marks.entries()) {
    if (!Number.isFinite(mark.min) || !Number.isFinite(mark.max) || mark.max < mark.min) {
      fail("artifact-invalid", `marks[${index}] must declare a finite [min, max] with max >= min.`, { index });
    }
    if (!Number.isSafeInteger(mark.bucket) || mark.bucket <= previousBucket) {
      fail("artifact-invalid", `marks[${index}].bucket must be a strictly increasing safe integer.`, {
        index,
        bucket: mark.bucket,
      });
    }
    previousBucket = mark.bucket;
  }
}

function validateTimeSeriesMarks(marks: readonly AnalyticsTimeSeriesMark[]): void {
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const [index, mark] of marks.entries()) {
    const start = Date.parse(requireInstant(mark.start, `marks[${index}].start`));
    const end = Date.parse(requireInstant(mark.end, `marks[${index}].end`));
    if (end <= start) {
      fail("artifact-invalid", `marks[${index}] must be a half-open interval with end > start.`, { index });
    }
    if (start < previousEnd) {
      fail("artifact-invalid", `marks[${index}] overlaps the previous bucket; time-series buckets must be disjoint.`, {
        index,
      });
    }
    previousEnd = end;
  }
}

function assertOrdering(artifact: AnalyticsArtifact): void {
  const { by, direction } = artifact.ordering;
  if (by === "explicit") return;
  const sign = direction === "asc" ? 1 : -1;
  const keyOf = (mark: AnalyticsMark): number | string | null => {
    switch (by) {
      case "value":
        return mark.value;
      case "label":
        return mark.label;
      case "bucket":
        return "bucket" in mark ? mark.bucket : null;
      case "time":
        return "start" in mark ? Date.parse(mark.start) : null;
      default:
        return null;
    }
  };

  let previous: number | string | null | undefined;
  for (const [index, mark] of (artifact.marks as readonly AnalyticsMark[]).entries()) {
    const current = keyOf(mark);
    // Nulls are ordering-neutral: a `null` measure has no position on the axis.
    if (current === null) continue;
    if (previous !== undefined && previous !== null) {
      const ordered =
        typeof current === "string" && typeof previous === "string"
          ? sign * previous.localeCompare(current) <= 0
          : sign * ((previous as number) - (current as number)) <= 0;
      if (!ordered) {
        fail(
          "artifact-invalid",
          `Artifact declares ordering ${by}/${direction} but marks[${index}] breaks it. Sort once at accept time so every linked presentation shows the same order.`,
          { index, by, direction },
        );
      }
    }
    previous = current;
  }
}

// ── Identity + update disposition ─────────────────────────────

/** Options for {@link analyticsArtifactIdentity}. */
export interface AnalyticsIdentityInput {
  readonly artifactId: string;
  readonly sourceId: string;
  readonly planId?: string;
  readonly planFingerprint?: string;
  readonly sourceVersion?: string;
  readonly cacheKey?: string;
  /** @default 0 */
  readonly sequence?: number;
  /** @default `new Date().toISOString()` */
  readonly acceptedAt?: string;
  /** @default `{ authority: "live", observedAt: acceptedAt }` */
  readonly freshness?: Partial<AnalyticsFreshnessState>;
}

/** Build a validated {@link AnalyticsArtifactIdentity} with sensible defaults. */
export function analyticsArtifactIdentity(input: AnalyticsIdentityInput): AnalyticsArtifactIdentity {
  const acceptedAt = input.acceptedAt ?? new Date().toISOString();
  const freshness: AnalyticsFreshnessState = {
    authority: input.freshness?.authority ?? "live",
    observedAt: input.freshness?.observedAt ?? acceptedAt,
    ...(input.freshness?.staleAfter ? { staleAfter: input.freshness.staleAfter } : {}),
    ...(input.freshness?.validator ? { validator: input.freshness.validator } : {}),
    ...(input.freshness?.generation ? { generation: input.freshness.generation } : {}),
  };
  return Object.freeze({
    artifactId: requireString(input.artifactId, "identity.artifactId"),
    sourceId: requireString(input.sourceId, "identity.sourceId"),
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.planFingerprint ? { planFingerprint: input.planFingerprint } : {}),
    ...(input.sourceVersion ? { sourceVersion: input.sourceVersion } : {}),
    ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
    sequence: input.sequence ?? 0,
    acceptedAt: requireInstant(acceptedAt, "identity.acceptedAt"),
    freshness: Object.freeze(freshness),
  });
}

function dimensionOf(artifact: AnalyticsArtifact): string | undefined {
  return artifact.kind === "aggregate" ? undefined : artifact.dimension;
}

/**
 * Decide whether a newly accepted artifact should patch a presentation in
 * place, force a rebuild, or be ignored as a late/duplicate delta.
 *
 * This is the single place the "do deltas patch or invalidate the view?"
 * question is answered, so the default presentation and every third-party
 * adapter reach the same conclusion for the same pair of artifacts.
 */
export function resolveAnalyticsUpdateDisposition(
  previous: AnalyticsArtifact | undefined,
  next: AnalyticsArtifact,
): AnalyticsUpdateDecision {
  if (previous === undefined) {
    return {
      disposition: "invalidate",
      reason: "first-artifact",
      message: "No artifact was mounted; build the presentation.",
    };
  }

  if (
    previous.identity.artifactId !== next.identity.artifactId ||
    previous.identity.sourceId !== next.identity.sourceId
  ) {
    return {
      disposition: "invalidate",
      reason: "lineage-changed",
      message: "The artifact lineage changed; the previous presentation cannot be patched.",
    };
  }

  if (previous.kind !== next.kind || dimensionOf(previous) !== dimensionOf(next)) {
    return {
      disposition: "invalidate",
      reason: "shape-changed",
      message: "The artifact kind or dimension changed; rebuild the presentation.",
    };
  }

  if ((previous.identity.planFingerprint ?? "") !== (next.identity.planFingerprint ?? "")) {
    return {
      disposition: "invalidate",
      reason: "plan-changed",
      message: "The producing query plan changed; previous marks are not comparable.",
    };
  }

  if (next.identity.sequence < previous.identity.sequence) {
    return {
      disposition: "ignore",
      reason: "stale-sequence",
      message: `Sequence ${next.identity.sequence} is older than the mounted ${previous.identity.sequence}; the late delta is dropped.`,
    };
  }

  if (next.identity.sequence === previous.identity.sequence) {
    if (next === previous) {
      return {
        disposition: "ignore",
        reason: "same-sequence",
        message: "The same artifact reference was re-accepted.",
      };
    }
    return {
      disposition: "patch",
      reason: "same-sequence",
      message: "Same sequence with a new value (status or freshness revision); patch in place.",
    };
  }

  return {
    disposition: "patch",
    reason: "newer-sequence",
    message: `Sequence advanced to ${next.identity.sequence}; patch marks in place and preserve focus.`,
  };
}

// ── Provenance helpers ────────────────────────────────────────

/** Options for {@link analyticsProvenance}. */
export interface AnalyticsProvenanceInput {
  readonly computedBy: AnalyticsComputeSite;
  /** @default `computedBy !== "client"` */
  readonly pushdown?: boolean;
  readonly bounds?: Partial<AnalyticsBounds>;
  readonly degraded?: readonly AnalyticsDegradation[];
  readonly attribution?: readonly string[];
  readonly notes?: readonly string[];
}

/**
 * Build a provenance record. `pushdown` defaults to `computedBy !== "client"`
 * so a client-side reduction can never accidentally claim server pushdown.
 */
export function analyticsProvenance(input: AnalyticsProvenanceInput): AnalyticsProvenance {
  const bounds: AnalyticsBounds = Object.freeze({
    truncated: input.bounds?.truncated ?? false,
    ...(input.bounds?.rowBudget !== undefined ? { rowBudget: input.bounds.rowBudget } : {}),
    ...(input.bounds?.scannedRowCount !== undefined ? { scannedRowCount: input.bounds.scannedRowCount } : {}),
    ...(input.bounds?.transferredRowCount !== undefined
      ? { transferredRowCount: input.bounds.transferredRowCount }
      : {}),
    ...(input.bounds?.omittedMarkCount !== undefined ? { omittedMarkCount: input.bounds.omittedMarkCount } : {}),
  });
  return Object.freeze({
    computedBy: input.computedBy,
    pushdown: input.pushdown ?? input.computedBy !== "client",
    bounds,
    ...(input.degraded?.length ? { degraded: Object.freeze([...input.degraded]) } : {}),
    ...(input.attribution?.length ? { attribution: Object.freeze([...input.attribution]) } : {}),
    ...(input.notes?.length ? { notes: Object.freeze([...input.notes]) } : {}),
  });
}

/**
 * Derive the honest status of an artifact from its provenance and freshness.
 * `partial` wins over `stale` because an incomplete number is the more
 * dangerous claim.
 */
export function resolveAnalyticsStatus(
  provenance: AnalyticsProvenance,
  freshness: AnalyticsFreshnessState,
  now: number = Date.now(),
): AnalyticsArtifactStatus {
  if (provenance.bounds.truncated) return "partial";
  if (provenance.degraded && provenance.degraded.length > 0) return "partial";
  if (freshness.authority === "stale") return "stale";
  if (freshness.staleAfter !== undefined && Date.parse(freshness.staleAfter) <= now) return "stale";
  return "ready";
}

// ── Accept: category ──────────────────────────────────────────

/** Shared accept options. */
export interface AcceptAnalyticsOptions {
  readonly identity: AnalyticsArtifactIdentity;
  readonly provenance: AnalyticsProvenance;
  readonly measure: AnalyticsMeasure;
  readonly title?: string;
  readonly nullPolicy?: AnalyticsNullPolicy;
  readonly ordering?: AnalyticsOrdering;
  readonly status?: AnalyticsArtifactStatus;
  readonly message?: string;
  readonly total?: number | null;
  /** Clock injection for status derivation and tests. */
  readonly now?: number;
}

function baseFields(options: AcceptAnalyticsOptions, defaultOrdering: AnalyticsOrdering) {
  return {
    contractVersion: ANALYTICS_CONTRACT_VERSION,
    identity: options.identity,
    provenance: options.provenance,
    status: options.status ?? resolveAnalyticsStatus(options.provenance, options.identity.freshness, options.now),
    ...(options.title ? { title: options.title } : {}),
    ...(options.message ? { message: options.message } : {}),
    nullPolicy: options.nullPolicy ?? "unknown",
    ordering: options.ordering ?? defaultOrdering,
    measure: options.measure,
    ...(options.total !== undefined ? { total: options.total } : {}),
  } as const;
}

/** Accept a category / group-by distribution. */
export function acceptCategoryArtifact(
  options: AcceptAnalyticsOptions & {
    readonly dimension: string;
    readonly marks: readonly AnalyticsCategoryMark[];
    readonly distinctCount?: number;
  },
): AnalyticsCategoryArtifact {
  return validateAnalyticsArtifact({
    ...baseFields(options, DEFAULT_CATEGORY_ORDERING),
    kind: "category",
    dimension: requireDimension(options.dimension, options.status),
    marks: Object.freeze([...options.marks]),
    ...(options.distinctCount !== undefined ? { distinctCount: options.distinctCount } : {}),
  });
}

/** Accept a binned distribution over a numeric field. */
export function acceptHistogramArtifact(
  options: AcceptAnalyticsOptions & {
    readonly dimension: string;
    readonly marks: readonly AnalyticsHistogramMark[];
    readonly bins: number;
    readonly domain?: { readonly min: number; readonly max: number };
  },
): AnalyticsHistogramArtifact {
  return validateAnalyticsArtifact({
    ...baseFields(options, DEFAULT_BUCKET_ORDERING),
    kind: "histogram",
    dimension: requireDimension(options.dimension, options.status),
    marks: Object.freeze([...options.marks]),
    bins: options.bins,
    ...(options.domain ? { domain: Object.freeze({ ...options.domain }) } : {}),
  });
}

/** Accept a bucketed temporal series. */
export function acceptTimeSeriesArtifact(
  options: AcceptAnalyticsOptions & {
    readonly dimension: string;
    readonly marks: readonly AnalyticsTimeSeriesMark[];
    readonly interval: AggregationTimeIntervalSpec;
    readonly window?: AnalyticsTemporalWindow;
  },
): AnalyticsTimeSeriesArtifact {
  const marks = Object.freeze([...options.marks]);
  const window =
    options.window ?? (marks.length > 0 ? { start: marks[0].start, end: marks[marks.length - 1].end } : undefined);
  return validateAnalyticsArtifact({
    ...baseFields(options, DEFAULT_TIME_ORDERING),
    kind: "time-series",
    dimension: requireDimension(options.dimension, options.status),
    marks,
    interval: options.interval,
    ...(window ? { window: Object.freeze({ ...window }) } : {}),
  });
}

/** Accept one or more scalar aggregates. */
export function acceptAggregateArtifact(
  options: AcceptAnalyticsOptions & { readonly marks: readonly AnalyticsAggregateMark[] },
): AnalyticsAggregateArtifact {
  return validateAnalyticsArtifact({
    ...baseFields(options, { by: "explicit", direction: "asc" }),
    kind: "aggregate",
    marks: Object.freeze([...options.marks]),
  });
}

/**
 * Build an explicit `unsupported` artifact. The presentation layer renders
 * this as a truthful "cannot be charted" state instead of an empty chart.
 */
export function unsupportedAnalyticsArtifact(options: {
  readonly identity: AnalyticsArtifactIdentity;
  readonly kind: AnalyticsArtifactKind;
  readonly measure: AnalyticsMeasure;
  readonly message: string;
  readonly dimension?: string;
  readonly title?: string;
  readonly provenance?: AnalyticsProvenance;
}): AnalyticsArtifact {
  const provenance =
    options.provenance ?? analyticsProvenance({ computedBy: "server", pushdown: false, bounds: UNBOUNDED });
  const shared = {
    identity: options.identity,
    provenance,
    measure: options.measure,
    status: "unsupported" as const,
    message: options.message,
    ...(options.title ? { title: options.title } : {}),
  };
  const dimension = options.dimension ?? "";
  switch (options.kind) {
    case "category":
      return acceptCategoryArtifact({ ...shared, dimension, marks: [] });
    case "histogram":
      return acceptHistogramArtifact({ ...shared, dimension, marks: [], bins: 0 });
    case "time-series":
      return acceptTimeSeriesArtifact({
        ...shared,
        dimension,
        marks: [],
        interval: { unit: "day", step: 1 },
      });
    default:
      return acceptAggregateArtifact({ ...shared, marks: [] });
  }
}

// ── Mark lookup ───────────────────────────────────────────────

/** Find a mark by its stable interaction key. */
export function analyticsMarkByKey(artifact: AnalyticsArtifact, key: string): AnalyticsMark | undefined {
  return (artifact.marks as readonly AnalyticsMark[]).find((mark) => mark.key === key);
}

/**
 * Resolve the half-open temporal window covered by a set of time-series mark
 * keys. Returns `undefined` when no key matches, so a caller can distinguish
 * "cleared" from "empty selection".
 */
export function temporalWindowForMarks(
  artifact: AnalyticsTimeSeriesArtifact,
  markKeys: readonly string[],
): AnalyticsTemporalWindow | undefined {
  const selected = artifact.marks.filter((mark) => markKeys.includes(mark.key));
  if (selected.length === 0) return undefined;
  let start = selected[0].start;
  let end = selected[0].end;
  for (const mark of selected) {
    if (Date.parse(mark.start) < Date.parse(start)) start = mark.start;
    if (Date.parse(mark.end) > Date.parse(end)) end = mark.end;
  }
  return { start, end };
}
