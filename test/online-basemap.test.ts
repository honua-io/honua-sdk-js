import { createExpression, v8 } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it, vi } from "vitest";
import {
  HONUA_ONLINE_BASEMAP_STYLES,
  HonuaOnlineBasemapBinding,
  resolveHonuaOnlineBasemapStyle,
} from "../src/runtime/online-basemap.js";

function fixtureStyle() {
  return {
    version: 8,
    glyphs: "./fonts/{fontstack}/{range}.pbf",
    sprite: "./sprites/basic",
    sources: {
      regions: { type: "geojson", data: "./regions.geojson", attribution: "Reviewed fixture contributor" },
      photo: {
        type: "image",
        url: "./photo.png",
        coordinates: [
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      },
      video: {
        type: "video",
        urls: ["./clip.mp4"],
        coordinates: [
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      },
    },
    layers: [
      { id: "paper", type: "background", paint: { "background-pattern": "paper" } },
      { id: "regions", type: "fill", source: "regions", paint: { "fill-pattern": "hatch" } },
      { id: "boundary", type: "line", source: "regions", paint: { "line-pattern": "dash" } },
      { id: "buildings", type: "fill-extrusion", source: "regions", paint: { "fill-extrusion-pattern": "brick" } },
      {
        id: "optional-icon",
        type: "symbol",
        source: "regions",
        layout: { "icon-image": ["coalesce", ["get", "icon"], "fallback"] },
      },
      { id: "hidden-icon", type: "symbol", source: "regions", layout: { "icon-image": "" } },
      {
        id: "zoom-icon",
        type: "symbol",
        source: "regions",
        layout: { "icon-image": ["step", ["zoom"], "circle_11_black", 10, ""] },
      },
      {
        id: "icons",
        type: "symbol",
        source: "regions",
        layout: { "icon-image": ["coalesce", ["image", ["get", "icon"]], ["image", "fallback"]] },
      },
    ],
  };
}

function mapFixture() {
  const operational = { id: "incidents", type: "circle", source: "live", filter: ["==", "priority", "high"] };
  const sources = new Map<string, unknown>([
    ["live", { type: "geojson", data: { type: "FeatureCollection", features: [] } }],
  ]);
  const layers: Record<string, unknown>[] = [{ id: "host-background", type: "background" }, operational];
  const sprites = new Map<string, string>();
  let glyphs: string | undefined;
  const map = {
    sources,
    layers,
    sprites,
    operational,
    selected: new Set(["incident-1"]),
    popup: { id: "incident-1" },
    camera: { zoom: 11 },
    getStyle: () => ({ version: 8, sources: Object.fromEntries(sources), layers, glyphs }),
    setGlyphs: vi.fn((value: string | null) => {
      glyphs = value ?? undefined;
    }),
    addSprite: vi.fn((id: string, url: string) => {
      sprites.set(id, url);
    }),
    getSprite: () => [...sprites].map(([id, url]) => ({ id, url })),
    removeSprite: (id: string) => {
      sprites.delete(id);
    },
    addSource: (id: string, value: unknown) => {
      sources.set(id, value);
    },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => {
      sources.delete(id);
    },
    addLayer: vi.fn((value: unknown, beforeId?: string) => {
      const layer = value as Record<string, unknown>;
      const index = layers.findIndex((item) => item.id === beforeId);
      layers.splice(index < 0 ? layers.length : index, 0, layer);
    }),
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    removeLayer: (id: string) => {
      const index = layers.findIndex((layer) => layer.id === id);
      if (index >= 0) layers.splice(index, 1);
    },
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.find((item) => item.id === id);
      if (layer) layer.layout = { ...(layer.layout as object), [key]: value };
    },
    on: vi.fn((_event: string, _listener: (event: unknown) => void) => {}),
    off: vi.fn(),
  };
  return map;
}

const styleResponse = () => new Response(JSON.stringify(fixtureStyle()), { status: 200 });

describe("explicit online basemap policy", () => {
  it("resolves free defaults and self-hosted overrides without requesting anything", () => {
    expect(resolveHonuaOnlineBasemapStyle()).toBe(HONUA_ONLINE_BASEMAP_STYLES.positron);
    expect(resolveHonuaOnlineBasemapStyle({ theme: "dark" })).toBe(HONUA_ONLINE_BASEMAP_STYLES.dark);
    expect(resolveHonuaOnlineBasemapStyle({ styleUrl: " /self-hosted/style.json " })).toBe("/self-hosted/style.json");
    expect(() => resolveHonuaOnlineBasemapStyle({ styleUrl: " " })).toThrow(/must not be empty/);
  });

  it("normalizes complete styles, namespaces all image slots and preserves operational state across themes", async () => {
    const map = mapFixture();
    const onError = vi.fn();
    const binding = new HonuaOnlineBasemapBinding(map, { fetch: vi.fn(async () => styleResponse()), onError });
    expect(await binding.activate({ styleUrl: "https://fixtures.example/styles/light/style.json" })).toBe(true);
    expect(map.layers[0].id).toBe("host-background");
    expect(map.layers.at(-1)).toBe(map.operational);
    const paper = map.layers.find((layer) => String(layer.id).endsWith("-paper"));
    expect(paper?.paint).toEqual({ "background-pattern": expect.stringMatching(/default:paper$/) });
    for (const [layerId, property, image] of [
      ["regions", "fill-pattern", "hatch"],
      ["boundary", "line-pattern", "dash"],
      ["buildings", "fill-extrusion-pattern", "brick"],
    ]) {
      expect(map.layers.find((layer) => String(layer.id).endsWith(`-${layerId}`))?.paint).toEqual({
        [property]: expect.stringMatching(new RegExp(`default:${image}$`)),
      });
    }
    expect(map.layers.find((layer) => String(layer.id).endsWith("-hidden-icon"))?.layout).toEqual({ "icon-image": "" });
    const dynamicIcon = map.layers.find((layer) => String(layer.id).endsWith("-zoom-icon"))?.layout as Record<
      string,
      unknown
    >;
    expect(dynamicIcon["icon-image"]).toEqual([
      "step",
      ["zoom"],
      expect.stringMatching(/default:circle_11_black$/),
      10,
      "",
    ]);
    const regionSource = [...map.sources].find(([id]) => id.endsWith("-regions"))?.[1];
    expect(regionSource).toMatchObject({
      data: "https://fixtures.example/styles/light/regions.geojson",
      attribution: "Reviewed fixture contributor",
    });
    expect([...map.sources].find(([id]) => id.endsWith("-photo"))?.[1]).toMatchObject({
      url: "https://fixtures.example/styles/light/photo.png",
    });
    expect([...map.sources].find(([id]) => id.endsWith("-video"))?.[1]).toMatchObject({
      urls: ["https://fixtures.example/styles/light/clip.mp4"],
    });
    expect(await binding.activate({ theme: "dark" })).toBe(true);
    expect(map.operational.filter).toEqual(["==", "priority", "high"]);
    expect(map.selected).toEqual(new Set(["incident-1"]));
    expect(map.popup).toEqual({ id: "incident-1" });
    expect(map.camera).toEqual({ zoom: 11 });
    expect(onError).not.toHaveBeenCalled();
    binding.dispose();
    expect([...map.sources.keys()]).toEqual(["live"]);
    expect(map.layers).toEqual([{ id: "host-background", type: "background" }, map.operational]);
    expect(map.sprites.size).toBe(0);
    expect(map.getStyle().glyphs).toBeUndefined();
  });

  it("preserves null-coalesce fallback semantics in real MapLibre expression evaluation", async () => {
    const map = mapFixture();
    const binding = new HonuaOnlineBasemapBinding(map, { fetch: vi.fn(async () => styleResponse()), onError: vi.fn() });
    expect(await binding.activate({ styleUrl: "https://fixtures.example/style.json" })).toBe(true);
    const layer = map.layers.find((entry) => String(entry.id).endsWith("-optional-icon"));
    const value = (layer?.layout as Record<string, unknown>)["icon-image"];
    const expression = createExpression(value, v8.layout_symbol["icon-image"]);
    expect(expression.result, JSON.stringify(expression.value)).toBe("success");
    if (expression.result === "error") throw new Error(JSON.stringify(expression.value));
    const missing = expression.value.evaluateWithoutErrorHandling({ zoom: 1 }, { type: 1, properties: {} });
    const present = expression.value.evaluateWithoutErrorHandling(
      { zoom: 1 },
      { type: 1, properties: { icon: "airport_11" } },
    );
    expect(missing.name).toMatch(/default:fallback$/);
    expect(present.name).toMatch(/default:airport_11$/);
    binding.dispose();
  });

  it("reports owned asset failures without relabeling operational failures on the same server", async () => {
    const map = mapFixture();
    const onError = vi.fn();
    const binding = new HonuaOnlineBasemapBinding(map, { fetch: vi.fn(async () => styleResponse()), onError });
    expect(await binding.activate({ styleUrl: "https://fixtures.example/styles/light/style.json" })).toBe(true);
    const listener = map.on.mock.calls[0]?.[1] as unknown as (event: unknown) => void;
    listener({ sourceId: "live", error: new Error("https://fixtures.example/styles/light/regions.geojson failed") });
    listener({ error: new Error("https://fixtures.example/other-service failed") });
    expect(onError).not.toHaveBeenCalled();
    listener({ error: new Error("https://fixtures.example/styles/light/fonts/Example/0-255.pbf failed") });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Basemap unavailable"));
    binding.dispose();
  });

  it.each(["source", "layer", "sprite"])(
    "preserves foreign %s resources when another owner occupies a generated namespace",
    async (collision) => {
      const map = mapFixture();
      const foreign = { owner: "another SDK module instance" };
      let namespace = "";
      const getSource = map.getSource;
      map.getSource = (id: string) => {
        if (id.startsWith("honua-online-basemap-")) {
          namespace = id.slice(0, id.lastIndexOf("-") + 1);
          if (collision === "source") return foreign;
        }
        return getSource(id);
      };
      const getLayer = map.getLayer;
      map.getLayer = (id: string) =>
        collision === "layer" && id.startsWith("honua-online-basemap-") ? foreign : getLayer(id);
      const getSprite = map.getSprite;
      map.getSprite = () =>
        collision === "sprite" && namespace
          ? [{ id: `${namespace}default`, url: "https://host.example/sprite" }]
          : getSprite();
      const removals = [vi.spyOn(map, "removeSource"), vi.spyOn(map, "removeLayer"), vi.spyOn(map, "removeSprite")];
      const before = { sources: [...map.sources], layers: [...map.layers] };
      const onError = vi.fn();
      const binding = new HonuaOnlineBasemapBinding(map, { fetch: vi.fn(async () => styleResponse()), onError });
      expect(await binding.activate({ styleUrl: "https://fixtures.example/style.json" })).toBe(false);
      expect({ sources: [...map.sources], layers: map.layers }).toEqual(before);
      expect(map.setGlyphs).not.toHaveBeenCalled();
      expect(map.addSprite).not.toHaveBeenCalled();
      expect(map.addLayer).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("namespace collides"));
      binding.dispose();
      for (const remove of removals) expect(remove).not.toHaveBeenCalled();
    },
  );

  it.each(["sprite", "layer"])("rolls back a renderer that throws during %s installation", async (failure) => {
    const map = mapFixture();
    const onError = vi.fn();
    const binding = new HonuaOnlineBasemapBinding(map, { fetch: vi.fn(async () => styleResponse()), onError });
    expect(await binding.activate({ styleUrl: "https://fixtures.example/light/style.json" })).toBe(true);
    const before = {
      sources: [...map.sources],
      layers: [...map.layers],
      sprites: [...map.sprites],
      glyphs: map.getStyle().glyphs,
    };
    if (failure === "sprite")
      map.addSprite.mockImplementationOnce((id, url) => {
        map.sprites.set(id, url);
        throw new Error("sprite installation failed");
      });
    else
      map.addLayer.mockImplementationOnce((layer) => {
        map.layers.push(layer as Record<string, unknown>);
        throw new Error("layer installation failed");
      });
    expect(await binding.activate({ theme: "dark" })).toBe(false);
    expect({
      sources: [...map.sources],
      layers: map.layers,
      sprites: [...map.sprites],
      glyphs: map.getStyle().glyphs,
    }).toEqual(before);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Operational data and controls remain available"));
    // A failed install was not cached as an active definition.
    expect(await binding.activate({ theme: "dark" })).toBe(true);
    binding.dispose();
  });

  it("reports unavailable styles without changing the operational map", async () => {
    const map = mapFixture();
    const onError = vi.fn();
    const binding = new HonuaOnlineBasemapBinding(map, {
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
      onError,
    });
    expect(await binding.activate()).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/HTTP 503.*self-hosted/));
    expect([...map.sources.keys()]).toEqual(["live"]);
    expect(map.layers).toHaveLength(2);
    expect(map.setGlyphs).not.toHaveBeenCalled();
    binding.dispose();
  });
});
