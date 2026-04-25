/**
 * Shared fixtures for the conformance suite. The mocks here construct a
 * `HonuaClient` whose `fetchFn` is a pluggable handler keyed by URL path.
 * Conformance tests dispatch the same canonical `Query` against each
 * adapter and assert against the canonical `Result` envelope.
 */

import { HonuaClient } from "../../src/core/client.js";
import type {
  HonuaOgcFeatureCollectionResponse,
  HonuaTypedQueryResponse,
} from "../../src/core/types.js";

export type MockResponder = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export interface MockClientOptions {
  /** Map of substring matchers → responder. First match wins. */
  routes: Array<[string | RegExp, MockResponder]>;
  /** Fallback responder; defaults to 404. */
  fallback?: MockResponder;
}

export function makeMockClient(options: MockClientOptions): HonuaClient {
  const fallback: MockResponder = options.fallback ?? (() => new Response("not found", { status: 404 }));
  return new HonuaClient({
    baseUrl: "https://mock.honua.test",
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      for (const [matcher, responder] of options.routes) {
        const matched =
          typeof matcher === "string" ? url.pathname.includes(matcher) || url.href.includes(matcher) : matcher.test(url.href);
        if (matched) return responder(url, init);
      }
      return fallback(url, init);
    },
  });
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

// ── Sample features ───────────────────────────────────────────

export interface ParcelAttrs {
  OBJECTID: number;
  STATE: string;
  ACRES: number;
}

export const PARCEL_FEATURES: Array<{ attributes: ParcelAttrs; geometry: { x: number; y: number } }> = [
  { attributes: { OBJECTID: 1, STATE: "CA", ACRES: 12 }, geometry: { x: -120, y: 38 } },
  { attributes: { OBJECTID: 2, STATE: "CA", ACRES: 7.5 }, geometry: { x: -121, y: 37 } },
  { attributes: { OBJECTID: 3, STATE: "OR", ACRES: 20 }, geometry: { x: -123, y: 45 } },
];

export function geoservicesQueryResponse(
  features = PARCEL_FEATURES,
  exceeded = false,
): HonuaTypedQueryResponse<ParcelAttrs> {
  return {
    features,
    exceededTransferLimit: exceeded,
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID" },
      { name: "STATE", type: "esriFieldTypeString" },
      { name: "ACRES", type: "esriFieldTypeDouble" },
    ],
  };
}

export function geoservicesAggregateResponse(): HonuaTypedQueryResponse<{ STATE: string; SUM_ACRES: number }> {
  return {
    features: [
      { attributes: { STATE: "CA", SUM_ACRES: 19.5 }, geometry: null },
      { attributes: { STATE: "OR", SUM_ACRES: 20 }, geometry: null },
    ],
    exceededTransferLimit: false,
  };
}

export function geoservicesExtentResponse(): { extent: { xmin: number; ymin: number; xmax: number; ymax: number }; count: number } {
  return {
    extent: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
    count: PARCEL_FEATURES.length,
  };
}

export function ogcCollectionMetadata(): {
  id: string;
  extent: { spatial: { bbox: number[][] } };
} {
  return {
    id: "parcels",
    extent: { spatial: { bbox: [[-123, 37, -120, 45]] } },
  };
}

export function ogcItemsResponse(
  features = PARCEL_FEATURES,
): HonuaOgcFeatureCollectionResponse {
  return {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature" as const,
      id: f.attributes.OBJECTID,
      properties: { ...f.attributes } as Record<string, unknown>,
      geometry: { type: "Point", coordinates: [f.geometry.x, f.geometry.y] },
    })),
    numberMatched: features.length,
    numberReturned: features.length,
  };
}

// ── GeoServices edit / related / attachment fixtures ─────────

export function geoservicesApplyEditsResponse(): {
  addResults?: Array<{ objectId: number; success: boolean }>;
  updateResults?: Array<{ objectId: number; success: boolean }>;
  deleteResults?: Array<{ objectId: number; success: boolean }>;
} {
  return {
    addResults: [{ objectId: 99, success: true }],
    updateResults: [{ objectId: 1, success: true }],
    deleteResults: [{ objectId: 3, success: true }],
  };
}

export function geoservicesObjectIdsResponse(): { objectIds: number[]; objectIdFieldName: string } {
  return { objectIds: [1, 2, 3], objectIdFieldName: "OBJECTID" };
}

export function geoservicesRelatedRecordsResponse(): {
  relatedRecordGroups: Array<{
    objectId: number;
    relatedRecords: Array<{ attributes: Record<string, unknown>; geometry?: null }>;
  }>;
  fields: Array<{ name: string; type: string }>;
} {
  return {
    relatedRecordGroups: [
      {
        objectId: 1,
        relatedRecords: [
          { attributes: { OBJECTID: 11, NOTE: "permit-A" } },
          { attributes: { OBJECTID: 12, NOTE: "permit-B" } },
        ],
      },
    ],
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID" },
      { name: "NOTE", type: "esriFieldTypeString" },
    ],
  };
}

export function geoservicesAttachmentInfosResponse(): {
  attachmentInfos: Array<{ id: number; name: string; contentType: string; size: number; parentObjectId: number }>;
} {
  return {
    attachmentInfos: [
      { id: 7, parentObjectId: 1, name: "deed.pdf", contentType: "application/pdf", size: 1024 },
    ],
  };
}

export function geoservicesQueryAttachmentsResponse(): {
  attachmentGroups: Array<{
    parentObjectId: number;
    attachmentInfos: Array<{ id: number; name: string; contentType: string; size: number }>;
  }>;
} {
  return {
    attachmentGroups: [
      {
        parentObjectId: 1,
        attachmentInfos: [{ id: 7, name: "deed.pdf", contentType: "application/pdf", size: 1024 }],
      },
    ],
  };
}

export function geoservicesAddAttachmentResponse(): {
  addAttachmentResult: { objectId: number; success: boolean };
} {
  return { addAttachmentResult: { objectId: 7, success: true } };
}

export function geoservicesUpdateAttachmentResponse(): {
  updateAttachmentResult: { objectId: number; success: boolean };
} {
  return { updateAttachmentResult: { objectId: 7, success: true } };
}

export function geoservicesDeleteAttachmentsResponse(): {
  deleteAttachmentResults: Array<{ objectId: number; success: boolean }>;
} {
  return { deleteAttachmentResults: [{ objectId: 7, success: true }] };
}

// ── ImageServer fixtures ─────────────────────────────────────

export function imageServerCatalogResponse(): import("../../src/core/types.js").HonuaQueryResponse {
  return {
    objectIdFieldName: "OBJECTID",
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID" },
      { name: "Name", type: "esriFieldTypeString" },
    ],
    features: [
      {
        attributes: { OBJECTID: 101, Name: "tile_a" },
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
      },
      {
        attributes: { OBJECTID: 102, Name: "tile_b" },
        geometry: { xmin: -120, ymin: 37, xmax: -117, ymax: 45 },
      },
    ],
    exceededTransferLimit: false,
  };
}

export function imageServerExportResponse(): import("../../src/core/types.js").HonuaExportMapResponse {
  return {
    href: "https://mock/export/abcd.png",
    width: 256,
    height: 256,
    extent: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
    scale: 1,
  };
}

export function imageServerIdentifyResponse(): import("../../src/core/types.js").HonuaIdentifyResponse {
  return {
    results: [
      {
        layerId: 0,
        layerName: "Imagery",
        attributes: { Pixel: "12.4" },
      },
    ],
  };
}

// ── Geometry Service fixtures ────────────────────────────────

export function geometryProjectResponse(): { geometries: Array<Record<string, unknown>> } {
  return {
    geometries: [{ x: 100, y: 200, spatialReference: { wkid: 3857 } }],
  };
}

export function geometryBufferResponse(): { geometries: Array<Record<string, unknown>> } {
  return {
    geometries: [
      { rings: [[[-122, 37], [-122, 38], [-121, 38], [-121, 37], [-122, 37]]] },
    ],
  };
}

// ── GP Service fixtures ──────────────────────────────────────

export function gpSubmitJobResponse(): { jobId: string; jobStatus: string } {
  return { jobId: "job-001", jobStatus: "esriJobSubmitted" };
}

export function gpJobStatusResponse(): { jobId: string; jobStatus: string } {
  return { jobId: "job-001", jobStatus: "esriJobSucceeded" };
}
