import { describe, expect, it } from "vitest";

import {
  acceptWidgetAggregateArtifact,
  acceptWidgetCategoriesArtifact,
  acceptWidgetHistogramArtifact,
  acceptWidgetTimeSeriesArtifact,
  analyticsTableModel,
  assertAnalyticsPushdown,
  categoryMarkKey,
} from "../src/analytics/index.js";
import type { Query, Result, Source } from "../src/contract/types.js";
import { createWidgetSource } from "../src/contract/widget-source.js";

const ACCEPTED_AT = "2026-07-25T12:00:00.000Z";

/**
 * A minimal in-memory `Source` that answers `queryAggregate` natively (the
 * server-pushdown path) or refuses it (forcing the widget source's bounded
 * client fallback).
 */
function memorySource(options: {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly aggregate?: (query: Query) => ReadonlyArray<Record<string, unknown>>;
  readonly exceededTransferLimit?: boolean;
  readonly sourceId?: string;
}): Source {
  const features = options.rows.map((attributes, index) => ({ id: index, attributes }));
  const capabilities = new Set<string>(["query", "pagination", ...(options.aggregate ? ["queryAggregate"] : [])]);
  const source = {
    descriptor: {
      id: options.sourceId ?? "incidents",
      protocol: "geoservices" as const,
      locator: { url: "https://example.test/FeatureServer/0" },
      capabilities,
    },
    capabilities,
    async query(): Promise<Result> {
      return { features, exceededTransferLimit: options.exceededTransferLimit ?? false };
    },
    async queryAll(): Promise<Result> {
      return { features, exceededTransferLimit: options.exceededTransferLimit ?? false };
    },
    async queryAggregate(query: Query): Promise<Result> {
      if (!options.aggregate) throw new Error("queryAggregate is not supported by this source");
      return { features: [], exceededTransferLimit: false, aggregateRows: options.aggregate(query) };
    },
    supports(capability: string): boolean {
      return capabilities.has(capability);
    },
    protocol(): undefined {
      return undefined;
    },
  };
  return source as unknown as Source;
}

describe("categoryMarkKey", () => {
  it("tags the value type so a string and a number never collide", () => {
    expect(categoryMarkKey("1", 0)).toBe("s:1");
    expect(categoryMarkKey(1, 0)).toBe("n:1");
    expect(categoryMarkKey(true, 0)).toBe("b:true");
    expect(categoryMarkKey(null, 0)).toBe("null");
    expect(categoryMarkKey({ nested: true }, 7)).toBe("i:7");
  });
});

describe("accepting a pushed-down widget response", () => {
  it("records server provenance and the widget cache key as artifact identity", async () => {
    const source = memorySource({
      rows: [],
      aggregate: () => [
        { status: "OPEN", count: 42 },
        { status: "CLOSED", count: 17 },
      ],
    });
    const widgets = createWidgetSource(source);
    const response = await widgets.categories({ field: "status" });
    expect(response.serverPushdown).toBe(true);

    const artifact = acceptWidgetCategoriesArtifact(response, {
      artifactId: "incidents-by-status",
      acceptedAt: ACCEPTED_AT,
      title: "Incidents by status",
    });

    expect(artifact.kind).toBe("category");
    expect(artifact.status).toBe("ready");
    expect(artifact.dimension).toBe("status");
    expect(artifact.identity.cacheKey).toBe(response.cache.cacheKey);
    expect(artifact.identity.sourceId).toBe("incidents");
    expect(artifact.provenance).toMatchObject({
      computedBy: "server",
      pushdown: true,
      bounds: { truncated: false, transferredRowCount: 2 },
    });
    expect(artifact.marks.map((mark) => [mark.key, mark.value])).toEqual([
      ["s:OPEN", 42],
      ["s:CLOSED", 17],
    ]);
    expect(() => assertAnalyticsPushdown(artifact.provenance)).not.toThrow();
  });

  it("marks a bounded client fallback partial and refuses the pushdown assertion", async () => {
    const source = memorySource({
      rows: Array.from({ length: 12 }, (_unused, index) => ({ status: index % 2 === 0 ? "OPEN" : "CLOSED" })),
      exceededTransferLimit: true,
    });
    const widgets = createWidgetSource(source, { maxClientRows: 10 });
    const response = await widgets.categories({ field: "status" });
    expect(response.serverPushdown).toBe(false);

    const artifact = acceptWidgetCategoriesArtifact(response, {
      artifactId: "incidents-by-status",
      acceptedAt: ACCEPTED_AT,
      rowBudget: 10,
    });

    expect(artifact.status).toBe("partial");
    expect(artifact.provenance).toMatchObject({
      computedBy: "client",
      pushdown: false,
      bounds: { truncated: true, rowBudget: 10 },
    });
    expect(artifact.provenance.notes).toContain(
      "Marks are incomplete: the widget source bounded its client-side scan.",
    );
    expect(() => assertAnalyticsPushdown(artifact.provenance, "The status widget")).toThrowError(
      expect.objectContaining({ code: "pushdown-required" }),
    );

    // The truthful accessible projection says so out loud.
    const model = analyticsTableModel(artifact);
    expect(model.statusMessage).toMatch(/Partial results/);
    expect(model.provenanceMessage).toMatch(/reduced in the browser from at most 10 rows/);
  });

  it("derives staleAfter from the widget cache TTL", async () => {
    const source = memorySource({ rows: [], aggregate: () => [{ status: "OPEN", count: 1 }] });
    const widgets = createWidgetSource(source, { ttlMs: 60_000 });
    const response = await widgets.categories({ field: "status" });

    const artifact = acceptWidgetCategoriesArtifact(response, {
      artifactId: "a",
      acceptedAt: ACCEPTED_AT,
      observedAt: ACCEPTED_AT,
    });
    expect(artifact.identity.freshness.staleAfter).toBe("2026-07-25T12:01:00.000Z");
  });
});

describe("accepting histogram, time-series, and aggregate widget responses", () => {
  it("accepts a histogram with monotonic buckets and a numeric domain", async () => {
    const source = memorySource({
      rows: [{ severity: 1 }, { severity: 4 }, { severity: 9 }, { severity: 12 }],
    });
    const widgets = createWidgetSource(source);
    const response = await widgets.histogram({ field: "severity", bins: 3 });

    const artifact = acceptWidgetHistogramArtifact(response, { artifactId: "sev", acceptedAt: ACCEPTED_AT });
    expect(artifact.kind).toBe("histogram");
    expect(artifact.marks.map((mark) => mark.bucket)).toEqual([0, 1, 2]);
    expect(artifact.marks.every((mark) => mark.boundary === "inclusive-exclusive")).toBe(true);
    expect(artifact.domain).toEqual({ min: 1, max: 12 });
    expect(artifact.nullPolicy).toBe("excluded");
  });

  it("accepts a time-series with half-open buckets and the source interval", async () => {
    const source = memorySource({
      rows: [{ reported_at: "2026-07-01T04:00:00Z" }, { reported_at: "2026-07-02T09:00:00Z" }],
    });
    const widgets = createWidgetSource(source);
    const response = await widgets.timeSeries({ field: "reported_at", interval: { unit: "day" } });

    const artifact = acceptWidgetTimeSeriesArtifact(response, { artifactId: "byday", acceptedAt: ACCEPTED_AT });
    expect(artifact.kind).toBe("time-series");
    expect(artifact.interval.unit).toBe("day");
    expect(artifact.marks.length).toBeGreaterThan(0);
    for (const mark of artifact.marks) {
      expect(Date.parse(mark.end)).toBeGreaterThan(Date.parse(mark.start));
    }
    expect(artifact.window?.start).toBe(artifact.marks[0].start);
    expect(artifact.nullPolicy).toBe("propagated-as-null");
  });

  it("accepts several count/formula responses as one aggregate artifact", async () => {
    const source = memorySource({ rows: [{ severity: 2 }, { severity: 6 }] });
    const widgets = createWidgetSource(source);
    const count = await widgets.count();
    const formula = await widgets.formula({ metric: { fn: "sum", field: "severity", alias: "total" } });

    const artifact = acceptWidgetAggregateArtifact([count, formula], {
      artifactId: "tiles",
      acceptedAt: ACCEPTED_AT,
    });
    expect(artifact.kind).toBe("aggregate");
    expect(artifact.marks).toHaveLength(2);
    expect(artifact.marks[1].measure).toMatchObject({ fn: "sum", field: "severity", alias: "total" });
  });

  it("refuses to mix sources in one aggregate artifact", async () => {
    const a = createWidgetSource(memorySource({ rows: [] }));
    const b = createWidgetSource(memorySource({ rows: [] }));
    const first = await a.count();
    const second = { ...(await b.count()), sourceId: "other" } as typeof first;

    expect(() => acceptWidgetAggregateArtifact([first, second], { artifactId: "x" })).toThrowError(/same source/);
  });

  it("requires at least one response", () => {
    expect(() => acceptWidgetAggregateArtifact([], { artifactId: "x" })).toThrowError(/at least one/);
  });
});

describe("single data ownership", () => {
  it("freezes the accepted artifact so no presentation can mutate the shared numbers", async () => {
    const source = memorySource({
      rows: [],
      aggregate: () => [
        { status: "OPEN", count: 2 },
        { status: "CLOSED", count: 1 },
      ],
    });
    const widgets = createWidgetSource(source);
    const response = await widgets.categories({ field: "status" });
    const artifact = acceptWidgetCategoriesArtifact(response, { artifactId: "one", acceptedAt: ACCEPTED_AT });

    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.marks)).toBe(true);
    // The accessible projection is derived, never a second stored copy.
    expect(analyticsTableModel(artifact).rows.map((row) => row.value)).toEqual(["2", "1"]);
  });
});
