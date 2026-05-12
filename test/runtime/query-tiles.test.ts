import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type QueryTileServerContractFixture,
  type SourceDescriptor,
  capabilities,
  defineIndexedSpatialSource,
  defineQueryTileSource,
} from "../../src/contract/index.js";
import {
  type QueryTileLifecycleEvent,
  QueryTileServerResponseError,
  buildMapLibreQueryTileSourceSpec,
  buildQueryTileJson,
  buildQueryTileUrl,
  buildQueryTileUrlTemplate,
  createQueryTileRequestController,
  diagnoseQueryTileSourceSupport,
  fetchQueryTileFeatureDetail,
  fetchQueryTileJson,
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

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/sdk-contract");
const queryTileFixture = JSON.parse(
  readFileSync(resolve(fixturesDir, "query-tile-server.v1.json"), "utf8"),
) as QueryTileServerContractFixture<{ id: string; severity: number; status: string }>;

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

interface ObservedQueryTileRequest {
  method: string;
  pathname: string;
  searchParams: Record<string, string>;
  headers: Record<string, string | undefined>;
}

async function startQueryTileFixtureServer(): Promise<{
  baseUrl: string;
  requests: ObservedQueryTileRequest[];
  close: () => Promise<void>;
}> {
  const requests: ObservedQueryTileRequest[] = [];
  let baseUrl = "http://127.0.0.1";
  const server = createServer((request, response) => {
    handleQueryTileFixtureRequest(baseUrl, requests, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("query tile fixture server did not bind to a TCP port"));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  return {
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function handleQueryTileFixtureRequest(
  baseUrl: string,
  requests: ObservedQueryTileRequest[],
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "/", baseUrl);
  requests.push({
    method: request.method ?? "GET",
    pathname: url.pathname,
    searchParams: Object.fromEntries(url.searchParams.entries()),
    headers: {
      authorization: headerValue(request.headers.authorization),
      ifNoneMatch: headerValue(request.headers["if-none-match"]),
      ifModifiedSince: headerValue(request.headers["if-modified-since"]),
    },
  });

  if (url.pathname === "/query-tiles/sources/incidents/tilejson.json") {
    if (request.headers["if-none-match"] === '"tilejson-fixture-v1"') {
      response.writeHead(304, {
        ETag: '"tilejson-fixture-v1"',
        "Cache-Control": "public, max-age=30",
        "X-Honua-Source-Version": "stream-42",
      });
      response.end();
      return;
    }
    writeJson(response, localTileJson(baseUrl), {
      ETag: '"tilejson-fixture-v1"',
      "Last-Modified": "Mon, 11 May 2026 00:00:00 GMT",
      "Cache-Control": "public, max-age=30",
      Vary: "Authorization, Accept-Encoding",
      "X-Honua-Source-Version": "stream-42",
    });
    return;
  }

  if (url.pathname === "/query-tiles/sources/incidents/tiles/6/9/23.mvt") {
    response.writeHead(200, {
      "Content-Type": "application/vnd.mapbox-vector-tile",
      ETag: '"tile-6-9-23-v1"',
      "Cache-Control": "public, max-age=15",
      "X-Honua-Feature-Count": "12",
      "X-Honua-Max-Features": "500",
      "X-Honua-Source-Version": "stream-42",
    });
    response.end(Buffer.from([0x1a, 0x02, 0x08, 0x01]));
    return;
  }

  if (url.pathname === "/query-tiles/sources/incidents/features/incident-42") {
    writeJson(response, queryTileFixture.detailResponse, {
      ETag: '"incident-42-v7"',
      "Cache-Control": "private, max-age=15",
      Vary: "Authorization",
      "X-Honua-Source-Version": "stream-42",
    });
    return;
  }

  if (url.pathname === "/query-tiles/sources/incidents/features/too-many") {
    writeJson(response, queryTileFixture.errorResponse, {
      status: 422,
      ETag: '"too-many-error"',
      "Cache-Control": "no-store",
      "X-Honua-Source-Version": "stream-42",
    });
    return;
  }

  writeJson(
    response,
    {
      contractVersion: 1,
      error: { code: "not-found", message: "fixture route not found", status: 404 },
    },
    { status: 404 },
  );
}

function localTileJson(baseUrl: string) {
  const metadata = queryTileFixture.tilejsonResponse["honua:queryTiles"]!;
  const detailUrlTemplate = `${baseUrl}/query-tiles/sources/incidents/features/{featureId}`;
  return {
    ...queryTileFixture.tilejsonResponse,
    tiles: [
      `${baseUrl}/query-tiles/sources/incidents/tiles/{z}/{x}/{y}.mvt?where=severity+%3E%3D+3&outFields=id%2Cseverity%2Cstatus&returnGeometry=true&outSr=3857&tileMatrixSet=WebMercatorQuad&projection=id%2Cseverity%2Cstatus&projectionReturnGeometry=true&simplifyTolerance=1.5&maxFeatures=500`,
    ],
    "honua:queryTiles": {
      ...metadata,
      detailUrlTemplate,
      featureIdentity: {
        ...metadata.featureIdentity,
        detailUrlTemplate,
      },
    },
  };
}

function writeJson(
  response: ServerResponse,
  value: unknown,
  headers: Record<string, string | number | undefined> = {},
): void {
  const { status, ...rest } = headers;
  response.writeHead(typeof status === "number" ? status : 200, {
    "Content-Type": "application/json",
    ...rest,
  });
  response.end(JSON.stringify(value));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

describe("query tile runtime helpers", () => {
  it("builds tile URLs, TileJSON, and MapLibre vector source specs", () => {
    const queryTiles = descriptor();
    const template = buildQueryTileUrlTemplate(queryTiles);
    expect(template).toContain("https://tiles.example.test/query/sources/incidents/tiles/{z}/{x}/{y}.mvt");

    const url = new URL(buildQueryTileUrl(queryTiles, { z: 5, x: 9, y: 12 }));
    expect(url.pathname).toBe("/query/sources/incidents/tiles/5/9/12.mvt");
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

  it("fetches TileJSON, MVT tiles, and feature details from a fixture server", async () => {
    const fixtureServer = await startQueryTileFixtureServer();
    try {
      const queryTiles = defineQueryTileSource({
        id: "incidents-query-tiles",
        source: sourceDescriptor,
        cache: descriptor().cache,
        fallback: { mode: "query-bbox", reason: "fixture server synthesizes MVT tiles from viewport queries" },
        featureIdentity: { idProperty: "id" },
        endpoint: { baseUrl: `${fixtureServer.baseUrl}/query-tiles` },
        tileMatrixSet: "WebMercatorQuad",
        query: {
          where: "severity >= 3",
          outFields: ["id", "severity", "status"],
          returnGeometry: true,
          outSr: 3857,
        },
        projection: {
          fields: ["id", "severity", "status"],
          returnGeometry: true,
          simplifyTolerance: 1.5,
        },
      });

      const tilejsonResult = await fetchQueryTileJson(queryTiles, {
        headers: { Authorization: "Bearer fixture-token" },
        params: { maxFeatures: 500 },
      });
      expect(tilejsonResult.notModified).toBe(false);
      expect(tilejsonResult.validators).toMatchObject({
        etag: '"tilejson-fixture-v1"',
        sourceVersion: "stream-42",
      });
      expect(tilejsonResult.tilejson?.["honua:queryTiles"]?.detailUrlTemplate).toContain(fixtureServer.baseUrl);
      expect(tilejsonResult.degraded?.[0]).toMatchObject({ code: "geometry-simplified", severity: "info" });

      const notModified = await fetchQueryTileJson(queryTiles, {
        headers: { Authorization: "Bearer fixture-token" },
        validators: tilejsonResult.validators,
      });
      expect(notModified).toMatchObject({ status: 304, notModified: true });

      const descriptorWithTileJson = { ...queryTiles, tilejson: tilejsonResult.tilejson };
      const detailResult = await fetchQueryTileFeatureDetail(
        descriptorWithTileJson,
        { sourceId: "incidents", id: "incident-42", sourceLayer: "incidents" },
        {
          headers: { Authorization: "Bearer fixture-token" },
          params: { outFields: ["id", "status"], returnGeometry: false },
        },
      );
      expect(detailResult.detail?.identity).toMatchObject({ sourceId: "incidents", id: "incident-42" });
      expect(detailResult.detail?.feature?.attributes.status).toBe("open");
      expect(detailResult.validators).toMatchObject({ etag: '"incident-42-v7"', sourceVersion: "stream-42" });

      const controller = createQueryTileRequestController<ArrayBuffer>(queryTiles, {
        fetchTile: async (request) => {
          const response = await fetch(request.url, { headers: { Authorization: "Bearer fixture-token" } });
          expect(response.ok).toBe(true);
          return response.arrayBuffer();
        },
      });
      const tilePayload = await controller.requestTile({ z: 6, x: 9, y: 23 });
      expect(tilePayload.byteLength).toBe(4);

      let detailError: unknown;
      try {
        await fetchQueryTileFeatureDetail(
          descriptorWithTileJson,
          { sourceId: "incidents", id: "too-many", sourceLayer: "incidents" },
          { headers: { Authorization: "Bearer fixture-token" } },
        );
      } catch (error) {
        detailError = error;
      }
      expect(detailError).toBeInstanceOf(QueryTileServerResponseError);
      expect(detailError).toMatchObject({
        name: "QueryTileServerResponseError",
        status: 422,
        response: {
          contractVersion: 1,
          error: {
            code: "max-features-exceeded",
            message: "The tile exceeded maxFeatures=500 before simplification could satisfy the request.",
            status: 422,
          },
        },
      });

      expect(fixtureServer.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pathname: "/query-tiles/sources/incidents/tilejson.json",
            searchParams: expect.objectContaining({ maxFeatures: "500", where: "severity >= 3" }),
            headers: expect.objectContaining({ authorization: "Bearer fixture-token" }),
          }),
          expect.objectContaining({
            pathname: "/query-tiles/sources/incidents/tilejson.json",
            headers: expect.objectContaining({ ifNoneMatch: '"tilejson-fixture-v1"' }),
          }),
          expect.objectContaining({
            pathname: "/query-tiles/sources/incidents/tiles/6/9/23.mvt",
            searchParams: expect.objectContaining({ where: "severity >= 3", tileMatrixSet: "WebMercatorQuad" }),
          }),
          expect.objectContaining({
            pathname: "/query-tiles/sources/incidents/features/incident-42",
            searchParams: expect.objectContaining({ outFields: "id,status", returnGeometry: "false" }),
          }),
        ]),
      );
    } finally {
      await fixtureServer.close();
    }
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

  it("rejects unsafe viewport inputs before materializing tile lists", () => {
    expect(() => queryTilesForViewport({ bounds: [0, 0, 10, 10], zoom: Number.POSITIVE_INFINITY })).toThrow(
      /zoom must be finite/,
    );
    expect(() => queryTilesForViewport({ bounds: [-180, -85, 180, 85], zoom: 12, maxTiles: 10 })).toThrow(
      /exceeding maxTiles=10/,
    );
    expect(() =>
      queryTilesForViewport({ bounds: [-180, -90, 180, 90], zoom: 31, maxzoom: 31, maxTiles: 100_000 }),
    ).toThrow(/exceeds safe tile zoom/);
  });

  it("limits viewport fetch concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const controller = createQueryTileRequestController<string>(descriptor(), {
      fetchTile: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return `tile:${request.tileKey.z}/${request.tileKey.x}/${request.tileKey.y}`;
      },
    });

    const result = await controller.requestViewport(
      { bounds: [-30, -30, 30, 30], zoom: 4, maxTiles: 64 },
      {
        concurrency: 2,
      },
    );

    expect(result.results.every((entry) => entry.status === "fulfilled")).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("does not reuse tile payloads when cache identity lacks authorization scope", async () => {
    let fetchCount = 0;
    const queryTiles = defineQueryTileSource({
      id: "unscoped-query-tiles",
      source: sourceDescriptor,
      endpoint: { baseUrl: "https://tiles.example.test/query" },
      cache: { maxEntries: 4, key: { sourceVersion: "stream-11" } },
    });
    const controller = createQueryTileRequestController<{ count: number }>(queryTiles, {
      fetchTile: async () => {
        fetchCount += 1;
        return { count: fetchCount };
      },
    });

    await controller.requestTile({ z: 3, x: 2, y: 4 });
    await controller.requestTile({ z: 3, x: 2, y: 4 });

    expect(fetchCount).toBe(2);
    expect(controller.cacheSnapshot().entries).toBe(0);
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

  it("diagnoses warehouse/indexed analytics tile descriptors without protocol metadata", () => {
    const analyticsSource = defineIndexedSpatialSource({
      id: "warehouse.incidents.h3",
      provider: "carto",
      sql: { text: "select h3_cell, severity from incidents" },
      index: { modelId: "h3", cellIdField: "h3_cell", resolution: 8 },
      cache: { key: { sourceVersion: "mv-42", authorizationScope: "ops-role" } },
      fallback: { mode: "disabled" },
    });
    const queryTiles = defineQueryTileSource({
      id: "warehouse-h3-tiles",
      source: analyticsSource,
      endpoint: { baseUrl: "https://tiles.example.test/query" },
      cache: { maxEntries: 8 },
    });

    const diagnostics = diagnoseQueryTileSourceSupport(queryTiles);

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["analytics-tile-pushdown-supported", "client-materialization-disabled"]),
    );
    expect(diagnostics.some((diagnostic) => diagnostic.code === "unsupported-protocol")).toBe(false);
  });
});
