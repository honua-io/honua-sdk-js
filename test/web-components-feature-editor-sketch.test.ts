import { describe, expect, it, vi } from "vitest";

import type { Capability, EditEnvelope, EditResult, Source } from "../src/contract/types.js";
import type {
  TerraDrawSketchFeature,
  TerraDrawSketchFeatureId,
  TerraDrawSketchInstance,
} from "../src/runtime/terra-draw-sketch.js";
import { bindEditorSketch } from "../src/web-components/feature-editor-sketch.js";
import { createFeatureEditorWorkflow } from "../src/web-components/feature-editor-workflow.js";

/**
 * The app-platform sketch default (issue #680, REQ-002). Verified against a
 * duck-typed terra-draw instance so the optional peer is never required: the
 * adapter must report terra-draw's real tool support into the workflow and stay
 * bound as the editor opens successive drafts.
 */

const ok = (
  added: EditResult["added"] = [],
  updated: EditResult["updated"] = [],
  deleted: EditResult["deleted"] = [],
): EditResult => ({ added, updated, deleted });

function makeSource(capabilities: readonly Capability[] = ["query", "applyEdits"]): Source {
  const caps = new Set<Capability>(capabilities);
  return {
    descriptor: {
      id: "parcels",
      protocol: "geoservices-feature-service",
      locator: { url: "https://example.test/FeatureServer/0" },
      capabilities: caps,
      schema: { fields: [{ name: "label", type: "esriFieldTypeString", alias: "Label" }], primaryKey: "OBJECTID" },
    },
    capabilities: caps,
    applyEdits: vi.fn(async (envelope: EditEnvelope) => {
      if (envelope.adds?.length) return ok([{ id: 7, success: true }]);
      if (envelope.updates?.length) return ok([], [{ id: envelope.updates[0]?.id ?? 1, success: true }]);
      return ok();
    }),
    attachments: { add: vi.fn(), update: vi.fn(), delete: vi.fn(), list: vi.fn(), query: vi.fn() },
  } as unknown as Source;
}

interface FakeDraw {
  on(event: string, listener: (...args: never[]) => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
  setMode(mode: string): void;
  getSnapshot(): TerraDrawSketchFeature[];
  addFeatures(features: TerraDrawSketchFeature[]): void;
  removeFeatures(ids: TerraDrawSketchFeatureId[]): void;
  emitFinish(id: TerraDrawSketchFeatureId, mode: string): void;
  listenerCount(event: string): number;
  readonly modes: string[];
  features: TerraDrawSketchFeature[];
}

function makeDraw(): FakeDraw {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const modes: string[] = [];
  const draw: FakeDraw = {
    features: [],
    modes,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    setMode(mode) {
      modes.push(mode);
    },
    getSnapshot() {
      return draw.features;
    },
    addFeatures(features) {
      draw.features = [...draw.features, ...features];
    },
    removeFeatures(ids) {
      draw.features = draw.features.filter((feature) => !ids.includes(feature.id as TerraDrawSketchFeatureId));
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    emitFinish(id, mode) {
      for (const listener of listeners.get("finish") ?? []) {
        (listener as unknown as (i: TerraDrawSketchFeatureId, c: { mode: string; action: string }) => void)(id, {
          mode,
          action: "draw",
        });
      }
    },
  };
  return draw;
}

/** The fake stands in for the duck-typed terra-draw surface. */
const asInstance = (draw: FakeDraw) => draw as unknown as TerraDrawSketchInstance;

describe("bindEditorSketch", () => {
  it("reports terra-draw's real tool support into the workflow", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource() });
    const draw = makeDraw();
    bindEditorSketch(asInstance(draw), { workflow });
    workflow.begin("create");
    const tools = Object.fromEntries((workflow.snapshot().sketch?.tools ?? []).map((tool) => [tool.tool, tool.state]));
    // The contract defaults mark these unsupported ("requires renderer support");
    // terra-draw provides them.
    expect(tools.rectangle).toBe("supported");
    expect(tools.circle).toBe("supported");
    expect(tools.buffer).toBe("unsupported");
  });

  it("marks a tool unsupported when its terra-draw mode is not registered", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource() });
    bindEditorSketch(asInstance(makeDraw()), { workflow, modes: ["point", "polygon"] });
    workflow.begin("create");
    const tools = Object.fromEntries((workflow.snapshot().sketch?.tools ?? []).map((tool) => [tool.tool, tool]));
    expect(tools.polygon?.state).toBe("supported");
    expect(tools.line?.state).toBe("unsupported");
    expect(tools.line?.reason).toMatch(/no terra-draw mode registered/i);
  });

  it("arms the terra-draw mode and applies a finished geometry to the open draft", async () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource() });
    const draw = makeDraw();
    const adapter = bindEditorSketch(asInstance(draw), { workflow });
    workflow.begin("create");
    await adapter.ready();

    expect(adapter.setTool("polygon").state).toBe("supported");
    expect(draw.modes).toContain("polygon");

    draw.features = [
      {
        id: "a",
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        properties: { mode: "polygon" },
      },
    ];
    draw.emitFinish("a", "polygon");
    expect(workflow.snapshot().sketch?.geometry).toMatchObject({ type: "Polygon" });
    expect(workflow.snapshot().dirty).toBe(true);
  });

  it("re-binds to each new draft so it keeps driving the editor after a submit", async () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource() });
    const draw = makeDraw();
    const adapter = bindEditorSketch(asInstance(draw), { workflow });

    workflow.begin("create");
    await adapter.ready();
    workflow.setValue("label", "first");
    await workflow.submit();

    workflow.begin("create");
    await adapter.ready();
    draw.features = [
      { id: "b", type: "Feature", geometry: { type: "Point", coordinates: [4, 5] }, properties: { mode: "point" } },
    ];
    draw.emitFinish("b", "point");
    // Without the re-bind this geometry would land on the discarded first draft.
    expect(workflow.snapshot().sketch?.geometry).toEqual({ type: "Point", coordinates: [4, 5] });
  });

  it("degrades to the workflow's own tool/undo path while no draft is open", () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource() });
    const adapter = bindEditorSketch(asInstance(makeDraw()), { workflow });
    expect(adapter.setTool("polygon").state).toBe("unsupported");
    expect(adapter.undo()).toBe(false);
    expect(adapter.redo()).toBe(false);
    expect(adapter.syncFromModel()).toBe(false);
  });

  it("mirrors undo back into terra-draw", async () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource() });
    const draw = makeDraw();
    const adapter = bindEditorSketch(asInstance(draw), { workflow });
    workflow.begin("create");
    await adapter.ready();
    adapter.setTool("point");
    draw.features = [
      { id: "c", type: "Feature", geometry: { type: "Point", coordinates: [9, 9] }, properties: { mode: "point" } },
    ];
    draw.emitFinish("c", "point");
    expect(workflow.snapshot().sketch?.geometry).toEqual({ type: "Point", coordinates: [9, 9] });

    expect(adapter.undo()).toBe(true);
    expect(workflow.snapshot().sketch?.geometry).toBeUndefined();
    expect(draw.features).toEqual([]);
  });

  it("switches terra-draw into select and static modes for reshape and cancel", async () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource() });
    const draw = makeDraw();
    const adapter = bindEditorSketch(asInstance(draw), { workflow });
    workflow.begin("create");
    await adapter.ready();
    adapter.select();
    adapter.cancel();
    expect(draw.modes).toEqual(expect.arrayContaining(["select", "static"]));
  });

  it("detaches every listener on remove and stops driving the workflow", async () => {
    const workflow = createFeatureEditorWorkflow({ source: makeSource() });
    const draw = makeDraw();
    const adapter = bindEditorSketch(asInstance(draw), { workflow });
    workflow.begin("create");
    await adapter.ready();
    expect(draw.listenerCount("finish")).toBe(1);

    adapter.remove();
    expect(draw.listenerCount("finish")).toBe(0);
    draw.features = [
      { id: "d", type: "Feature", geometry: { type: "Point", coordinates: [1, 1] }, properties: { mode: "point" } },
    ];
    draw.emitFinish("d", "point");
    expect(workflow.snapshot().sketch?.geometry).toBeUndefined();

    // A later draft must not resurrect the binding.
    workflow.begin("create");
    await adapter.ready();
    expect(draw.listenerCount("finish")).toBe(0);
  });
});
