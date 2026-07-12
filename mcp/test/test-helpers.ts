import type { HonuaClient } from "@honua/sdk-js";
import type {
  HonuaLayerMetadata,
  HonuaQueryResponse,
  HonuaServiceMetadata,
  HonuaServicesResponse,
} from "@honua/sdk-js/honua";
import { vi } from "vitest";

export interface MockHonuaClient {
  listServices: ReturnType<typeof vi.fn<() => Promise<HonuaServicesResponse>>>;
  getFeatureServiceMetadata: ReturnType<typeof vi.fn<(serviceId: string) => Promise<HonuaServiceMetadata>>>;
  getLayerMetadata: ReturnType<typeof vi.fn<(serviceId: string, layerId: number) => Promise<HonuaLayerMetadata>>>;
  queryFeatures: ReturnType<
    typeof vi.fn<(...args: unknown[]) => Promise<HonuaQueryResponse | Record<string, unknown>>>
  >;
  pipelineFetch: ReturnType<typeof vi.fn<(method: string, path: string, init?: RequestInit) => Promise<Response>>>;
  serverBaseUrl: string;
}

/**
 * Default `pipelineFetch` for the OGC API – Styles surface used by the styles
 * resource/tools. Routes by path to canned styles list, metadata, and MapLibre
 * stylesheet bodies.
 */
function defaultStylesPipelineFetch(): MockHonuaClient["pipelineFetch"] {
  return vi.fn<(method: string, path: string, init?: RequestInit) => Promise<Response>>(async (_method, path) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (path === "/ogc/styles") {
      return json({
        styles: [
          { id: "topographic", title: "Topographic", links: [] },
          { id: "imagery", title: "Imagery", links: [] },
        ],
        default: "topographic",
      });
    }
    if (path === "/ogc/styles/topographic/metadata") {
      return json({
        id: "topographic",
        title: "Topographic",
        description: "Default topographic basemap style",
        version: "3",
        links: [{ rel: "preview", type: "image/png", href: "https://example.test/ogc/styles/topographic/preview" }],
      });
    }
    if (path === "/ogc/styles/topographic") {
      return json({ version: 8, name: "Topographic", layers: [{ id: "background", type: "background" }] });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
}

export function createMockClient(overrides: Partial<MockHonuaClient> = {}): MockHonuaClient {
  return {
    listServices:
      overrides.listServices ??
      vi.fn<() => Promise<HonuaServicesResponse>>().mockResolvedValue({
        services: [
          { name: "Parks", type: "FeatureServer" },
          { name: "Basemap", type: "MapServer" },
          { name: "Census", type: "FeatureServer" },
        ],
      }),
    getFeatureServiceMetadata:
      overrides.getFeatureServiceMetadata ??
      vi.fn<(serviceId: string) => Promise<HonuaServiceMetadata>>().mockResolvedValue({
        serviceDescription: "Test service",
        layers: [
          { id: 0, name: "Layer 0" },
          { id: 1, name: "Layer 1" },
        ],
        spatialReference: { wkid: 4326 },
      }),
    getLayerMetadata:
      overrides.getLayerMetadata ??
      vi.fn<(serviceId: string, layerId: number) => Promise<HonuaLayerMetadata>>().mockResolvedValue({
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
      }),
    queryFeatures:
      overrides.queryFeatures ??
      vi.fn<(...args: unknown[]) => Promise<HonuaQueryResponse>>().mockResolvedValue({
        objectIdFieldName: "OBJECTID",
        geometryType: "esriGeometryPoint",
        spatialReference: { wkid: 4326 },
        features: [
          { attributes: { OBJECTID: 1, NAME: "Park A", VALUE: 100 } },
          { attributes: { OBJECTID: 2, NAME: "Park B", VALUE: 200 } },
        ],
        exceededTransferLimit: false,
      }),
    pipelineFetch: overrides.pipelineFetch ?? defaultStylesPipelineFetch(),
    serverBaseUrl: overrides.serverBaseUrl ?? "https://example.test",
  };
}

export function asClient(mock: MockHonuaClient): HonuaClient {
  return mock as unknown as HonuaClient;
}
