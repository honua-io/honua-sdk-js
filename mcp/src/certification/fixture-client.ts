import type {
  HonuaClient,
  HonuaLayerMetadata,
  HonuaQueryResponse,
  HonuaServiceMetadata,
  HonuaServicesResponse,
} from "@honua/sdk-js";

/**
 * Offline fixture `HonuaClient` for deterministic certification.
 *
 * This is the standalone (non-vitest) counterpart of `test/test-helpers.ts`:
 * it returns canned, schema-shaped responses for every method the MCP tools and
 * resources call, so the certifier can run `tools/call` round-trips with no live
 * backend, no network access, and no model/API calls. CI instead points the
 * certifier at a live honua-server via `createClientFromEnv`.
 */

const STYLES_LIST = {
  styles: [
    { id: "topographic", title: "Topographic", links: [] },
    { id: "imagery", title: "Imagery", links: [] },
  ],
  default: "topographic",
};

const TOPOGRAPHIC_METADATA = {
  id: "topographic",
  title: "Topographic",
  description: "Default topographic basemap style",
  version: "3",
  links: [{ rel: "preview", type: "image/png", href: "https://example.test/ogc/styles/topographic/preview" }],
};

const TOPOGRAPHIC_STYLESHEET = {
  version: 8,
  name: "Topographic",
  layers: [{ id: "background", type: "background" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fixtureFetch(_method: string, path: string): Promise<Response> {
  if (path === "/ogc/styles") {
    return jsonResponse(STYLES_LIST);
  }
  if (path === "/ogc/styles/topographic/metadata") {
    return jsonResponse(TOPOGRAPHIC_METADATA);
  }
  if (path === "/ogc/styles/topographic") {
    return jsonResponse(TOPOGRAPHIC_STYLESHEET);
  }
  return jsonResponse({ error: "not found" }, 404);
}

/** Build an offline fixture client usable anywhere a `HonuaClient` is expected. */
export function createFixtureClient(): HonuaClient {
  const client = {
    serverBaseUrl: "https://example.test",
    async listServices(): Promise<HonuaServicesResponse> {
      return {
        services: [
          { name: "Parks", type: "FeatureServer" },
          { name: "Basemap", type: "MapServer" },
          { name: "Census", type: "FeatureServer" },
        ],
      };
    },
    async getFeatureServiceMetadata(_serviceId: string): Promise<HonuaServiceMetadata> {
      return {
        serviceDescription: "Test service",
        layers: [
          { id: 0, name: "Layer 0" },
          { id: 1, name: "Layer 1" },
        ],
        spatialReference: { wkid: 4326 },
      };
    },
    async getLayerMetadata(_serviceId: string, _layerId: number): Promise<HonuaLayerMetadata> {
      return {
        id: 0,
        name: "Test Layer",
        description: "A test layer",
        geometryType: "esriGeometryPoint",
        fields: [
          { name: "OBJECTID", type: "esriFieldTypeOID" },
          { name: "NAME", type: "esriFieldTypeString", alias: "Feature Name" },
          { name: "VALUE", type: "esriFieldTypeDouble" },
        ],
        extent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90 },
        spatialReference: { wkid: 4326 },
        relationships: [{ id: 0, name: "rel_0", relatedTableId: 1 }],
      };
    },
    async queryFeatures(request?: { extraParams?: Record<string, unknown> }): Promise<HonuaQueryResponse> {
      const extraParams = request?.extraParams ?? {};
      // count-only and extent-only projections mirror the GeoServices query
      // surface the tools exercise (returnCountOnly / returnExtentOnly).
      if (extraParams.returnCountOnly === true) {
        return { count: 2 } as unknown as HonuaQueryResponse;
      }
      if (extraParams.returnExtentOnly === true) {
        return {
          count: 2,
          extent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: { wkid: 4326 } },
        } as unknown as HonuaQueryResponse;
      }
      return {
        objectIdFieldName: "OBJECTID",
        geometryType: "esriGeometryPoint",
        spatialReference: { wkid: 4326 },
        features: [
          { attributes: { OBJECTID: 1, NAME: "Park A", VALUE: 100 } },
          { attributes: { OBJECTID: 2, NAME: "Park B", VALUE: 200 } },
        ],
        exceededTransferLimit: false,
      };
    },
    pipelineFetch: fixtureFetch,
  };

  return client as unknown as HonuaClient;
}
