import { describe, expect, it, vi } from "vitest";
import { createDataset } from "../src/contract/index.js";
import {
  compileQueryFilterToCql2Text,
  compileQueryFilterToOData,
  compileQueryFilterToSql92,
  queryFilter,
} from "../src/contract/query-filter.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError, HonuaHttpError } from "../src/core/errors.js";
import { toProtoQueryRequest } from "../src/core/grpc-adapter.js";
import { HonuaOdataEntitySet } from "../src/core/odata.js";

const context = { protocol: "test" };

describe("audit query correctness regressions", () => {
  it.each(["2024-01-15", "2024-01-15T12:34:56Z"])("keeps scalar %s as text across dialects", (value) => {
    const expressions = [
      queryFilter.eq("label", value),
      queryFilter.isIn("label", [value]),
      queryFilter.between("label", value, value),
    ];
    for (const expression of expressions) {
      const sql = compileQueryFilterToSql92(expression, context).where;
      const cql = compileQueryFilterToCql2Text(expression, context, () => "unused");
      const odata = compileQueryFilterToOData(expression, context, () => "unused");
      for (const compiled of [sql, cql, odata]) {
        expect(compiled).toContain(`'${value}'`);
        expect(compiled).not.toMatch(/TIMESTAMP|DATE\(/);
      }
    }
  });

  it("uses source field types for scalar date equality, IN, and ranges", () => {
    const ctx = { ...context, fieldTypes: { label: "Edm.String", observedAt: "Edm.DateTimeOffset" } };
    const value = "2024-01-15T12:34:56Z";
    for (const field of ["label", "observedAt"]) {
      for (const expression of [
        queryFilter.eq(field, value),
        queryFilter.isIn(field, [value]),
        queryFilter.between(field, value, value),
      ]) {
        const sql = compileQueryFilterToSql92(expression, ctx).where;
        const cql = compileQueryFilterToCql2Text(expression, ctx, () => "unused");
        const odata = compileQueryFilterToOData(expression, ctx, () => "unused");
        if (field === "observedAt") {
          expect(sql).toContain(`TIMESTAMP '${value}'`);
          expect(cql).toContain(`TIMESTAMP('${value}')`);
          expect(odata).toContain(value);
          expect(odata).not.toContain(`'${value}'`);
        } else {
          for (const compiled of [sql, cql, odata]) {
            expect(compiled).toContain(`'${value}'`);
            expect(compiled).not.toContain("TIMESTAMP");
          }
        }
      }
    }
  });

  it("binds OData metadata types when the descriptor has no schema", async () => {
    const filters: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/$metadata"))
          return new Response(
            `<Schema Namespace="Test"><EntityType Name="Feature"><Property Name="label" Type="Edm.String"/><Property Name="observedAt" Type="Edm.DateTimeOffset"/><Property Name="observedDate" Type="Edm.Date"/></EntityType><EntityContainer Name="Container"><EntitySet Name="Features" EntityType="Test.Feature"/></EntityContainer></Schema>`,
            { headers: { "Content-Type": "application/xml" } },
          );
        filters.push(url.searchParams.get("$filter") ?? "");
        return Response.json({ value: [] });
      },
    });
    const source = createDataset({
      id: "test",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "rows",
          protocol: "odata",
          locator: { url: "https://example.test/odata", entitySet: "Features" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
        },
      ],
    }).source("rows")!;
    const value = "2024-01-15T12:34:56Z";
    for (const field of ["label", "observedAt"]) {
      await source.query({ filter: queryFilter.eq(field, value) });
      await source.query({ filter: queryFilter.isIn(field, [value]) });
      await source.query({ filter: queryFilter.between(field, value, value) });
    }
    const date = "2024-01-15";
    await source.query({ filter: queryFilter.eq("observedDate", date) });
    await source.query({ filter: queryFilter.isIn("observedDate", [date]) });
    await source.query({ filter: queryFilter.between("observedDate", date, date) });
    expect(filters).toEqual([
      `label eq '${value}'`,
      `label in ('${value}')`,
      `(label ge '${value}' and label le '${value}')`,
      `observedAt eq ${value}`,
      `observedAt in (${value})`,
      `(observedAt ge ${value} and observedAt le ${value})`,
      `observedDate eq ${date}`,
      `observedDate in (${date})`,
      `(observedDate ge ${date} and observedDate le ${date})`,
    ]);
  });

  it("binds GeoServices descriptor field types", async () => {
    const wheres: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input) => {
        wheres.push(new URL(String(input)).searchParams.get("where") ?? "");
        return Response.json({ features: [] });
      },
    });
    const source = createDataset({
      id: "test",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "rows",
          protocol: "geoservices-feature-service",
          locator: { url: "https://example.test", serviceId: "test", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
          schema: {
            fields: [
              { name: "label", type: "esriFieldTypeString" },
              { name: "observedAt", type: "esriFieldTypeDate" },
            ],
          },
        },
      ],
    }).source("rows")!;
    const value = "2024-01-15T12:34:56Z";
    await source.query({ filter: queryFilter.eq("label", value) });
    await source.query({ filter: queryFilter.eq("observedAt", value) });
    expect(wheres).toEqual([`label = '${value}'`, `observedAt = TIMESTAMP '${value}'`]);
  });

  it("keeps explicit temporal predicates typed", () => {
    const expression = queryFilter.before("observedAt", "2024-01-15T12:34:56Z");
    expect(compileQueryFilterToSql92(expression, context).where).toBe("observedAt < TIMESTAMP '2024-01-15T12:34:56Z'");
    expect(compileQueryFilterToCql2Text(expression, context, () => "unused")).toBe(
      "T_BEFORE(observedAt, TIMESTAMP('2024-01-15T12:34:56Z'))",
    );
    expect(compileQueryFilterToOData(expression, context, () => "unused")).toBe("observedAt lt 2024-01-15T12:34:56Z");
  });

  it.each(["queryAll", "queryStream", "delta"] as const)("rejects a cyclic OData nextLink in %s", async (operation) => {
    let calls = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () => {
        calls += 1;
        return Response.json({
          value: [{ id: calls }],
          "@odata.nextLink": calls === 1 ? "/odata/Features?$skip=1" : "https://example.test/odata/Features?$skip=1",
        });
      },
    });
    const entity = new HonuaOdataEntitySet({ client, entitySet: "Features" });
    const run = async () => {
      if (operation === "queryAll") return entity.queryAll();
      for await (const _page of entity[operation]()) {
        /* Drain until the cycle is refused. */
      }
    };
    await expect(run()).rejects.toBeInstanceOf(HonuaHttpError);
    expect(calls).toBe(2);
  });

  it.each([undefined, 500])("streams more than 2000 gRPC rows with per-batch limit %s", async (limit) => {
    const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web" });
    const signal = new AbortController().signal;
    const query = vi.spyOn(client, "queryFeatures").mockImplementation(async (request) => {
      expect(request.signal).toBe(signal);
      const wire = toProtoQueryRequest(request);
      const offset = Number(wire.resultOffsetLong);
      const count = Math.min(Number(wire.resultRecordCountLong), 4501 - offset);
      return {
        features: Array.from({ length: Math.max(0, count) }, (_, index) => ({
          attributes: { OBJECTID: offset + index },
        })),
      };
    });
    const native = vi.spyOn(client, "queryFeaturesStream");
    const dataset = createDataset({
      id: "test",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "rows",
          protocol: "grpc",
          locator: { url: "https://example.test", serviceId: "test", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.grpc,
        },
      ],
    });
    const source = dataset.source("rows")!;
    const ids: number[] = [];
    for await (const page of source.stream({ signal, ...(limit ? { pagination: { limit } } : {}) })) {
      expect(page.features.length).toBeLessThanOrEqual(limit ?? 2000);
      ids.push(...page.features.map((feature) => feature.attributes.OBJECTID as number));
    }
    expect(ids).toEqual(Array.from({ length: 4501 }, (_, index) => index));
    expect(query.mock.calls.map(([request]) => request.resultOffset)).toEqual(
      Array.from({ length: Math.ceil(4501 / (limit ?? 2000)) }, (_, index) => index * (limit ?? 2000)),
    );
    expect(native).not.toHaveBeenCalled();
  });

  it("refuses a gRPC server that ignores the advancing stream offset", async () => {
    const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web" });
    vi.spyOn(client, "queryFeatures").mockResolvedValue({ features: [{ attributes: { OBJECTID: 1 } }] });
    const stream = client.featureLayer("test", 0).queryFeaturesStream({ pageSize: 1 });
    await stream.next();
    await expect(stream.next()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("propagates cancellation between gRPC stream pages", async () => {
    const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web" });
    const controller = new AbortController();
    vi.spyOn(client, "queryFeatures").mockImplementation(async (request) => {
      if (request.signal?.aborted) throw new HonuaAbortError();
      return { features: [{ attributes: { OBJECTID: request.resultOffset } }] };
    });
    const stream = client.featureLayer("test", 0).queryFeaturesStream({ pageSize: 1, signal: controller.signal });
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toBeInstanceOf(HonuaAbortError);
  });
});
