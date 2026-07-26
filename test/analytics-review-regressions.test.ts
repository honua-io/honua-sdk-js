// @vitest-environment jsdom
/**
 * Regression tests for the seven code-quality review findings on the #682
 * linked-analytics contract. Each `describe` block names the finding it pins.
 */
import { describe, expect, it } from "vitest";

import {
  UNBOUNDED,
  acceptCategoryArtifact,
  acceptHistogramArtifact,
  acceptTimeSeriesArtifact,
  analyticsArtifactIdentity,
  analyticsBrushIndices,
  analyticsProvenance,
  bindAnalyticsToExploration,
  createAnalyticsAdapterRegistry,
  createAnalyticsLinkedSession,
  createDefaultAnalyticsPresentation,
  renderAnalyticsBrushHtml,
} from "../src/analytics/index.js";
import type {
  AnalyticsCategoryArtifact,
  AnalyticsHistogramArtifact,
  AnalyticsMeasure,
  AnalyticsPresentationAdapter,
  AnalyticsPresentationHandle,
  AnalyticsTimeSeriesArtifact,
} from "../src/analytics/index.js";
import type { Query, Result, Source } from "../src/contract/types.js";
import { createWidgetSource } from "../src/contract/widget-source.js";
import { createExplorationContext } from "../src/exploration/context.js";
import type { ExplorationViewController } from "../src/exploration/types.js";

const COUNT: AnalyticsMeasure = { field: "*", fn: "count", label: "Count", unit: "count", unitSystem: "count" };
const ACCEPTED_AT = "2026-07-25T12:00:00.000Z";

function identity(sequence = 0, overrides: Record<string, unknown> = {}) {
  return analyticsArtifactIdentity({
    artifactId: "incidents-by-status",
    sourceId: "incidents",
    planFingerprint: "sha256:abc",
    sequence,
    acceptedAt: ACCEPTED_AT,
    ...overrides,
  });
}

function provenance() {
  return analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED });
}

function view(): ExplorationViewController {
  const ctx = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
  return ctx.connectView({ id: "chart", role: "chart" });
}

function categories(marks: AnalyticsCategoryArtifact["marks"], sequence = 0): AnalyticsCategoryArtifact {
  return acceptCategoryArtifact({
    identity: identity(sequence),
    provenance: provenance(),
    measure: COUNT,
    dimension: "status",
    marks,
    ordering: { by: "explicit", direction: "asc" },
  });
}

function timeSeries(values: readonly number[], sequence = 0): AnalyticsTimeSeriesArtifact {
  return acceptTimeSeriesArtifact({
    identity: analyticsArtifactIdentity({
      artifactId: "incidents-by-day",
      sourceId: "incidents",
      sequence,
      acceptedAt: ACCEPTED_AT,
    }),
    provenance: provenance(),
    measure: COUNT,
    dimension: "reported_at",
    interval: { unit: "day", step: 1 },
    marks: values.map((value, index) => ({
      key: `d${index + 1}`,
      label: `Jul ${index + 1}`,
      value,
      start: `2026-07-0${index + 1}T00:00:00.000Z`,
      end: `2026-07-0${index + 2}T00:00:00.000Z`,
    })),
  });
}

function histogram(): AnalyticsHistogramArtifact {
  return acceptHistogramArtifact({
    identity: analyticsArtifactIdentity({ artifactId: "severity", sourceId: "incidents", acceptedAt: ACCEPTED_AT }),
    provenance: provenance(),
    measure: COUNT,
    dimension: "severity",
    bins: 4,
    marks: [0, 1, 2, 3].map((bucket) => ({
      key: `b${bucket}`,
      label: `${bucket * 10}–${bucket * 10 + 10}`,
      value: 4 - bucket,
      min: bucket * 10,
      max: bucket * 10 + 10,
      boundary: "inclusive-exclusive" as const,
      bucket,
    })),
  });
}

// ── Finding 1 ─────────────────────────────────────────────────

describe("finding 1: the link binding must follow a realtime patch", () => {
  it("resolves a mark added by a patch instead of clearing the filter", () => {
    const controller = view();
    const registry = createAnalyticsAdapterRegistry();
    const session = createAnalyticsLinkedSession({
      view: controller,
      artifact: categories([{ key: "s:OPEN", label: "Open", value: 4, filterValue: "OPEN" }]),
      registry,
    });

    // A realtime delta introduces a bucket that did not exist at bind time.
    session.accept(
      categories(
        [
          { key: "s:OPEN", label: "Open", value: 4, filterValue: "OPEN" },
          { key: "s:ESCALATED", label: "Escalated", value: 2, filterValue: "ESCALATED" },
        ],
        1,
      ),
    );
    expect(session.binding.artifact).toBe(session.artifact);

    session.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: "incidents-by-status",
      markKeys: ["s:ESCALATED"],
    });

    // Before the fix the binding looked the key up in the pre-patch artifact,
    // found nothing, and cleared the clause instead of selecting.
    expect(controller.state.filters[session.binding.clauseIds.marks]).toEqual({
      field: "status",
      operator: "=",
      value: "ESCALATED",
      appliesTo: ["incidents"],
    });
    expect(session.linkedState.selectedMarkKeys).toEqual(["s:ESCALATED"]);
    session.dispose();
  });

  it("publishes feature targets from the patched artifact, not the stale one", () => {
    const controller = view();
    const session = createAnalyticsLinkedSession({
      view: controller,
      artifact: categories([{ key: "s:OPEN", label: "Open", value: 1, filterValue: "OPEN" }]),
      registry: createAnalyticsAdapterRegistry(),
    });

    session.accept(
      categories(
        [
          {
            key: "s:OPEN",
            label: "Open",
            value: 2,
            filterValue: "OPEN",
            targets: [{ sourceId: "incidents", id: 77 }],
          },
        ],
        1,
      ),
    );

    session.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: "incidents-by-status",
      markKeys: ["s:OPEN"],
    });

    expect(controller.state.selection).toEqual([{ sourceId: "incidents", id: 77 }]);
    session.dispose();
  });

  it("exposes retarget directly and rejects it after dispose", () => {
    const controller = view();
    const first = timeSeries([1, 2]);
    const binding = bindAnalyticsToExploration(controller, first);
    expect(binding.artifact).toBe(first);

    const second = timeSeries([3, 4], 1);
    binding.retarget(second);
    expect(binding.artifact).toBe(second);

    binding.dispose();
    expect(() => binding.retarget(first)).toThrowError(expect.objectContaining({ code: "disposed" }));
  });
});

// ── Finding 2 ─────────────────────────────────────────────────

describe("finding 2: brush controls render from linked state", () => {
  it("initializes both inputs to the brushed range instead of full range", () => {
    const artifact = histogram();
    const html = renderAnalyticsBrushHtml(artifact, { selectedMarkKeys: [], range: { min: 10, max: 30 } });
    expect(html).toContain('data-brush="start" min="0" max="3" step="1" value="1"');
    expect(html).toContain('data-brush="end" min="0" max="3" step="1" value="2"');
  });

  it("falls back to full range when nothing is brushed", () => {
    const html = renderAnalyticsBrushHtml(histogram());
    expect(html).toContain('data-brush="start" min="0" max="3" step="1" value="0"');
    expect(html).toContain('data-brush="end" min="0" max="3" step="1" value="3"');
  });

  it("resolves a temporal window to mark indices", () => {
    const artifact = timeSeries([1, 2, 3]);
    expect(
      analyticsBrushIndices(artifact, {
        selectedMarkKeys: [],
        temporalWindow: { start: "2026-07-02T00:00:00.000Z", end: "2026-07-04T00:00:00.000Z" },
      }),
    ).toEqual({ start: 1, end: 2 });
    expect(analyticsBrushIndices(artifact)).toEqual({ start: 0, end: 2 });
    expect(analyticsBrushIndices(categories([{ key: "a", label: "A", value: 1, filterValue: "A" }]))).toBeUndefined();
  });

  it("keeps the live controls on the brushed range after a rerender", async () => {
    const controller = view();
    const session = createAnalyticsLinkedSession({
      view: controller,
      artifact: histogram(),
      registry: createAnalyticsAdapterRegistry({ adapters: [createDefaultAnalyticsPresentation()] }),
    });
    const panel = document.createElement("div");
    await session.present({ target: panel });

    const inputs = () =>
      Array.from(panel.querySelectorAll<HTMLInputElement>(".honua-analytics__brush-input")).map((input) => input.value);
    expect(inputs()).toEqual(["0", "3"]);

    // Drag the "to" handle down to bin 1 and commit it, exactly as a user would.
    const [, end] = Array.from(panel.querySelectorAll<HTMLInputElement>(".honua-analytics__brush-input"));
    end.value = "1";
    end.dispatchEvent(new Event("change"));

    expect(controller.state.filters[session.binding.clauseIds.range]).toMatchObject({ value: [0, 20] });
    // Before the fix the rerender snapped both handles back to 0/3, so the next
    // adjustment silently re-widened the filter.
    expect(inputs()).toEqual(["0", "1"]);
    session.dispose();
  });

  it("displays an inbound peer brush rather than full range", async () => {
    const controller = view();
    const session = createAnalyticsLinkedSession({
      view: controller,
      artifact: histogram(),
      registry: createAnalyticsAdapterRegistry({ adapters: [createDefaultAnalyticsPresentation()] }),
    });
    const panel = document.createElement("div");
    await session.present({ target: panel });

    session.apply({
      kind: "range-brush",
      adapterId: "peer-chart",
      artifactId: "severity",
      range: { min: 20, max: 40 },
    });

    const values = Array.from(panel.querySelectorAll<HTMLInputElement>(".honua-analytics__brush-input")).map(
      (input) => input.value,
    );
    expect(values).toEqual(["2", "3"]);
    session.dispose();
  });
});

// ── Finding 3 ─────────────────────────────────────────────────

describe("finding 3: dispose during an in-flight mount", () => {
  it("releases the handle instead of registering it in a disposed session", async () => {
    let release: (() => void) | undefined;
    const mounted: AnalyticsPresentationHandle[] = [];
    const slow: AnalyticsPresentationAdapter = {
      id: "test.slow-peer",
      contractVersion: "1.0",
      kinds: ["category", "histogram", "aggregate", "time-series"],
      channels: [],
      describeSupport: () => ({ supported: true }),
      async mount(request) {
        // Stand in for `await import("uplot")`.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        let disposed = false;
        const handle: AnalyticsPresentationHandle = {
          adapterId: "test.slow-peer",
          artifact: request.artifact,
          accessibleDescription: "slow",
          get disposed() {
            return disposed;
          },
          update: () => ({ disposition: "patch", reason: "newer-sequence", message: "" }),
          applyLinkedState: () => {},
          dispose: () => {
            disposed = true;
          },
        };
        mounted.push(handle);
        return handle;
      },
    };

    const session = createAnalyticsLinkedSession({
      view: view(),
      artifact: categories([{ key: "s:OPEN", label: "Open", value: 1, filterValue: "OPEN" }]),
      registry: createAnalyticsAdapterRegistry({ adapters: [slow] }),
    });

    const pending = session.present({ target: document.createElement("div") });
    session.dispose();
    release?.();

    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    expect(mounted).toHaveLength(1);
    expect(mounted[0].disposed).toBe(true);
    expect(session.presentations).toHaveLength(0);
  });
});

// ── Finding 4 ─────────────────────────────────────────────────

describe("finding 4: clearing the marks channel releases a temporal filter", () => {
  it("clears the temporal clause a time-series mark-select wrote", () => {
    const controller = view();
    const artifact = timeSeries([1, 2, 3]);
    const binding = bindAnalyticsToExploration(controller, artifact);

    binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: "incidents-by-day",
      markKeys: ["d2"],
    });
    expect(controller.state.filters[binding.clauseIds.temporal]).toBeDefined();

    const cleared = binding.apply({
      kind: "clear",
      adapterId: "test",
      artifactId: "incidents-by-day",
      channel: "marks",
    });

    // Before the fix this cleared only the unused marks clause and left the
    // time filter applied to the map and the table.
    expect(controller.state.filters[binding.clauseIds.temporal]).toBeUndefined();
    expect(cleared.touchedClauseIds).toEqual([binding.clauseIds.temporal]);

    cleared.undo();
    expect(controller.state.filters[binding.clauseIds.temporal]).toBeDefined();
    binding.dispose();
  });

  it("still clears the marks clause for a category artifact", () => {
    const controller = view();
    const binding = bindAnalyticsToExploration(
      controller,
      categories([{ key: "s:OPEN", label: "Open", value: 1, filterValue: "OPEN" }]),
    );
    binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: "incidents-by-status",
      markKeys: ["s:OPEN"],
    });
    const cleared = binding.apply({
      kind: "clear",
      adapterId: "test",
      artifactId: "incidents-by-status",
      channel: "marks",
    });
    expect(cleared.touchedClauseIds).toEqual([binding.clauseIds.marks]);
    expect(controller.state.filters[binding.clauseIds.marks]).toBeUndefined();
    binding.dispose();
  });

  it("does not clear one clause twice on a full clear of a time series", () => {
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, timeSeries([1, 2]));
    const cleared = binding.apply({ kind: "clear", adapterId: "test", artifactId: "incidents-by-day" });
    expect(cleared.touchedClauseIds).toEqual([binding.clauseIds.temporal, binding.clauseIds.range]);
    binding.dispose();
  });
});

// ── Finding 5 ─────────────────────────────────────────────────

describe("finding 5: replacement selection clears stale feature targets", () => {
  it("drops the previous mark's features when the new mark has no targets", () => {
    const controller = view();
    const artifact = categories([
      {
        key: "s:OPEN",
        label: "Open",
        value: 2,
        filterValue: "OPEN",
        targets: [
          { sourceId: "incidents", id: 1 },
          { sourceId: "incidents", id: 2 },
        ],
      },
      { key: "s:CLOSED", label: "Closed", value: 1, filterValue: "CLOSED" },
    ]);
    const binding = bindAnalyticsToExploration(controller, artifact);

    binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: "incidents-by-status",
      markKeys: ["s:OPEN"],
    });
    expect(controller.state.selection).toHaveLength(2);

    const second = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: "incidents-by-status",
      markKeys: ["s:CLOSED"],
    });

    // Before the fix the OPEN features stayed selected while the filter said
    // CLOSED — the map highlighted rows the filter had excluded.
    expect(controller.state.selection).toEqual([]);
    expect(controller.state.filters[binding.clauseIds.marks]).toMatchObject({ value: "CLOSED" });
    expect(second.touchedSelection).toBe(true);

    second.undo();
    expect(controller.state.selection).toEqual([
      { sourceId: "incidents", id: 1 },
      { sourceId: "incidents", id: 2 },
    ]);
    binding.dispose();
  });

  it("leaves a foreign selection alone when this binding never published one", () => {
    const ctx = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const chart = ctx.connectView({ id: "chart", role: "chart" });
    const table = ctx.connectView({ id: "table", role: "grid" });
    table.select([{ sourceId: "incidents", id: 500 }], { replace: true });

    const binding = bindAnalyticsToExploration(
      chart,
      categories([{ key: "s:CLOSED", label: "Closed", value: 1, filterValue: "CLOSED" }]),
    );
    const commit = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: "incidents-by-status",
      markKeys: ["s:CLOSED"],
    });

    expect(commit.touchedSelection).toBe(false);
    expect(chart.state.selection).toEqual([{ sourceId: "incidents", id: 500 }]);
    binding.dispose();
  });
});

// ── Finding 6 ─────────────────────────────────────────────────

function memorySource(options: {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly aggregate?: (query: Query) => ReadonlyArray<Record<string, unknown>>;
}): Source {
  const features = options.rows.map((attributes, index) => ({ id: index, attributes }));
  const capabilities = new Set<string>(["query", "pagination", ...(options.aggregate ? ["queryAggregate"] : [])]);
  const source = {
    descriptor: {
      id: "incidents",
      protocol: "geoservices" as const,
      locator: { url: "https://example.test/FeatureServer/0" },
      capabilities,
    },
    capabilities,
    async query(): Promise<Result> {
      return { features, exceededTransferLimit: false };
    },
    async queryAll(): Promise<Result> {
      return { features, exceededTransferLimit: false };
    },
    async queryAggregate(query: Query): Promise<Result> {
      if (!options.aggregate) throw new Error("queryAggregate is not supported");
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

describe("finding 6: transferredRowCount must not report bucket counts", () => {
  it("omits the count when the reduction ran in the browser", async () => {
    const { acceptWidgetCategoriesArtifact } = await import("../src/analytics/index.js");
    // 5,000 rows reduce to 2 categories; "2 rows transferred" would be a lie.
    const rows = Array.from({ length: 5_000 }, (_unused, index) => ({
      status: index % 2 === 0 ? "OPEN" : "CLOSED",
    }));
    const widgets = createWidgetSource(memorySource({ rows }));
    const response = await widgets.categories({ field: "status" });
    expect(response.serverPushdown).toBe(false);

    const artifact = acceptWidgetCategoriesArtifact(response, { artifactId: "a", acceptedAt: ACCEPTED_AT });
    expect(artifact.marks).toHaveLength(2);
    expect(artifact.provenance.bounds.transferredRowCount).toBeUndefined();
    expect(artifact.provenance.notes).toContain(
      "Transferred row count is unavailable: the reduction ran outside the source.",
    );
  });

  it("reports the count on the pushdown path, where the aggregate rows are the transfer", async () => {
    const { acceptWidgetCategoriesArtifact } = await import("../src/analytics/index.js");
    const widgets = createWidgetSource(
      memorySource({
        rows: [],
        aggregate: () => [
          { status: "OPEN", count: 2_500 },
          { status: "CLOSED", count: 2_500 },
        ],
      }),
    );
    const response = await widgets.categories({ field: "status" });
    expect(response.serverPushdown).toBe(true);

    const artifact = acceptWidgetCategoriesArtifact(response, { artifactId: "a", acceptedAt: ACCEPTED_AT });
    expect(artifact.provenance.bounds.transferredRowCount).toBe(2);
    expect(artifact.provenance.notes).not.toContain(
      "Transferred row count is unavailable: the reduction ran outside the source.",
    );
  });
});

// ── Finding 7 ─────────────────────────────────────────────────

describe("finding 7: ordering validation after removing the dead guard", () => {
  it("still compares across an interleaved null measure", () => {
    expect(() =>
      acceptCategoryArtifact({
        identity: identity(),
        provenance: provenance(),
        measure: COUNT,
        dimension: "status",
        marks: [
          { key: "a", label: "A", value: 9, filterValue: "A" },
          { key: "n", label: "N", value: null, filterValue: null },
          { key: "b", label: "B", value: 20, filterValue: "B" },
        ],
      }),
    ).toThrowError(/breaks it/);
  });

  it("accepts a leading null measure", () => {
    expect(() =>
      acceptCategoryArtifact({
        identity: identity(),
        provenance: provenance(),
        measure: COUNT,
        dimension: "status",
        marks: [
          { key: "n", label: "N", value: null, filterValue: null },
          { key: "a", label: "A", value: 9, filterValue: "A" },
          { key: "b", label: "B", value: 3, filterValue: "B" },
        ],
      }),
    ).not.toThrow();
  });
});
