// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  UNBOUNDED,
  acceptCategoryArtifact,
  acceptTimeSeriesArtifact,
  analyticsArtifactIdentity,
  analyticsProvenance,
  analyticsTableModel,
  createAccessibleTableAdapter,
  createAnalyticsAdapterRegistry,
  createAnalyticsLinkedSession,
  createDefaultAnalyticsPresentation,
  unsupportedAnalyticsArtifact,
} from "../src/analytics/index.js";
import type {
  AnalyticsArtifact,
  AnalyticsCategoryArtifact,
  AnalyticsMeasure,
  AnalyticsPresentationAdapter,
  AnalyticsTimeSeriesArtifact,
} from "../src/analytics/index.js";
import { createExplorationContext } from "../src/exploration/context.js";
import { bindTableSelectionToExploration, syncMapLayerFilterToExploration } from "../src/interactions/index.js";

const COUNT: AnalyticsMeasure = { field: "*", fn: "count", label: "Count", unit: "count", unitSystem: "count" };

/** Drain the exploration context's microtask coalescing. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
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

function categoryArtifact(sequence = 0, open = 42): AnalyticsCategoryArtifact {
  return acceptCategoryArtifact({
    identity: identity(sequence),
    provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
    measure: COUNT,
    title: "Incidents by status",
    dimension: "status",
    marks: [
      {
        key: "s:OPEN",
        label: "Open",
        value: open,
        filterValue: "OPEN",
        targets: [{ sourceId: "incidents", id: 1 }],
      },
      { key: "s:CLOSED", label: "Closed", value: 17, filterValue: "CLOSED" },
      { key: "null", label: "(no status)", value: null, filterValue: null },
    ],
    nullPolicy: "separate-bucket",
    total: open + 17,
  });
}

function timeSeriesArtifact(): AnalyticsTimeSeriesArtifact {
  return acceptTimeSeriesArtifact({
    identity: analyticsArtifactIdentity({
      artifactId: "incidents-by-day",
      sourceId: "incidents",
      acceptedAt: ACCEPTED_AT,
    }),
    provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
    measure: COUNT,
    dimension: "reported_at",
    interval: { unit: "day", step: 1 },
    marks: [
      { key: "d1", label: "Jul 1", value: 2, start: "2026-07-01T00:00:00.000Z", end: "2026-07-02T00:00:00.000Z" },
      { key: "d2", label: "Jul 2", value: 4, start: "2026-07-02T00:00:00.000Z", end: "2026-07-03T00:00:00.000Z" },
    ],
  });
}

function session(artifact: AnalyticsArtifact, adapters: AnalyticsPresentationAdapter[] = []) {
  const ctx = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
  const view = ctx.connectView({ id: "chart", role: "chart" });
  const registry = createAnalyticsAdapterRegistry({ adapters });
  return { ctx, view, registry, session: createAnalyticsLinkedSession({ view, artifact, registry }) };
}

describe("one accepted artifact drives linked map, table, and presentations", () => {
  it("shares one reference and one filter set across map, table, chart, and accessible table", async () => {
    const artifact = categoryArtifact();
    const ctx = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const chartView = ctx.connectView({ id: "chart", role: "chart" });
    const mapView = ctx.connectView({ id: "map", role: "map" });
    const tableView = ctx.connectView({ id: "table", role: "grid" });

    // The map observes the shared query projection.
    const mapFilters: Array<Record<string, unknown>> = [];
    const mapHandle = syncMapLayerFilterToExploration(
      { setFilter: (_layerId, filter) => mapFilters.push(filter as Record<string, unknown>) },
      mapView,
      { layerId: "incidents", translate: (projection) => projection.filters },
    );

    // The table observes the shared selection.
    const tableSelections: unknown[] = [];
    const table = bindTableSelectionToExploration(tableView);
    table.subscribe((selection) => tableSelections.push(selection));

    const registry = createAnalyticsAdapterRegistry({ adapters: [createDefaultAnalyticsPresentation()] });
    const linked = createAnalyticsLinkedSession({ view: chartView, artifact, registry });

    const panel = document.createElement("div");
    const chart = await linked.present({ target: panel });
    const text = await linked.present({ id: "a11y", headlessOnly: true });

    // Every presentation holds the session's own reference — no copies.
    expect(chart.handle.artifact).toBe(artifact);
    expect(text.handle.artifact).toBe(artifact);
    expect(linked.artifact).toBe(artifact);
    expect(chart.adapter.id).toBe("honua.default-bars");
    expect(text.adapter.id).toBe("honua.accessible-table");

    // A click in the DOM presentation reaches the map and the table.
    const openButton = panel.querySelector<HTMLButtonElement>('button[data-mark="s:OPEN"]');
    expect(openButton).not.toBeNull();
    openButton?.click();
    await flush();

    expect(chartView.state.filters[linked.binding.clauseIds.marks]).toMatchObject({
      field: "status",
      operator: "=",
      value: "OPEN",
    });
    expect(mapFilters.at(-1)?.[linked.binding.clauseIds.marks]).toMatchObject({
      field: "status",
      operator: "=",
      value: "OPEN",
    });
    expect(tableSelections.at(-1)).toEqual([{ sourceId: "incidents", id: 1 }]);

    // Both presentations reflect the same selection.
    expect(panel.querySelector('button[data-mark="s:OPEN"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(linked.linkedState.selectedMarkKeys).toEqual(["s:OPEN"]);

    // Undo is exact: the map and table return to their prior state.
    linked.undo();
    await flush();
    expect(chartView.state.filters[linked.binding.clauseIds.marks]).toBeUndefined();
    expect(chartView.state.selection).toEqual([]);
    expect(panel.querySelector('button[data-mark="s:OPEN"]')?.getAttribute("aria-pressed")).toBe("false");

    linked.dispose();
    mapHandle.remove();
    expect(chart.handle.disposed).toBe(true);
    expect(text.handle.disposed).toBe(true);
  });
});

describe("registry fallback", () => {
  it("falls back to the accessible table when every adapter declines, and reports why", async () => {
    const artifact = categoryArtifact();
    const numericOnly: AnalyticsPresentationAdapter = {
      id: "test.numeric-only",
      contractVersion: "1.0",
      kinds: ["histogram"],
      channels: [],
      describeSupport: () => ({ supported: true }),
      mount: () => {
        throw new Error("should never mount");
      },
    };
    const registry = createAnalyticsAdapterRegistry({ adapters: [numericOnly] });

    const resolution = registry.resolve(artifact);
    expect(resolution.fallback).toBe(true);
    expect(resolution.adapter.id).toBe("honua.accessible-table");
    expect(resolution.rejected).toEqual([
      {
        adapterId: "test.numeric-only",
        reason: "kind-not-supported",
        message: 'test.numeric-only does not present "category" artifacts.',
      },
    ]);
  });

  it("skips DOM adapters when the host asks for a headless presentation", () => {
    const registry = createAnalyticsAdapterRegistry({ adapters: [createDefaultAnalyticsPresentation()] });
    const resolution = registry.resolve(categoryArtifact(), { headlessOnly: true });
    expect(resolution.fallback).toBe(true);
    expect(resolution.rejected[0]).toMatchObject({ reason: "peer-unavailable" });
  });

  it("rejects duplicate ids, unknown ids, and incompatible contract majors", () => {
    const registry = createAnalyticsAdapterRegistry({ adapters: [createDefaultAnalyticsPresentation()] });
    expect(() => registry.register(createDefaultAnalyticsPresentation())).toThrowError(
      expect.objectContaining({ code: "duplicate-adapter" }),
    );
    expect(() => registry.get("nope")).toThrowError(expect.objectContaining({ code: "adapter-not-registered" }));
    expect(() =>
      registry.register({ ...createAccessibleTableAdapter(), id: "future", contractVersion: "9.0" }),
    ).toThrowError(expect.objectContaining({ code: "contract-version-mismatch" }));
    expect(registry.unregister("honua.default-bars")).toBe(true);
    expect(registry.unregister("honua.default-bars")).toBe(false);
  });

  it("refuses a fallback adapter that cannot present every kind", () => {
    expect(() =>
      createAnalyticsAdapterRegistry({
        fallback: { ...createAccessibleTableAdapter(), kinds: ["category"] },
      }),
    ).toThrowError(expect.objectContaining({ code: "adapter-unsupported" }));
  });
});

describe("accessible states", () => {
  it("renders an unsupported artifact as a truthful, inspectable state", async () => {
    const artifact = unsupportedAnalyticsArtifact({
      identity: identity(),
      kind: "category",
      measure: COUNT,
      dimension: "status",
      message: "This source cannot group by status.",
    });
    const { session: linked } = session(artifact, [createDefaultAnalyticsPresentation()]);
    const panel = document.createElement("div");
    const presentation = await linked.present({ target: panel });

    expect(panel.querySelector('[role="status"]')?.textContent).toBe("This source cannot group by status.");
    expect(panel.querySelector('[data-status="unsupported"]')).not.toBeNull();
    expect(panel.textContent).toContain("No buckets.");
    expect(presentation.handle.accessibleDescription).toContain("cannot group by status");
    linked.dispose();
  });

  it("renders a partial artifact with an explicit incompleteness banner", async () => {
    const artifact = acceptCategoryArtifact({
      identity: identity(),
      provenance: analyticsProvenance({
        computedBy: "client",
        bounds: { truncated: true, rowBudget: 10_000 },
      }),
      measure: COUNT,
      dimension: "status",
      marks: [{ key: "s:OPEN", label: "Open", value: 5, filterValue: "OPEN" }],
    });
    expect(artifact.status).toBe("partial");

    const model = analyticsTableModel(artifact);
    expect(model.statusMessage).toMatch(/Partial results — do not treat these numbers as complete/);
    expect(model.statusMessage).toMatch(/10000-row budget/);
    expect(model.provenanceMessage).toMatch(/reduced in the browser/);
  });

  it("renders a null measure as an explicit gap, never as zero", () => {
    const model = analyticsTableModel(categoryArtifact());
    const nullRow = model.rows.find((row) => row.key === "null");
    expect(nullRow).toMatchObject({ isNull: true, value: "no data", fraction: 0 });
    expect(model.total).toBe("59");
  });

  it("describes a stale artifact with the observation instant", () => {
    const stale = acceptCategoryArtifact({
      identity: identity(0, { freshness: { authority: "stale", observedAt: "2026-07-24T00:00:00.000Z" } }),
      provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
      measure: COUNT,
      dimension: "status",
      marks: [{ key: "s:OPEN", label: "Open", value: 1, filterValue: "OPEN" }],
    });
    expect(stale.status).toBe("stale");
    expect(analyticsTableModel(stale).statusMessage).toBe("Stale results — last observed 2026-07-24T00:00:00.000Z.");
  });

  it("surfaces required attribution verbatim", async () => {
    const artifact = acceptCategoryArtifact({
      identity: identity(),
      provenance: analyticsProvenance({
        computedBy: "server",
        bounds: UNBOUNDED,
        attribution: ["© City of Example"],
      }),
      measure: COUNT,
      dimension: "status",
      marks: [{ key: "s:OPEN", label: "Open", value: 1, filterValue: "OPEN" }],
    });
    const { session: linked } = session(artifact, [createDefaultAnalyticsPresentation()]);
    const panel = document.createElement("div");
    await linked.present({ target: panel });
    expect(panel.textContent).toContain("© City of Example");
    linked.dispose();
  });
});

describe("realtime updates", () => {
  it("patches in place on a newer sequence and keeps the DOM presentation mounted", async () => {
    const { session: linked } = session(categoryArtifact(1, 42), [createDefaultAnalyticsPresentation()]);
    const panel = document.createElement("div");
    const presentation = await linked.present({ target: panel });
    expect(panel.textContent).toContain("42");

    const decision = linked.accept(categoryArtifact(2, 55));
    expect(decision).toMatchObject({ disposition: "patch", reason: "newer-sequence" });
    expect(panel.textContent).toContain("55");
    expect(presentation.handle.disposed).toBe(false);
    expect(presentation.handle.artifact).toBe(linked.artifact);
    linked.dispose();
  });

  it("ignores a late delta so the presentation never rewinds", async () => {
    const { session: linked } = session(categoryArtifact(5, 99), [createDefaultAnalyticsPresentation()]);
    const panel = document.createElement("div");
    await linked.present({ target: panel });

    const decision = linked.accept(categoryArtifact(4, 20));
    expect(decision).toMatchObject({ disposition: "ignore", reason: "stale-sequence" });
    expect(linked.artifact.identity.sequence).toBe(5);
    expect(panel.querySelector('tr[data-mark="s:OPEN"] .honua-analytics__number')?.textContent).toBe("99");
    linked.dispose();
  });

  it("preserves a brushed selection through a patch", async () => {
    const { session: linked, view } = session(timeSeriesArtifact(), [createDefaultAnalyticsPresentation()]);
    const panel = document.createElement("div");
    await linked.present({ target: panel });

    linked.apply({
      kind: "temporal-brush",
      adapterId: "test",
      artifactId: "incidents-by-day",
      window: { start: "2026-07-02T00:00:00.000Z", end: "2026-07-03T00:00:00.000Z" },
    });
    expect(view.state.filters[linked.binding.clauseIds.temporal]).toBeDefined();

    linked.accept(
      acceptTimeSeriesArtifact({
        identity: analyticsArtifactIdentity({
          artifactId: "incidents-by-day",
          sourceId: "incidents",
          sequence: 1,
          acceptedAt: ACCEPTED_AT,
        }),
        provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
        measure: COUNT,
        dimension: "reported_at",
        interval: { unit: "day", step: 1 },
        marks: [
          { key: "d1", label: "Jul 1", value: 3, start: "2026-07-01T00:00:00.000Z", end: "2026-07-02T00:00:00.000Z" },
          { key: "d2", label: "Jul 2", value: 9, start: "2026-07-02T00:00:00.000Z", end: "2026-07-03T00:00:00.000Z" },
        ],
      }),
    );

    expect(view.state.filters[linked.binding.clauseIds.temporal]).toBeDefined();
    expect(linked.linkedState.selectedMarkKeys).toEqual(["d2"]);
    linked.dispose();
  });
});

describe("session lifecycle", () => {
  it("releases every listener and DOM node on dispose", async () => {
    const artifact = categoryArtifact();
    const { session: linked, view } = session(artifact, [createDefaultAnalyticsPresentation()]);
    const panel = document.createElement("div");
    const presentation = await linked.present({ target: panel });
    const button = panel.querySelector<HTMLButtonElement>('button[data-mark="s:OPEN"]');
    expect(button).not.toBeNull();

    linked.dispose();

    expect(linked.disposed).toBe(true);
    expect(presentation.handle.disposed).toBe(true);
    expect(panel.innerHTML).toBe("");
    // A detached button click can no longer reach shared state.
    button?.click();
    expect(view.state.filters[linked.binding.clauseIds.marks]).toBeUndefined();
    expect(() => linked.apply({ kind: "clear", adapterId: "x", artifactId: "y" })).toThrowError(
      expect.objectContaining({ code: "disposed" }),
    );
  });

  it("rejects a duplicate presentation id and removes one presentation independently", async () => {
    const { session: linked } = session(categoryArtifact(), [createDefaultAnalyticsPresentation()]);
    const panel = document.createElement("div");
    const chart = await linked.present({ target: panel });
    await expect(linked.present({ target: panel })).rejects.toThrowError(
      expect.objectContaining({ code: "duplicate-adapter" }),
    );

    const text = await linked.present({ id: "a11y", headlessOnly: true });
    chart.remove();
    expect(chart.handle.disposed).toBe(true);
    expect(text.handle.disposed).toBe(false);
    expect(linked.presentations.map((entry) => entry.id)).toEqual(["a11y"]);
    linked.dispose();
  });

  it("rejects update and applyLinkedState on a disposed handle", async () => {
    const { session: linked } = session(categoryArtifact(), []);
    const text = await linked.present({ headlessOnly: true });
    text.handle.dispose();
    expect(() => text.handle.update(categoryArtifact(1))).toThrowError(expect.objectContaining({ code: "disposed" }));
    expect(() => text.handle.applyLinkedState({ selectedMarkKeys: [] })).toThrowError(
      expect.objectContaining({ code: "disposed" }),
    );
    linked.dispose();
  });

  it("forwards adapter warnings to the host", async () => {
    const onWarning = vi.fn();
    const ctx = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const view = ctx.connectView({ id: "chart", role: "chart" });
    const warning: AnalyticsPresentationAdapter = {
      ...createAccessibleTableAdapter(),
      id: "test.warner",
      mount(request) {
        request.host.reportWarning?.("bounded", { adapterId: "test.warner" });
        return createAccessibleTableAdapter().mount(request);
      },
    };
    const registry = createAnalyticsAdapterRegistry({ adapters: [warning] });
    const linked = createAnalyticsLinkedSession({ view, artifact: categoryArtifact(), registry, onWarning });
    await linked.present();
    expect(onWarning).toHaveBeenCalledWith("bounded", { adapterId: "test.warner" });
    linked.dispose();
  });

  it("bounds the undo history", async () => {
    const { session: linked } = session(timeSeriesArtifact(), []);
    for (let index = 0; index < 3; index += 1) {
      linked.apply({
        kind: "temporal-brush",
        adapterId: "test",
        artifactId: "incidents-by-day",
        window: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-02T00:00:00.000Z" },
      });
    }
    expect(linked.history.length).toBe(3);
    expect(linked.undo()).toBeDefined();
    expect(linked.history.length).toBe(2);
    linked.dispose();
  });
});
