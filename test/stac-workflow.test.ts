import { describe, expect, it, vi } from "vitest";

import { searchMauiImagery } from "../examples/stac-imagery-browser/src/dynamic-stac-example.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import type { HonuaStacItemResponse } from "../src/core/types.js";
import { createDynamicStacClient, resolveStacLink } from "../src/stac/index.js";

const MAUI_ITEM: HonuaStacItemResponse = {
  type: "Feature",
  id: "S2B_MAUI_20260418",
  collection: "sentinel-2-l2a",
  geometry: null,
  properties: {
    datetime: "2026-04-18T21:20:29Z",
    "eo:cloud_cover": 8,
    "proj:epsg": 32604,
  },
  links: [{ rel: "self", href: "./collections/sentinel-2-l2a/items/S2B_MAUI_20260418" }],
  assets: {
    visual: {
      href: "../../../../assets/maui-visual.tif?token=old",
      type: "image/tiff; application=geotiff; profile=cloud-optimized",
      title: "Maui visual",
      roles: ["visual", "data"],
      "proj:code": "EPSG:32604",
      "raster:bands": [
        { name: "B04", common_name: "red", data_type: "uint16", scale: 0.0001 },
        { name: "B03", common_name: "green", data_type: "uint16", scale: 0.0001 },
        { name: "B02", common_name: "blue", data_type: "uint16", scale: 0.0001 },
      ],
    },
  },
};

describe("dynamic STAC workflows", () => {
  it("executes the Maui POST search example with CQL2 JSON, fields, sorting, auth, and interceptors", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown>; authorization: string | null }> =
      [];
    const after = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({
        url: input.toString(),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ type: "FeatureCollection", features: [MAUI_ITEM], links: [] });
    });
    const stac = createDynamicStacClient({
      baseUrl: "https://stac.example.test/v1",
      clientOptions: {
        fetchFn,
        auth: async () => "fixture-token",
        interceptors: [{ after }],
      },
    });

    const selected = await searchMauiImagery(stac);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://stac.example.test/v1/search",
      method: "POST",
      authorization: "Bearer fixture-token",
    });
    expect(calls[0]?.body).toMatchObject({
      bbox: [-156.75, 20.55, -155.85, 21.05],
      "filter-lang": "cql2-json",
      filter: { op: "<=", args: [{ property: "eo:cloud_cover" }, 20] },
      sortby: [{ field: "properties.datetime", direction: "desc" }],
    });
    expect(after).toHaveBeenCalledOnce();
    expect(selected.asset).toMatchObject({
      format: "cog",
      maturity: "experimental",
      projection: { code: "EPSG:32604", epsg: 32604 },
      handoff: { kind: "cog", packageExport: "@honua/sdk-js/cog" },
    });
    expect(selected.asset.bands[0]).toMatchObject({ name: "B04", commonName: "red" });
  });

  it("serializes GET CQL2, fields, and structured sorting", async () => {
    let requested = "";
    const stac = createDynamicStacClient({
      baseUrl: "https://stac.example.test/v1",
      clientOptions: {
        fetchFn: async (input) => {
          requested = input.toString();
          return Response.json({ type: "FeatureCollection", features: [], links: [] });
        },
      },
    });

    await stac.search({
      method: "GET",
      filterLang: "cql2-json",
      filter: { op: "=", args: [{ property: "collection" }, "sentinel-2-l2a"] },
      fields: { include: ["id", "assets"], exclude: ["geometry"] },
      sortby: [{ field: "properties.datetime", direction: "desc" }],
    });

    const url = new URL(requested);
    expect(JSON.parse(url.searchParams.get("filter") ?? "null")).toEqual({
      op: "=",
      args: [{ property: "collection" }, "sentinel-2-l2a"],
    });
    expect(url.searchParams.get("fields")).toBe("id,assets,-geometry");
    expect(url.searchParams.get("sortby")).toBe("-properties.datetime");
  });

  it("follows relative next links and bounds prefetch to one page", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString();
      requests.push(url);
      const second = new URL(url).searchParams.get("token") === "page-two";
      return Response.json({
        type: "FeatureCollection",
        features: [{ ...MAUI_ITEM, id: second ? "maui-2" : "maui-1" }],
        links: second ? [] : [{ rel: "next", href: "./search?token=page-two" }],
      });
    });
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1", clientOptions: { fetchFn } });
    const ids: Array<string | number> = [];

    for await (const item of stac.items({ method: "GET", pageSize: 1, maxPages: 2, prefetchPages: 1 })) {
      if (item.id === undefined) throw new Error("fixture item id missing");
      ids.push(item.id);
    }

    expect(ids).toEqual(["maui-1", "maui-2"]);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1] ?? "").searchParams.get("token")).toBe("page-two");
  });

  it("observes and cancels a prefetched page when iteration stops early", async () => {
    let prefetched = false;
    let aborted = false;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (new URL(input.toString()).searchParams.has("token")) {
        prefetched = true;
        if (init?.signal?.aborted) {
          aborted = true;
          throw new DOMException("aborted", "AbortError");
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      return Response.json({
        type: "FeatureCollection",
        features: [{ ...MAUI_ITEM, id: "maui-1" }],
        links: [{ rel: "next", href: "./search?token=page-two" }],
      });
    });
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1", clientOptions: { fetchFn } });

    for await (const _page of stac.pages({ method: "GET", pageSize: 1, maxPages: 2, prefetchPages: 1 })) break;

    expect(prefetched).toBe(true);
    expect(aborted).toBe(true);
  });

  it("resolves relative catalog links without accepting unsafe schemes", () => {
    expect(resolveStacLink({ rel: "child", href: "./collections/maui" }, "https://stac.example.test/v1/")).toEqual({
      href: "https://stac.example.test/v1/collections/maui",
      rel: "child",
      method: "GET",
    });
    expect(() =>
      resolveStacLink({ rel: "child", href: "javascript:alert(1)" }, "https://stac.example.test/v1/"),
    ).toThrow(/HTTP or HTTPS/);
  });

  it("uses the STAC root as a directory when resolving relative links", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = input.toString();
      requests.push(url);
      if (url.endsWith("/collections")) return Response.json({ collections: [], links: [] });
      return Response.json({ links: [{ rel: "data", href: "./collections" }] });
    });
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1", clientOptions: { fetchFn } });

    const catalog = await stac.catalog();
    const assets = await stac.assets({
      type: "Feature",
      id: "maui",
      geometry: null,
      properties: {},
      links: [{ rel: "self", href: "./collections/sentinel/items/maui" }],
      assets: { data: { href: "./visual.pmtiles" } },
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        "https://stac.example.test/v1?f=json",
        "https://stac.example.test/v1/collections?f=json",
      ]),
    );
    expect(catalog.links[0]?.href).toBe("https://stac.example.test/v1/collections");
    expect(assets[0]?.href).toBe("https://stac.example.test/v1/collections/sentinel/items/visual.pmtiles");
  });

  it("includes the configured mount path when resolving relative links", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      if (input.toString().includes("/collections")) return Response.json({ collections: [], links: [] });
      return Response.json({ links: [{ rel: "data", href: "./collections" }] });
    });
    const stac = createDynamicStacClient({
      baseUrl: "https://stac.example.test/api",
      basePath: "/stac",
      clientOptions: { fetchFn },
    });

    const catalog = await stac.catalog();

    expect(catalog.links[0]?.href).toBe("https://stac.example.test/api/stac/collections");
    expect(fetchFn.mock.calls.map(([input]) => input.toString())).toEqual(
      expect.arrayContaining([
        "https://stac.example.test/api/stac?f=json",
        "https://stac.example.test/api/stac/collections?f=json",
      ]),
    );
  });

  it("refreshes signed URLs but rejects unsupported assets", async () => {
    const refreshAssetUrl = vi.fn(async () => "https://signed.example.test/maui.tif?token=new");
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1", refreshAssetUrl });
    const selected = await stac.selectAsset(MAUI_ITEM, { roles: ["data"] });
    expect(selected.href).toBe("https://signed.example.test/maui.tif?token=new");
    expect(refreshAssetUrl).toHaveBeenCalledOnce();

    const unsupported: HonuaStacItemResponse = {
      ...MAUI_ITEM,
      assets: { climate: { href: "./climate.nc", type: "application/x-netcdf", roles: ["data"] } },
      stac_extensions: undefined,
    };
    await expect(stac.selectAsset(unsupported)).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect((await stac.assets(unsupported))[0]).toMatchObject({ format: "unsupported", maturity: "unavailable" });
  });

  it("filters asset formats before refreshing signed URLs", async () => {
    const refreshAssetUrl = vi.fn(async ({ assetKey }: { assetKey: string }) => {
      if (assetKey === "tiles") throw new Error("excluded PMTiles asset must not be signed");
      return `https://signed.example.test/${assetKey}.tif?token=new`;
    });
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1", refreshAssetUrl });
    const item: HonuaStacItemResponse = {
      ...MAUI_ITEM,
      assets: {
        tiles: { href: "./maui.pmtiles", type: "application/vnd.pmtiles", roles: ["data"] },
        visual: {
          href: "./maui.tif",
          type: "image/tiff; application=geotiff; profile=cloud-optimized",
          roles: ["visual", "data"],
        },
      },
    };

    const assets = await stac.assets(item, { formats: ["cog"] });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ key: "visual", format: "cog" });
    expect(refreshAssetUrl).toHaveBeenCalledOnce();
    expect(refreshAssetUrl.mock.calls[0]?.[0].assetKey).toBe("visual");
  });

  it("uses the canonical PMTiles and columnar workflow handoffs", async () => {
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1" });
    const item: HonuaStacItemResponse = {
      ...MAUI_ITEM,
      assets: {
        tiles: { href: "./maui.pmtiles", type: "application/vnd.pmtiles", roles: ["data"] },
        parcels: { href: "./maui.parquet", type: "application/vnd.apache.parquet", roles: ["data"] },
      },
    };

    const assets = await stac.assets(item);

    expect(assets.find((asset) => asset.key === "tiles")?.handoff).toEqual({
      kind: "pmtiles",
      href: "https://stac.example.test/v1/collections/sentinel-2-l2a/items/maui.pmtiles",
      packageExport: "@honua/sdk-js/pmtiles",
    });
    expect(assets.find((asset) => asset.key === "parcels")?.handoff).toEqual({
      kind: "geoparquet",
      href: "https://stac.example.test/v1/collections/sentinel-2-l2a/items/maui.parquet",
      packageExport: "@honua/sdk-js/columnar-workflow",
      geoArrowEncoding: false,
    });
  });

  it("does not treat projection or raster metadata as proof of a COG", async () => {
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1" });
    const ordinaryTiff: HonuaStacItemResponse = {
      ...MAUI_ITEM,
      assets: {
        visual: {
          href: "./ordinary.tif",
          type: "image/tiff",
          roles: ["data"],
          "proj:epsg": 32604,
          "raster:bands": [{ name: "B04", common_name: "red" }],
        },
      },
    };

    const descriptor = (await stac.assets(ordinaryTiff))[0];
    expect(descriptor).toMatchObject({ format: "unsupported", maturity: "unavailable" });
    expect(descriptor?.handoff).toBeUndefined();
    await expect(stac.selectAsset(ordinaryTiff)).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("requires an exact cloud-optimized media profile for COG handoff", async () => {
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1" });
    const item: HonuaStacItemResponse = {
      ...MAUI_ITEM,
      assets: {
        impostor: {
          href: "./impostor.tif",
          type: "image/tiff; application=geotiff; profile=not-cloud-optimized",
          roles: ["data"],
        },
      },
    };

    const descriptor = (await stac.assets(item))[0];

    expect(descriptor).toMatchObject({ format: "unsupported", maturity: "unavailable" });
    expect(descriptor?.handoff).toBeUndefined();
  });

  it("propagates AbortSignal through search and signed URL refresh", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return Response.json({ type: "FeatureCollection", features: [], links: [] });
    });
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1", clientOptions: { fetchFn } });

    await expect(stac.search({ method: "GET", signal: controller.signal })).rejects.toBeInstanceOf(HonuaAbortError);
    await expect(stac.assets(MAUI_ITEM, { signal: controller.signal })).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("cancels automatic POST discovery and does not cache an aborted probe", async () => {
    const methods: string[] = [];
    let requestCount = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      requestCount += 1;
      methods.push(init?.method ?? "GET");
      if (requestCount === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      }
      if (requestCount === 2) {
        return Response.json({ links: [{ rel: "search", href: "./search", method: "POST" }] });
      }
      return Response.json({ type: "FeatureCollection", features: [], links: [] });
    });
    const stac = createDynamicStacClient({ baseUrl: "https://stac.example.test/v1", clientOptions: { fetchFn } });
    const controller = new AbortController();

    const abortedSearch = stac.search({ signal: controller.signal });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    controller.abort();
    await expect(abortedSearch).rejects.toBeInstanceOf(HonuaAbortError);

    await stac.search();
    expect(methods).toEqual(["GET", "GET", "POST"]);
  });

  it("does not fall back to GET when POST is explicitly requested", async () => {
    const methods: string[] = [];
    const stac = createDynamicStacClient({
      baseUrl: "https://stac.example.test/v1",
      clientOptions: {
        fetchFn: async (_input, init) => {
          methods.push(init?.method ?? "GET");
          return Response.json({ message: "POST disabled" }, { status: 405 });
        },
      },
    });

    await expect(stac.search({ method: "POST", limit: 1 })).rejects.toThrow();
    expect(methods).toEqual(["POST"]);
  });
});
