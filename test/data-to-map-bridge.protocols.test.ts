/**
 * Cross-protocol matrix for the standalone data-to-map bridge: the same
 * `mountSource` workflow is exercised end-to-end (protocol adapter → bridge →
 * duck-typed MapLibre host) against GeoServices, OGC API Features, and WFS
 * sources served by the shared deterministic mock client.
 */

import { describe, expect, it } from "vitest";

import {
  type Dataset,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type SourceDescriptor,
  createDataset,
} from "../src/contract/index.js";
import { type DataToMapLibreMap, mountSource } from "../src/map/index.js";
import {
  geoservicesExtentResponse,
  geoservicesQueryResponse,
  jsonResponse,
  makeMockClient,
  ogcCollectionMetadata,
  ogcItemsResponse,
  wfsCapabilitiesXml,
  wfsGeoJsonResponse,
  xmlResponse,
} from "./contract/shared.js";

class FakeMap implements DataToMapLibreMap {
  readonly sources = new Map<string, Record<string, unknown> & { setData(data: unknown): void; data?: unknown }>();
  readonly layers = new Map<string, Record<string, unknown>>();

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
  addSource(id: string, spec: unknown): void {
    const handle = {
      ...(spec as Record<string, unknown>),
      setData(data: unknown) {
        handle.data = data;
      },
    } as Record<string, unknown> & { setData(data: unknown): void; data?: unknown };
    this.sources.set(id, handle);
  }
  removeSource(id: string): void {
    this.sources.delete(id);
  }
  getLayer(id: string): unknown {
    return this.layers.get(id);
  }
  addLayer(layer: unknown): void {
    const record = layer as Record<string, unknown>;
    this.layers.set(String(record.id), record);
  }
  removeLayer(id: string): void {
    this.layers.delete(id);
  }
}

interface Harness {
  protocol: Protocol;
  sourceId: string;
  build(): Dataset;
}

const harnesses: Harness[] = [
  {
    protocol: "geoservices-feature-service",
    sourceId: "parcels-fs",
    build() {
      const client = makeMockClient({
        routes: [
          [
            "/rest/services/Parcels/FeatureServer/0/query",
            (url) => {
              if (url.searchParams.get("returnExtentOnly") === "true") {
                return jsonResponse(geoservicesExtentResponse());
              }
              return jsonResponse(geoservicesQueryResponse());
            },
          ],
        ],
      });
      return createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels-fs",
            protocol: "geoservices-feature-service",
            locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
            schema: { primaryKey: "OBJECTID" },
          } satisfies SourceDescriptor,
        ],
      });
    },
  },
  {
    protocol: "ogc-features",
    sourceId: "parcels-ogc",
    build() {
      const client = makeMockClient({
        routes: [
          ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
          ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
        ],
      });
      return createDataset({
        id: "parcels",
        client,
        capabilityPolicy: "degraded",
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels-ogc",
            protocol: "ogc-features",
            locator: { url: "https://mock/", collectionId: "parcels" },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
          } satisfies SourceDescriptor,
        ],
      });
    },
  },
  {
    protocol: "wfs",
    sourceId: "parcels-wfs",
    build() {
      const client = makeMockClient({
        routes: [
          [
            "/wfs",
            (url) => {
              const request = url.searchParams.get("request");
              if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
              if (request === "GetFeature") {
                return new Response(JSON.stringify(wfsGeoJsonResponse()), {
                  status: 200,
                  headers: { "Content-Type": "application/geo+json" },
                });
              }
              return new Response("not implemented", { status: 404 });
            },
          ],
        ],
      });
      return createDataset({
        id: "parcels",
        client,
        skipCompatibilityCheck: true,
        sources: [
          {
            id: "parcels-wfs",
            protocol: "wfs",
            locator: { url: "https://mock.honua.test/wfs", typeName: "parcels:lot" },
            capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
          } satisfies SourceDescriptor,
        ],
      });
    },
  },
];

describe.each(harnesses)("data-to-map bridge across protocols: $protocol", ({ sourceId, build }) => {
  it("mounts, styles, diff-updates, and disposes through the real adapter", async () => {
    const dataset = build();
    const source = dataset.source(sourceId);
    expect(source).toBeDefined();
    if (!source) return;

    const map = new FakeMap();
    const mounted = await mountSource(map, source, { maxGeoJsonFeatures: 100 });

    // Strategy + diagnostics: no tile descriptor, so bounded GeoJSON.
    expect(mounted.strategy).toBe("geojson");
    expect(mounted.diagnostics.reasons).toContainEqual(expect.objectContaining({ code: "query-capability" }));

    // Materialized data flowed through the protocol adapter.
    const handle = map.sources.get(mounted.sourceId);
    expect(handle).toBeDefined();
    const data = handle?.data as { type: string; features: Array<Record<string, unknown>> };
    expect(data.type).toBe("FeatureCollection");
    expect(data.features).toHaveLength(3);
    expect(data.features.every((feature) => (feature.geometry as { type?: string })?.type === "Point")).toBe(true);

    // Geometry-appropriate default styling.
    expect(map.layers.get(`${mounted.sourceId}-point`)).toMatchObject({ type: "circle" });
    expect(mounted.diagnostics.geometryKinds).toEqual(["point"]);

    // Diff update through setData, not teardown.
    await mounted.setFilter({ where: "STATE = 'CA'" });
    expect(map.sources.get(mounted.sourceId)).toBe(handle);
    expect(mounted.diagnostics.updates).toContainEqual(expect.objectContaining({ code: "filter-applied" }));

    // Disposal removes everything the bridge created.
    mounted.dispose();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    mounted.dispose(); // idempotent
  });
});
