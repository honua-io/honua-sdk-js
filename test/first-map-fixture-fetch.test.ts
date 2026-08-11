import { afterEach, describe, expect, it, vi } from "vitest";

import { createFirstMapFixtureFetch } from "../examples/maplibre-quickstart/src/fixture-fetch.js";

const fixtureBodies = new Map([
  ["ogc-landing.json", { title: "First Map OGC fixture" }],
  ["ogc-api-definition.json", { openapi: "3.0.3" }],
  ["ogc-conformance.json", { conformsTo: ["core"] }],
  ["ogc-collection.json", { id: "maui-census-tracts-2025" }],
  ["ogc-items.json", { type: "FeatureCollection", features: [{ id: 1 }] }],
] as const);

afterEach(() => vi.unstubAllGlobals());

describe("First Map packaged fixture fetch", () => {
  it("serves the closed OGC route set under a deployed gallery subpath", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const value = input instanceof Request ? input.url : String(input);
        const fixture = [...fixtureBodies].find(([name]) => value.includes(name));
        if (!fixture) throw new Error(`Unexpected fixture asset: ${value}`);
        return new Response(JSON.stringify(fixture[1]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const root = "https://samples.example.test/sdk/maplibre-quickstart/app/ogc/features";
    const collection = `${root}/collections/maui-census-tracts-2025`;
    const fixtureFetch = createFirstMapFixtureFetch(collection);

    await expect(fixtureFetch(`${root}?f=json`).then((response) => response.json())).resolves.toMatchObject({
      title: "First Map OGC fixture",
    });
    await expect(fixtureFetch(`${root}/api?f=json`).then((response) => response.json())).resolves.toMatchObject({
      openapi: "3.0.3",
    });
    await expect(fixtureFetch(`${root}/conformance?f=json`).then((response) => response.json())).resolves.toMatchObject(
      {
        conformsTo: ["core"],
      },
    );
    await expect(fixtureFetch(`${root}/collections?f=json`).then((response) => response.json())).resolves.toEqual({
      collections: [{ id: "maui-census-tracts-2025" }],
    });
    await expect(fixtureFetch(`${collection}?f=json`).then((response) => response.json())).resolves.toMatchObject({
      id: "maui-census-tracts-2025",
    });
    await expect(
      fixtureFetch(`${collection}/items?limit=48`).then((response) => response.json()),
    ).resolves.toMatchObject({
      type: "FeatureCollection",
      features: [{ id: 1 }],
    });
    await expect(fixtureFetch(`${root}/collections/not-the-fixture/items`)).rejects.toThrow(
      "First Map fixture rejected an unexpected SDK request",
    );
    await expect(fixtureFetch("https://other.example.test/ogc/features")).rejects.toThrow(
      "First Map fixture rejected an unexpected SDK request",
    );
  });
});
