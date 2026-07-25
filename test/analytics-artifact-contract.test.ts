import { describe, expect, it } from "vitest";

import {
  ANALYTICS_CONTRACT_VERSION,
  HonuaAnalyticsError,
  MAX_ANALYTICS_MARKS,
  UNBOUNDED,
  acceptAggregateArtifact,
  acceptCategoryArtifact,
  acceptHistogramArtifact,
  acceptTimeSeriesArtifact,
  analyticsArtifactIdentity,
  analyticsMarkByKey,
  analyticsProvenance,
  assertAnalyticsContractVersion,
  resolveAnalyticsStatus,
  resolveAnalyticsUpdateDisposition,
  temporalWindowForMarks,
  unsupportedAnalyticsArtifact,
} from "../src/analytics/index.js";
import type { AnalyticsCategoryMark, AnalyticsMeasure } from "../src/analytics/index.js";

const OBSERVED_AT = "2026-07-25T12:00:00.000Z";

const COUNT: AnalyticsMeasure = { field: "*", fn: "count", label: "Count", unit: "count", unitSystem: "count" };

function identity(overrides: Partial<Parameters<typeof analyticsArtifactIdentity>[0]> = {}) {
  return analyticsArtifactIdentity({
    artifactId: "incidents-by-status",
    sourceId: "incidents",
    planFingerprint: "sha256:abc",
    acceptedAt: OBSERVED_AT,
    ...overrides,
  });
}

function serverProvenance() {
  return analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED });
}

function categoryMarks(): AnalyticsCategoryMark[] {
  return [
    { key: "s:OPEN", label: "Open", value: 42, count: 42, filterValue: "OPEN" },
    { key: "s:CLOSED", label: "Closed", value: 17, count: 17, filterValue: "CLOSED" },
    { key: "null", label: "(no status)", value: null, filterValue: null },
  ];
}

describe("analytics artifact acceptance", () => {
  it("accepts a category artifact and freezes it with the declared contract version", () => {
    const artifact = acceptCategoryArtifact({
      identity: identity(),
      provenance: serverProvenance(),
      measure: COUNT,
      dimension: "status",
      marks: categoryMarks(),
      distinctCount: 3,
    });

    expect(artifact.contractVersion).toBe(ANALYTICS_CONTRACT_VERSION);
    expect(artifact.kind).toBe("category");
    expect(artifact.status).toBe("ready");
    expect(artifact.nullPolicy).toBe("unknown");
    expect(artifact.ordering).toEqual({ by: "value", direction: "desc", tieBreak: "key" });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(analyticsMarkByKey(artifact, "s:CLOSED")?.label).toBe("Closed");
  });

  it("keeps a null measure as null rather than coercing it to zero", () => {
    const artifact = acceptCategoryArtifact({
      identity: identity(),
      provenance: serverProvenance(),
      measure: COUNT,
      dimension: "status",
      marks: categoryMarks(),
      nullPolicy: "separate-bucket",
    });
    expect(analyticsMarkByKey(artifact, "null")?.value).toBeNull();
    expect(artifact.nullPolicy).toBe("separate-bucket");
  });

  it("rejects duplicate mark keys so an interaction can never be ambiguous", () => {
    expect(() =>
      acceptCategoryArtifact({
        identity: identity(),
        provenance: serverProvenance(),
        measure: COUNT,
        dimension: "status",
        marks: [
          { key: "dup", label: "A", value: 2, filterValue: "A" },
          { key: "dup", label: "B", value: 1, filterValue: "B" },
        ],
      }),
    ).toThrowError(expect.objectContaining({ name: "HonuaAnalyticsError", code: "artifact-invalid" }));
  });

  it("rejects marks that break the declared ordering", () => {
    expect(() =>
      acceptCategoryArtifact({
        identity: identity(),
        provenance: serverProvenance(),
        measure: COUNT,
        dimension: "status",
        marks: [
          { key: "a", label: "A", value: 1, filterValue: "A" },
          { key: "b", label: "B", value: 9, filterValue: "B" },
        ],
        ordering: { by: "value", direction: "desc" },
      }),
    ).toThrowError(/breaks it/);
  });

  it("treats null measures as ordering-neutral", () => {
    expect(() =>
      acceptCategoryArtifact({
        identity: identity(),
        provenance: serverProvenance(),
        measure: COUNT,
        dimension: "status",
        marks: [
          { key: "a", label: "A", value: 9, filterValue: "A" },
          { key: "n", label: "N", value: null, filterValue: null },
          { key: "b", label: "B", value: 3, filterValue: "B" },
        ],
      }),
    ).not.toThrow();
  });

  it("enforces the mark ceiling instead of letting a widget become a data transfer", () => {
    const marks = Array.from({ length: MAX_ANALYTICS_MARKS + 1 }, (_unused, index) => ({
      key: `k${index}`,
      label: `k${index}`,
      value: 1,
      filterValue: index,
    }));
    expect(() =>
      acceptCategoryArtifact({
        identity: identity(),
        provenance: serverProvenance(),
        measure: COUNT,
        dimension: "status",
        marks,
        ordering: { by: "explicit", direction: "asc" },
      }),
    ).toThrowError(expect.objectContaining({ code: "row-budget-exceeded" }));
  });

  it("requires a message on unsupported and error artifacts", () => {
    expect(() =>
      acceptAggregateArtifact({
        identity: identity(),
        provenance: serverProvenance(),
        measure: COUNT,
        marks: [],
        status: "unsupported",
      }),
    ).toThrowError(/must carry a message/);
  });

  it("builds an explicit unsupported artifact for every kind", () => {
    for (const kind of ["category", "histogram", "aggregate", "time-series"] as const) {
      const artifact = unsupportedAnalyticsArtifact({
        identity: identity(),
        kind,
        measure: COUNT,
        message: "The source cannot compute this analytic.",
        dimension: "status",
      });
      expect(artifact.kind).toBe(kind);
      expect(artifact.status).toBe("unsupported");
      expect(artifact.marks).toHaveLength(0);
      expect(artifact.message).toMatch(/cannot compute/);
    }
  });

  it("validates histogram bucket monotonicity and bin extents", () => {
    expect(() =>
      acceptHistogramArtifact({
        identity: identity(),
        provenance: serverProvenance(),
        measure: COUNT,
        dimension: "severity",
        bins: 2,
        marks: [
          { key: "b1", label: "1", value: 3, min: 0, max: 10, boundary: "inclusive-exclusive", bucket: 1 },
          { key: "b0", label: "0", value: 4, min: 10, max: 20, boundary: "inclusive-exclusive", bucket: 0 },
        ],
      }),
    ).toThrowError(/strictly increasing/);
  });

  it("rejects overlapping time-series buckets", () => {
    expect(() =>
      acceptTimeSeriesArtifact({
        identity: identity(),
        provenance: serverProvenance(),
        measure: COUNT,
        dimension: "reported_at",
        interval: { unit: "day", step: 1 },
        marks: [
          { key: "d1", label: "Jul 1", value: 2, start: "2026-07-01T00:00:00Z", end: "2026-07-03T00:00:00Z" },
          { key: "d2", label: "Jul 2", value: 4, start: "2026-07-02T00:00:00Z", end: "2026-07-04T00:00:00Z" },
        ],
      }),
    ).toThrowError(/disjoint/);
  });

  it("derives the temporal window from the accepted marks", () => {
    const artifact = acceptTimeSeriesArtifact({
      identity: identity(),
      provenance: serverProvenance(),
      measure: COUNT,
      dimension: "reported_at",
      interval: { unit: "day", step: 1 },
      marks: [
        { key: "d1", label: "Jul 1", value: 2, start: "2026-07-01T00:00:00Z", end: "2026-07-02T00:00:00Z" },
        { key: "d2", label: "Jul 2", value: 4, start: "2026-07-02T00:00:00Z", end: "2026-07-03T00:00:00Z" },
      ],
    });
    expect(artifact.window).toEqual({ start: "2026-07-01T00:00:00Z", end: "2026-07-03T00:00:00Z" });
    expect(temporalWindowForMarks(artifact, ["d2"])).toEqual({
      start: "2026-07-02T00:00:00Z",
      end: "2026-07-03T00:00:00Z",
    });
    expect(temporalWindowForMarks(artifact, ["missing"])).toBeUndefined();
  });
});

describe("analytics status derivation", () => {
  it("reports partial when the producer truncated", () => {
    const provenance = analyticsProvenance({
      computedBy: "client",
      bounds: { truncated: true, rowBudget: 10_000 },
    });
    expect(resolveAnalyticsStatus(provenance, { authority: "live", observedAt: OBSERVED_AT })).toBe("partial");
  });

  it("reports partial when the source degraded the aggregation", () => {
    const provenance = analyticsProvenance({
      computedBy: "server",
      bounds: UNBOUNDED,
      degraded: [{ capability: "queryAggregate", reason: "client-side fallback" }],
    });
    expect(resolveAnalyticsStatus(provenance, { authority: "live", observedAt: OBSERVED_AT })).toBe("partial");
  });

  it("reports stale once the freshness window expired", () => {
    const provenance = serverProvenance();
    const freshness = { authority: "cached" as const, observedAt: OBSERVED_AT, staleAfter: OBSERVED_AT };
    expect(resolveAnalyticsStatus(provenance, freshness, Date.parse(OBSERVED_AT) + 1)).toBe("stale");
    expect(resolveAnalyticsStatus(provenance, freshness, Date.parse(OBSERVED_AT) - 1)).toBe("ready");
  });

  it("never lets a client reduction claim pushdown by default", () => {
    expect(analyticsProvenance({ computedBy: "client" }).pushdown).toBe(false);
    expect(analyticsProvenance({ computedBy: "server" }).pushdown).toBe(true);
    expect(analyticsProvenance({ computedBy: "worker" }).pushdown).toBe(true);
  });
});

describe("resolveAnalyticsUpdateDisposition", () => {
  function artifactAt(sequence: number, overrides: Record<string, unknown> = {}) {
    return acceptCategoryArtifact({
      identity: identity({ sequence, ...overrides }),
      provenance: serverProvenance(),
      measure: COUNT,
      dimension: "status",
      marks: categoryMarks(),
    });
  }

  it("invalidates on the first artifact", () => {
    expect(resolveAnalyticsUpdateDisposition(undefined, artifactAt(0))).toMatchObject({
      disposition: "invalidate",
      reason: "first-artifact",
    });
  });

  it("patches when the sequence advances within one lineage", () => {
    expect(resolveAnalyticsUpdateDisposition(artifactAt(1), artifactAt(2))).toMatchObject({
      disposition: "patch",
      reason: "newer-sequence",
    });
  });

  it("ignores a late delta so numbers never rewind", () => {
    expect(resolveAnalyticsUpdateDisposition(artifactAt(5), artifactAt(4))).toMatchObject({
      disposition: "ignore",
      reason: "stale-sequence",
    });
  });

  it("ignores a re-accept of the identical reference", () => {
    const artifact = artifactAt(3);
    expect(resolveAnalyticsUpdateDisposition(artifact, artifact)).toMatchObject({
      disposition: "ignore",
      reason: "same-sequence",
    });
  });

  it("patches a same-sequence revision (status or freshness change)", () => {
    expect(resolveAnalyticsUpdateDisposition(artifactAt(3), artifactAt(3))).toMatchObject({
      disposition: "patch",
      reason: "same-sequence",
    });
  });

  it("invalidates when the lineage, plan, or shape changes", () => {
    expect(resolveAnalyticsUpdateDisposition(artifactAt(1), artifactAt(2, { artifactId: "other" }))).toMatchObject({
      disposition: "invalidate",
      reason: "lineage-changed",
    });

    expect(
      resolveAnalyticsUpdateDisposition(artifactAt(1), artifactAt(2, { planFingerprint: "sha256:zzz" })),
    ).toMatchObject({ disposition: "invalidate", reason: "plan-changed" });

    const histogram = acceptHistogramArtifact({
      identity: identity({ sequence: 2 }),
      provenance: serverProvenance(),
      measure: COUNT,
      dimension: "status",
      bins: 1,
      marks: [{ key: "b0", label: "0", value: 1, min: 0, max: 1, boundary: "inclusive-exclusive", bucket: 0 }],
    });
    expect(resolveAnalyticsUpdateDisposition(artifactAt(1), histogram)).toMatchObject({
      disposition: "invalidate",
      reason: "shape-changed",
    });
  });
});

describe("assertAnalyticsContractVersion", () => {
  it("accepts a matching major and a newer minor", () => {
    expect(() => assertAnalyticsContractVersion(ANALYTICS_CONTRACT_VERSION, "a")).not.toThrow();
    expect(() => assertAnalyticsContractVersion("1.7", "a")).not.toThrow();
  });

  it("rejects a different major", () => {
    expect(() => assertAnalyticsContractVersion("2.0", "future-adapter")).toThrowError(
      expect.objectContaining({ code: "contract-version-mismatch" }),
    );
  });
});

describe("identity defaults", () => {
  it("defaults freshness to live at the acceptance instant", () => {
    const built = analyticsArtifactIdentity({ artifactId: "a", sourceId: "s", acceptedAt: OBSERVED_AT });
    expect(built).toMatchObject({
      sequence: 0,
      acceptedAt: OBSERVED_AT,
      freshness: { authority: "live", observedAt: OBSERVED_AT },
    });
  });

  it("rejects a non-instant acceptedAt", () => {
    expect(() => analyticsArtifactIdentity({ artifactId: "a", sourceId: "s", acceptedAt: "yesterday" })).toThrowError(
      HonuaAnalyticsError,
    );
  });
});
