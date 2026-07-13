import { describe, expect, it, vi } from "vitest";

import {
  type AttachmentApi,
  type SnapCandidate,
  type Source,
  type SourceDescriptor,
  capabilities,
  createEditSketchWorkflow,
  createSnapIndex,
} from "../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { type SnappingMap, bindEditSketchSnapping } from "../src/runtime/index.js";

interface FakeGeoJsonSource {
  data: unknown;
  setData(data: unknown): void;
}

class FakeMap implements SnappingMap {
  public readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  public readonly sources = new Map<string, FakeGeoJsonSource>();
  public readonly layers = new Map<string, Record<string, unknown>>();
  public readonly removedLayers: string[] = [];
  public readonly removedSources: string[] = [];

  public on(event: string, handler: (...args: unknown[]) => void): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  public off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  public emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  // Identity projection: geographic units are screen pixels.
  public project(position: readonly [number, number]): { x: number; y: number } {
    return { x: position[0], y: position[1] };
  }

  public addSource(id: string, source: Record<string, unknown>): void {
    const entry: FakeGeoJsonSource = {
      data: source.data,
      setData(data: unknown) {
        entry.data = data;
      },
    };
    this.sources.set(id, entry);
  }

  public removeSource(id: string): void {
    this.sources.delete(id);
    this.removedSources.push(id);
  }

  public addLayer(layer: Record<string, unknown>): void {
    this.layers.set(String(layer.id), layer);
  }

  public removeLayer(id: string): void {
    this.layers.delete(id);
    this.removedLayers.push(id);
  }

  public getSource(id: string): unknown {
    return this.sources.get(id);
  }

  public getLayer(id: string): unknown {
    return this.layers.get(id);
  }
}

function pointerEvent(x: number, y: number): { point: { x: number; y: number }; lngLat: { lng: number; lat: number } } {
  return { point: { x, y }, lngLat: { lng: x, lat: y } };
}

function seededIndex() {
  const index = createSnapIndex();
  index.setSourceFeatures("hydrants", [
    { id: 1, geometry: { type: "Point", coordinates: [0, 0] } },
    { id: 2, geometry: { type: "Point", coordinates: [100, 0] } },
  ]);
  return index;
}

describe("runtime / bindEditSketchSnapping", () => {
  it("resolves pointer-move into snap events with target feature and vertex info", () => {
    const map = new FakeMap();
    const onSnap = vi.fn();
    const onUnsnap = vi.fn();
    const handle = bindEditSketchSnapping(map, {
      index: seededIndex(),
      config: { enabled: true, tolerance: 10 },
      onSnap,
      onUnsnap,
    });

    map.emit("mousemove", pointerEvent(3, 4));
    expect(onSnap).toHaveBeenCalledTimes(1);
    expect(handle.current).toMatchObject({
      kind: "vertex",
      sourceId: "hydrants",
      featureId: 1,
      position: [0, 0],
      distance: 5,
      vertexIndex: 0,
    });

    // Moving within the same target does not re-fire onSnap.
    map.emit("mousemove", pointerEvent(2, 2));
    expect(onSnap).toHaveBeenCalledTimes(1);

    // Moving to a different target fires onSnap with the new candidate.
    map.emit("mousemove", pointerEvent(98, 2));
    expect(onSnap).toHaveBeenCalledTimes(2);
    expect(handle.current?.featureId).toBe(2);

    // Leaving all targets fires onUnsnap with the lost candidate.
    map.emit("mousemove", pointerEvent(50, 50));
    expect(handle.current).toBeUndefined();
    expect(onUnsnap).toHaveBeenCalledTimes(1);
    expect((onUnsnap.mock.calls[0][0] as SnapCandidate).featureId).toBe(2);
  });

  it("maintains the default indicator layer through snap and unsnap", () => {
    const map = new FakeMap();
    const handle = bindEditSketchSnapping(map, { index: seededIndex(), config: { enabled: true, tolerance: 10 } });

    expect(map.sources.has("honua-snap-indicator")).toBe(true);
    expect(map.layers.get("honua-snap-indicator")).toMatchObject({ type: "circle", source: "honua-snap-indicator" });

    map.emit("mousemove", pointerEvent(1, 0));
    const snappedData = map.sources.get("honua-snap-indicator")?.data as {
      features: Array<{ geometry: { coordinates: number[] }; properties: Record<string, unknown> }>;
    };
    expect(snappedData.features).toHaveLength(1);
    expect(snappedData.features[0].geometry.coordinates).toEqual([0, 0]);
    expect(snappedData.features[0].properties).toMatchObject({ kind: "vertex", sourceId: "hydrants", featureId: 1 });

    map.emit("mousemove", pointerEvent(50, 50));
    const clearedData = map.sources.get("honua-snap-indicator")?.data as { features: unknown[] };
    expect(clearedData.features).toHaveLength(0);

    handle.remove();
    expect(map.removedLayers).toContain("honua-snap-indicator");
    expect(map.removedSources).toContain("honua-snap-indicator");
  });

  it("skips the indicator when disabled and detaches handlers on remove", () => {
    const map = new FakeMap();
    const onSnap = vi.fn();
    const handle = bindEditSketchSnapping(map, {
      index: seededIndex(),
      config: { enabled: true, tolerance: 10 },
      indicator: false,
      onSnap,
    });
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);

    handle.remove();
    map.emit("mousemove", pointerEvent(1, 0));
    expect(onSnap).not.toHaveBeenCalled();
    expect(handle.current).toBeUndefined();
  });

  it("reads config from the bound sketch model and writes setConfig through it", () => {
    const map = new FakeMap();
    const model = createEditSketchWorkflow({ source: makeSource(), kind: "create", feature: { attributes: {} } });
    const handle = bindEditSketchSnapping(map, { index: seededIndex(), model, indicator: false });

    // Model snapping defaults to disabled: nothing snaps.
    map.emit("mousemove", pointerEvent(1, 0));
    expect(handle.current).toBeUndefined();

    handle.setConfig({ enabled: true, tolerance: 10 });
    expect(model.snappingConfig()).toMatchObject({ enabled: true, tolerance: 10 });
    map.emit("mousemove", pointerEvent(1, 0));
    expect(handle.current?.featureId).toBe(1);
    expect(model.snapshot().sketch.snapping.enabled).toBe(true);
  });

  it("applies snapped coordinates to the sketch model", () => {
    const map = new FakeMap();
    const model = createEditSketchWorkflow({
      source: makeSource(),
      kind: "create",
      feature: { attributes: {} },
      snapping: { enabled: true, tolerance: 10 },
    });
    const handle = bindEditSketchSnapping(map, { index: seededIndex(), model, indicator: false });

    map.emit("mousemove", pointerEvent(98, 3));
    expect(handle.current?.featureId).toBe(2);

    const applied = handle.applySketchGeometry("point", { type: "Point", coordinates: [98, 3] });
    expect(applied).toBe(true);
    expect(model.snapshot().sketch.geometry).toEqual({ type: "Point", coordinates: [100, 0] });
    expect(model.snapshot().undo.canUndo).toBe(true);

    // Without an active snap the geometry passes through unchanged.
    map.emit("mousemove", pointerEvent(50, 50));
    handle.applySketchGeometry("point", { type: "Point", coordinates: [50, 50] });
    expect(model.snapshot().sketch.geometry).toEqual({ type: "Point", coordinates: [50, 50] });
  });

  it("clears the active snap, indicator, and fires onUnsnap when disabled via setConfig", () => {
    const map = new FakeMap();
    const onUnsnap = vi.fn();
    const model = createEditSketchWorkflow({
      source: makeSource(),
      kind: "create",
      feature: { attributes: {} },
      snapping: { enabled: true, tolerance: 10 },
    });
    const handle = bindEditSketchSnapping(map, { index: seededIndex(), model, onUnsnap });

    map.emit("mousemove", pointerEvent(1, 0));
    expect(handle.current?.featureId).toBe(1);

    handle.setConfig({ enabled: false });
    expect(handle.current).toBeUndefined();
    expect(onUnsnap).toHaveBeenCalledTimes(1);
    expect((onUnsnap.mock.calls[0][0] as SnapCandidate).featureId).toBe(1);
    const indicatorData = map.sources.get("honua-snap-indicator")?.data as { features: unknown[] };
    expect(indicatorData.features).toHaveLength(0);

    // The stale snap position is not applied to the sketch model.
    handle.applySketchGeometry("point", { type: "Point", coordinates: [3, 4] });
    expect(model.snapshot().sketch.geometry).toEqual({ type: "Point", coordinates: [3, 4] });
  });

  it("never applies a snap acquired before snapping was disabled directly on the model", () => {
    const map = new FakeMap();
    const model = createEditSketchWorkflow({
      source: makeSource(),
      kind: "create",
      feature: { attributes: {} },
      snapping: { enabled: true, tolerance: 10 },
    });
    const handle = bindEditSketchSnapping(map, { index: seededIndex(), model, indicator: false });

    map.emit("mousemove", pointerEvent(98, 3));
    expect(handle.current?.featureId).toBe(2);

    // Bypass the handle: disable snapping on the workflow model directly.
    model.setSnapping({ enabled: false });
    handle.applySketchGeometry("point", { type: "Point", coordinates: [98, 3] });
    expect(model.snapshot().sketch.geometry).toEqual({ type: "Point", coordinates: [98, 3] });
  });

  it("exposes manual resolution helpers", () => {
    const map = new FakeMap();
    const handle = bindEditSketchSnapping(map, {
      index: seededIndex(),
      config: { enabled: true, tolerance: 10 },
      indicator: false,
    });

    expect(handle.snapPosition([2, 2])).toEqual([0, 0]);
    expect(handle.snapPosition([50, 50])).toEqual([50, 50]);

    const resolution = handle.resolve({ point: { x: 99, y: 1 }, position: [99, 1] });
    expect(resolution.snapped).toBe(true);
    expect(handle.current?.featureId).toBe(2);
    expect(handle.config()).toMatchObject({ enabled: true, tolerance: 10 });
  });

  it("ignores malformed pointer events", () => {
    const map = new FakeMap();
    const onSnap = vi.fn();
    const handle = bindEditSketchSnapping(map, {
      index: seededIndex(),
      config: { enabled: true, tolerance: 10 },
      indicator: false,
      onSnap,
    });
    map.emit("mousemove", undefined);
    map.emit("mousemove", { point: { x: 1 } });
    map.emit("mousemove", { lngLat: { lng: 1, lat: 1 } });
    expect(onSnap).not.toHaveBeenCalled();
    expect(handle.current).toBeUndefined();
  });
});

// ── Fakes ─────────────────────────────────────────────────────

function makeSource(): Source {
  const descriptor: SourceDescriptor = {
    id: "hydrants",
    protocol: "geoservices-feature-service",
    locator: { url: "https://mock/", serviceId: "Hydrants", layerId: 0 },
    capabilities: capabilities(["query", "applyEdits"]),
    schema: { primaryKey: "OBJECTID", fields: [] },
  };
  return {
    descriptor,
    capabilities: descriptor.capabilities,
    async query() {
      return { features: [], exceededTransferLimit: false };
    },
    async queryAll() {
      return { features: [], exceededTransferLimit: false };
    },
    async queryAggregate() {
      return { features: [], exceededTransferLimit: false };
    },
    async queryExtent() {
      return { extent: null };
    },
    stream() {
      return emptyResultStream();
    },
    async queryObjectIds() {
      return [];
    },
    async applyEdits() {
      return { added: [{ id: 1, success: true }], updated: [], deleted: [] };
    },
    async queryRelated(request) {
      return { groups: request.sourceIds.map((sourceId) => ({ sourceId, features: [] })) };
    },
    attachments: unsupportedAttachments(),
    protocol() {
      return undefined;
    },
    adapter() {
      return undefined;
    },
  };
}

async function* emptyResultStream() {
  // never yields
}

function unsupportedAttachments(): AttachmentApi {
  const fail = () => {
    throw new HonuaCapabilityNotSupportedError("attachments", "geoservices-feature-service", "hydrants");
  };
  return { query: fail, list: fail, add: fail, update: fail, delete: fail };
}
