import { describe, expect, it } from "vitest";
import {
  UNBOUNDED,
  acceptScatterArtifact,
  analyticsArtifactIdentity,
  analyticsFilterContributions,
  analyticsProvenance,
  analyticsTableModel,
  bindAnalyticsToExploration,
  renderAnalyticsBrushHtml,
  renderAnalyticsTableHtml,
  resolveAnalyticsUpdateDisposition,
} from "../src/analytics/index.js";
import { createExplorationContext } from "../src/exploration/context.js";

function options() {
  return {
    identity: analyticsArtifactIdentity({ artifactId: "scatter", sourceId: "s", acceptedAt: "2026-11-10T00:00:00Z" }),
    provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
    dimension: "height",
    yDimension: "weight",
    measure: { field: "weight", fn: "avg" as const },
    marks: [
      { key: "a", label: "A", x: 10, value: 20, targets: [{ sourceId: "s", id: 1 }] },
      { key: "b", label: "B", x: 30, value: 40, targets: [{ sourceId: "s", id: 2 }] },
    ],
  };
}

function setup() {
  const artifact = acceptScatterArtifact(options());
  const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
  const view = ctx.connectView({ id: "chart", role: "chart" });
  const peer = ctx.connectView({ id: "map", role: "map" });
  const binding = bindAnalyticsToExploration(view, artifact);
  return { artifact, view, peer, binding };
}

const rectangle = { x: { min: 5, max: 15 }, y: { min: 10, max: 25 } };
const envelope = { adapterId: "test", artifactId: "scatter" };

describe("linked scatter", () => {
  it("projects both numeric axes, supports undo and preserves peer filters on clear", () => {
    const { artifact, view, peer, binding } = setup();
    peer.setFilter("peer", { field: "active", operator: "=", value: true });
    const commit = binding.apply({ ...envelope, kind: "rectangle-brush", rectangle });
    expect(Object.values(peer.state.filters)).toEqual(
      expect.arrayContaining([
        { field: "height", operator: "between", value: [5, 15], appliesTo: ["s"] },
        { field: "weight", operator: "between", value: [10, 25], appliesTo: ["s"] },
      ]),
    );
    expect(binding.linkedState.rectangle).toEqual(rectangle);
    expect(analyticsFilterContributions(artifact, binding.linkedState, binding.clauseIds)).toHaveLength(2);
    commit.undo();
    expect(Object.keys(view.state.filters)).toEqual(["peer"]);
    binding.apply({ ...envelope, kind: "rectangle-brush", rectangle });
    binding.apply({ ...envelope, kind: "clear" });
    expect(Object.keys(peer.state.filters)).toEqual(["peer"]);
    expect(binding.linkedState.rectangle).toBeUndefined();
  });

  it("publishes exact point targets and reflects peer selection changes", () => {
    const { peer, binding } = setup();
    binding.apply({ ...envelope, kind: "mark-select", markKeys: ["a"] });
    expect(peer.state.selection).toEqual([{ sourceId: "s", id: 1 }]);
    expect(binding.linkedState.selectedMarkKeys).toEqual(["a"]);
    peer.select([{ sourceId: "s", id: 2 }], { replace: true });
    expect(binding.linkedState.selectedMarkKeys).toEqual(["b"]);
    binding.apply({ ...envelope, kind: "clear", channel: "marks" });
    expect(peer.state.selection).toEqual([]);
  });

  it("preserves primitive feature IDs while isolating source-qualified targets", () => {
    const target = { sourceId: "s", id: 7 };
    const artifact = acceptScatterArtifact({
      ...options(),
      marks: [{ key: "a", label: "A", x: 10, value: 20, targets: [42, "feature-a", target] }],
    });
    target.id = 99;
    expect(artifact.marks[0].targets).toEqual([42, "feature-a", { sourceId: "s", id: 7 }]);
    expect(Object.isFrozen(artifact.marks[0].targets?.[2])).toBe(true);
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
    const view = ctx.connectView({ id: "chart", role: "chart" });
    const peer = ctx.connectView({ id: "map", role: "map" });
    bindAnalyticsToExploration(view, artifact).apply({ ...envelope, kind: "mark-select", markKeys: ["a"] });
    expect(peer.state.selection).toEqual([42, "feature-a", { sourceId: "s", id: 7 }]);
  });

  it("presents errors before either axis is known, while rejecting equal known axes", () => {
    const error = acceptScatterArtifact({
      ...options(),
      dimension: "",
      yDimension: "",
      marks: [],
      status: "error",
      message: "Source unavailable",
    });
    expect(analyticsTableModel(error).statusMessage).toBe("Source unavailable");
    expect(renderAnalyticsBrushHtml(error)).toBe("");
    expect(() =>
      acceptScatterArtifact({
        ...options(),
        yDimension: "height",
        marks: [],
        status: "error",
        message: "Source unavailable",
      }),
    ).toThrow("distinct fields");
  });

  it.each([
    { x: { min: Number.NaN, max: 15 }, y: rectangle.y },
    { x: rectangle.x, y: { min: 30, max: 20 } },
    { x: rectangle.x, y: { min: 0, max: Number.POSITIVE_INFINITY } },
  ])("rejects an invalid rectangle before mutating shared state", (invalid) => {
    const { view, binding } = setup();
    expect(() => binding.apply({ ...envelope, kind: "rectangle-brush", rectangle: invalid })).toThrow();
    expect(view.state.filters).toEqual({});
  });

  it("validates finite coordinates and distinct axis fields and freezes its accepted marks", () => {
    expect(() =>
      acceptScatterArtifact({ ...options(), marks: [{ key: "a", label: "A", x: Number.NaN, value: 1 }] }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error Runtime callers can supply invalid coordinates.
      acceptScatterArtifact({ ...options(), marks: [{ key: "a", label: "A", x: 1, value: null }] }),
    ).toThrow();
    expect(() => acceptScatterArtifact({ ...options(), yDimension: "height" })).toThrow();
    const input = options();
    const artifact = acceptScatterArtifact(input);
    input.marks[0].x = 999;
    expect(artifact.marks[0].x).toBe(10);
    expect(Object.isFrozen(artifact.marks[0])).toBe(true);
    expect(
      resolveAnalyticsUpdateDisposition(artifact, acceptScatterArtifact({ ...options(), yDimension: "age" }))
        .disposition,
    ).toBe("invalidate");
  });

  it("renders coordinates, keyboard brush controls, and truthful empty/error states without a DOM", () => {
    const artifact = acceptScatterArtifact(options());
    const model = analyticsTableModel(artifact);
    expect(model.columns).toEqual(["Point", "weight", "height"]);
    expect(model.rows[0]).toMatchObject({ value: "20", extent: "10" });
    expect(renderAnalyticsTableHtml(model)).toContain('aria-pressed="false"');
    const brush = renderAnalyticsBrushHtml(artifact, { selectedMarkKeys: [], rectangle });
    expect(brush.match(/type="number"/g)).toHaveLength(4);
    expect(brush).toContain('value="5"');
    expect(brush).toContain("Apply rectangle");
    expect(analyticsTableModel(acceptScatterArtifact({ ...options(), marks: [] })).rows).toEqual([]);
    expect(renderAnalyticsBrushHtml(acceptScatterArtifact({ ...options(), marks: [] }))).toBe("");
    expect(() => acceptScatterArtifact({ ...options(), marks: [], status: "error" })).toThrow();
    const error = acceptScatterArtifact({ ...options(), marks: [], status: "error", message: "Source unavailable" });
    expect(analyticsTableModel(error).statusMessage).toBe("Source unavailable");
  });
});
