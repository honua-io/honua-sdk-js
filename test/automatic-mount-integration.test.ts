import { describe, expect, it, vi } from "vitest";

import { createFilterRegistry } from "../src/filter-registry/index.js";
import {
  type AutomaticMapLibreIntegrationMap,
  HonuaAutomaticMapLibreIntegrationError,
  attachAutomaticMapLibreInteractions,
} from "../src/map/index.js";
import type { AutomaticMapLibrePlan, MountedAutomaticMapLibreSource } from "../src/map/index.js";

interface Handler {
  event: string;
  layer: string;
  fn: (...args: unknown[]) => void;
}

class FakeInteractiveMap implements AutomaticMapLibreIntegrationMap {
  readonly featureState = new Map<string, Record<string, unknown>>();
  readonly filters = new Map<string, unknown>();
  readonly handlers: Handler[] = [];
  rendered: Array<{ id: string | number; layer: string }> = [];

  constructor(baseFilters: Record<string, unknown> = {}) {
    for (const [layer, filter] of Object.entries(baseFilters)) this.filters.set(layer, filter);
  }

  private key(id: string | number): string {
    return String(id);
  }
  setFilter(layerId: string, filter?: unknown): void {
    this.filters.set(layerId, filter);
  }
  getFilter(layerId: string): unknown {
    return this.filters.get(layerId);
  }
  setFeatureState(target: { source: string; id: string | number }, state: Record<string, unknown>): void {
    this.featureState.set(this.key(target.id), { ...this.featureState.get(this.key(target.id)), ...state });
  }
  getFeatureState(target: { source: string; id: string | number }): Record<string, unknown> {
    return this.featureState.get(this.key(target.id)) ?? {};
  }
  removeFeatureState(target: { source: string; id: string | number }, key?: string): void {
    if (key === undefined) this.featureState.delete(this.key(target.id));
    else {
      const current = this.featureState.get(this.key(target.id));
      if (current) delete current[key];
    }
  }
  on(event: string, layer: string, fn: (...args: unknown[]) => void): void {
    this.handlers.push({ event, layer, fn });
  }
  off(event: string, layer: string, fn: (...args: unknown[]) => void): void {
    const index = this.handlers.findIndex((h) => h.event === event && h.layer === layer && h.fn === fn);
    if (index >= 0) this.handlers.splice(index, 1);
  }
  queryRenderedFeatures(_geometry?: unknown, options?: { layers?: readonly string[] }): readonly unknown[] {
    const layers = options?.layers;
    return this.rendered
      .filter((f) => !layers || layers.includes(f.layer))
      .map((f) => ({ id: f.id, layer: f.layer, properties: {}, geometry: { type: "Point", coordinates: [0, 0] } }));
  }
  unproject(): readonly [number, number] {
    return [0, 0];
  }
  emit(event: string, layer: string, id?: string | number): void {
    for (const h of this.handlers.filter((entry) => entry.event === event && entry.layer === layer)) {
      h.fn(id === undefined ? {} : { features: [{ id }] });
    }
  }
}

function fakeMounted(overrides: Partial<MountedAutomaticMapLibreSource> = {}): MountedAutomaticMapLibreSource {
  const plan = { kind: "honua.maplibre-source-plan" } as unknown as AutomaticMapLibrePlan;
  return {
    strategy: "geojson-query",
    sourceId: "honua-parcels",
    layerIds: ["honua-parcels-features-point", "honua-parcels-features-polygon"],
    state: "ready",
    diagnostics: [],
    ready: Promise.resolve(plan),
    refresh: vi.fn(async () => plan),
    cancel: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as MountedAutomaticMapLibreSource;
}

describe("attachAutomaticMapLibreInteractions", () => {
  it("toggles selection feature-state on click across mounted layers", () => {
    const map = new FakeInteractiveMap();
    const changes: Array<readonly (string | number)[]> = [];
    const integration = attachAutomaticMapLibreInteractions(map, fakeMounted(), {
      onSelectionChange: (ids) => changes.push([...ids]),
    });

    map.emit("click", "honua-parcels-features-point", 7);
    expect(map.getFeatureState({ source: "honua-parcels", id: 7 })).toEqual({ selected: true });
    expect([...integration.selectedIds]).toEqual([7]);

    // Single-select: clicking a polygon feature clears the point selection.
    map.emit("click", "honua-parcels-features-polygon", 12);
    expect(map.getFeatureState({ source: "honua-parcels", id: 7 })).toEqual({ selected: false });
    expect([...integration.selectedIds]).toEqual([12]);

    // Clicking the same feature again deselects it.
    map.emit("click", "honua-parcels-features-polygon", 12);
    expect([...integration.selectedIds]).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });

  it("composes runtime filters with a layer's baked-in geometry filter", () => {
    const base = ["==", ["geometry-type"], "Point"];
    const map = new FakeInteractiveMap({
      "honua-parcels-features-point": base,
      "honua-parcels-features-polygon": null,
    });
    const integration = attachAutomaticMapLibreInteractions(map, fakeMounted());

    integration.setRuntimeFilter(["==", ["get", "status"], "active"]);
    expect(map.getFilter("honua-parcels-features-point")).toEqual(["all", base, ["==", ["get", "status"], "active"]]);
    // Layers without a base filter receive the runtime filter directly.
    expect(map.getFilter("honua-parcels-features-polygon")).toEqual(["==", ["get", "status"], "active"]);

    // Clearing restores the original base filter (not undefined) where present.
    integration.setRuntimeFilter(undefined);
    expect(map.getFilter("honua-parcels-features-point")).toEqual(base);
    expect(map.getFilter("honua-parcels-features-polygon")).toBeUndefined();
  });

  it("projects a bound filter registry to layers and unsubscribes cleanly", () => {
    const map = new FakeInteractiveMap();
    const integration = attachAutomaticMapLibreInteractions(map, fakeMounted());
    const registry = createFilterRegistry();
    const unbind = integration.bindFilterRegistry(registry, { sourceId: "honua-parcels" });

    registry.upsert({
      id: "status",
      owner: { kind: "control", id: "status-picker" },
      field: "status",
      operator: "=",
      value: "active",
    });
    expect(integration.appliedFilter).toBeDefined();
    const applied = map.getFilter("honua-parcels-features-point");
    expect(JSON.stringify(applied)).toContain("status");

    unbind();
    registry.upsert({
      id: "kind",
      owner: { kind: "control", id: "kind-picker" },
      field: "kind",
      operator: "=",
      value: "res",
    });
    // After unbinding, further registry changes no longer touch the layers.
    expect(JSON.stringify(map.getFilter("honua-parcels-features-point"))).not.toContain("kind");
  });

  it("applies realtime feature-state deltas without a reload", () => {
    const map = new FakeInteractiveMap();
    const integration = attachAutomaticMapLibreInteractions(map, fakeMounted());
    integration.applyRealtimeFeatureState([
      { id: 3, state: { status: "responding" } },
      { id: 9, state: { status: "cleared" } },
    ]);
    expect(map.getFeatureState({ source: "honua-parcels", id: 3 })).toEqual({ status: "responding" });
    expect(map.getFeatureState({ source: "honua-parcels", id: 9 })).toEqual({ status: "cleared" });
    integration.clearRealtimeFeatureState(3, "status");
    expect(map.getFeatureState({ source: "honua-parcels", id: 3 })).toEqual({});
    expect(integration.diagnostics.some((d) => d.code === "realtime-feature-state")).toBe(true);
  });

  it("hit-tests scoped to the mounted layers", async () => {
    const map = new FakeInteractiveMap();
    map.rendered = [
      { id: 1, layer: "honua-parcels-features-point" },
      { id: 2, layer: "other-layer" },
    ];
    const integration = attachAutomaticMapLibreInteractions(map, fakeMounted());
    const result = await integration.hitTest({ point: [10, 10] });
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.featureId).toBe(1);
  });

  it("delegates refresh to the mount for in-place edits", async () => {
    const mounted = fakeMounted();
    const integration = attachAutomaticMapLibreInteractions(new FakeInteractiveMap(), mounted);
    await integration.refresh({ sourceVersion: "v2" });
    expect(mounted.refresh).toHaveBeenCalledWith({ sourceVersion: "v2" });
  });

  it("removes every listener and clears feature-state on dispose (leak-free)", () => {
    const map = new FakeInteractiveMap();
    const integration = attachAutomaticMapLibreInteractions(map, fakeMounted());
    map.emit("click", "honua-parcels-features-point", 5);
    map.emit("mousemove", "honua-parcels-features-point", 5);
    expect(map.handlers.length).toBeGreaterThan(0);

    integration.dispose();
    expect(map.handlers).toHaveLength(0);
    expect(map.getFeatureState({ source: "honua-parcels", id: 5 })).toEqual({ selected: false, hover: false });
    expect(() => integration.setRuntimeFilter(undefined)).toThrow(HonuaAutomaticMapLibreIntegrationError);
  });

  it("degrades safely when the renderer lacks feature-state or filters", () => {
    const map: AutomaticMapLibreIntegrationMap = {};
    const integration = attachAutomaticMapLibreInteractions(map, fakeMounted());
    integration.setRuntimeFilter(["==", ["get", "x"], 1]);
    integration.applyRealtimeFeatureState([{ id: 1, state: { a: 1 } }]);
    expect(integration.diagnostics.filter((d) => d.code === "capability-unavailable").length).toBeGreaterThan(0);
  });
});
