import { describe, expect, it } from "vitest";

import {
  UNBOUNDED,
  acceptCategoryArtifact,
  acceptHistogramArtifact,
  acceptTimeSeriesArtifact,
  analyticsArtifactIdentity,
  analyticsFilterContributions,
  analyticsProvenance,
  bindAnalyticsToExploration,
  selectAnalyticsLinkedState,
} from "../src/analytics/index.js";
import type { AnalyticsArtifact, AnalyticsMeasure } from "../src/analytics/index.js";
import { createExplorationContext } from "../src/exploration/context.js";
import type { ExplorationViewController } from "../src/exploration/types.js";

const COUNT: AnalyticsMeasure = { field: "*", fn: "count", label: "Count", unit: "count", unitSystem: "count" };
const ACCEPTED_AT = "2026-07-25T12:00:00.000Z";

function identity(sequence = 0) {
  return analyticsArtifactIdentity({
    artifactId: "incidents-by-status",
    sourceId: "incidents",
    planFingerprint: "sha256:abc",
    sequence,
    acceptedAt: ACCEPTED_AT,
  });
}

function provenance() {
  return analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED });
}

function categoryArtifact(): AnalyticsArtifact {
  return acceptCategoryArtifact({
    identity: identity(),
    provenance: provenance(),
    measure: COUNT,
    dimension: "status",
    marks: [
      {
        key: "s:OPEN",
        label: "Open",
        value: 42,
        filterValue: "OPEN",
        targets: [
          { sourceId: "incidents", id: 1 },
          { sourceId: "incidents", id: 2 },
        ],
      },
      { key: "s:CLOSED", label: "Closed", value: 17, filterValue: "CLOSED" },
      { key: "null", label: "(no status)", value: null, filterValue: null },
      { key: "other", label: "Other", value: 3, filterValue: null, overflow: true },
    ],
    nullPolicy: "separate-bucket",
  });
}

function histogramArtifact(): AnalyticsArtifact {
  return acceptHistogramArtifact({
    identity: identity(),
    provenance: provenance(),
    measure: COUNT,
    dimension: "severity",
    bins: 3,
    marks: [
      { key: "b0", label: "0–10", value: 5, min: 0, max: 10, boundary: "inclusive-exclusive", bucket: 0 },
      { key: "b1", label: "10–20", value: 9, min: 10, max: 20, boundary: "inclusive-exclusive", bucket: 1 },
      { key: "b2", label: "20–30", value: 2, min: 20, max: 30, boundary: "inclusive-exclusive", bucket: 2 },
    ],
  });
}

function timeSeriesArtifact(): AnalyticsArtifact {
  return acceptTimeSeriesArtifact({
    identity: identity(),
    provenance: provenance(),
    measure: COUNT,
    dimension: "reported_at",
    interval: { unit: "day", step: 1 },
    marks: [
      { key: "d1", label: "Jul 1", value: 2, start: "2026-07-01T00:00:00.000Z", end: "2026-07-02T00:00:00.000Z" },
      { key: "d2", label: "Jul 2", value: 4, start: "2026-07-02T00:00:00.000Z", end: "2026-07-03T00:00:00.000Z" },
      { key: "d3", label: "Jul 3", value: 1, start: "2026-07-03T00:00:00.000Z", end: "2026-07-04T00:00:00.000Z" },
    ],
  });
}

function view(): ExplorationViewController {
  const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents"] });
  return ctx.connectView({ id: "chart", role: "chart" });
}

describe("bindAnalyticsToExploration: mark selection", () => {
  it("writes an equality clause for a single category mark", () => {
    const artifact = categoryArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);

    const commit = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["s:OPEN"],
    });

    expect(commit.changed).toBe(true);
    expect(controller.state.filters[binding.clauseIds.marks]).toEqual({
      field: "status",
      operator: "=",
      value: "OPEN",
      appliesTo: ["incidents"],
    });
    expect(commit.linkedState.selectedMarkKeys).toEqual(["s:OPEN"]);
  });

  it("writes an in clause for several marks and publishes their feature targets", () => {
    const artifact = categoryArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);

    binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["s:OPEN", "s:CLOSED"],
    });

    expect(controller.state.filters[binding.clauseIds.marks]).toMatchObject({
      operator: "in",
      value: ["OPEN", "CLOSED"],
    });
    expect(controller.state.selection).toEqual([
      { sourceId: "incidents", id: 1 },
      { sourceId: "incidents", id: 2 },
    ]);
  });

  it("uses is-null for the null bucket and refuses to filter on an overflow bucket", () => {
    const artifact = categoryArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);

    binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["null"],
    });
    expect(controller.state.filters[binding.clauseIds.marks]).toMatchObject({ operator: "is-null" });

    binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["other"],
    });
    expect(controller.state.filters[binding.clauseIds.marks]).toBeUndefined();
  });

  it("toggles additively when replace is false", () => {
    const artifact = categoryArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);

    binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["s:OPEN"],
      replace: false,
    });
    const commit = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["s:CLOSED"],
      replace: false,
    });
    expect(new Set(commit.linkedState.selectedMarkKeys)).toEqual(new Set(["s:OPEN", "s:CLOSED"]));

    const off = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["s:OPEN"],
      replace: false,
    });
    expect(off.linkedState.selectedMarkKeys).toEqual(["s:CLOSED"]);
  });

  it("publishes a time-series mark click on the temporal clause", () => {
    const artifact = timeSeriesArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);

    const commit = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["d2"],
    });

    expect(commit.touchedClauseIds).toEqual([binding.clauseIds.temporal]);
    expect(controller.state.filters[binding.clauseIds.temporal]).toEqual({
      field: "reported_at",
      operator: "between",
      value: ["2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z"],
      appliesTo: ["incidents"],
    });
  });
});

describe("bindAnalyticsToExploration: brushing", () => {
  it("writes a between clause for a numeric brush", () => {
    const artifact = histogramArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);

    binding.apply({
      kind: "range-brush",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      range: { min: 5, max: 25 },
    });

    expect(controller.state.filters[binding.clauseIds.range]).toEqual({
      field: "severity",
      operator: "between",
      value: [5, 25],
      appliesTo: ["incidents"],
    });
    expect(binding.linkedState.range).toEqual({ min: 5, max: 25 });
  });

  it("writes a between clause for a temporal brush and recovers the covered marks", () => {
    const artifact = timeSeriesArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);

    binding.apply({
      kind: "temporal-brush",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      window: { start: "2026-07-02T00:00:00.000Z", end: "2026-07-04T00:00:00.000Z" },
    });

    expect(binding.linkedState.temporalWindow).toEqual({
      start: "2026-07-02T00:00:00.000Z",
      end: "2026-07-04T00:00:00.000Z",
    });
    expect(binding.linkedState.selectedMarkKeys).toEqual(["d2", "d3"]);
  });
});

describe("bindAnalyticsToExploration: deterministic undo", () => {
  it("restores the exact previous clause value", () => {
    const artifact = categoryArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);

    const first = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["s:OPEN"],
    });
    const second = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["s:CLOSED"],
    });

    second.undo();
    expect(controller.state.filters[binding.clauseIds.marks]).toMatchObject({ value: "OPEN" });

    first.undo();
    expect(controller.state.filters[binding.clauseIds.marks]).toBeUndefined();
  });

  it("restores the previous selection without clobbering a peer view's change", () => {
    const artifact = categoryArtifact();
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents"] });
    const chart = ctx.connectView({ id: "chart", role: "chart" });
    const table = ctx.connectView({ id: "table", role: "grid" });
    const binding = bindAnalyticsToExploration(chart, artifact);

    const commit = binding.apply({
      kind: "mark-select",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKeys: ["s:OPEN"],
    });
    // A peer view contributes an unrelated clause after the chart interaction.
    table.setFilter("table:district", { field: "district", operator: "=", value: "north" });

    commit.undo();

    expect(chart.state.filters[binding.clauseIds.marks]).toBeUndefined();
    expect(chart.state.filters["table:district"]).toMatchObject({ value: "north" });
    expect(chart.state.selection).toEqual([]);
  });

  it("is idempotent", () => {
    const artifact = histogramArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);
    const commit = binding.apply({
      kind: "range-brush",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      range: { min: 0, max: 10 },
    });
    commit.undo();
    commit.undo();
    expect(controller.state.filters[binding.clauseIds.range]).toBeUndefined();
  });

  it("undoes a clear back to the exact prior clause set", () => {
    const artifact = histogramArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);
    binding.apply({
      kind: "range-brush",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      range: { min: 10, max: 20 },
    });
    const cleared = binding.apply({
      kind: "clear",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
    });
    expect(controller.state.filters[binding.clauseIds.range]).toBeUndefined();

    cleared.undo();
    expect(controller.state.filters[binding.clauseIds.range]).toMatchObject({ value: [10, 20] });
  });
});

describe("bindAnalyticsToExploration: hover", () => {
  it("keeps hover out of the exploration reducer but shares it with peers", () => {
    const artifact = categoryArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);
    const seen: Array<string | undefined> = [];
    binding.subscribe((state) => seen.push(state.hoveredMarkKey));

    const commit = binding.apply({
      kind: "hover",
      adapterId: "test",
      artifactId: artifact.identity.artifactId,
      markKey: "s:OPEN",
    });

    expect(binding.linkedState.hoveredMarkKey).toBe("s:OPEN");
    expect(seen).toContain("s:OPEN");
    expect(commit.touchedClauseIds).toEqual([]);
    // The shareable snapshot is unchanged by hover.
    expect(Object.keys(controller.snapshot().state.filters)).toEqual([]);

    commit.undo();
    expect(binding.linkedState.hoveredMarkKey).toBeUndefined();
  });
});

describe("bindAnalyticsToExploration: lifecycle", () => {
  it("stops accepting interactions and drops listeners after dispose", () => {
    const artifact = categoryArtifact();
    const controller = view();
    const binding = bindAnalyticsToExploration(controller, artifact);
    let calls = 0;
    binding.subscribe(() => {
      calls += 1;
    });

    binding.dispose();
    controller.setFilter("unrelated", { field: "a", operator: "=", value: 1 });

    expect(calls).toBe(0);
    expect(binding.linkedState.selectedMarkKeys).toEqual([]);
    expect(() =>
      binding.apply({ kind: "clear", adapterId: "test", artifactId: artifact.identity.artifactId }),
    ).toThrowError(expect.objectContaining({ code: "disposed" }));
  });

  it("rejects a non-controller", () => {
    expect(() => bindAnalyticsToExploration({} as ExplorationViewController, categoryArtifact())).toThrowError(
      /ExplorationViewController/,
    );
  });
});

describe("pure projections", () => {
  it("projects linked state from a filters record without a controller", () => {
    const artifact = histogramArtifact();
    const clauseIds = { marks: "m", range: "r", temporal: "t" };
    const state = selectAnalyticsLinkedState(
      artifact,
      { r: { field: "severity", operator: "between", value: [0, 20] } },
      clauseIds,
    );
    expect(state.range).toEqual({ min: 0, max: 20 });
  });

  it("projects the clauses a linked state would write", () => {
    const artifact = categoryArtifact();
    const contributions = analyticsFilterContributions(
      artifact,
      { selectedMarkKeys: ["s:OPEN"] },
      { marks: "m", range: "r", temporal: "t" },
    );
    expect(contributions).toEqual([
      { id: "m", clause: { field: "status", operator: "=", value: "OPEN", appliesTo: ["incidents"] } },
    ]);
  });
});
