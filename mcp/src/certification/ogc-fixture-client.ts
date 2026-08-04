import type { HonuaClient } from "@honua/sdk-js";
import type {
  HonuaOgcCollectionMetadata,
  HonuaOgcCollectionsResponse,
  HonuaOgcFeatureCollectionResponse,
  HonuaOgcQueryablesResponse,
  OgcCollectionRequest,
  OgcItemsRequest,
  OgcMetadataRequest,
} from "@honua/sdk-js/honua";
import { compileCql2 } from "./cql2.js";
import { OGC_COLLECTIONS, OGC_COLLECTION_IDS, OGC_ENDPOINT } from "./ogc-data.js";

/**
 * Offline NON-GeoServices fixture `HonuaClient` (issue #1005).
 *
 * Where `census-fixture-client.ts` models a plain Esri FeatureServer, this one
 * models a plain **OGC API Features** endpoint — no `/rest/services`, no
 * FeatureServer query surface, no Honua surfaces — replaying the recorded
 * pygeoapi demo collections (`ogc-data.ts`) through an in-process evaluator that
 * honours the OGC API Features Part 1 query parameters (`limit`, `offset`,
 * `bbox`, `datetime`, `properties`, `sortby`) plus the Part 3 `filter` +
 * `filter-lang=cql2-text` the neutral tool contract compiles to.
 *
 * Its whole purpose is to prove the protocol-neutral tool contract on a
 * protocol whose vocabulary shares nothing with GeoServices: the GeoServices
 * entry points all reject, so a tool that still secretly depended on
 * `serviceId`/`layerId` fails loudly here instead of passing by accident.
 */

const NO_GEOSERVICES = "This endpoint is OGC API Features only; it publishes no GeoServices/FeatureServer surface.";

interface Feature {
  readonly type: "Feature";
  readonly id?: string | number;
  readonly geometry: Record<string, unknown> | null;
  readonly properties: Record<string, unknown> | null;
}

function requireCollection(collectionId: string | number) {
  const collection = OGC_COLLECTIONS[String(collectionId)];
  if (!collection) {
    throw new Error(`OGC API Features fixture: unknown collection "${String(collectionId)}"`);
  }
  return collection;
}

function geometryBbox(geometry: Record<string, unknown> | null): [number, number, number, number] | undefined {
  if (!geometry) return undefined;
  const coordinates = geometry.coordinates;
  const xs: number[] = [];
  const ys: number[] = [];
  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      xs.push(node[0]);
      ys.push(node[1]);
      return;
    }
    for (const child of node) visit(child);
  };
  visit(coordinates);
  if (xs.length === 0) return undefined;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function bboxIntersects(feature: Feature, bbox: string): boolean {
  const [minX, minY, maxX, maxY] = bbox.split(",").map(Number);
  const box = geometryBbox(feature.geometry);
  if (!box) return false;
  return !(box[2] < minX || box[0] > maxX || box[3] < minY || box[1] > maxY);
}

/** The collection's own time dimension, when it publishes one. */
function timeField(collectionId: string): string | undefined {
  const properties = OGC_COLLECTIONS[collectionId]?.queryables ?? {};
  return "datetime" in properties ? "datetime" : undefined;
}

function withinDatetime(feature: Feature, datetime: string, field: string): boolean {
  const raw = feature.properties?.[field];
  if (typeof raw !== "string") return false;
  const value = Date.parse(raw);
  if (Number.isNaN(value)) return false;
  const [rawStart, rawEnd] = datetime.includes("/") ? datetime.split("/") : [datetime, datetime];
  const start = rawStart === ".." || rawStart === "" ? Number.NEGATIVE_INFINITY : Date.parse(rawStart);
  const end = rawEnd === ".." || rawEnd === "" ? Number.POSITIVE_INFINITY : Date.parse(rawEnd);
  return value >= start && value <= end;
}

function sortFeatures(features: Feature[], sortby: string): Feature[] {
  const specs = sortby
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part.startsWith("-") ? { field: part.slice(1), descending: true } : { field: part, descending: false },
    );
  return [...features].sort((a, b) => {
    for (const spec of specs) {
      const av = a.properties?.[spec.field];
      const bv = b.properties?.[spec.field];
      if (av === bv) continue;
      const less = typeof av === "number" && typeof bv === "number" ? av < bv : String(av) < String(bv);
      return (less ? -1 : 1) * (spec.descending ? -1 : 1);
    }
    return 0;
  });
}

function projectProperties(feature: Feature, properties: OgcItemsRequest["properties"]): Feature {
  if (properties === undefined) return feature;
  const requested = (Array.isArray(properties) ? properties : String(properties).split(","))
    .map((name) => name.trim())
    .filter(Boolean);
  if (requested.length === 0 || requested.includes("*")) return feature;
  const projected: Record<string, unknown> = {};
  for (const name of requested) {
    if (feature.properties && name in feature.properties) projected[name] = feature.properties[name];
  }
  return { ...feature, properties: projected };
}

/** Build the offline platform-free OGC API Features fixture client. */
export function createOgcFixtureClient(): HonuaClient {
  const client = {
    serverBaseUrl: OGC_ENDPOINT,

    async listOgcCollections(_request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
      return {
        collections: OGC_COLLECTION_IDS.map(
          (id) => OGC_COLLECTIONS[id].collection as unknown as HonuaOgcCollectionsResponse["collections"][number],
        ),
      };
    },

    async getOgcCollection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
      return requireCollection(request.collectionId).collection as unknown as HonuaOgcCollectionMetadata;
    },

    async getOgcQueryables(request: OgcCollectionRequest): Promise<HonuaOgcQueryablesResponse> {
      const collection = requireCollection(request.collectionId);
      if (!collection.queryables) {
        throw new Error(
          `OGC API Features fixture: collection "${String(request.collectionId)}" publishes no queryables`,
        );
      }
      return { type: "object", properties: collection.queryables };
    },

    async listOgcItems(request: OgcItemsRequest): Promise<HonuaOgcFeatureCollectionResponse> {
      const collectionId = String(request.collectionId);
      const collection = requireCollection(collectionId);
      let features = collection.features as unknown as Feature[];

      if (request.filter !== undefined && request.filter !== "") {
        if (request.filterLang !== undefined && request.filterLang !== "cql2-text") {
          throw new Error(`OGC API Features fixture: unsupported filter-lang "${String(request.filterLang)}"`);
        }
        const predicate = compileCql2(request.filter);
        features = features.filter((feature) => predicate(feature.properties ?? {}));
      }
      if (request.bbox !== undefined) {
        features = features.filter((feature) => bboxIntersects(feature, request.bbox as string));
      }
      if (request.datetime !== undefined) {
        const field = timeField(collectionId);
        if (!field) {
          throw new Error(`OGC API Features fixture: collection "${collectionId}" has no time dimension`);
        }
        features = features.filter((feature) => withinDatetime(feature, request.datetime as string, field));
      }
      if (request.ids !== undefined) {
        const ids = (Array.isArray(request.ids) ? request.ids : String(request.ids).split(",")).map(String);
        features = features.filter((feature) => ids.includes(String(feature.id)));
      }

      const numberMatched = features.length;
      if (request.sortby) features = sortFeatures(features, request.sortby);

      const offset = request.offset ?? 0;
      // OGC API Features servers apply a default and a maximum page size
      // (Part 1 §7.15.4). The default mirrors the pygeoapi demo's 10; the
      // maximum is generous so a client that asks to drain a collection
      // actually drains it, rather than silently aggregating one page.
      const limit = Math.min(request.limit ?? 10, 1000);
      const page = features
        .slice(offset, offset + limit)
        .map((feature) => projectProperties(feature, request.properties));

      return {
        type: "FeatureCollection",
        features: page as unknown as HonuaOgcFeatureCollectionResponse["features"],
        numberMatched,
        numberReturned: page.length,
      };
    },

    // ── Surfaces this endpoint does NOT publish ──────────────────
    async listServices(): Promise<never> {
      throw new Error(NO_GEOSERVICES);
    },
    async getFeatureServiceMetadata(): Promise<never> {
      throw new Error(NO_GEOSERVICES);
    },
    async getLayerMetadata(): Promise<never> {
      throw new Error(NO_GEOSERVICES);
    },
    async queryFeatures(): Promise<never> {
      throw new Error(NO_GEOSERVICES);
    },
    async pipelineFetch(_method: string, _path: string): Promise<Response> {
      return new Response(JSON.stringify({ error: { code: 404, message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  };

  return client as unknown as HonuaClient;
}
