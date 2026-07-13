import { describe, expect, it, vi } from "vitest";

import type { EditSketchTool } from "../src/contract/edit-sketch.js";
import { SketchCompat, resolveSketchToolBindingCompat } from "../src/esri-compat/sketch.js";

function fakeBinding() {
  return {
    setTool: vi.fn((tool: EditSketchTool) => ({ tool, state: "supported" })),
    select: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("esri-compat / Sketch terra-draw delegation", () => {
  it("feature-detects a sketch binding by its setTool method", () => {
    const binding = fakeBinding();
    expect(resolveSketchToolBindingCompat(binding)).toBe(binding);
    expect(resolveSketchToolBindingCompat(undefined)).toBeUndefined();
    expect(resolveSketchToolBindingCompat(null)).toBeUndefined();
    expect(resolveSketchToolBindingCompat("terra-draw")).toBeUndefined();
    expect(resolveSketchToolBindingCompat({ setTool: "not-a-function" })).toBeUndefined();
    // A binding without the optional select/cancel methods still qualifies.
    expect(resolveSketchToolBindingCompat({ setTool: () => undefined })).toBeDefined();
  });

  it("delegates create tool modes to the binding with compat tool names mapped", () => {
    const binding = fakeBinding();
    const sketch = new SketchCompat({ sketchBinding: binding });
    expect(sketch.delegatesToSketchBinding()).toBe(true);

    sketch.create("polyline");
    expect(binding.setTool).toHaveBeenCalledWith("line");
    sketch.cancel();

    for (const [compatTool, editTool] of [
      ["point", "point"],
      ["polygon", "polygon"],
      ["rectangle", "rectangle"],
      ["circle", "circle"],
    ] as const) {
      binding.setTool.mockClear();
      sketch.create(compatTool);
      expect(binding.setTool).toHaveBeenCalledWith(editTool);
      sketch.cancel();
    }
  });

  it("delegates update to select mode and cancel/reset to cancel", () => {
    const binding = fakeBinding();
    const sketch = new SketchCompat({ sketchBinding: binding });

    sketch.update([{ id: "g-1" }]);
    expect(binding.select).toHaveBeenCalledTimes(1);

    sketch.create("polygon");
    sketch.cancel();
    expect(binding.cancel).toHaveBeenCalledTimes(1);

    sketch.reset();
    expect(binding.cancel).toHaveBeenCalledTimes(2);
  });

  it("ends the drawing mode after single-mode completion but keeps continuous mode active", () => {
    const single = fakeBinding();
    const singleSketch = new SketchCompat({ sketchBinding: single, creationMode: "single" });
    singleSketch.create("polygon");
    singleSketch.complete({ geometry: {} });
    expect(single.cancel).toHaveBeenCalledTimes(1);

    const continuous = fakeBinding();
    const continuousSketch = new SketchCompat({ sketchBinding: continuous, creationMode: "continuous" });
    continuousSketch.create("polygon");
    continuousSketch.complete({ geometry: {} });
    expect(continuous.cancel).not.toHaveBeenCalled();
  });

  it("keeps the existing headless behavior when no binding is present", () => {
    const sketch = new SketchCompat();
    expect(sketch.delegatesToSketchBinding()).toBe(false);

    const events: string[] = [];
    sketch.eventBus.on("sketch.create-started", () => events.push("create-started"));
    sketch.eventBus.on("sketch.create-completed", () => events.push("create-completed"));

    sketch.create("polyline");
    expect(sketch.state).toBe("active");
    expect(sketch.activeTool).toBe("polyline");
    const result = sketch.complete({ geometry: {} });
    expect(result?.state).toBe("complete");
    expect(events).toEqual(["create-started", "create-completed"]);
  });

  it("keeps the existing behavior when the provided binding is not usable", () => {
    const sketch = new SketchCompat({ sketchBinding: { notSetTool: true } });
    expect(sketch.delegatesToSketchBinding()).toBe(false);
    sketch.create("point");
    expect(sketch.activeTool).toBe("point");
    expect(sketch.cancel()?.state).toBe("cancel");
  });

  it("emits identical compat events with and without a binding attached", () => {
    const record = (sketch: SketchCompat) => {
      const events: string[] = [];
      for (const name of [
        "sketch.create-started",
        "sketch.create-completed",
        "sketch.create-cancelled",
        "sketch.update-started",
        "sketch.reset",
      ]) {
        sketch.eventBus.on(name, () => events.push(name));
      }
      sketch.create("polygon");
      sketch.complete({ geometry: {} });
      sketch.create("point");
      sketch.cancel();
      sketch.update([{ id: "g-1" }]);
      sketch.reset();
      return events;
    };

    const plain = record(new SketchCompat());
    const bound = record(new SketchCompat({ sketchBinding: fakeBinding() }));
    expect(bound).toEqual(plain);
  });
});
