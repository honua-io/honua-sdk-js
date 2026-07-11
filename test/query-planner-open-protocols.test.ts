import { describe, expect, it } from "vitest";

import type { Query, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import {
  HonuaQueryPlanningError,
  compileOdataQuery,
  compileWfsQuery,
  createQueryIr,
  explainQuery,
} from "../src/query-planner/index.js";

function wfsDescriptor(queryAggregate = false): SourceDescriptor {
  return {
    id: "parcels",
    protocol: "wfs",
    locator: { url: "https://geo.example.test/wfs?token=secret", typeName: "cad:parcels", srsName: "EPSG:4326" },
    capabilities: capabilities(queryAggregate ? ["query", "queryAggregate"] : ["query"]),
    schema: {
      primaryKey: "parcel_id",
      fields: [
        { name: "parcel_id", type: "esriFieldTypeInteger" },
        { name: "shape", type: "esriFieldTypeGeometry" },
      ],
    },
  };
}

function odataDescriptor(): SourceDescriptor {
  return {
    id: "incidents",
    protocol: "odata",
    locator: { url: "https://api.example.test/odata#private", entitySet: "Incidents" },
    capabilities: capabilities(["query"]),
    schema: {
      primaryKey: "Id",
      fields: [
        { name: "Id", type: "esriFieldTypeInteger" },
        { name: "Location", type: "esriFieldTypeGeometry" },
      ],
    },
  };
}

describe("WFS query planning", () => {
  it("compiles filtering, spatial predicates, projection, sorting, and paging to FES 2.0", () => {
    const query: Query = {
      where: "status = 'A&B'",
      spatialFilter: {
        geometry: { xmin: -158, ymin: 20, xmax: -157, ymax: 21 },
        geometryType: "esriGeometryEnvelope",
      },
      outFields: ["parcel_id", "status"],
      orderBy: [{ field: "parcel_id", direction: "desc" }],
      pagination: { offset: 5, limit: 25 },
    };

    const plan = explainQuery({ descriptor: wfsDescriptor(), query, authorizationScope: ["read"] });
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      compiled: {
        compiler: "wfs-2.0-get-feature-v1",
        typeName: "cad:parcels",
        propertyName: ["parcel_id", "status", "the_geom"],
        sortBy: "parcel_id D",
        startIndex: 5,
        count: 25,
      },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote" || step.compiled.compiler !== "wfs-2.0-get-feature-v1") {
      throw new Error("expected WFS remote step");
    }
    expect(step.compiled.filter).toContain("<fes:And>");
    expect(step.compiled.filter).toContain("A&amp;B");
    expect(step.compiled.filter).toContain("<fes:BBOX>");
    expect(JSON.stringify(plan)).not.toContain("secret");
  });

  it("fails closed for unsupported FES and permits only explicit bounded local aggregation", () => {
    expect(() =>
      explainQuery({ descriptor: wfsDescriptor(), query: { where: "UPPER(status) = 'OPEN'" } }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-query" }));
    expect(() =>
      explainQuery({
        descriptor: wfsDescriptor(),
        query: {
          spatialFilter: {
            geometry: { xmin: -158, ymin: 20, xmax: -157, ymax: 21 },
            geometryType: "esriGeometryEnvelope",
          },
          outSr: "EPSG:3857",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-query" }));

    const responseCrs = explainQuery({
      descriptor: wfsDescriptor(),
      query: { outSr: "EPSG:3857" },
    });
    expect(responseCrs.steps[0]).toMatchObject({ compiled: { srsName: "EPSG:3857" } });

    const plan = explainQuery({
      descriptor: wfsDescriptor(),
      query: { aggregation: { metrics: [{ fn: "count", field: "parcel_id" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 100 },
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      operation: "queryAll",
      compiled: { compiler: "wfs-2.0-get-feature-v1", count: 101 },
    });
    expect(() =>
      explainQuery({
        descriptor: wfsDescriptor(),
        query: { outFields: ["parcel_id", "the_geom"], returnGeometry: false },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-query" }));
  });
});

describe("OData query planning", () => {
  it("compiles canonical predicates, spatial filters, nested projection, sorting, and paging", () => {
    const plan = explainQuery({
      descriptor: odataDescriptor(),
      query: {
        where: "Severity >= 3 AND Status = 'open'",
        spatialFilter: {
          geometry: { x: -157.8, y: 21.3, spatialReference: { wkid: 4326 } },
          geometryType: "esriGeometryPoint",
        },
        outFields: ["Id", "Status", "Reporter.Name"],
        orderBy: [{ field: "ReportedAt", direction: "desc" }],
        pagination: { offset: 10, limit: 20 },
      },
    });
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      compiled: {
        compiler: "odata-v4-query-v1",
        entitySet: "Incidents",
        filter:
          "Severity ge 3 and Status eq 'open' and geo.intersects(Location,geography'SRID=4326;POINT(-157.8 21.3)')",
        select: ["Id", "Status", "Location"],
        expand: ["Reporter($select=Name)"],
        orderBy: ["ReportedAt desc"],
        skip: 10,
        top: 20,
      },
    });
  });

  it("rejects unsupported operators and non-finite spatial coordinates before execution", () => {
    const source = createQueryIr({ descriptor: odataDescriptor() }).source;
    expect(() =>
      compileOdataQuery(source, createQueryIr({ descriptor: odataDescriptor(), query: { where: "Id IN (1)" } }).query),
    ).toThrowError(HonuaQueryPlanningError);
    expect(() =>
      compileOdataQuery(
        source,
        createQueryIr({
          descriptor: odataDescriptor(),
          query: {
            spatialFilter: {
              geometry: { x: "0');delete" as unknown as number, y: 1 },
              geometryType: "esriGeometryPoint",
            },
          },
        }).query,
      ),
    ).toThrowError(expect.objectContaining({ code: "unsupported-query" }));
    for (const where of ["Name LIKE 'A%'", "Id BETWEEN 1 AND 3", "Name = 'unterminated", "Id != 2", "Id == 2"]) {
      expect(() => explainQuery({ descriptor: odataDescriptor(), query: { where } })).toThrowError(
        expect.objectContaining({ code: "unsupported-query" }),
      );
    }
  });

  it("requires an explicit projection to prove geometry suppression", () => {
    expect(() => explainQuery({ descriptor: odataDescriptor(), query: { returnGeometry: false } })).toThrowError(
      expect.objectContaining({ code: "unsupported-query" }),
    );
    const withoutGeometrySchema = { ...odataDescriptor(), schema: { primaryKey: "Id" } };
    expect(() =>
      explainQuery({
        descriptor: withoutGeometrySchema,
        query: {
          spatialFilter: { geometry: { x: 0, y: 0 }, geometryType: "esriGeometryPoint" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-query" }));
    expect(() => explainQuery({ descriptor: odataDescriptor(), query: { outSr: 4326 } })).toThrowError(
      expect.objectContaining({ code: "unsupported-query" }),
    );
  });

  it("preserves the geometry column for explicit projections unless geometry is disabled", () => {
    for (const returnGeometry of [undefined, true]) {
      const plan = explainQuery({
        descriptor: odataDescriptor(),
        query: { outFields: ["Id", "Location"], ...(returnGeometry === undefined ? {} : { returnGeometry }) },
      });
      expect(plan.steps[0]).toMatchObject({
        compiled: { select: ["Id", "Location"] },
      });
    }

    const withoutGeometry = explainQuery({
      descriptor: odataDescriptor(),
      query: { outFields: ["Id", "Location"], returnGeometry: false },
    });
    expect(withoutGeometry.steps[0]).toMatchObject({ compiled: { select: ["Id"] } });
  });
});

describe("compiler protocol guards", () => {
  it("rejects cross-protocol compiler calls", () => {
    const odata = createQueryIr({ descriptor: odataDescriptor() });
    expect(() => compileWfsQuery(odata.source, odata.query)).toThrowError(
      expect.objectContaining({ code: "unsupported-compiler" }),
    );
  });
});
