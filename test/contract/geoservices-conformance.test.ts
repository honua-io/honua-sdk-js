/**
 * Ticket 24: GeoServices REST conformance against the shared client contract.
 *
 * Exercises the canonical edit / attachment / related-records / object-id
 * surface plus the new ImageServer / Geometry Service / GP Service source
 * factories. Every scenario rides the canonical `Source` envelope so the
 * same shape consumers see for OGC sources also lights up for GeoServices.
 *
 * Mock responders mirror the routes published in
 * `honua-server/docs/gis/feature-server-matrix.md`,
 * `honua-server/docs/gis/image-server-matrix.md`,
 * `honua-server/docs/gis/geometry-service-matrix.md`, and the GP Service
 * adapter spec.
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  type SourceDescriptor,
  capabilities,
  createDataset,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import {
  HonuaFeatureLayer,
  HonuaGeometryService,
  HonuaGeoprocessingService,
  HonuaImageService,
  HonuaMapLayer,
} from "../../src/core/surfaces.js";

import {
  geometryBufferResponse,
  geometryProjectResponse,
  geoservicesAddAttachmentResponse,
  geoservicesApplyEditsResponse,
  geoservicesAttachmentInfosResponse,
  geoservicesDeleteAttachmentsResponse,
  geoservicesObjectIdsResponse,
  geoservicesQueryAttachmentsResponse,
  geoservicesRelatedRecordsResponse,
  geoservicesUpdateAttachmentResponse,
  gpJobStatusResponse,
  gpSubmitJobResponse,
  imageServerCatalogResponse,
  imageServerExportResponse,
  imageServerIdentifyResponse,
  jsonResponse,
  makeMockClient,
  type ParcelAttrs,
} from "./shared.js";

describe("contract / GeoServices FeatureServer parity", () => {
  function buildFeatureDataset(routes: Array<[string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>]>) {
    const client = makeMockClient({ routes });
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
        } satisfies SourceDescriptor,
      ],
    });
  }

  it("queryObjectIds returns the OBJECTID list as canonical FeatureId[]", async () => {
    let observedReturnIdsOnly = false;
    const dataset = buildFeatureDataset([
      [
        "/rest/services/Parcels/FeatureServer/0/query",
        (url) => {
          observedReturnIdsOnly = url.searchParams.get("returnIdsOnly") === "true";
          return jsonResponse(geoservicesObjectIdsResponse());
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;
    const ids = await source.queryObjectIds({ where: "1=1" });
    expect(observedReturnIdsOnly).toBe(true);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("applyEdits round-trips canonical EditEnvelope/EditResult through the FeatureServer applyEdits route", async () => {
    let observedBody: string | undefined;
    const dataset = buildFeatureDataset([
      [
        "/rest/services/Parcels/FeatureServer/0/applyEdits",
        async (_url, init) => {
          observedBody = typeof init?.body === "string" ? init.body : await (init?.body as Blob).text();
          return jsonResponse(geoservicesApplyEditsResponse());
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;
    const result = await source.applyEdits({
      adds: [{ attributes: { OBJECTID: 0, STATE: "NV", ACRES: 100 }, geometry: { x: -115, y: 40 } }],
      updates: [{ id: 1, attributes: { OBJECTID: 1, STATE: "CA", ACRES: 99 } }],
      deletes: [3],
      rollbackOnFailure: true,
    });
    expect(result.added).toEqual([{ id: 99, success: true }]);
    expect(result.updated).toEqual([{ id: 1, success: true }]);
    expect(result.deleted).toEqual([{ id: 3, success: true }]);
    expect(observedBody).toBeDefined();
    // The canonical envelope must surface as adds/updates/deletes on the
    // wire — the shared client must not reshape into ArcGIS-only field
    // names like `addFeatures` for the unified applyEdits route.
    expect(observedBody).toContain("adds=");
    expect(observedBody).toContain("updates=");
    expect(observedBody).toContain("deletes=");
  });

  it("queryRelated translates RelatedQuery into a queryRelatedRecords request and canonicalizes the response", async () => {
    let observedRelationshipId: string | null = null;
    let observedObjectIds: string | null = null;
    const dataset = buildFeatureDataset([
      [
        "/rest/services/Parcels/FeatureServer/0/queryRelatedRecords",
        (url) => {
          observedRelationshipId = url.searchParams.get("relationshipId");
          observedObjectIds = url.searchParams.get("objectIds");
          return jsonResponse(geoservicesRelatedRecordsResponse());
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;
    const related = await source.queryRelated({ relationshipId: 0, sourceIds: [1, 2] });
    expect(observedRelationshipId).toBe("0");
    expect(observedObjectIds).toBe("1,2");
    expect(related.groups).toHaveLength(1);
    expect(related.groups[0].sourceId).toBe(1);
    expect(related.groups[0].features).toHaveLength(2);
    expect(related.groups[0].features[0].attributes).toEqual({ OBJECTID: 11, NOTE: "permit-A" });
    expect(related.fields).toBeDefined();
  });

  it("attachments.list/add/update/delete/query route through the FeatureServer attachments endpoints", async () => {
    const dataset = buildFeatureDataset([
      ["/rest/services/Parcels/FeatureServer/0/queryAttachments", () => jsonResponse(geoservicesQueryAttachmentsResponse())],
      ["/rest/services/Parcels/FeatureServer/0/1/attachments", () => jsonResponse(geoservicesAttachmentInfosResponse())],
      ["/rest/services/Parcels/FeatureServer/0/1/addAttachment", () => jsonResponse(geoservicesAddAttachmentResponse())],
      ["/rest/services/Parcels/FeatureServer/0/1/updateAttachment", () => jsonResponse(geoservicesUpdateAttachmentResponse())],
      ["/rest/services/Parcels/FeatureServer/0/1/deleteAttachments", () => jsonResponse(geoservicesDeleteAttachmentsResponse())],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;

    const list = await source.attachments.list(1);
    expect(list).toEqual([
      { id: 7, parentId: 1, name: "deed.pdf", contentType: "application/pdf", size: 1024 },
    ]);

    const queryGroups = await source.attachments.query({ parentIds: [1] });
    expect(queryGroups).toHaveLength(1);
    expect(queryGroups[0].parentId).toBe(1);

    const added = await source.attachments.add({
      parentId: 1,
      attachment: "doc-bytes",
      name: "deed.pdf",
      contentType: "application/pdf",
    });
    expect(added).toEqual({ parentId: 1, attachmentId: 7, success: true });

    const updated = await source.attachments.update({
      parentId: 1,
      attachmentId: 7,
      attachment: "new-bytes",
      name: "deed.pdf",
      contentType: "application/pdf",
    });
    expect(updated).toEqual({ parentId: 1, attachmentId: 7, success: true });

    const deleted = await source.attachments.delete({ parentId: 1, attachmentIds: [7] });
    expect(deleted).toEqual([{ parentId: 1, attachmentId: 7, success: true }]);
  });

  it("protocol() escape hatch returns the underlying HonuaFeatureLayer for raw GeoServices ops", () => {
    const dataset = buildFeatureDataset([]);
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;
    const layer = source.protocol("geoservices-feature-service");
    expect(layer).toBeInstanceOf(HonuaFeatureLayer);
    // adapter() is the legacy alias and must surface the same instance.
    expect(source.adapter("geoservices-feature-service")).toBe(layer);
  });

  it("strict policy refuses applyEdits / attachments / queryRelated when the descriptor omits them", async () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      capabilityPolicy: "strict",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-fs",
          protocol: "geoservices-feature-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: capabilities(["query"]),
        },
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-fs")!;
    await expect(
      source.applyEdits({ adds: [{ attributes: { OBJECTID: 0, STATE: "WA", ACRES: 5 } }] }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryRelated({ relationshipId: 0, sourceIds: [1] })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryObjectIds()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.attachments.list(1)).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("contract / GeoServices MapServer parity (read-only)", () => {
  function buildMapDataset(routes: Array<[string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>]>) {
    const client = makeMockClient({ routes });
    return createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-ms",
          protocol: "geoservices-map-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-map-service"],
        } satisfies SourceDescriptor,
      ],
    });
  }

  it("queryObjectIds + queryRelated work; applyEdits + attachments throw because MapServer is read-only", async () => {
    // Order matters: the `/query` matcher uses substring containment, so the
    // more specific `/queryRelatedRecords` matcher must come first or both
    // routes map to the ids-only fixture.
    const dataset = buildMapDataset([
      ["/rest/services/Parcels/MapServer/0/queryRelatedRecords", () => jsonResponse(geoservicesRelatedRecordsResponse())],
      ["/rest/services/Parcels/MapServer/0/query", () => jsonResponse(geoservicesObjectIdsResponse())],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-ms")!;
    expect(source.protocol("geoservices-map-layer")).toBeInstanceOf(HonuaMapLayer);
    expect(await source.queryObjectIds()).toEqual([1, 2, 3]);
    const related = await source.queryRelated({ relationshipId: 0, sourceIds: [1] });
    expect(related.groups).toHaveLength(1);
    await expect(
      source.applyEdits({ adds: [{ attributes: { OBJECTID: 0, STATE: "WA", ACRES: 5 } }] }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.attachments.list(1)).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("contract / GeoServices ImageServer parity", () => {
  function buildImageDataset(routes: Array<[string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>]>) {
    const client = makeMockClient({ routes });
    return createDataset({
      id: "imagery",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "tiles-img",
          protocol: "geoservices-image-service",
          locator: { url: "https://mock/", serviceId: "Imagery" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-image-service"],
        } satisfies SourceDescriptor,
      ],
    });
  }

  it("query() returns the raster catalog as canonical Result features", async () => {
    const dataset = buildImageDataset([
      ["/rest/services/Imagery/ImageServer/query", () => jsonResponse(imageServerCatalogResponse())],
    ]);
    const source = dataset.source("tiles-img")!;
    const result = await source.query({ where: "1=1" });
    expect(result.features).toHaveLength(2);
    expect((result.features[0].attributes as Record<string, unknown>).Name).toBe("tile_a");
  });

  it("protocol().exportImage / identify route through the ImageServer adapter", async () => {
    const dataset = buildImageDataset([
      ["/rest/services/Imagery/ImageServer/exportImage", () => jsonResponse(imageServerExportResponse())],
      ["/rest/services/Imagery/ImageServer/identify", () => jsonResponse(imageServerIdentifyResponse())],
    ]);
    const source = dataset.source("tiles-img")!;
    const adapter = source.protocol("geoservices-image-service");
    expect(adapter).toBeInstanceOf(HonuaImageService);
    const exported = await adapter!.exportImage({
      bbox: [-123, 37, -120, 45],
      size: [256, 256],
      format: "png",
    });
    expect(exported.href).toBe("https://mock/export/abcd.png");

    const identified = await adapter!.identify({
      geometry: { x: -121, y: 38 },
      geometryType: "esriGeometryPoint",
    });
    expect(identified.results).toHaveLength(1);
  });

  it("ImageServer source refuses applyEdits / attachments / stream / queryAggregate via capability negotiation", async () => {
    const dataset = buildImageDataset([]);
    const source = dataset.source("tiles-img")!;
    await expect(source.applyEdits({ adds: [{ attributes: {} }] })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.attachments.list(1)).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(
      source.queryAggregate({ aggregation: { metrics: [{ fn: "count", field: "OBJECTID" }] } }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(async () => {
      for await (const _ of source.stream()) {
        void _;
        break;
      }
    }).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("contract / GeoServices Geometry Service parity", () => {
  it("Geometry source exposes only the protocol() escape hatch; canonical query family throws", async () => {
    const client = makeMockClient({
      routes: [
        ["/rest/services/geometry/project", () => jsonResponse(geometryProjectResponse())],
        ["/rest/services/geometry/buffer", () => jsonResponse(geometryBufferResponse())],
      ],
    });
    const dataset = createDataset({
      id: "geom",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "geom-svc",
          protocol: "geoservices-geometry-service",
          locator: { url: "https://mock/" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-geometry-service"],
        },
      ],
    });
    const source = dataset.source("geom-svc")!;
    const adapter = source.protocol("geoservices-geometry-service");
    expect(adapter).toBeInstanceOf(HonuaGeometryService);
    const projected = await adapter!.project({
      geometries: { geometryType: "esriGeometryPoint", geometries: [{ x: -120, y: 38 }] },
      inSr: 4326,
      outSr: 3857,
    });
    expect(projected.geometries).toHaveLength(1);
    const buffered = await adapter!.buffer({
      geometries: { geometryType: "esriGeometryPoint", geometries: [{ x: -120, y: 38 }] },
      distances: [1000],
      inSr: 4326,
    });
    expect(buffered.geometries).toHaveLength(1);

    // Canonical feature surface is intentionally unsupported.
    await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryObjectIds()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.applyEdits({ adds: [] })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.attachments.list(1)).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("contract / GeoServices GP Service parity", () => {
  it("GP source lifecycle (submitJob -> jobStatus) routes through HonuaGeoprocessingService", async () => {
    const client = makeMockClient({
      routes: [
        ["/rest/services/Print/GPServer/Export%20Web%20Map%20Task/submitJob", () => jsonResponse(gpSubmitJobResponse())],
        ["/rest/services/Print/GPServer/Export%20Web%20Map%20Task/jobs/job-001", () => jsonResponse(gpJobStatusResponse())],
      ],
    });
    const dataset = createDataset({
      id: "print",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "print-gp",
          protocol: "geoservices-gp-service",
          locator: { url: "https://mock/", serviceId: "Print", taskName: "Export Web Map Task" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-gp-service"],
        },
      ],
    });
    const source = dataset.source("print-gp")!;
    const adapter = source.protocol("geoservices-gp-service");
    expect(adapter).toBeInstanceOf(HonuaGeoprocessingService);
    const submitted = await adapter!.submitJob({
      parameters: { Web_Map_as_JSON: "{}", Format: "PDF" },
    });
    expect(submitted.jobId).toBe("job-001");
    const status = await adapter!.jobStatus(submitted.jobId);
    expect(status.jobStatus).toBe("esriJobSucceeded");

    // Canonical feature surface is intentionally unsupported.
    await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.applyEdits({ adds: [] })).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("contract / OGC Features applyEdits via createItem/replaceItem/deleteItem", () => {
  it("translates the canonical EditEnvelope into per-item OGC mutations", async () => {
    const created: Array<Record<string, unknown>> = [];
    let replaced: { id: string | number | undefined; body: unknown } | null = null;
    const deleted: Array<string | number> = [];
    const itemRegex = /\/ogc\/features\/collections\/parcels\/items\/(\d+)/;
    const client = makeMockClient({
      routes: [
        [
          itemRegex,
          async (url, init) => {
            const match = itemRegex.exec(url.pathname);
            const id = match ? Number(match[1]) : undefined;
            const method = init?.method ?? "GET";
            if (method === "PUT") {
              const rawBody = init?.body;
              const body = typeof rawBody === "string" ? rawBody : rawBody !== undefined ? await (rawBody as Blob).text() : "";
              replaced = { id, body: body ? JSON.parse(body) : null };
              return jsonResponse({ id, type: "Feature", properties: {}, geometry: null });
            }
            if (method === "DELETE") {
              if (id !== undefined) deleted.push(id);
              return new Response(null, { status: 204 });
            }
            return new Response("not found", { status: 404 });
          },
        ],
        [
          "/ogc/features/collections/parcels/items",
          async (_url, init) => {
            const rawBody = init?.body;
            const body = typeof rawBody === "string" ? rawBody : rawBody !== undefined ? await (rawBody as Blob).text() : "";
            const parsed = body ? JSON.parse(body) : {};
            created.push(parsed);
            return jsonResponse({ ...parsed, id: 99 });
          },
        ],
      ],
    });
    const dataset = createDataset({
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
        },
      ],
    });
    const source = dataset.source<ParcelAttrs>("parcels-ogc")!;
    const result = await source.applyEdits({
      adds: [{ attributes: { OBJECTID: 0, STATE: "WA", ACRES: 50 }, geometry: { type: "Point", coordinates: [-122, 47] } }],
      updates: [{ id: 1, attributes: { OBJECTID: 1, STATE: "CA", ACRES: 99 }, geometry: { type: "Point", coordinates: [-120, 38] } }],
      deletes: [3],
    });
    expect(result.added[0]).toEqual({ id: 99, success: true });
    expect(result.updated[0]).toEqual({ id: 1, success: true });
    expect(result.deleted[0]).toEqual({ id: 3, success: true });
    expect(created).toHaveLength(1);
    expect(replaced).not.toBeNull();
    expect(deleted).toEqual([3]);
  });
});
