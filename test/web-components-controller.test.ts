import { describe, expect, it, vi } from "vitest";

import {
  createHonuaWebComponentController,
  createHonuaWebComponentControllerFromRuntime,
  defineHonuaWebComponents,
} from "../src/web-components/index.js";
import type { HonuaFeatureRecord, HonuaWebComponentRuntimeLike } from "../src/web-components/index.js";

const features: HonuaFeatureRecord[] = [
  {
    id: 1,
    sourceId: "incidents",
    title: "Harbor response district",
    attributes: { name: "Harbor response district", status: "Open", priority: "High" },
    geometry: { x: -157.87, y: 21.31 },
  },
  {
    id: 2,
    sourceId: "incidents",
    title: "Kakaako utility corridor",
    attributes: { name: "Kakaako utility corridor", status: "Monitoring", priority: "Medium" },
    geometry: { x: -157.86, y: 21.29 },
  },
];

function mapPackage() {
  return {
    mapPackageId: "component-test",
    format: "honua_map_package.v1" as const,
    sourceBindings: [],
    legend: [{ label: "Open incident", color: "#dc2626" }],
    initialView: { center: [-157.86, 21.3] as const, zoom: 10 },
    mapSpec: {
      version: 8 as const,
      sources: {
        incidents: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers: [
        {
          id: "incident-points",
          source: "incidents",
          type: "circle",
          metadata: { title: "Incident points" },
          paint: { "circle-color": "#dc2626" },
        },
      ],
    },
  };
}

describe("Honua web component controller", () => {
  it("creates map, layer, legend, table, and search state from plain TypeScript", async () => {
    const controller = createHonuaWebComponentController({
      mapPackage: mapPackage(),
      featuresBySource: { incidents: features },
      fieldsBySource: { incidents: ["name", "status", "priority"] },
      searchFields: ["name", "priority"],
    });

    const seenVisible: boolean[] = [];
    const handle = controller.subscribe((state) => {
      seenVisible.push(state.layers[0]?.visible ?? false);
    });

    controller.setLayerVisibility("incident-points", false);
    const table = await controller.queryFeatures("incidents", { fields: ["name", "status"] });
    const searchResults = await controller.search("harbor");
    controller.selectFeature({ sourceId: "incidents", featureId: 1 });

    handle.remove();

    expect(controller.getState().packageId).toBe("component-test");
    expect(controller.getState().layers[0]).toMatchObject({ title: "Incident points", visible: false });
    expect(controller.getState().legend[0]).toMatchObject({ label: "Open incident", color: "#dc2626" });
    expect(table.fields).toEqual(["name", "status"]);
    expect(table.rows).toHaveLength(2);
    expect(searchResults[0]).toMatchObject({ label: "Harbor response district", sourceId: "incidents" });
    expect(controller.getState().selection?.feature?.title).toBe("Harbor response district");
    expect(seenVisible.slice(0, 2)).toEqual([true, false]);
  });

  it("filters in-memory table rows and accepts realtime feature updates", async () => {
    const controller = createHonuaWebComponentController({
      mapPackage: mapPackage(),
      featuresBySource: { incidents: features },
    });

    controller.setFilter({ sourceId: "incidents", text: "kakaako" });
    expect((await controller.queryFeatures("incidents")).rows.map((row) => row.id)).toEqual([2]);

    controller.updateFeatures?.("incidents", [
      ...features,
      {
        id: 3,
        sourceId: "incidents",
        attributes: { name: "Kakaako backup shelter", status: "Open" },
      },
    ]);

    expect((await controller.queryFeatures("incidents")).rows.map((row) => row.id)).toEqual([2, 3]);
  });

  it("tracks source-qualified feature-state patches for renderers", () => {
    const controller = createHonuaWebComponentController({
      mapPackage: mapPackage(),
      featuresBySource: { incidents: features },
    });

    controller.setFeatureState({ sourceId: "incidents", featureId: 1 }, { selected: true });
    controller.setFeatureState({ sourceId: "incidents", featureId: 1 }, { hover: true });
    controller.setFeatureState({ sourceId: "incidents", featureId: 2, sourceLayer: "events" }, { selected: true });
    controller.selectFeature({ sourceId: "incidents", sourceLayer: "events", featureId: 2 });

    expect(controller.getState().featureStates).toEqual([
      { sourceId: "incidents", featureId: 1, state: { selected: true, hover: true } },
      { sourceId: "incidents", featureId: 2, sourceLayer: "events", state: { selected: true } },
    ]);
    expect(controller.getState().selection).toMatchObject({ sourceId: "incidents", sourceLayer: "events" });

    controller.removeFeatureState({ sourceId: "incidents", featureId: 1 }, "hover");
    controller.removeFeatureState({ sourceId: "incidents", featureId: 2, sourceLayer: "events" });

    expect(controller.getState().featureStates).toEqual([
      { sourceId: "incidents", featureId: 1, state: { selected: true } },
    ]);
  });

  it("adapts an existing runtime without taking over controller internals", async () => {
    const setLayerVisibility = vi.fn();
    const setViewState = vi.fn();
    const runtime = {
      mapPackage: mapPackage(),
      composedStyle: mapPackage().mapSpec,
      getLegend: () => [{ id: "open", label: "Open incident", color: "#dc2626" }],
      setLayerVisibility,
      setViewState,
      dataset: {
        source: () => ({
          query: async () => ({
            features: [{ attributes: { OBJECTID: 11, name: "Runtime feature" }, geometry: null }],
            totalCount: 1,
            exceededTransferLimit: false,
            fields: [{ name: "name" }],
          }),
        }),
      },
    } satisfies HonuaWebComponentRuntimeLike;

    const controller = createHonuaWebComponentControllerFromRuntime(runtime);
    controller.setLayerVisibility("incident-points", false);
    controller.setViewport({ zoom: 12 });
    const table = await controller.queryFeatures("incidents");
    const search = await createHonuaWebComponentControllerFromRuntime(runtime, {
      searchFields: ["name"],
    }).search("Runtime");

    expect(setLayerVisibility).toHaveBeenCalledWith("incident-points", false);
    expect(setViewState).toHaveBeenCalledWith({ zoom: 12 });
    expect(table.rows[0]).toMatchObject({ id: 11, title: "Runtime feature" });
    expect(controller.getState().featuresBySource.incidents?.[0]).toMatchObject({ id: 11, title: "Runtime feature" });
    expect(search[0]).toMatchObject({ sourceId: "incidents", featureId: 11, label: "Runtime feature" });
  });

  it("can be imported in Node and registers only when a registry is supplied", () => {
    const defined = new Map<string, CustomElementConstructor>();
    const registry = {
      get: (name: string) => defined.get(name),
      define: (name: string, ctor: CustomElementConstructor) => {
        defined.set(name, ctor);
      },
    } as unknown as CustomElementRegistry;

    defineHonuaWebComponents(registry);

    expect(defined.has("honua-map")).toBe(true);
    expect(defined.has("honua-feature-table")).toBe(true);
    expect(defined.has("honua-basemap-control")).toBe(true);
    expect(defined.has("honua-bookmarks")).toBe(true);
    expect(defined.has("honua-locate-control")).toBe(true);
    expect(defined.has("honua-measure-control")).toBe(true);
    expect(defined.has("honua-sketch-control")).toBe(true);
    expect(defined.has("honua-print-export")).toBe(true);
    expect(defined.has("honua-map-status")).toBe(true);
    expect(defined.has("honua-action-panel")).toBe(true);
  });
});
