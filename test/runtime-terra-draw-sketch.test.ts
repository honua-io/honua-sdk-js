import { describe, expect, it, vi } from "vitest";

import {
  type AttachmentApi,
  type EditEnvelope,
  type Source,
  type SourceDescriptor,
  capabilities,
  createEditSketchWorkflow,
  createSnapIndex,
} from "../src/contract/index.js";
import { project, toWebMercator, toWgs84 } from "../src/geometry/index.js";
import {
  TERRA_DRAW_SKETCH_TOOL_MODES,
  type TerraDrawSketchFeature,
  type TerraDrawSketchFeatureId,
  type TerraDrawSketchFinishContext,
  type TerraDrawSketchInstance,
  bindTerraDrawSketch,
  createTerraDrawSketch,
  createTerraDrawSnapping,
  editSketchToolForTerraDrawMode,
  terraDrawSketchToolCapabilities,
} from "../src/runtime/index.js";

// ── Fake terra-draw instance (the real optional peer is never loaded) ─────────

type Listener = (...args: any[]) => void;

class FakeTerraDraw implements TerraDrawSketchInstance {
  public readonly listeners = new Map<string, Set<Listener>>();
  public readonly features = new Map<TerraDrawSketchFeatureId, TerraDrawSketchFeature>();
  public readonly modeHistory: string[] = [];
  public mode = "static";

  public on(event: string, listener: Listener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  public off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  public setMode(mode: string): void {
    this.mode = mode;
    this.modeHistory.push(mode);
  }

  public getSnapshot(): TerraDrawSketchFeature[] {
    return [...this.features.values()];
  }

  public getSnapshotFeature(id: TerraDrawSketchFeatureId): TerraDrawSketchFeature | undefined {
    return this.features.get(id);
  }

  public addFeatures(features: TerraDrawSketchFeature[]): unknown {
    for (const feature of features) this.features.set(feature.id ?? `generated-${this.features.size}`, feature);
    return features.map(() => ({ valid: true }));
  }

  public removeFeatures(ids: TerraDrawSketchFeatureId[]): void {
    for (const id of ids) this.features.delete(id);
  }

  /** Simulate a user finishing a sketch in the given mode. */
  public finishDraw(
    id: TerraDrawSketchFeatureId,
    mode: string,
    geometry: Record<string, unknown>,
    action = "draw",
  ): void {
    this.features.set(id, { id, type: "Feature", geometry, properties: { mode } });
    this.emit("finish", id, { mode, action } satisfies TerraDrawSketchFinishContext);
  }

  /** Simulate a select-mode delete of stored features. */
  public deleteFeatures(ids: TerraDrawSketchFeatureId[]): void {
    for (const id of ids) this.features.delete(id);
    this.emit("change", ids, "delete");
  }
}

function makeSource(applyEditsSpy?: (envelope: EditEnvelope) => void): Source {
  const descriptor: SourceDescriptor = {
    id: "assets",
    protocol: "geoservices-feature-service",
    locator: { url: "https://mock/", serviceId: "Assets", layerId: 0 },
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
    async applyEdits(envelope: EditEnvelope) {
      applyEditsSpy?.(envelope);
      return { added: [{ id: 1, success: true }], updated: [], deleted: [] };
    },
    async queryRelated(request: { sourceIds: readonly unknown[] }) {
      return { groups: request.sourceIds.map((sourceId: unknown) => ({ sourceId, features: [] })) };
    },
    attachments: unsupportedAttachments(),
    protocol() {
      return undefined;
    },
    adapter() {
      return undefined;
    },
  } as unknown as Source;
}

async function* emptyResultStream() {
  // no features
}

function unsupportedAttachments(): AttachmentApi {
  const unsupported = async () => {
    throw new Error("attachments unsupported");
  };
  return { list: unsupported, add: unsupported, update: unsupported, delete: unsupported } as unknown as AttachmentApi;
}

function makeWorkflow() {
  return createEditSketchWorkflow({
    source: makeSource(),
    kind: "create",
    feature: { attributes: {} },
    sketchTools: terraDrawSketchToolCapabilities(),
  });
}

const POLYGON: Record<string, unknown> = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ],
  ],
};

const LINE: Record<string, unknown> = {
  type: "LineString",
  coordinates: [
    [0, 0],
    [5, 5],
  ],
};

// ── Mode / tool mapping ───────────────────────────────────────

describe("runtime / terra-draw mode mapping", () => {
  it("maps every canonical terra-draw drawing mode to a sketch tool", () => {
    expect(editSketchToolForTerraDrawMode("point")).toBe("point");
    expect(editSketchToolForTerraDrawMode("marker")).toBe("point");
    expect(editSketchToolForTerraDrawMode("linestring")).toBe("line");
    expect(editSketchToolForTerraDrawMode("polyline")).toBe("line");
    expect(editSketchToolForTerraDrawMode("freehand-linestring")).toBe("line");
    expect(editSketchToolForTerraDrawMode("polygon")).toBe("polygon");
    expect(editSketchToolForTerraDrawMode("freehand")).toBe("polygon");
    expect(editSketchToolForTerraDrawMode("sector")).toBe("polygon");
    expect(editSketchToolForTerraDrawMode("sensor")).toBe("polygon");
    expect(editSketchToolForTerraDrawMode("rectangle")).toBe("rectangle");
    expect(editSketchToolForTerraDrawMode("angled-rectangle")).toBe("rectangle");
    expect(editSketchToolForTerraDrawMode("circle")).toBe("circle");
    expect(editSketchToolForTerraDrawMode("select")).toBeUndefined();
    expect(editSketchToolForTerraDrawMode("static")).toBeUndefined();
  });

  it("marks renderer-backed tools supported and leaves buffer unsupported", () => {
    const tools = terraDrawSketchToolCapabilities();
    expect(tools).toMatchObject({
      point: "supported",
      line: "supported",
      polygon: "supported",
      rectangle: "supported",
      circle: "supported",
    });
    expect(tools.buffer).toBeUndefined();

    const model = makeWorkflow();
    expect(model.toolCapability("rectangle").state).toBe("supported");
    expect(model.toolCapability("buffer").state).toBe("unsupported");
  });

  it("derives unsupported reasons from the registered mode list", () => {
    const tools = terraDrawSketchToolCapabilities(["point", "polygon"]);
    expect(tools.point).toBe("supported");
    expect(tools.polygon).toBe("supported");
    expect(tools.rectangle).toMatchObject({ state: "unsupported" });
    expect(tools.circle).toMatchObject({ state: "unsupported" });
  });
});

// ── Binding: finish / change adaptation ───────────────────────

describe("runtime / bindTerraDrawSketch", () => {
  it("applies finished draws to the workflow model with undo/redo history", () => {
    const draw = new FakeTerraDraw();
    const model = makeWorkflow();
    const onFinish = vi.fn();
    const handle = bindTerraDrawSketch(draw, { model, onFinish });

    draw.finishDraw("f-1", "polygon", POLYGON);
    let snapshot = model.snapshot();
    expect(snapshot.sketch.geometry).toEqual(POLYGON);
    expect(snapshot.sketch.tool).toBe("polygon");
    expect(snapshot.undo).toMatchObject({ canUndo: true, undoDepth: 1, redoDepth: 0 });
    expect(handle.activeFeatureId).toBe("f-1");
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "f-1", tool: "polygon", mode: "polygon", action: "draw", applied: true }),
    );

    // A select-mode edit of the same feature lands through the same path.
    const reshaped = { ...POLYGON, coordinates: [[...(POLYGON.coordinates as unknown[][])[0]]] };
    (reshaped.coordinates as number[][][])[0][1] = [12, 0];
    draw.finishDraw("f-1", "polygon", reshaped, "dragCoordinate");
    snapshot = model.snapshot();
    expect((snapshot.sketch.geometry as { coordinates: number[][][] }).coordinates[0][1]).toEqual([12, 0]);
    expect(snapshot.undo.undoDepth).toBe(2);

    expect(model.undo()).toBe(true);
    expect(model.snapshot().sketch.geometry).toEqual(POLYGON);
    expect(model.redo()).toBe(true);
    expect((model.snapshot().sketch.geometry as { coordinates: number[][][] }).coordinates[0][1]).toEqual([12, 0]);
  });

  it("maps freehand finishes to the polygon tool", () => {
    const draw = new FakeTerraDraw();
    const model = makeWorkflow();
    bindTerraDrawSketch(draw, { model });

    draw.finishDraw("f-free", "freehand", POLYGON);
    expect(model.snapshot().sketch.tool).toBe("polygon");
    expect(model.snapshot().sketch.geometry).toEqual(POLYGON);
  });

  it("surfaces unmapped modes and unsupported tools without touching the model", () => {
    const draw = new FakeTerraDraw();
    // Default contract capabilities: rectangle is unsupported without renderer support.
    const model = createEditSketchWorkflow({ source: makeSource(), kind: "create", feature: { attributes: {} } });
    const onFinish = vi.fn();
    bindTerraDrawSketch(draw, { model, onFinish });

    draw.finishDraw("f-custom", "my-custom-mode", POLYGON);
    expect(model.snapshot().sketch.geometry).toBeUndefined();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ mode: "my-custom-mode", applied: false }));

    draw.finishDraw("f-rect", "rectangle", POLYGON);
    expect(model.snapshot().sketch.geometry).toBeUndefined();
    expect(model.snapshot().undo.undoDepth).toBe(0);
    expect(onFinish).toHaveBeenLastCalledWith(expect.objectContaining({ tool: "rectangle", applied: false }));
  });

  it("honors featureFilter scoping", () => {
    const draw = new FakeTerraDraw();
    const model = makeWorkflow();
    const onFinish = vi.fn();
    bindTerraDrawSketch(draw, { model, onFinish, featureFilter: (id) => id === "mine" });

    draw.finishDraw("theirs", "polygon", POLYGON);
    expect(model.snapshot().sketch.geometry).toBeUndefined();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ featureId: "theirs", applied: false }));

    draw.finishDraw("mine", "polygon", POLYGON);
    expect(model.snapshot().sketch.geometry).toEqual(POLYGON);
  });

  it("stages an undoable null geometry when the tracked feature is deleted", () => {
    const draw = new FakeTerraDraw();
    const model = makeWorkflow();
    const onDelete = vi.fn();
    bindTerraDrawSketch(draw, { model, onDelete });

    draw.finishDraw("f-1", "linestring", LINE);
    expect(model.snapshot().sketch.geometry).toEqual(LINE);

    draw.deleteFeatures(["f-1"]);
    expect(model.snapshot().sketch.geometry).toBeNull();
    expect(onDelete).toHaveBeenCalledWith("f-1");

    // The delete is part of workflow history.
    expect(model.undo()).toBe(true);
    expect(model.snapshot().sketch.geometry).toEqual(LINE);
  });

  it("ignores deletes of untracked features", () => {
    const draw = new FakeTerraDraw();
    const model = makeWorkflow();
    bindTerraDrawSketch(draw, { model });

    draw.finishDraw("f-1", "point", { type: "Point", coordinates: [1, 2] });
    draw.deleteFeatures(["other"]);
    expect(model.snapshot().sketch.geometry).toEqual({ type: "Point", coordinates: [1, 2] });
  });

  it("mirrors model undo/redo back into terra-draw via syncFromModel", () => {
    const draw = new FakeTerraDraw();
    const model = makeWorkflow();
    const handle = bindTerraDrawSketch(draw, { model });

    draw.finishDraw("f-1", "polygon", POLYGON);
    const reshaped = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 0],
        ],
      ],
    };
    draw.finishDraw("f-1", "polygon", reshaped, "dragCoordinate");

    expect(handle.undo()).toBe(true);
    // terra-draw now holds the model's restored geometry under the same id.
    expect(draw.features.get("f-1")?.geometry).toEqual(POLYGON);
    expect(draw.features.get("f-1")?.properties).toEqual({ mode: "polygon" });

    expect(handle.redo()).toBe(true);
    expect(draw.features.get("f-1")?.geometry).toEqual(reshaped);

    // Undoing past the first draw clears the terra-draw feature.
    expect(handle.undo()).toBe(true);
    expect(handle.undo()).toBe(true);
    expect(draw.features.has("f-1")).toBe(false);
    expect(handle.undo()).toBe(false);
  });

  it("tracks selection events and detaches cleanly", () => {
    const draw = new FakeTerraDraw();
    const model = makeWorkflow();
    const onSelect = vi.fn();
    const onDeselect = vi.fn();
    const handle = bindTerraDrawSketch(draw, { model, onSelect, onDeselect });

    draw.emit("select", "f-9");
    expect(handle.selectedFeatureId).toBe("f-9");
    expect(onSelect).toHaveBeenCalledWith("f-9");
    draw.emit("deselect", "f-9");
    expect(handle.selectedFeatureId).toBeUndefined();
    expect(onDeselect).toHaveBeenCalledWith("f-9");

    handle.remove();
    draw.finishDraw("f-2", "polygon", POLYGON);
    expect(model.snapshot().sketch.geometry).toBeUndefined();
  });

  it("activates terra-draw modes through setTool and respects capability gating", () => {
    const draw = new FakeTerraDraw();
    const model = makeWorkflow();
    const handle = bindTerraDrawSketch(draw, { model });

    expect(handle.setTool("line").state).toBe("supported");
    expect(draw.mode).toBe("linestring");
    expect(model.snapshot().sketch.status).toBe("sketching");

    expect(handle.setTool("buffer").state).toBe("unsupported");
    expect(draw.mode).toBe("linestring");

    handle.select();
    expect(draw.mode).toBe("select");
    handle.cancel();
    expect(draw.mode).toBe("static");

    expect(TERRA_DRAW_SKETCH_TOOL_MODES.line).toBe("linestring");
    expect(TERRA_DRAW_SKETCH_TOOL_MODES.buffer).toBeUndefined();
  });
});

// ── Geometry round-trip (REQ-003) ─────────────────────────────

describe("runtime / terra-draw geometry round-trip", () => {
  it("reprojects finished geometry with the /geometry helpers and lands it in applyEdits unchanged", async () => {
    const envelopes: EditEnvelope[] = [];
    const model = createEditSketchWorkflow({
      source: makeSource((envelope) => envelopes.push(envelope)),
      kind: "create",
      feature: { attributes: {} },
      sketchTools: terraDrawSketchToolCapabilities(),
    });
    const draw = new FakeTerraDraw();
    const handle = bindTerraDrawSketch(draw, {
      model,
      // terra-draw emits EPSG:4326; this edit source stores Web Mercator.
      transformGeometry: (geometry) => toWebMercator(geometry as never, 4326) as unknown as Record<string, unknown>,
      restoreGeometry: (geometry) => toWgs84(geometry as never, 3857) as unknown as Record<string, unknown>,
    });

    draw.finishDraw("f-1", "point", { type: "Point", coordinates: [10, 20] });
    const stored = model.snapshot().sketch.geometry as { type: string; coordinates: [number, number] };
    const expected = project({ type: "Point", coordinates: [10, 20] }, 4326, 3857) as unknown as {
      coordinates: [number, number];
    };
    expect(stored.type).toBe("Point");
    expect(stored.coordinates[0]).toBeCloseTo(expected.coordinates[0], 6);
    expect(stored.coordinates[1]).toBeCloseTo(expected.coordinates[1], 6);

    // Submit flows through the edit-session applyEdits path unchanged.
    const result = await model.submit();
    expect(result.status).toBe("succeeded");
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].adds?.[0]?.geometry).toEqual(stored);

    // Undo after submit history reset: draw again and sync back to 4326.
    draw.finishDraw("f-1", "point", { type: "Point", coordinates: [30, 40] });
    expect(handle.undo()).toBe(true);
    const restored = draw.features.get("f-1")?.geometry as { coordinates: [number, number] };
    expect(restored.coordinates[0]).toBeCloseTo(10, 6);
    expect(restored.coordinates[1]).toBeCloseTo(20, 6);
  });
});

// ── Snapping bridge (REQ-004) ─────────────────────────────────

describe("runtime / createTerraDrawSnapping", () => {
  const context = {
    // Identity-ish projection: 1 degree = 10 pixels.
    project: (lng: number, lat: number) => ({ x: lng * 10, y: lat * 10 }),
  };

  function seededIndex() {
    const index = createSnapIndex();
    index.setSourceFeatures("hydrants", [{ id: 1, geometry: { type: "Point", coordinates: [10, 10] } }]);
    return index;
  }

  it("returns the snapped position for pointer events within tolerance", () => {
    const onResolve = vi.fn();
    const snap = createTerraDrawSnapping({
      index: seededIndex(),
      config: { enabled: true, tolerance: 12 },
      onResolve,
    });

    const snapped = snap({ lng: 10.5, lat: 10.5, containerX: 105, containerY: 105 }, context);
    expect(snapped).toEqual([10, 10]);
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ snapped: true }));

    const unsnapped = snap({ lng: 50, lat: 50, containerX: 500, containerY: 500 }, context);
    expect(unsnapped).toBeUndefined();
  });

  it("reads the live snapping config from a bound workflow model", () => {
    const model = createEditSketchWorkflow({
      source: makeSource(),
      kind: "create",
      feature: { attributes: {} },
      snapping: { enabled: true, tolerance: 12 },
    });
    const snap = createTerraDrawSnapping({ index: seededIndex(), model });

    expect(snap({ lng: 10.5, lat: 10.5, containerX: 105, containerY: 105 }, context)).toEqual([10, 10]);

    model.setSnapping({ enabled: false });
    expect(snap({ lng: 10.5, lat: 10.5, containerX: 105, containerY: 105 }, context)).toBeUndefined();
  });
});

// ── Dynamic factory (REQ-002) ─────────────────────────────────

const constructed: Record<string, unknown[]> = {};
const fakeInstance = () => {
  const draw = new FakeTerraDraw();
  return Object.assign(draw, {
    started: false,
    start() {
      (this as { started: boolean }).started = true;
    },
    stop() {
      (this as { started: boolean }).started = false;
    },
  });
};
let lastInstance: (FakeTerraDraw & { started: boolean }) | undefined;

vi.mock("terra-draw", () => {
  const record = (name: string) =>
    class {
      public readonly options: unknown;
      public constructor(options?: unknown) {
        this.options = options;
        constructed[name] = [...(constructed[name] ?? []), options];
      }
    };
  return {
    TerraDraw: class {
      public constructor(options: { adapter: unknown; modes: unknown[] }) {
        constructed.TerraDraw = [...(constructed.TerraDraw ?? []), options];
        lastInstance = fakeInstance() as FakeTerraDraw & { started: boolean };
        // biome-ignore lint/correctness/noConstructorReturn: test double returns the shared fake
        return lastInstance as unknown as object;
      }
    },
    TerraDrawPointMode: record("point"),
    TerraDrawLineStringMode: record("linestring"),
    TerraDrawPolygonMode: record("polygon"),
    TerraDrawRectangleMode: record("rectangle"),
    TerraDrawCircleMode: record("circle"),
    TerraDrawFreehandMode: record("freehand"),
    TerraDrawSelectMode: record("select"),
  };
});

vi.mock("terra-draw-maplibre-gl-adapter", () => ({
  TerraDrawMapLibreGLAdapter: class {
    public constructor(options: { map: unknown }) {
      constructed.adapter = [...(constructed.adapter ?? []), options];
    }
  },
}));

describe("runtime / createTerraDrawSketch", () => {
  it("dynamically loads the optional peers, wires snapping, and binds the model", async () => {
    const model = makeWorkflow();
    const index = createSnapIndex();
    const map = { fake: "maplibre-map" };
    const controller = await createTerraDrawSketch(map, {
      model,
      snapping: { index, config: { enabled: true, tolerance: 10 } },
    });

    expect(constructed.adapter?.at(-1)).toEqual({ map });
    expect(lastInstance?.started).toBe(true);
    // Snapping bridged into the modes that accept a custom snapping hook.
    const linestringOptions = constructed.linestring?.at(-1) as { snapping?: { toCustom?: unknown } };
    const polygonOptions = constructed.polygon?.at(-1) as { snapping?: { toCustom?: unknown } };
    expect(typeof linestringOptions.snapping?.toCustom).toBe("function");
    expect(typeof polygonOptions.snapping?.toCustom).toBe("function");
    expect(constructed.select?.at(-1)).toMatchObject({
      flags: expect.objectContaining({ polygon: expect.anything() }),
    });

    // The controller drives the model through the shared binding.
    controller.setTool("polygon");
    expect(lastInstance?.mode).toBe("polygon");
    lastInstance?.finishDraw("f-1", "polygon", POLYGON);
    expect(model.snapshot().sketch.geometry).toEqual(POLYGON);

    controller.stop();
    expect(lastInstance?.started).toBe(false);
    lastInstance?.finishDraw("f-2", "polygon", POLYGON);
    expect(model.snapshot().undo.undoDepth).toBe(1);
  });
});
