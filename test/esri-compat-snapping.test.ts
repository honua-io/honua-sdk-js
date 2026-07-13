import { describe, expect, it, vi } from "vitest";

import { EditorCompat, SketchCompat, snappingOptionsToSnappingConfig } from "../src/esri-compat-entry.js";

describe("esri-compat / snappingOptions mapping", () => {
  it("defaults to disabled snapping with the contract tolerance", () => {
    expect(snappingOptionsToSnappingConfig()).toEqual({
      enabled: false,
      tolerance: 12,
      kinds: ["vertex", "edge"],
      sources: {},
    });
  });

  it("maps enabled, distance, and featureSources onto SnappingConfig", () => {
    const config = snappingOptionsToSnappingConfig({
      enabled: true,
      distance: 5,
      featureSources: [
        { layer: { id: "parcels" } },
        { id: "roads", enabled: false },
        { layer: { sourceId: "hydrants" }, enabled: true },
        { layer: {} }, // no derivable id: skipped
      ],
    });
    expect(config).toEqual({
      enabled: true,
      tolerance: 5,
      kinds: ["vertex", "edge"],
      sources: { parcels: true, roads: false, hydrants: true },
    });
  });

  it("disables every listed source when featureEnabled is false", () => {
    const config = snappingOptionsToSnappingConfig({
      enabled: true,
      featureEnabled: false,
      featureSources: [{ id: "parcels" }, { id: "roads", enabled: true }],
    });
    expect(config.sources).toEqual({ parcels: false, roads: false });
  });
});

describe("esri-compat / Sketch snapping options", () => {
  it("accepts snappingOptions at construction and exposes the mapped config", () => {
    const sketch = new SketchCompat({
      snappingOptions: { enabled: true, distance: 8, featureSources: [{ id: "parcels" }] },
    });
    expect(sketch.snappingOptions).toEqual({ enabled: true, distance: 8, featureSources: [{ id: "parcels" }] });
    expect(sketch.snappingConfig()).toEqual({
      enabled: true,
      tolerance: 8,
      kinds: ["vertex", "edge"],
      sources: { parcels: true },
    });
  });

  it("notifies watchers and the event bus when snapping options change", () => {
    const sketch = new SketchCompat();
    expect(sketch.snappingConfig().enabled).toBe(false);

    const watcher = vi.fn();
    const events = vi.fn();
    sketch.watch("snappingOptions", watcher);
    sketch.eventBus.on("sketch.snapping-options-changed", events);

    sketch.setSnappingOptions({ enabled: true, distance: 15 });
    expect(watcher).toHaveBeenCalledWith({ enabled: true, distance: 15 });
    expect(events).toHaveBeenCalledTimes(1);
    expect(sketch.snappingConfig()).toMatchObject({ enabled: true, tolerance: 15 });
  });
});

describe("esri-compat / Editor snapping options", () => {
  it("accepts snappingOptions and maps them like the Sketch shim", () => {
    const editor = new EditorCompat({
      snappingOptions: { enabled: true, featureSources: [{ layer: { id: "inspections" } }] },
    });
    expect(editor.snappingConfig()).toEqual({
      enabled: true,
      tolerance: 12,
      kinds: ["vertex", "edge"],
      sources: { inspections: true },
    });

    const watcher = vi.fn();
    editor.watch("snappingOptions", watcher);
    editor.setSnappingOptions({ enabled: false });
    expect(watcher).toHaveBeenCalledWith({ enabled: false });
    expect(editor.snappingConfig().enabled).toBe(false);
  });
});
