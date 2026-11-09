import { describe, expect, it, vi } from "vitest";
import { HonuaClient } from "../src/core/client.js";
import { HonuaHttpError } from "../src/core/errors.js";
import type { HonuaCatalogItem } from "../src/honua.js";

const item = {
  id: "survey/publication",
  type: "layer",
  title: "Parcels",
  owner: "surveyor",
  access: "public",
  tags: ["land"],
  layers: [],
  endpoints: [{ protocol: "FeatureServer", href: "https://example.test/rest/services/Survey/FeatureServer" }],
};
const page = { items: [item], total: 1, offset: 0, limit: 10, facets: { type: [{ value: "layer", count: 1 }] } };

describe("public catalog client", () => {
  it("preserves published app display and both lineage directions", async () => {
    const app: HonuaCatalogItem = {
      ...item,
      id: "survey-app",
      type: "app",
      access: "public",
      thumbnail: "/images/survey.png",
      services: ["survey-service"],
    };
    const service: HonuaCatalogItem = {
      ...item,
      id: "survey-service",
      type: "service",
      access: "public",
      apps: [app.id],
    };
    const response = { ...page, items: [app, service], total: 2 };
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () => new Response(JSON.stringify(response)),
    });
    const result = await client.listCatalog();
    expect(result.items[0].thumbnail).toBe(app.thumbnail);
    expect(result.items[0].services).toEqual([service.id]);
    expect(result.items[1].apps).toEqual([app.id]);
  });

  it("passes all filters and caller credentials through the existing transport", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(page)));
    const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn, apiKey: "catalog-reader" });
    const result = await client.listCatalog({
      q: "land & parcels",
      type: "layer",
      protocol: "FeatureServer",
      folder: "Survey",
      tag: "land",
      owner: "surveyor",
      bbox: [170, -20, -170, 20],
      datetime: "2026-01-01T00:00:00Z/..",
      offset: 0,
      limit: 10,
    });
    expect(result).toEqual(page);
    const [input, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(input);
    expect(url.pathname).toBe("/api/v1/catalog");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "land & parcels",
      type: "layer",
      protocol: "FeatureServer",
      folder: "Survey",
      tag: "land",
      owner: "surveyor",
      bbox: "170,-20,-170,20",
      datetime: "2026-01-01T00:00:00Z/..",
      offset: "0",
      limit: "10",
    });
    expect(new Headers(init.headers).get("x-api-key")).toBe("catalog-reader");
  });

  it("encodes a detail identity as one path segment", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(item)));
    const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
    expect(await client.getCatalogItem("survey/publication")).toEqual(item);
    const [input] = fetchFn.mock.calls[0] as unknown as [string];
    expect(new URL(input).pathname).toBe("/api/v1/catalog/survey%2Fpublication");
  });

  it("reads each caller-dependent listing without the metadata cache", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(page)));
    const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
    await client.listCatalog();
    await client.listCatalog();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retains the standard HTTP error for an unavailable catalog", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ title: "Not found", status: 404 }), { status: 404 }),
    );
    const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
    await expect(client.listCatalog()).rejects.toBeInstanceOf(HonuaHttpError);
  });

  it("passes cancellation through the standard request boundary", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(page)));
    const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
    const controller = new AbortController();
    controller.abort();
    await expect(client.listCatalog({ signal: controller.signal })).rejects.toThrow();
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });
});
