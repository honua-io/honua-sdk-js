import { describe, expect, test } from "vitest";

import { HonuaBasemapStyleBinding } from "../../src/controls/basemap-style-binding.js";
import { HonuaBasemapSwitcherElement, defineHonuaControls } from "../../src/controls/basemap-switcher.js";
import type { HonuaBasemapDefinition, HonuaBasemapSwitcherChangeDetail } from "../../src/controls/types.js";

interface MockCall {
  method: string;
  args: unknown[];
}

interface MockLayer {
  id: string;
  layout?: Record<string, unknown>;
  [key: string]: unknown;
}

interface MockMap {
  _calls: MockCall[];
  _layers: MockLayer[];
  _sources: Map<string, unknown>;
  addSource(id: string, source: unknown): void;
  removeSource(id: string): void;
  getSource(id: string): unknown;
  addLayer(layer: unknown, beforeId?: string): void;
  removeLayer(id: string): void;
  getLayer(id: string): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): void;
  getStyle(): unknown;
  visibility(layerId: string): string;
  layerOrder(): string[];
}

/**
 * Stateful MapLibre map stub following the duck-typed mock pattern of
 * test/runtime-style-interactions.test.ts, with enough style bookkeeping to
 * assert layer order and visibility. Throws on duplicate adds and on layout
 * updates for missing layers, like the real maplibre-gl Map.
 */
function makeMockMap(initialLayers: MockLayer[] = []): MockMap {
  const calls: MockCall[] = [];
  const layers: MockLayer[] = initialLayers.map((layer) => ({ ...layer }));
  const sources = new Map<string, unknown>();

  function record(method: string, args: unknown[]): void {
    calls.push({ method, args });
  }

  return {
    _calls: calls,
    _layers: layers,
    _sources: sources,
    addSource(id, source) {
      record("addSource", [id, source]);
      if (sources.has(id)) throw new Error(`Source "${id}" already exists.`);
      sources.set(id, source);
    },
    removeSource(id) {
      record("removeSource", [id]);
      sources.delete(id);
    },
    getSource(id) {
      return sources.has(id) ? { id } : undefined;
    },
    addLayer(layer, beforeId) {
      record("addLayer", [layer, beforeId]);
      const spec = layer as MockLayer;
      if (layers.some((existing) => existing.id === spec.id)) throw new Error(`Layer "${spec.id}" already exists.`);
      const index = beforeId === undefined ? -1 : layers.findIndex((existing) => existing.id === beforeId);
      if (index >= 0) layers.splice(index, 0, { ...spec });
      else layers.push({ ...spec });
    },
    removeLayer(id) {
      record("removeLayer", [id]);
      const index = layers.findIndex((existing) => existing.id === id);
      if (index >= 0) layers.splice(index, 1);
    },
    getLayer(id) {
      return layers.find((existing) => existing.id === id);
    },
    setLayoutProperty(layerId, name, value) {
      record("setLayoutProperty", [layerId, name, value]);
      const layer = layers.find((existing) => existing.id === layerId);
      if (!layer) throw new Error(`Layer "${layerId}" does not exist.`);
      layer.layout = { ...layer.layout, [name]: value };
    },
    getStyle() {
      return { version: 8, sources: Object.fromEntries(sources), layers: layers.map((layer) => ({ ...layer })) };
    },
    visibility(layerId) {
      const layer = layers.find((existing) => existing.id === layerId);
      if (!layer) return "missing";
      return (layer.layout?.visibility as string | undefined) ?? "visible";
    },
    layerOrder() {
      return layers.map((layer) => layer.id);
    },
  };
}

/** Real-world shaped bases: pmtiles vector, raster imagery, vector+hillshade composite. */
function makeBases(): HonuaBasemapDefinition[] {
  const vectorSource = { type: "vector", url: "pmtiles://https://tiles.example/basemap.pmtiles" };
  const streetsLayers = [
    { id: "streets-land", type: "fill", source: "basemap-vec", "source-layer": "land" },
    { id: "streets-roads", type: "line", source: "basemap-vec", "source-layer": "roads" },
  ];
  return [
    {
      id: "streets",
      label: "Streets",
      kind: "vector",
      sources: { "basemap-vec": vectorSource },
      layers: streetsLayers,
    },
    {
      id: "imagery",
      label: "Imagery",
      kind: "raster",
      sources: { imagery: { type: "raster", tiles: ["https://imagery.example/{z}/{x}/{y}.png"], tileSize: 256 } },
      layers: [{ id: "imagery-tiles", type: "raster", source: "imagery" }],
    },
    {
      id: "terrain",
      label: "Terrain",
      kind: "raster-dem-composite",
      sources: {
        "basemap-vec": vectorSource,
        "terrain-dem": { type: "raster-dem", url: "pmtiles://https://tiles.example/terrain.pmtiles" },
      },
      layers: [...streetsLayers, { id: "terrain-hillshade", type: "hillshade", source: "terrain-dem" }],
    },
  ];
}

function makeElement(): {
  element: HonuaBasemapSwitcherElement;
  attributes: Map<string, string>;
  events: CustomEvent<HonuaBasemapSwitcherChangeDetail>[];
} {
  const element = new HonuaBasemapSwitcherElement();
  const attributes = new Map<string, string>();
  const events: CustomEvent<HonuaBasemapSwitcherChangeDetail>[] = [];
  Object.assign(element, {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    dispatchEvent: (event: Event) => {
      events.push(event as CustomEvent<HonuaBasemapSwitcherChangeDetail>);
      return true;
    },
  });
  return { element, attributes, events };
}

describe("HonuaBasemapStyleBinding", () => {
  test("activating a base adds only that base's sources and layers", () => {
    const map = makeMockMap();
    const binding = new HonuaBasemapStyleBinding();
    binding.setMap(map);
    binding.setBases(makeBases());

    expect(binding.activate("streets")).toBe(true);

    expect([...map._sources.keys()]).toEqual(["basemap-vec"]);
    expect(map.layerOrder()).toEqual(["streets-land", "streets-roads"]);
    expect(map.visibility("streets-land")).toBe("visible");
    expect(map.visibility("imagery-tiles")).toBe("missing");
  });

  test("switching bases is exclusive: the new base shows and the others hide", () => {
    const map = makeMockMap();
    const binding = new HonuaBasemapStyleBinding();
    binding.setMap(map);
    binding.setBases(makeBases());

    binding.activate("streets");
    binding.activate("imagery");

    expect(map.visibility("imagery-tiles")).toBe("visible");
    expect(map.visibility("streets-land")).toBe("none");
    expect(map.visibility("streets-roads")).toBe("none");
    // Sources stay registered (cheap once layers are hidden), layers are reused.
    expect([...map._sources.keys()]).toEqual(["basemap-vec", "imagery"]);

    binding.activate("streets");
    expect(map.visibility("streets-land")).toBe("visible");
    expect(map.visibility("imagery-tiles")).toBe("none");
    expect(
      map._calls.filter((call) => call.method === "addLayer").map((call) => (call.args[0] as MockLayer).id),
    ).toEqual(["streets-land", "streets-roads", "imagery-tiles"]);
  });

  test("composite base shows all of its layers together and shares layers with sibling bases", () => {
    const map = makeMockMap();
    const binding = new HonuaBasemapStyleBinding();
    binding.setMap(map);
    binding.setBases(makeBases());

    binding.activate("terrain");
    expect([...map._sources.keys()]).toEqual(["basemap-vec", "terrain-dem"]);
    expect(map.layerOrder()).toEqual(["streets-land", "streets-roads", "terrain-hillshade"]);
    expect(map.visibility("terrain-hillshade")).toBe("visible");
    expect(map.visibility("streets-land")).toBe("visible");

    // Switching to the plain vector base keeps the shared layers visible and
    // only hides the hillshade half of the composite.
    binding.activate("streets");
    expect(map.visibility("streets-land")).toBe("visible");
    expect(map.visibility("streets-roads")).toBe("visible");
    expect(map.visibility("terrain-hillshade")).toBe("none");

    binding.activate("terrain");
    expect(map.visibility("terrain-hillshade")).toBe("visible");
  });

  test("base layers are inserted beneath layers the switcher does not own", () => {
    const map = makeMockMap([
      { id: "incident-halos", type: "circle", source: "incidents" },
      { id: "incident-points", type: "circle", source: "incidents" },
    ]);
    const binding = new HonuaBasemapStyleBinding();
    binding.setMap(map);
    binding.setBases(makeBases());

    binding.activate("terrain");
    expect(map.layerOrder()).toEqual([
      "streets-land",
      "streets-roads",
      "terrain-hillshade",
      "incident-halos",
      "incident-points",
    ]);

    binding.activate("imagery");
    expect(map.layerOrder()).toEqual([
      "streets-land",
      "streets-roads",
      "terrain-hillshade",
      "imagery-tiles",
      "incident-halos",
      "incident-points",
    ]);
  });

  test("activate returns false for unknown base ids and keeps the previous selection", () => {
    const map = makeMockMap();
    const binding = new HonuaBasemapStyleBinding();
    binding.setMap(map);
    binding.setBases(makeBases());

    binding.activate("streets");
    expect(binding.activate("nope")).toBe(false);
    expect(binding.activeId).toBe("streets");
    expect(map.visibility("streets-land")).toBe("visible");
  });

  test("selection made before a map is bound is applied when the map arrives", () => {
    const binding = new HonuaBasemapStyleBinding();
    binding.setBases(makeBases());
    expect(binding.activate("imagery")).toBe(true);

    const map = makeMockMap();
    binding.setMap(map);
    expect(map.visibility("imagery-tiles")).toBe("visible");
    expect([...map._sources.keys()]).toEqual(["imagery"]);
  });

  test("unbinding the map removes every layer and source the binding added", () => {
    const overlay: MockLayer = { id: "incident-points", type: "circle", source: "incidents" };
    const map = makeMockMap([overlay]);
    map._sources.set("incidents", { type: "geojson" });
    const binding = new HonuaBasemapStyleBinding();
    binding.setMap(map);
    binding.setBases(makeBases());
    binding.activate("terrain");

    binding.setMap(undefined);
    expect(map.layerOrder()).toEqual(["incident-points"]);
    expect([...map._sources.keys()]).toEqual(["incidents"]);
  });

  test("setBases prunes layers and sources of removed bases but keeps shared ones", () => {
    const map = makeMockMap();
    const binding = new HonuaBasemapStyleBinding();
    binding.setMap(map);
    const bases = makeBases();
    binding.setBases(bases);
    binding.activate("terrain");
    binding.activate("imagery");

    // Drop the composite; its hillshade layer and dem source must be removed,
    // while the shared vector source/layers (still used by "streets") remain.
    binding.setBases(bases.filter((base) => base.id !== "terrain"));
    expect(map.getLayer("terrain-hillshade")).toBeUndefined();
    expect(map.getSource("terrain-dem")).toBeUndefined();
    expect(map.getLayer("streets-land")).toBeDefined();
    expect(map.getSource("basemap-vec")).toBeDefined();
    expect(binding.activeId).toBe("imagery");
  });

  test("removing the active base clears the selection", () => {
    const map = makeMockMap();
    const binding = new HonuaBasemapStyleBinding();
    binding.setMap(map);
    const bases = makeBases();
    binding.setBases(bases);
    binding.activate("imagery");

    binding.setBases(bases.filter((base) => base.id !== "imagery"));
    expect(binding.activeId).toBeUndefined();
    expect(map.getLayer("imagery-tiles")).toBeUndefined();
  });
});

describe("HonuaBasemapSwitcherElement", () => {
  test("is registered for browser registries via defineHonuaControls", () => {
    const defined: Record<string, CustomElementConstructor> = {};
    const registry = {
      get: (name: string) => defined[name],
      define: (name: string, ctor: CustomElementConstructor) => {
        defined[name] = ctor;
      },
    } as unknown as CustomElementRegistry;
    defineHonuaControls(registry);
    expect(defined["honua-basemap-switcher"]).toBe(HonuaBasemapSwitcherElement);
    // Idempotent: re-defining must not throw.
    defineHonuaControls(registry);
  });

  test("select() switches exclusively and dispatches a change event with the active base id", () => {
    const { element, events } = makeElement();
    const map = makeMockMap();
    element.connect(map);
    element.bases = makeBases();

    // Wiring auto-activates the first base.
    expect(element.value).toBe("streets");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("change");
    expect(events[0]?.detail).toEqual({ value: "streets", kind: "vector" });

    expect(element.select("imagery")).toBe(true);
    expect(map.visibility("imagery-tiles")).toBe("visible");
    expect(map.visibility("streets-land")).toBe("none");
    expect(events).toHaveLength(2);
    expect(events[1]?.detail).toEqual({ value: "imagery", previousValue: "streets", kind: "raster" });
    expect(events[1]?.bubbles).toBe(true);
    expect(events[1]?.composed).toBe(true);
  });

  test("re-selecting the active base does not dispatch change", () => {
    const { element, events } = makeElement();
    element.connect(makeMockMap());
    element.bases = makeBases();
    const initialEvents = events.length;

    expect(element.select(element.value as string)).toBe(true);
    element.value = element.value;
    expect(events).toHaveLength(initialEvents);
  });

  test("value assignments made before bases arrive are honored once they do", () => {
    const { element, events } = makeElement();
    element.value = "terrain";
    expect(element.value).toBe("terrain");
    expect(events).toHaveLength(0);

    const map = makeMockMap();
    element.connect(map);
    element.bases = makeBases();

    expect(element.value).toBe("terrain");
    expect(map.visibility("terrain-hillshade")).toBe("visible");
    expect(events).toHaveLength(1);
    expect(events[0]?.detail.value).toBe("terrain");
    expect(events[0]?.detail.kind).toBe("raster-dem-composite");
  });

  test("the value attribute drives the initial selection", () => {
    const { element, attributes, events } = makeElement();
    attributes.set("value", "imagery");
    const map = makeMockMap();
    element.connect(map);
    element.bases = makeBases();

    expect(element.value).toBe("imagery");
    expect(map.visibility("imagery-tiles")).toBe("visible");
    expect(events.map((event) => event.detail.value)).toEqual(["imagery"]);
  });

  test("selection is reflected to the value attribute", () => {
    const { element, attributes } = makeElement();
    element.connect(makeMockMap());
    element.bases = makeBases();
    element.select("terrain");
    expect(attributes.get("value")).toBe("terrain");
  });

  test("bases attribute accepts JSON and ignores malformed input", () => {
    const { element } = makeElement();
    const map = makeMockMap();
    element.connect(map);

    element.attributeChangedCallback("bases", null, "not json");
    expect(element.bases).toHaveLength(0);

    element.attributeChangedCallback("bases", null, JSON.stringify(makeBases()));
    expect(element.bases.map((base) => base.id)).toEqual(["streets", "imagery", "terrain"]);
    expect(element.value).toBe("streets");
    expect(map.visibility("streets-land")).toBe("visible");

    element.attributeChangedCallback("value", "streets", "terrain");
    expect(element.value).toBe("terrain");
    expect(map.visibility("terrain-hillshade")).toBe("visible");
  });

  test("removing the active base falls back to the first remaining base", () => {
    const { element, events } = makeElement();
    const map = makeMockMap();
    element.connect(map);
    const bases = makeBases();
    element.bases = bases;
    element.select("imagery");

    element.bases = bases.filter((base) => base.id !== "imagery");
    expect(element.value).toBe("streets");
    expect(map.getLayer("imagery-tiles")).toBeUndefined();
    expect(map.visibility("streets-land")).toBe("visible");
    expect(events.at(-1)?.detail.value).toBe("streets");
  });

  test("detaching the map removes the switcher's layers and reconnecting restores the selection", () => {
    const { element } = makeElement();
    const map = makeMockMap([{ id: "incident-points", type: "circle", source: "incidents" }]);
    element.connect(map);
    element.bases = makeBases();
    element.select("terrain");

    element.map = undefined;
    expect(map.layerOrder()).toEqual(["incident-points"]);

    const nextMap = makeMockMap();
    element.connect(nextMap);
    expect(element.value).toBe("terrain");
    expect(nextMap.visibility("terrain-hillshade")).toBe("visible");
  });
});
