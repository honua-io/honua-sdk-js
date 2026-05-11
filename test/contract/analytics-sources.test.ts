import { describe, expect, it } from "vitest";

import {
  ANALYTICS_SOURCE_SCHEMA_VERSION,
  assessAnalyticsSourcePushdown,
  buildAnalyticsSourceCacheKey,
  createWidgetSource,
  defineIndexedSpatialSource,
  defineQueryTileSource,
  defineWarehouseQuerySource,
  defineWarehouseTableSource,
} from "../../src/contract/index.js";
import type { AttachmentApi, Query, Result, Source } from "../../src/contract/index.js";
import { capabilities } from "../../src/contract/index.js";

interface Row {
  severity: string;
  exposure: number;
}

describe("contract / analytics source primitives", () => {
  it("normalizes warehouse table/query/tileset and indexed spatial descriptors", () => {
    const table = defineWarehouseTableSource({
      id: "warehouse.incidents.table",
      provider: "bigquery",
      relation: { project: "honua", dataset: "ops", table: "incidents" },
      cache: { key: { sourceVersion: "snapshot-9", authorizationScope: "tenant:alpha" } },
    });
    const query = defineWarehouseQuerySource({
      id: "warehouse.incidents.query",
      provider: "snowflake",
      sql: {
        text: "select severity, h3_cell, exposure from ops.incidents where status <> @status",
        dialect: "snowflake",
        parameters: { status: "closed" },
      },
    });
    const indexed = defineIndexedSpatialSource({
      id: "warehouse.incidents.h3",
      provider: "carto",
      relation: { dataset: "ops", table: "incident_cells" },
      index: {
        modelId: "h3",
        cellIdField: "h3_cell",
        resolution: 8,
        minResolution: 4,
        maxResolution: 12,
        hierarchy: "parent-child",
        coverage: { kind: "bounded", cellCount: 42_000, complete: true },
      },
    });

    expect(table).toMatchObject({
      schemaVersion: ANALYTICS_SOURCE_SCHEMA_VERSION,
      kind: "warehouse-table",
      capabilities: { pushdown: expect.arrayContaining(["sql", "widgets", "spatialAggregate"]) },
      fallback: { mode: "disabled" },
    });
    expect(query.capabilities?.pushdown).toContain("sql");
    expect(indexed.kind).toBe("h3-index");
    expect(indexed.capabilities?.pushdown).toEqual(
      expect.arrayContaining(["tiles", "widgets", "spatialAggregate", "crossfilter"]),
    );
  });

  it("builds cache keys from SQL, auth scope, filters, index resolution, and projections", () => {
    const source = defineIndexedSpatialSource({
      id: "warehouse.incidents.quadbin",
      provider: "carto",
      sql: { text: "select quadbin, severity, exposure from incidents where severity >= 3" },
      index: {
        modelId: "quadbin",
        cellIdField: "quadbin",
        resolution: 10,
        hierarchy: "parent-child",
      },
      cache: {
        key: {
          sourceVersion: "mv-17",
          authorizationScope: "role:ops",
        },
      },
    });

    const base = buildAnalyticsSourceCacheKey(source, {
      operation: "widget",
      cache: {
        filters: { severity: [3, 4, 5] },
        indexResolution: 10,
        widgetProjection: { kind: "histogram", field: "exposure" },
      },
    });
    const changedResolution = buildAnalyticsSourceCacheKey(source, {
      operation: "widget",
      cache: { filters: { severity: [3, 4, 5] }, indexResolution: 11 },
    });

    expect(base).toContain("mv-17");
    expect(base).toContain("role:ops");
    expect(base).toContain("quadbin");
    expect(base).toContain("exposure");
    expect(changedResolution).not.toBe(base);
  });

  it("threads warehouse and indexed descriptors into query-tile and widget cache identity", async () => {
    const analyticsSource = defineIndexedSpatialSource({
      id: "warehouse.incidents.h3",
      provider: "honua",
      sql: { text: "select h3_cell, severity, exposure from incidents where status <> 'closed'" },
      index: { modelId: "h3", cellIdField: "h3_cell", resolution: 8, hierarchy: "parent-child" },
      cache: { key: { sourceVersion: "snapshot-4", authorizationScope: "ops" } },
    });

    const tiles = defineQueryTileSource({
      id: "incident-h3-tiles",
      source: analyticsSource,
      endpoint: { baseUrl: "https://tiles.example.test/query-tiles" },
      query: { where: "severity >= 3", outFields: ["severity", "exposure"] },
      projection: { fields: ["severity", "exposure"] },
      cache: { key: { styleFilters: { severity: "high" }, extra: { indexResolution: 8 } } },
      featureIdentity: { idProperty: "h3_cell" },
    });

    expect(tiles.analyticsSource).toMatchObject({ id: "warehouse.incidents.h3", kind: "h3-index" });
    expect(tiles.sourceId).toBe("warehouse.incidents.h3");

    const source = stubSource();
    const result = await createWidgetSource(source, { analyticsSource }).count({
      query: { where: "severity >= 3" },
      cache: { keyParts: ["chart:count"] },
    });

    expect(result.cache.cacheKey).toContain("warehouse.incidents.h3");
    expect(result.cache.cacheKey).toContain("snapshot-4");
    expect(result.cache.cacheKey).toContain("severity >= 3");
  });

  it("reports unsupported pushdown without allowing hidden unbounded materialization", () => {
    const source = defineWarehouseTableSource({
      id: "warehouse.raw-events",
      relation: { schema: "ops", table: "raw_events" },
      capabilities: { pushdown: ["sql", "metadata"], maxClientRows: 0 },
      fallback: { mode: "disabled", reason: "raw event warehouse sources must be queried by server pushdown" },
    });

    const assessment = assessAnalyticsSourcePushdown(source, "widgets", { operation: "widget" });

    expect(assessment.supported).toBe(false);
    expect(assessment.degraded?.[0]).toMatchObject({
      capability: "queryAggregate",
      sourceId: "warehouse.raw-events",
    });
    expect(assessment.cacheKey).toContain("warehouse.raw-events");
  });
});

const emptyAttachments: AttachmentApi = {
  query: async () => [],
  list: async () => [],
  add: async () => ({ success: false }),
  update: async () => ({ success: false }),
  delete: async () => [],
};

function stubSource(): Source<Row> {
  return {
    descriptor: {
      id: "incident-records",
      protocol: "geoservices-feature-service",
      locator: { url: "https://mock/", serviceId: "Incidents", layerId: 0 },
      capabilities: capabilities(["query", "queryAggregate"]),
    },
    capabilities: capabilities(["query", "queryAggregate"]),
    query: async () => ({ features: [], exceededTransferLimit: false }),
    queryAll: async (_request?: Query<Row>): Promise<Result<Row>> => ({
      features: [],
      exceededTransferLimit: false,
      totalCount: 42,
    }),
    queryAggregate: async () => ({
      features: [],
      exceededTransferLimit: false,
      aggregateRows: [{ widget_count: 42 }],
    }),
    queryExtent: async () => ({ extent: null }),
    stream: async function* () {},
    queryObjectIds: async () => [],
    applyEdits: async () => ({ added: [], updated: [], deleted: [] }),
    queryRelated: async () => ({ groups: [] }),
    attachments: emptyAttachments,
    protocol: () => undefined,
    adapter: () => undefined,
  };
}
