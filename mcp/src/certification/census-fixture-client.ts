import type {
  HonuaClient,
  HonuaLayerMetadata,
  HonuaQueryResponse,
  HonuaServiceMetadata,
  HonuaServicesResponse,
} from "@honua/sdk-js";
import {
  CENSUS_EXTENT,
  CENSUS_FIELDS,
  CENSUS_LAYER_NAME,
  CENSUS_ROWS,
  CENSUS_SERVICE_ID,
  type CensusRow,
} from "./census-data.js";

/**
 * Offline PLATFORM-FREE fixture `HonuaClient` (issue #369).
 *
 * Where {@link ./fixture-client.ts:createFixtureClient} models a Honua-enhanced
 * deployment (it serves the OGC API – Styles surface), this client models a PLAIN
 * public Esri FeatureServer — exactly what the standalone `honua-mcp` front door
 * points at. It replays the recorded US Census apportionment layer
 * (services.arcgis.com; see `census-data.ts`) through a tiny in-memory GeoServices
 * evaluator so `count / query / extent / statistics` return REAL, deterministic
 * answers with no network. Crucially it exposes NO Honua-only surface: every
 * `pipelineFetch` (the OGC API – Styles path the style tools probe) 404s, so the
 * capability-degradation path is exercised for real.
 *
 * The evaluator is verified against the live recordings in
 * `test/certification/census-fixture-client.test.ts` (count=52, sum(pop)=335085841,
 * sum(seats)=435, max=California, min=Wyoming), so the semantic eval assertions
 * that ride on it are grounded, not hand-waved.
 */

const SPATIAL_REFERENCE = { wkid: 102100, latestWkid: 3857 } as const;

type QueryRequest = {
  where?: string;
  outFields?: string | string[];
  orderByFields?: string;
  resultOffset?: number;
  resultRecordCount?: number;
  outStatistics?: Array<{ statisticType: string; onStatisticField: string; outStatisticFieldName: string }>;
  groupByFieldsForStatistics?: string;
  extraParams?: Record<string, unknown>;
};

function fieldValue(row: CensusRow, field: string): string | number | null | undefined {
  return (row as unknown as Record<string, string | number | null | undefined>)[field];
}

function compare(actual: string | number | null | undefined, op: string, expected: string | number): boolean {
  if (actual === undefined || actual === null) {
    // NULL never satisfies a comparison (matches GeoServices/SQL semantics).
    return false;
  }
  if (typeof expected === "string" || typeof actual === "string") {
    const a = String(actual);
    const e = String(expected);
    switch (op) {
      case "=":
        return a === e;
      case "<>":
      case "!=":
        return a !== e;
      default:
        throw new Error(`census fixture: operator ${op} is not supported for string values`);
    }
  }
  switch (op) {
    case "=":
      return actual === expected;
    case "<>":
    case "!=":
      return actual !== expected;
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
    default:
      throw new Error(`census fixture: unsupported operator "${op}"`);
  }
}

function matchClause(row: CensusRow, clause: string): boolean {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|<>|!=|=|>|<)\s*(.+?)\s*$/.exec(clause);
  if (!match) {
    throw new Error(`census fixture: unsupported WHERE clause "${clause}"`);
  }
  const [, field, op, rawValue] = match;
  const actual = fieldValue(row, field);
  if (actual === undefined) {
    throw new Error(`census fixture: unknown field "${field}" in WHERE`);
  }
  const expected = /^'.*'$/.test(rawValue) ? rawValue.slice(1, -1) : Number(rawValue);
  if (typeof expected === "number" && Number.isNaN(expected)) {
    throw new Error(`census fixture: unparseable value in WHERE clause "${clause}"`);
  }
  return compare(actual, op, expected);
}

/** Filter the recorded rows by a (minimal) SQL WHERE clause. */
export function filterRows(where: string | undefined): CensusRow[] {
  const clause = (where ?? "1=1").trim();
  if (clause === "" || clause === "1=1") {
    return [...CENSUS_ROWS];
  }
  const conditions = clause.split(/\s+AND\s+/i);
  return CENSUS_ROWS.filter((row) => conditions.every((condition) => matchClause(row, condition)));
}

function orderRows(rows: CensusRow[], orderByFields: string): CensusRow[] {
  const specs = orderByFields.split(",").map((part) => {
    const [field, dir] = part.trim().split(/\s+/);
    return { field, descending: (dir ?? "ASC").toUpperCase() === "DESC" };
  });
  return [...rows].sort((a, b) => {
    for (const { field, descending } of specs) {
      const av = fieldValue(a, field);
      const bv = fieldValue(b, field);
      if (av === bv) {
        continue;
      }
      const less = (av ?? 0) < (bv ?? 0);
      return (less ? -1 : 1) * (descending ? -1 : 1);
    }
    return 0;
  });
}

function aggregate(rows: CensusRow[], type: string, field: string): number {
  // GeoServices aggregate statistics ignore NULL values (e.g. DC/PR seats).
  const values = rows.map((row) => fieldValue(row, field)).filter((v): v is number => typeof v === "number");
  switch (type) {
    case "count":
      return values.length;
    case "sum":
      return values.reduce((acc, v) => acc + v, 0);
    case "min":
      return values.length > 0 ? Math.min(...values) : 0;
    case "max":
      return values.length > 0 ? Math.max(...values) : 0;
    case "avg":
      return values.reduce((acc, v) => acc + v, 0) / (values.length || 1);
    case "stddev": {
      const mean = values.reduce((acc, v) => acc + v, 0) / (values.length || 1);
      const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length || 1);
      return Math.sqrt(variance);
    }
    default:
      throw new Error(`census fixture: unsupported statisticType "${type}"`);
  }
}

function computeStatistics(rows: CensusRow[], request: QueryRequest): HonuaQueryResponse {
  const stats = request.outStatistics ?? [];
  const groupField = request.groupByFieldsForStatistics?.split(",")[0]?.trim();

  const build = (subset: CensusRow[], groupValue?: string | number): Record<string, unknown> => {
    const attributes: Record<string, unknown> = {};
    if (groupField && groupValue !== undefined) {
      attributes[groupField] = groupValue;
    }
    for (const stat of stats) {
      attributes[stat.outStatisticFieldName] = aggregate(subset, stat.statisticType, stat.onStatisticField);
    }
    return { attributes };
  };

  if (!groupField) {
    return { features: [build(rows)] } as unknown as HonuaQueryResponse;
  }
  const groups = new Map<string | number, CensusRow[]>();
  for (const row of rows) {
    const key = fieldValue(row, groupField) ?? "";
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const features = [...groups.entries()].map(([value, subset]) => build(subset, value));
  return { features } as unknown as HonuaQueryResponse;
}

function projectAttributes(row: CensusRow, outFields: string | string[] | undefined): Record<string, unknown> {
  if (outFields === undefined || outFields === "*" || (Array.isArray(outFields) && outFields.length === 0)) {
    return { ...row };
  }
  const requested = Array.isArray(outFields) ? outFields : outFields.split(",").map((f) => f.trim());
  const attributes: Record<string, unknown> = {};
  for (const field of requested) {
    const value = fieldValue(row, field);
    if (value !== undefined) {
      attributes[field] = value;
    }
  }
  return attributes;
}

/** Build the offline platform-free fixture client (a plain public FeatureServer). */
export function createStandaloneFixtureClient(): HonuaClient {
  const client = {
    serverBaseUrl: "https://services.arcgis.com",

    async listServices(): Promise<HonuaServicesResponse> {
      return { services: [{ name: CENSUS_SERVICE_ID, type: "FeatureServer" }] };
    },

    async getFeatureServiceMetadata(_serviceId: string): Promise<HonuaServiceMetadata> {
      return {
        serviceDescription: "US Census 2020 apportionment (public Esri Living Atlas FeatureServer)",
        layers: [{ id: 0, name: CENSUS_LAYER_NAME }],
        spatialReference: SPATIAL_REFERENCE,
      } as unknown as HonuaServiceMetadata;
    },

    async getLayerMetadata(_serviceId: string, _layerId: number): Promise<HonuaLayerMetadata> {
      return {
        id: 0,
        name: CENSUS_LAYER_NAME,
        description: "One row per state (plus DC and Puerto Rico) with 2020 population and apportioned House seats.",
        geometryType: "esriGeometryPolygon",
        fields: CENSUS_FIELDS.map((f) => ({ ...f })),
        extent: CENSUS_EXTENT,
        spatialReference: SPATIAL_REFERENCE,
        relationships: [],
      } as unknown as HonuaLayerMetadata;
    },

    async queryFeatures(request: QueryRequest = {}): Promise<HonuaQueryResponse> {
      const rows = filterRows(request.where);
      const extra = request.extraParams ?? {};
      if (extra.returnCountOnly === true) {
        return { count: rows.length } as unknown as HonuaQueryResponse;
      }
      if (extra.returnExtentOnly === true) {
        return { count: rows.length, extent: CENSUS_EXTENT } as unknown as HonuaQueryResponse;
      }
      if (request.outStatistics && request.outStatistics.length > 0) {
        return computeStatistics(rows, request);
      }
      const ordered = request.orderByFields ? orderRows(rows, request.orderByFields) : rows;
      const offset = request.resultOffset ?? 0;
      const limit = request.resultRecordCount ?? ordered.length;
      const page = ordered.slice(offset, offset + limit);
      return {
        objectIdFieldName: "OBJECTID",
        geometryType: "esriGeometryPolygon",
        spatialReference: SPATIAL_REFERENCE,
        features: page.map((row) => ({ attributes: projectAttributes(row, request.outFields) })),
        exceededTransferLimit: false,
      } as unknown as HonuaQueryResponse;
    },

    // No Honua-only surface: the OGC API - Styles probe always 404s so the
    // capability-degradation path is exercised against a real plain endpoint.
    async pipelineFetch(_method: string, _path: string): Promise<Response> {
      return new Response(JSON.stringify({ error: { code: 404, message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  };

  return client as unknown as HonuaClient;
}
