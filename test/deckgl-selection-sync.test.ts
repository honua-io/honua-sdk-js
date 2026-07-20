import { describe, expect, it } from "vitest";

import type { DeckGlPickedSelection } from "../src/deckgl/index.js";
import { bindDeckGlPickToExploration, deckGlPickedSelectionTarget, selectedFeatureIdSet } from "../src/deckgl/index.js";
import { createExplorationContext } from "../src/exploration/context.js";

function pick(overrides: Partial<DeckGlPickedSelection> = {}): DeckGlPickedSelection {
  return {
    sourceId: "incidents-live",
    planId: "plan:sha256:abc",
    featureId: 101,
    rowIndex: 0,
    ...overrides,
  };
}

describe("deckGlPickedSelectionTarget", () => {
  it("converts a picked selection into a source-qualified exploration target", () => {
    expect(deckGlPickedSelectionTarget(pick())).toEqual({ sourceId: "incidents-live", id: 101 });
  });

  it("stringifies bigint feature ids since FeatureId is number | string", () => {
    expect(deckGlPickedSelectionTarget(pick({ featureId: 9_007_199_254_740_993n }))).toEqual({
      sourceId: "incidents-live",
      id: "9007199254740993",
    });
  });

  it("preserves string feature ids", () => {
    expect(deckGlPickedSelectionTarget(pick({ featureId: "incident-42" }))).toEqual({
      sourceId: "incidents-live",
      id: "incident-42",
    });
  });
});

describe("bindDeckGlPickToExploration", () => {
  it("replaces the exploration selection with the picked feature by default", () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents-live"] });
    const view = ctx.connectView({ id: "deck", role: "map" });
    const handler = bindDeckGlPickToExploration(view);

    handler(pick({ featureId: 101 }));

    expect(view.state.selection).toEqual([{ sourceId: "incidents-live", id: 101 }]);
  });

  it("adds to the existing selection when replace is false", () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents-live"] });
    const view = ctx.connectView({ id: "deck", role: "map" });
    const handler = bindDeckGlPickToExploration(view, { replace: false });

    handler(pick({ featureId: 101 }));
    handler(pick({ featureId: 102 }));

    expect(view.state.selection).toEqual([
      { sourceId: "incidents-live", id: 101 },
      { sourceId: "incidents-live", id: 102 },
    ]);
  });

  it("clears the selection when the handler is invoked with undefined and replace is true", () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents-live"] });
    const view = ctx.connectView({ id: "deck", role: "map" });
    const handler = bindDeckGlPickToExploration(view);

    handler(pick());
    expect(view.state.selection).toHaveLength(1);

    handler(undefined);
    expect(view.state.selection).toEqual([]);
  });

  it("leaves the selection untouched on undefined when replace is false", () => {
    const ctx = createExplorationContext({ datasetId: "d", sourceIds: ["incidents-live"] });
    const view = ctx.connectView({ id: "deck", role: "map" });
    const handler = bindDeckGlPickToExploration(view, { replace: false });

    handler(pick());
    handler(undefined);

    expect(view.state.selection).toHaveLength(1);
  });

  it("rejects a value that is not an ExplorationViewController", () => {
    expect(() => bindDeckGlPickToExploration({} as never)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });
});

describe("selectedFeatureIdSet", () => {
  it("filters the shared selection to one source's feature ids", () => {
    const selection = [
      { sourceId: "incidents-live", id: 101 },
      { sourceId: "incidents-live", id: 102 },
      { sourceId: "parcels", id: 5 },
      "raw-id",
    ] as const;

    expect(selectedFeatureIdSet(selection, "incidents-live")).toEqual(new Set([101, 102]));
    expect(selectedFeatureIdSet(selection, "parcels")).toEqual(new Set([5]));
    expect(selectedFeatureIdSet(selection, "unknown-source")).toEqual(new Set());
  });
});
