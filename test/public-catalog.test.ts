import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { HonuaAbortError, HonuaHttpError } from "../src/core/errors.js";
import { HonuaClient } from "../src/honua.js";
import type { HonuaCatalogItem, HonuaCatalogPage } from "../src/honua.js";

const CATALOG_ITEMS_PATH = "/ogc/records/collections/honua-catalog/items";

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/public-catalog/${name}`, import.meta.url), "utf8")) as T;
}

const itemsPage = readFixture<HonuaCatalogPage>("items-page.json");
const serviceRecord = readFixture<HonuaCatalogItem>("service-record.json");
const layerRecord = readFixture<HonuaCatalogItem>("layer-record.json");
const recordNotFound = readFixture<Record<string, unknown>>("record-not-found.json");

function geoJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/geo+json" : "application/problem+json" },
  });
}

function catalogClient(respond: () => Response, options: { apiKey?: string } = {}) {
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return respond();
  });
  const client = new HonuaClient({ baseUrl: "https://gis.example.test", fetchFn, ...options });
  return { client, fetchFn };
}

function requestedUrl(fetchFn: ReturnType<typeof catalogClient>["fetchFn"], call = 0): URL {
  return new URL(String(fetchFn.mock.calls[call]?.[0]));
}

describe("HonuaClient public catalog", () => {
  it("lists one page of service and layer records with the server's paging totals", async () => {
    const { client, fetchFn } = catalogClient(() => geoJsonResponse(itemsPage));

    const page = await client.listCatalog();

    expect(requestedUrl(fetchFn).pathname).toBe(CATALOG_ITEMS_PATH);
    expect(Object.fromEntries(requestedUrl(fetchFn).searchParams)).toEqual({ f: "json" });
    expect(page.numberMatched).toBe(itemsPage.numberMatched);
    expect(page.features.map((item) => item.id)).toEqual(["service:demo-stac", "service:maui-buildings"]);
    expect(page.features[0]?.properties.resourceType).toBe("Service");
    expect(page.links.find((link) => link.rel === "next")?.href).toContain("offset=2");
  });

  it("encodes every filter the server catalog accepts", async () => {
    const { client, fetchFn } = catalogClient(() => geoJsonResponse(itemsPage));

    await client.listCatalog({
      q: ["maui parcels", "zoning"],
      type: "dataset",
      ids: ["service:maui-parcels", "layer:pub-layer-1"],
      externalIds: "maui-parcels",
      bbox: [170, -20, -170, 20],
      datetime: "2026-01-01T00:00:00Z/..",
      limit: 25,
      offset: 50,
    });

    expect(Object.fromEntries(requestedUrl(fetchFn).searchParams)).toEqual({
      f: "json",
      q: "maui parcels,zoning",
      type: "dataset",
      ids: "service:maui-parcels,layer:pub-layer-1",
      externalIds: "maui-parcels",
      bbox: "170,-20,-170,20",
      datetime: "2026-01-01T00:00:00Z/..",
      limit: "25",
      offset: "50",
    });
  });

  it("sends only the filters the server catalog accepts", async () => {
    const { client, fetchFn } = catalogClient(() => geoJsonResponse(itemsPage));
    const widerQuery = { q: "parcels", sortby: "title", filter: "title = 'x'", basePath: "/elsewhere" };

    await client.listCatalog(widerQuery);

    expect(requestedUrl(fetchFn).pathname).toBe(CATALOG_ITEMS_PATH);
    expect(Object.fromEntries(requestedUrl(fetchFn).searchParams)).toEqual({ f: "json", q: "parcels" });
  });

  it("reads a record by identity as one encoded path segment", async () => {
    const { client, fetchFn } = catalogClient(() => geoJsonResponse(layerRecord));

    const item = await client.getCatalogItem("layer:pub-layer-1");

    expect(fetchFn.mock.calls[0]?.[0]).toBe(`https://gis.example.test${CATALOG_ITEMS_PATH}/layer%3Apub-layer-1?f=json`);
    expect(item.properties).toMatchObject({ type: "dataset", resourceType: "Layer", geometryType: "MultiPolygon" });
    expect(item.links.filter((link) => link.rel === "data").map((link) => link.href)).toEqual([
      "https://demo.honua.io/ogc/features/collections/1/items",
    ]);
  });

  it("returns a service record with its visible layer identities", async () => {
    const { client } = catalogClient(() => geoJsonResponse(serviceRecord));

    const item = await client.getCatalogItem("service:maui-parcels");

    expect(item.properties.layerIds).toEqual(["pub-layer-1"]);
    expect(item.links.map((link) => link.title)).toEqual(["maui-parcels", "FeatureServer", "MapServer"]);
  });

  it("propagates the client credential and per-request headers", async () => {
    const { client, fetchFn } = catalogClient(() => geoJsonResponse(itemsPage), { apiKey: "catalog-reader" });

    await client.listCatalog({ headers: { "X-Request-Id": "catalog-list" } });
    await client.getCatalogItem("service:maui-parcels", { headers: { "X-Request-Id": "catalog-item" } });

    const listHeaders = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    const itemHeaders = new Headers(fetchFn.mock.calls[1]?.[1]?.headers);
    expect(listHeaders.get("x-api-key")).toBe("catalog-reader");
    expect(listHeaders.get("x-request-id")).toBe("catalog-list");
    expect(itemHeaders.get("x-api-key")).toBe("catalog-reader");
    expect(itemHeaders.get("x-request-id")).toBe("catalog-item");
  });

  it("sends every repeated read to the server instead of a cache", async () => {
    const { client, fetchFn } = catalogClient(() => geoJsonResponse(itemsPage));

    await client.listCatalog({ q: "maui" });
    await client.listCatalog({ q: "maui" });
    await client.getCatalogItem("service:maui-parcels");
    await client.getCatalogItem("service:maui-parcels");

    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("rejects with HonuaAbortError when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = catalogClient(() => geoJsonResponse(itemsPage));

    await expect(client.listCatalog({ signal: controller.signal })).rejects.toBeInstanceOf(HonuaAbortError);
    await expect(client.getCatalogItem("service:maui-parcels", { signal: controller.signal })).rejects.toBeInstanceOf(
      HonuaAbortError,
    );
  });

  it("surfaces an unknown or hidden record as HonuaHttpError 404", async () => {
    const { client } = catalogClient(() => geoJsonResponse(recordNotFound, 404));

    const failure = await client.getCatalogItem("layer:nope").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HonuaHttpError);
    expect((failure as HonuaHttpError).statusCode).toBe(404);
    expect((failure as HonuaHttpError).body).toMatchObject({ detail: "Record 'layer:nope' not found." });
  });
});
