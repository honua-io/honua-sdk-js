import { describe, expect, it } from "vitest";

import { type SourceDescriptor, capabilities, defineQueryTileSource } from "../../src/contract/index.js";
import {
  type QueryTileLifecycleEvent,
  buildMapLibreQueryTileSourceSpec,
  buildQueryTileJson,
  buildQueryTileUrl,
  buildQueryTileUrlTemplate,
  createQueryTileRequestController,
  diagnoseQueryTileSourceSupport,
  queryTilesForViewport,
} from "../../src/runtime/index.js";

const sourceDescriptor: SourceDescriptor = {
  id: "incidents",
  protocol: "ogc-features",
  locator: {
    url: "https://gis.example.test/ogc/collections/incidents",
    collectionId: "incidents",
  },
  capabilities: capabilities(["query", "queryObjectIds"]),
};

function descriptor() {
  return defineQueryTileSource({
    id: "incidents-query-tiles",
    source: sourceDescriptor,
    endpoint: { baseUrl: "https://tiles.example.test/query" },
    query: { where: "severity >= 3", outFields: ["id", "severity"], returnGeometry: true },
    projection: { fields: ["id", "severity"] },
    cache: {
      maxEntries: 2,
      key: {
        sourceVersion: "stream-11",
        authorizationScope: "ops-role",
        styleFilters: { minSeverity: 3 },
      },
    },
    fallback: { mode: "query-bbox", reason: "mock server synthesizes MVT tiles from viewport queries" },
    featureIdentity: { idProperty: "id" },
  });
}

describe("query tile runtime helpers", () => {
  it("builds tile URLs, TileJSON, and MapLibre vector source specs", () => {
    const queryTiles = descriptor();
    const template = buildQueryTileUrlTemplate(queryTiles);
    expect(template).toContain("https://tiles.example.test/query/tiles/{z}/{x}/{y}.mvt");
    expect(template).toContain("sourceId=incidents");

    const url = new URL(buildQueryTileUrl(queryTiles, { z: 5, x: 9, y: 12 }));
    expect(url.pathname).toBe("/query/tiles/5/9/12.mvt");
    expect(url.searchParams.get("where")).toBe("severity >= 3");
    expect(url.searchParams.get("outFields")).toBe("id,severity");
    expect(url.searchParams.get("projection")).toBe("id,severity");

    const tilejson = buildQueryTileJson(queryTiles);
    expect(tilejson.vector_layers?.[0]).toMatchObject({ id: "incidents" });
    expect(tilejson.tiles[0]).toContain("{z}/{x}/{y}.mvt");

    const spec = buildMapLibreQueryTileSourceSpec(queryTiles);
    expect(spec).toMatchObject({
      type: "vector",
      promoteId: "id",
    });
    expect(spec.tiles?.[0]).toContain("severity+%3E%3D+3");
  });

  it("computes viewport tiles and aborts inflight requests outside the next viewport", async () => {
    const events: QueryTileLifecycleEvent<string>[] = [];
    const controller = createQueryTileRequestController<string>(descriptor(), {
      fetchTile: (request) => {
        if (request.tileKey.z === 2 && request.tileKey.x === 0 && request.tileKey.y === 0) {
          return new Promise((resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
              once: true,
            });
          });
        }
        return Promise.resolve(`tile:${request.tileKey.z}/${request.tileKey.x}/${request.tileKey.y}`);
      },
      onEvent: (event) => events.push(event),
    });

    const first = controller.requestTile({ z: 2, x: 0, y: 0 }).catch((error) => error);
    const visible = queryTilesForViewport({ bounds: [0, 0, 10, 10], zoom: 2 });
    expect(visible.some((tile) => tile.x === 0 && tile.y === 0)).toBe(false);

    const viewportResult = await controller.requestViewport({ bounds: [0, 0, 10, 10], zoom: 2 });
    await expect(first).resolves.toMatchObject({ name: "AbortError" });

    expect(viewportResult.results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(events.some((event) => event.type === "tile-aborted")).toBe(true);
    expect(controller.cacheSnapshot().entries).toBeGreaterThan(0);
  });

  it("reuses cached tiles and exposes invalidation events", async () => {
    const events: QueryTileLifecycleEvent<{ bytes: number }>[] = [];
    let fetchCount = 0;
    const controller = createQueryTileRequestController<{ bytes: number }>(descriptor(), {
      fetchTile: async () => {
        fetchCount += 1;
        return { bytes: fetchCount };
      },
      onEvent: (event) => events.push(event),
    });

    await controller.requestTile({ z: 3, x: 2, y: 4 });
    await controller.requestTile({ z: 3, x: 2, y: 4 });
    expect(fetchCount).toBe(1);
    expect(events.some((event) => event.type === "tile-cache-hit")).toBe(true);

    const invalidated = controller.invalidate((entry) => entry.tileKey.z === 3);
    await controller.requestTile({ z: 3, x: 2, y: 4 });

    expect(invalidated).toBe(1);
    expect(fetchCount).toBe(2);
    expect(events.some((event) => event.type === "tile-evicted" && event.reason === "invalidate")).toBe(true);
  });

  it("reports unsupported protocols and fallback/cache diagnostics", () => {
    const diagnostics = diagnoseQueryTileSourceSupport(descriptor());
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["tile-pushdown-unavailable", "fallback-enabled"]),
    );

    const unsupported = diagnoseQueryTileSourceSupport(
      defineQueryTileSource({
        id: "geometry-query-tiles",
        source: {
          id: "geometry",
          protocol: "geoservices-geometry-service",
          locator: { url: "https://gis.example.test/rest/services/Geometry/GeometryServer" },
          capabilities: capabilities(["geometry"]),
        },
        endpoint: { baseUrl: "https://tiles.example.test/query" },
        fallback: { mode: "disabled" },
      }),
    );

    expect(unsupported.some((diagnostic) => diagnostic.code === "unsupported-protocol")).toBe(true);
    expect(unsupported.some((diagnostic) => diagnostic.code === "missing-cache-scope")).toBe(true);
  });
});
