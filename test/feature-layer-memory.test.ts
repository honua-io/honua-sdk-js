import { describe, expect, it, vi } from "vitest";
import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { FeatureLayerCompat } from "../src/esri-compat/feature-layer.js";

const source = [1, 2, 3, 4].map((id) => ({ attributes: { id, name: `item ${id}` }, geometry: { x: id, y: -id } }));

describe("in-memory FeatureLayer queries", () => {
  it("projects fields and geometry and paginates without duplicating features", async () => {
    const layer = new FeatureLayerCompat({ source, objectIdField: "id", outFields: ["name"] });
    expect((await layer.queryFeatures({ returnGeometry: false })).features).toEqual(
      source.map(({ attributes }) => ({ attributes: { name: attributes.name } })),
    );
    expect(
      (await layer.queryFeatures({ outFields: "id, name", extraParams: { resultOffset: 1, resultRecordCount: 2 } }))
        .features,
    ).toEqual(source.slice(1, 3));
    expect(await layer.queryFeaturesAll({ pageSize: 2, outFields: ["*"] })).toEqual(source);
    const pages = [];
    for await (const page of layer.queryFeaturesStream({ pageSize: 2, outFields: ["*"] })) pages.push(page);
    expect(pages).toEqual([source.slice(0, 2), source.slice(2)]);
    expect((await layer.queryFeatures({ extraParams: { resultOffset: 4 } })).features).toEqual([]);
  });

  it("applies equality filters and rejects clauses it cannot evaluate", async () => {
    const layer = new FeatureLayerCompat({ source });
    expect((await layer.queryFeatures({ where: "id = 1" })).features).toEqual([source[0]]);
    await expect(layer.queryFeatures({ where: "id > 1" })).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(layer.queryFeatures({ where: "id = 1 OR id = 2" })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    await expect(layer.queryFeatures({ extraParams: { orderByFields: "id DESC" } })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    await expect(layer.queryFeatures({ extraParams: { resultOffset: -1 } })).rejects.toThrow(RangeError);
    layer.timeExtent = { start: new Date(0), end: new Date(1) };
    await expect(layer.queryFeatures()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    const filtered = new FeatureLayerCompat({ source, definitionExpression: "id = 1" });
    expect((await filtered.queryFeatures({ where: "1=1" })).features).toEqual([source[0]]);
    await expect(layer.queryFeatures({ signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it("answers auxiliary queries locally, independent of default outFields", async () => {
    const client = new HonuaClient({ baseUrl: "https://memory.invalid" });
    const network = vi.spyOn(client, "queryFeatures").mockRejectedValue(new Error("unexpected network"));
    const layer = new FeatureLayerCompat({ source, objectIdField: "id", outFields: ["name"], client });
    expect(await layer.queryObjectIds()).toEqual([1, 2, 3, 4]);
    expect(await layer.queryFeatureCount()).toBe(4);
    expect(await layer.queryExtent()).toEqual({ count: 4, extent: { xmin: 1, ymin: -4, xmax: 4, ymax: -1 } });
    expect(await layer.queryObjectIds({ where: "id = 1" })).toEqual([1]);
    expect(await layer.queryFeatureCount({ where: "id = 1" })).toBe(1);
    expect(await layer.queryExtent({ where: "id = 1" })).toEqual({
      count: 1,
      extent: { xmin: 1, ymin: -1, xmax: 1, ymax: -1 },
    });
    for (const query of [
      layer.queryObjectIds.bind(layer),
      layer.queryFeatureCount.bind(layer),
      layer.queryExtent.bind(layer),
    ]) {
      await expect(query({ where: "id > 1" })).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    }
    expect(network).not.toHaveBeenCalled();
    expect(await new FeatureLayerCompat({ source: [] }).queryExtent()).toEqual({ count: 0, extent: null });
  });

  it("computes extents for line, polygon, multipoint and envelope geometries", async () => {
    for (const geometry of [
      {
        paths: [
          [
            [1, 2],
            [3, 4],
          ],
        ],
      },
      {
        rings: [
          [
            [1, 2],
            [3, 4],
            [1, 2],
          ],
        ],
      },
      {
        points: [
          [1, 2],
          [3, 4],
        ],
      },
      { xmin: 1, ymin: 2, xmax: 3, ymax: 4 },
    ]) {
      const layer = new FeatureLayerCompat({ source: [{ attributes: {}, geometry }] });
      expect((await layer.queryExtent()).extent).toMatchObject({ xmin: 1, ymin: 2, xmax: 3, ymax: 4 });
    }
  });

  it("exposes configured fields before and after loading", async () => {
    const fields = [{ name: "id", type: "oid" }];
    const layer = new FeatureLayerCompat({ source: [], fields });
    expect(layer.listFields()).toEqual(fields);
    expect(layer.getField("id")).toEqual(fields[0]);
    expect(layer.hasField("id")).toBe(true);
    await layer.load();
    expect(layer.listFields()).toEqual(fields);
  });

  it("notifies watchers and lifecycle subscribers once when loaded", async () => {
    const layer = new FeatureLayerCompat({ source: [] });
    const events: unknown[] = [];
    layer.watch("loadStatus", (value) => events.push(value));
    layer.watch("loaded", (value) => events.push(value));
    layer.on("loading", () => events.push("loading-event"));
    layer.on("loaded", () => events.push("loaded-event"));
    await layer.load();
    await layer.load();
    expect(events).toEqual(["loading", "loading-event", true, "loaded", "loaded-event"]);
  });

  it("uses the service when both a URL and source are supplied", async () => {
    const client = new HonuaClient({ baseUrl: "https://example.test" });
    const query = vi.spyOn(client, "queryFeatures").mockResolvedValue({ features: [] });
    const layer = new FeatureLayerCompat({
      source,
      client,
      url: "https://example.test/rest/services/test/FeatureServer/0",
    });
    expect((await layer.queryFeatures()).features).toEqual([]);
    expect(query).toHaveBeenCalledOnce();
  });
});
