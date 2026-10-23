import { describe, expect, test, vi } from "vitest";
import { HonuaClient } from "../../src/core/client.js";
import {
  type HonuaMapPackage,
  applyStyleRefs,
  createOgcStyleRefResolver,
  fetchMapPackage,
  styleDocumentToRefBody,
  validateMapPackage,
} from "../../src/runtime/index.js";
import type { HonuaStyleSpecification } from "../../src/style/specification.js";

function mapPackage(): HonuaMapPackage {
  return {
    mapPackageId: "published-map",
    format: "honua_map_package.v1",
    sourceBindings: [],
    mapSpec: {
      version: 8,
      sources: { parcels: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: [
        {
          id: "places",
          type: "fill",
          source: "parcels",
          paint: { "fill-color": "white" },
          metadata: { "honua:compositionLayerId": "places", "honua:compositionSourceId": "parcels" },
        },
        { id: "places__outline", type: "line", source: "parcels", paint: { "line-color": "black" } },
      ],
    },
    styleRefs: [
      {
        styleId: "zoning",
        layerBindings: [
          { styleLayerId: "catalog-fill", targetLayerId: "places", layerType: "fill" },
          {
            styleLayerId: "catalog-fill",
            targetLayerId: "places__outline",
            layerType: "fill",
            properties: ["filter", "minzoom", "maxzoom", "visibility"],
          },
        ],
      },
    ],
  };
}

function catalog(color = "green"): HonuaStyleSpecification {
  return {
    version: 8,
    sources: { catalog: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    layers: [
      {
        id: "catalog-fill",
        type: "fill",
        source: "catalog",
        paint: { "fill-color": color },
        layout: { visibility: "visible", "fill-sort-key": 2 },
        filter: ["==", ["get", "zone"], "R"],
        minzoom: 3,
        metadata: {
          "honua:compositionLayerId": "wrong-owner",
          "honua:compositionSourceId": "wrong-source",
          credit: "Survey",
        },
      },
    ],
  };
}

function response(value: unknown, etag?: string): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...(etag ? { etag } : {}) },
  });
}

describe("live shared style render bindings", () => {
  test("projects an authorized catalog document through the same public mapping seam", async () => {
    const pkg = mapPackage();
    const bindings = pkg.styleRefs![0].layerBindings!;
    const doc = catalog();
    const projected = styleDocumentToRefBody(doc, bindings);
    const client = new HonuaClient({ baseUrl: "https://honua.test", fetchFn: async () => response(doc) });
    expect(projected).toEqual(await createOgcStyleRefResolver({ client })("zoning", undefined, bindings));
    expect(Object.keys(projected)).toEqual(["places", "places__outline"]);
    expect(projected.places.metadata).toEqual({ credit: "Survey" });
    expect(projected.places__outline.paint).toBeUndefined();
    expect(() => styleDocumentToRefBody(doc, [{ ...bindings[0], styleLayerId: "missing" }])).toThrow("rebind");
    expect(() => styleDocumentToRefBody(doc, [bindings[0], bindings[0]])).toThrow("multiple overrides");
  });

  test("reopens serialized mappings against current catalog appearance without changing sources or ownership", async () => {
    const original = mapPackage();
    const reopened = JSON.parse(JSON.stringify(original)) as HonuaMapPackage;
    let color = "green";
    let requests = 0;
    const client = new HonuaClient({
      baseUrl: "https://honua.test",
      fetchFn: async (url) => {
        expect(String(url)).toBe("https://honua.test/ogc/styles/zoning");
        requests++;
        return response(catalog(color));
      },
    });
    const resolver = createOgcStyleRefResolver({ client });
    const first = await applyStyleRefs(reopened.mapSpec, reopened, resolver);
    expect(first.layers[0]).toMatchObject({
      source: "parcels",
      paint: { "fill-color": "green" },
      metadata: { "honua:compositionLayerId": "places", "honua:compositionSourceId": "parcels", credit: "Survey" },
    });
    expect(first.layers[1]).toMatchObject({
      type: "line",
      paint: { "line-color": "black" },
      minzoom: 3,
      filter: ["==", ["get", "zone"], "R"],
      layout: { visibility: "visible" },
    });
    expect(first.layers[1].paint).not.toHaveProperty("fill-color");
    expect(first.layers[1].layout).not.toHaveProperty("fill-sort-key");
    color = "orange";
    const second = await applyStyleRefs(reopened.mapSpec, reopened, resolver);
    expect(second.layers[0].paint?.["fill-color"]).toBe("orange");
    expect(requests).toBe(2);
    expect(reopened).toEqual(original);
    expect(reopened.styleRefs?.[0].body).toBeUndefined();
  });

  test("a map's hidden target masks shared visibility and a hidden shared render stays hidden", async () => {
    const pkg = mapPackage();
    pkg.mapSpec.layers[0].layout = { visibility: "none" };
    const doc = catalog();
    const client = new HonuaClient({ baseUrl: "https://honua.test", fetchFn: async () => response(doc) });
    const resolver = createOgcStyleRefResolver({ client });
    expect((await applyStyleRefs(pkg.mapSpec, pkg, resolver)).layers[0].layout?.visibility).toBe("none");
    pkg.mapSpec.layers[0].layout = {};
    doc.layers[0].layout = { visibility: "none" };
    expect((await applyStyleRefs(pkg.mapSpec, pkg, resolver)).layers[0].layout?.visibility).toBe("none");
  });

  test.each(["missing", "duplicate", "type"])(
    "refuses a %s catalog selection instead of losing styling",
    async (change) => {
      const doc = catalog();
      if (change === "missing") doc.layers[0].id = "replacement";
      if (change === "duplicate") doc.layers.push({ ...doc.layers[0] });
      if (change === "type") doc.layers[0].type = "line";
      const client = new HonuaClient({ baseUrl: "https://honua.test", fetchFn: async () => response(doc) });
      const pkg = mapPackage();
      await expect(applyStyleRefs(pkg.mapSpec, pkg, createOgcStyleRefResolver({ client }))).rejects.toMatchObject({
        name: "HonuaMapPackageError",
        stage: "style-compose",
      });
    },
  );

  test.each(["missing", "type", "duplicate-reference", "duplicate-target", "source-property"])(
    "refuses %s target bindings before a fetch",
    async (change) => {
      const pkg = mapPackage();
      if (change === "missing") pkg.mapSpec.layers.shift();
      if (change === "type") pkg.mapSpec.layers[0].type = "line";
      if (change === "duplicate-reference") pkg.styleRefs = [pkg.styleRefs![0], pkg.styleRefs![0]];
      if (change === "duplicate-target")
        pkg.styleRefs![0].layerBindings = [pkg.styleRefs![0].layerBindings![0], pkg.styleRefs![0].layerBindings![0]];
      if (change === "source-property") {
        Object.assign(pkg.styleRefs![0].layerBindings![0], { properties: ["source"] });
      }
      expect(validateMapPackage(pkg).diagnostics).toContainEqual(
        expect.objectContaining({ code: "style-ref-invalid-binding", severity: "error" }),
      );
      const resolver = vi.fn(async () => ({ places: {}, places__outline: {} }));
      await expect(applyStyleRefs(pkg.mapSpec, pkg, resolver)).rejects.toMatchObject({
        name: "HonuaMapPackageError",
        stage: "style-compose",
      });
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  test("rejects custom resolvers that ignore the explicit target mappings", async () => {
    const pkg = mapPackage();
    await expect(
      applyStyleRefs(pkg.mapSpec, pkg, async () => ({ "catalog-fill": { paint: { "fill-color": "green" } } })),
    ).rejects.toMatchObject({ name: "HonuaMapPackageError", stage: "style-compose" });
  });

  test("package 304 still resolves live catalog changes and reports refreshed for runtime watchers", async () => {
    const pkg = mapPackage();
    let mapRequests = 0;
    let styleRequests = 0;
    let color = "green";
    const client = new HonuaClient({
      baseUrl: "https://honua.test",
      fetchFn: async (url, init) => {
        if (String(url).endsWith("/ogc/styles/zoning")) {
          styleRequests++;
          return response(catalog(color));
        }
        mapRequests++;
        if (mapRequests > 1) {
          expect(new Headers(init?.headers).get("if-none-match")).toBe('"map-v1"');
          return new Response(null, { status: 304 });
        }
        return response(pkg, '"map-v1"');
      },
    });
    const first = await fetchMapPackage("published-map", { client });
    expect(first.mapPackage.styleRefs?.[0].body?.places.paint?.["fill-color"]).toBe("green");
    color = "orange";
    const changed = await fetchMapPackage("published-map", { client });
    expect(changed.cache.status).toBe("refreshed");
    expect(changed.mapPackage.styleRefs?.[0].body?.places.paint?.["fill-color"]).toBe("orange");
    const unchanged = await fetchMapPackage("published-map", { client });
    expect(unchanged.cache.status).toBe("not-modified");
    expect(styleRequests).toBe(3);
    const rendered = await applyStyleRefs(changed.mapPackage.mapSpec, changed.mapPackage);
    expect(rendered.layers[0].paint?.["fill-color"]).toBe("orange");
    expect(pkg.styleRefs?.[0].body).toBeUndefined();
  });

  test("an inline snapshot stays map-local and never fetches the catalog", async () => {
    const pkg = mapPackage();
    pkg.styleRefs![0].body = { places: { paint: { "fill-color": "purple" } }, places__outline: {} };
    const resolver = vi.fn(async () => ({ places: {}, places__outline: {} }));
    const result = await applyStyleRefs(pkg.mapSpec, JSON.parse(JSON.stringify(pkg)), resolver);
    expect(result.layers[0].paint?.["fill-color"]).toBe("purple");
    expect(resolver).not.toHaveBeenCalled();
  });

  test("a cached package cannot conceal loss of access to its live shared style", async () => {
    let cached = false;
    const client = new HonuaClient({
      baseUrl: "https://honua.test",
      fetchFn: async (url) => {
        if (String(url).endsWith("/ogc/styles/zoning"))
          return cached ? new Response(null, { status: 403 }) : response(catalog());
        return cached ? new Response(null, { status: 304 }) : response(mapPackage(), '"map-v1"');
      },
    });
    await fetchMapPackage("published-map", { client });
    cached = true;
    await expect(fetchMapPackage("published-map", { client })).rejects.toMatchObject({
      name: "HonuaMapPackageError",
      stage: "validate",
    });
  });
});
