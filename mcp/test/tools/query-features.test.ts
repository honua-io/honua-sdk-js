import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/index.js";
import { execute, schema } from "../../src/tools/query-features.js";
import { asClient, createMockClient } from "../test-helpers.js";

const LEGACY = { serviceId: "Parks", layerId: 0 };
const NEUTRAL = { source: "geoservices-feature-service:Parks/0" };

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("honua_query_features", () => {
  it("rejects unsupported standard inputs over MCP without executing a query", async () => {
    const mock = createMockClient();
    const server = createServer(asClient(mock));
    const client = new Client({ name: "schema-honesty", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      const advertised = tools.find((tool) => tool.name === "honua_query_features")?.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      const standard = JSON.parse(
        readFileSync(
          new URL("../../certification/geospatial-mcp-schemas/tools/query_features.schema.json", import.meta.url),
          "utf8",
        ),
      );
      for (const field of ["resultOffset", "outSrid", "returnGeometry"]) {
        expect(advertised[field].type).toBe(standard.properties[field].type);
      }
      expect(advertised.returnGeometry.default).toBe(standard.properties.returnGeometry.default);
      for (const argument of [{ returnCountOnly: true }, { geometryPrecision: 2 }, { typoOffset: 100 }]) {
        const result = await client.callTool({ name: "honua_query_features", arguments: { ...LEGACY, ...argument } });
        expect(result.isError).toBe(true);
      }
      const style = await client.callTool({
        name: "honua_apply_style_preset",
        arguments: { styleId: "streets", ...LEGACY },
      });
      expect(style.isError).toBe(true);
      expect(mock.queryFeatures).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("forwards standard paging and CRS aliases and defaults to geometry", async () => {
    const mock = createMockClient();
    await execute(
      asClient(mock),
      schema.parse({ ...LEGACY, resultOffset: 100, outSrid: 3857, returnCountOnly: false }),
    );
    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        resultOffset: 100,
        outSr: 3857,
        returnGeometry: true,
      }),
    );
  });

  it.each([{ returnCountOnly: true }, { geometryPrecision: 2 }, { typoOffset: 100 }])(
    "rejects unsupported arguments instead of dropping %j",
    (argument) => {
      expect(() => schema.parse({ ...LEGACY, ...argument })).toThrow();
    },
  );

  it("refuses ambiguous alias pairs before issuing a query", async () => {
    const mock = createMockClient();
    await expect(execute(asClient(mock), schema.parse({ ...LEGACY, offset: 10, resultOffset: 20 }))).rejects.toThrow(
      /either offset/,
    );
    await expect(execute(asClient(mock), schema.parse({ ...LEGACY, outSr: 4326, outSrid: 3857 }))).rejects.toThrow(
      /either outSr/,
    );
    expect(mock.queryFeatures).not.toHaveBeenCalled();
  });

  it("returns features with returnedCount and the neutral source identity", async () => {
    const mock = createMockClient();
    const parsed = parse(await execute(asClient(mock), schema.parse(NEUTRAL)));

    expect(parsed.returnedCount).toBe(2);
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].attributes.NAME).toBe("Park A");
    expect(parsed.exceededTransferLimit).toBe(false);
    expect(parsed.source).toBe("geoservices-feature-service:Parks/0");
    expect(parsed.protocol).toBe("geoservices-feature-service");
  });

  it("accepts the deprecated serviceId/layerId pair and resolves the same source", async () => {
    const mock = createMockClient();
    const parsed = parse(await execute(asClient(mock), schema.parse(LEGACY)));

    expect(parsed.source).toBe("geoservices-feature-service:Parks/0");
    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ serviceId: "Parks", layerId: 0 }));
  });

  it("omits geometry when returnGeometry is false", async () => {
    const mock = createMockClient();
    const parsed = parse(await execute(asClient(mock), schema.parse({ ...NEUTRAL, returnGeometry: false })));

    expect(parsed.features[0].geometry).toBeUndefined();
    expect(parsed.geometryFormat).toBeNull();
  });

  it("returns GeoJSON geometry for a neutrally addressed source", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({
        features: [{ attributes: { OBJECTID: 1 }, geometry: { x: 10, y: 20 } }],
      }),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse({ ...NEUTRAL, returnGeometry: true })));

    expect(parsed.geometryFormat).toBe("geojson");
    expect(parsed.features[0].geometry).toEqual({ type: "Point", coordinates: [10, 20] });
  });

  it("keeps Esri-JSON geometry for a legacy-addressed source", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({
        features: [{ attributes: { OBJECTID: 1 }, geometry: { x: 10, y: 20 } }],
      }),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse({ ...LEGACY, returnGeometry: true })));

    expect(parsed.geometryFormat).toBe("esri-json");
    expect(parsed.features[0].geometry).toEqual({ x: 10, y: 20 });
  });

  it("honours an explicit geometryFormat over the addressing default", async () => {
    const mock = createMockClient({
      queryFeatures: vi.fn().mockResolvedValue({
        features: [{ attributes: { OBJECTID: 1 }, geometry: { x: 10, y: 20 } }],
      }),
    });
    const parsed = parse(
      await execute(asClient(mock), schema.parse({ ...LEGACY, returnGeometry: true, geometryFormat: "geojson" })),
    );

    expect(parsed.features[0].geometry).toEqual({ type: "Point", coordinates: [10, 20] });
  });

  it("compiles the typed filter to a GeoServices where clause", async () => {
    const mock = createMockClient();
    await execute(
      asClient(mock),
      schema.parse({
        ...NEUTRAL,
        filter: {
          op: "and",
          args: [
            { op: "eq", field: "STATUS", value: "open" },
            { op: "gt", field: "VALUE", value: 100 },
          ],
        },
      }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ where: "(STATUS = 'open') AND (VALUE > 100)" }),
    );
  });

  it("carries a bbox through as an envelope geometry parameter", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, bbox: [-120, 30, -110, 40] }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        geometry: { xmin: -120, ymin: 30, xmax: -110, ymax: 40 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      }),
    );
  });

  it("converts GeoJSON geometry into the query geometry", async () => {
    const mock = createMockClient();
    await execute(
      asClient(mock),
      schema.parse({ ...NEUTRAL, geometry: { type: "Point", coordinates: [10, 20] }, spatialRel: "within" }),
    );

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        geometry: { x: 10, y: 20 },
        geometryType: "esriGeometryPoint",
        spatialRel: "esriSpatialRelWithin",
      }),
    );
  });

  it("still accepts Esri-JSON geometry from legacy clients", async () => {
    const mock = createMockClient();
    const geometry = { xmin: -120, ymin: 30, xmax: -110, ymax: 40 };
    await execute(asClient(mock), schema.parse({ ...LEGACY, geometry }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ geometry, geometryType: "esriGeometryEnvelope" }),
    );
  });

  it("compiles the canonical temporal filter onto the source time dimension", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, temporal: { start: "2026-01-01T00:00:00Z", end: null } }));

    const request = mock.queryFeatures.mock.calls[0][0] as { extraParams?: Record<string, unknown> };
    expect(request.extraParams?.time).toBeDefined();
  });

  it("clamps limit to 2000 and defaults it to 100", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, limit: 5000 }));
    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ resultRecordCount: 2000 }));

    const other = createMockClient();
    await execute(asClient(other), schema.parse(NEUTRAL));
    expect(other.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ resultRecordCount: 100 }));
  });

  it("accepts both the array and legacy string orderBy forms", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, orderBy: "NAME DESC,VALUE ASC" }));
    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ orderByFields: "NAME DESC,VALUE" }));

    const other = createMockClient();
    await execute(asClient(other), schema.parse({ ...NEUTRAL, orderBy: [{ field: "NAME", direction: "desc" }] }));
    expect(other.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ orderByFields: "NAME DESC" }));
  });

  it("requests all fields on GeoServices when outFields is omitted or empty", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse(NEUTRAL));
    expect(mock.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ outFields: ["*"] }));

    const other = createMockClient();
    await execute(asClient(other), schema.parse({ ...NEUTRAL, outFields: [] }));
    expect(other.queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ outFields: ["*"] }));
  });

  it("passes explicit outFields and offset through", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ ...NEUTRAL, outFields: ["OBJECTID", "NAME"], offset: 25 }));

    expect(mock.queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ outFields: ["OBJECTID", "NAME"], resultOffset: 25 }),
    );
  });

  it("returns a structured validation error when no source is addressed", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({}));

    expect(result.isError).toBe(true);
    const parsed = parse(result);
    expect(parsed.code).toBe("invalid_source_reference");
    expect(parsed.error.kind).toBe("ValidationFailed");
    expect(mock.queryFeatures).not.toHaveBeenCalled();
  });

  it("refuses serviceId without layerId rather than guessing layer 0", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({ serviceId: "Parks" }));

    expect(result.isError).toBe(true);
    expect(parse(result).error.kind).toBe("ValidationFailed");
  });

  it("rejects invalid negative paging/layer inputs", () => {
    expect(() => schema.parse({ serviceId: "Parks", layerId: -1 })).toThrow();
    expect(() => schema.parse({ ...NEUTRAL, offset: -1 })).toThrow();
    expect(() => schema.parse({ ...NEUTRAL, limit: 0 })).toThrow();
  });
});
