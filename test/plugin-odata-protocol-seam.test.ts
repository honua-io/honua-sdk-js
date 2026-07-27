/**
 * First-party query-capable ProtocolModule parity for issue #655.
 *
 * The public OData module, deterministic planner, and built-in Source path
 * share one compiler/executor seam while retaining the existing typed OData
 * escape hatch and lazy metadata behavior.
 */
import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../src/contract/index.js";
import { HonuaOdataEntitySet } from "../src/core/odata.js";
import {
  type QueryExecutionPlanV1,
  canonicalStringify,
  compileOdataQuery,
  executeQueryPlan,
  explainQuery,
  odataProtocolModule,
  parseQueryPlan,
  serializeQueryPlan,
  sha256,
  toJsonValue,
} from "../src/query-planner/index.js";
import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  jsonResponse,
  makeMockClient,
  odataMetadataResponse,
  odataParcelsResponse,
} from "./contract/shared.js";

const descriptor = {
  id: "parcels-odata",
  protocol: "odata",
  locator: { url: "https://mock/odata", entitySet: "Parcels" },
  capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
  schema: {
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID" },
      { name: "STATE", type: "esriFieldTypeString" },
      { name: "ACRES", type: "esriFieldTypeDouble" },
      { name: "Geometry", type: "esriFieldTypeGeometry" },
    ],
  },
} satisfies SourceDescriptor;

function previousReleaseOdataPlan(plan: QueryExecutionPlanV1): QueryExecutionPlanV1 {
  if (plan.ir.source.protocol !== "odata") throw new Error("expected an OData plan");
  const steps = plan.steps.map((step) => {
    if (step.engine !== "remote") return step;
    let query = step.query;
    if (step.operation === "queryAll") {
      const pagination = query.pagination;
      if (!pagination || pagination.offset !== 0 || pagination.limit === undefined) {
        throw new Error("expected a bounded queryAll input");
      }
      query = {
        ...query,
        pagination: { offset: 0, limit: pagination.limit + 1 },
      };
    }
    return {
      ...step,
      query,
      compiled: compileOdataQuery(plan.ir.source, query),
    };
  });
  const { id: _id, fingerprint: _fingerprint, steps: _steps, ...shared } = plan;
  const unsigned = { ...shared, steps };
  const fingerprint = sha256(canonicalStringify(toJsonValue(unsigned)));
  return {
    ...unsigned,
    id: `plan_${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`,
    fingerprint,
  } as QueryExecutionPlanV1;
}

describe("OData query-capable protocol-module seam (#655)", () => {
  it("uses the planner's exact deterministic compiler hook and executes only against its discovered handle", async () => {
    let entityRequests = 0;
    const client = makeMockClient({
      routes: [
        ["/odata/$metadata", () => odataMetadataResponse()],
        [
          "/odata/Parcels",
          () => {
            entityRequests += 1;
            return jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(0, 2), { count: PARCEL_FEATURES.length }));
          },
        ],
      ],
    });
    const module = odataProtocolModule(client);
    expect(module.compile).toBeTypeOf("function");
    expect(module.execute).toBeTypeOf("function");

    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("OData discovery must remain synchronous");
    expect(discovered.adapter).toBeInstanceOf(HonuaOdataEntitySet);
    expect(entityRequests).toBe(0);

    const plan = explainQuery<ParcelAttrs>({
      descriptor,
      query: {
        where: "STATE = 'CA'",
        outFields: ["OBJECTID", "STATE"],
        pagination: { limit: 2 },
      },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote") throw new Error("expected one remote OData step");
    const compiled = module.compile({
      source: plan.ir.source,
      query: plan.ir.query,
      operation: "query",
    });
    expect(compiled).toEqual(step.compiled);
    expect(compiled.compiler).toBe("odata-v4-protocol-query-v1");
    expect(compiled.operation).toBe("query");
    expect(compiled.top).toBe(2);
    expect(entityRequests).toBe(0);

    const result = await module.execute<ParcelAttrs>(discovered, {
      compiled,
      operation: "query",
      query: {
        count: true,
        fields: [],
        returnGeometry: true,
        geometryColumn: "Geometry",
      },
    });
    expect(result.features).toHaveLength(2);
    expect(result.features[0]?.attributes.STATE).toBe("CA");
    expect(result.totalCount).toBe(PARCEL_FEATURES.length);
    expect(entityRequests).toBe(1);

    await expect(
      module.execute(discovered, {
        compiled: { ...compiled, entitySet: "Other" },
        operation: "query",
        query: { count: false, fields: [] },
      }),
    ).rejects.toThrow(/does not match the discovered protocol handle/);
    expect(entityRequests).toBe(1);

    await discovered.dispose();
  });

  it("follows a no-count nextLink for the queryAll lookahead and reports truncation", async () => {
    let entityRequests = 0;
    let firstPageTop: string | null = null;
    const client = makeMockClient({
      routes: [
        [
          "/odata/Parcels",
          (url) => {
            entityRequests += 1;
            if (url.searchParams.has("$skiptoken")) {
              return jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(2)));
            }
            firstPageTop = url.searchParams.get("$top");
            return jsonResponse(
              odataParcelsResponse(PARCEL_FEATURES.slice(0, 2), {
                nextLink: "https://mock.honua.test/odata/Parcels?$skiptoken=page-2",
              }),
            );
          },
        ],
      ],
    });
    const module = odataProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("OData discovery must remain synchronous");
    const plan = explainQuery<ParcelAttrs>({
      descriptor,
      query: { outFields: ["OBJECTID", "STATE"], pagination: { limit: 2 } },
    });
    const compiled = module.compile({
      source: plan.ir.source,
      query: plan.ir.query,
      operation: "queryAll",
    });

    expect(compiled.compiler).toBe("odata-v4-protocol-query-v1");
    expect(compiled.operation).toBe("queryAll");
    expect(compiled.top).toBe(3);
    const result = await module.execute<ParcelAttrs>(discovered, {
      compiled,
      operation: "queryAll",
      query: { count: false, fields: [] },
    });

    expect(firstPageTop).toBe("3");
    expect(entityRequests).toBe(2);
    expect(result.features).toHaveLength(2);
    expect(result.exceededTransferLimit).toBe(true);
    await discovered.dispose();
  });

  it("rejects both colliding operation-swap directions before I/O", async () => {
    let entityRequests = 0;
    const client = makeMockClient({
      routes: [
        [
          "/odata/Parcels",
          () => {
            entityRequests += 1;
            return jsonResponse(odataParcelsResponse());
          },
        ],
      ],
    });
    const module = odataProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("OData discovery must remain synchronous");
    const queryPlan = explainQuery<ParcelAttrs>({
      descriptor,
      query: { outFields: ["OBJECTID"], pagination: { limit: 2 } },
    });
    const queryAllPlan = explainQuery<ParcelAttrs>({
      descriptor,
      query: { outFields: ["OBJECTID"], pagination: { limit: 1 } },
    });
    const queryArtifact = module.compile({
      source: queryPlan.ir.source,
      query: queryPlan.ir.query,
      operation: "query",
    });
    const queryAllArtifact = module.compile({
      source: queryAllPlan.ir.source,
      query: queryAllPlan.ir.query,
      operation: "queryAll",
    });

    expect(queryArtifact.top).toBe(2);
    expect(queryAllArtifact.top).toBe(2);
    expect(queryArtifact.operation).toBe("query");
    expect(queryAllArtifact.operation).toBe("queryAll");
    await expect(
      module.execute(discovered, {
        compiled: queryArtifact,
        operation: "queryAll",
        query: { count: false, fields: [], limit: 1 },
      }),
    ).rejects.toThrow(/compiled operation does not match the requested protocol operation/);
    await expect(
      module.execute(discovered, {
        compiled: queryAllArtifact,
        operation: "query",
        query: { count: false, fields: [] },
      }),
    ).rejects.toThrow(/compiled operation does not match the requested protocol operation/);
    expect(entityRequests).toBe(0);
    await discovered.dispose();
  });

  it("does not report truncation when a no-count queryAll result exactly matches the logical limit", async () => {
    const client = makeMockClient({
      routes: [["/odata/Parcels", () => jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(0, 2)))]],
    });
    const module = odataProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("OData discovery must remain synchronous");
    const plan = explainQuery<ParcelAttrs>({
      descriptor,
      query: { outFields: ["OBJECTID"], pagination: { limit: 2 } },
    });
    const compiled = module.compile({
      source: plan.ir.source,
      query: plan.ir.query,
      operation: "queryAll",
    });
    const result = await module.execute<ParcelAttrs>(discovered, {
      compiled,
      operation: "queryAll",
      query: { count: false, fields: [], limit: 2 },
    });

    expect(compiled.top).toBe(3);
    expect(result.features).toHaveLength(2);
    expect(result.exceededTransferLimit).toBe(false);
    await discovered.dispose();
  });

  it("uses a one-row queryAll sentinel for a zero logical limit", async () => {
    let observedTop: string | null = null;
    const client = makeMockClient({
      routes: [
        [
          "/odata/Parcels",
          (url) => {
            observedTop = url.searchParams.get("$top");
            return jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(0, 1)));
          },
        ],
      ],
    });
    const module = odataProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("OData discovery must remain synchronous");
    const plan = explainQuery<ParcelAttrs>({
      descriptor,
      query: { outFields: ["OBJECTID"], pagination: { limit: 0 } },
    });
    const compiled = module.compile({
      source: plan.ir.source,
      query: plan.ir.query,
      operation: "queryAll",
    });
    const result = await module.execute<ParcelAttrs>(discovered, {
      compiled,
      operation: "queryAll",
      query: { count: false, fields: [], limit: 0 },
    });

    expect(compiled.top).toBe(1);
    expect(observedTop).toBe("1");
    expect(result.features).toHaveLength(0);
    expect(result.exceededTransferLimit).toBe(true);
    await discovered.dispose();
  });

  it("rejects a queryAll runtime limit that disagrees with the compiled lookahead before I/O", async () => {
    let entityRequests = 0;
    const client = makeMockClient({
      routes: [
        [
          "/odata/Parcels",
          () => {
            entityRequests += 1;
            return jsonResponse(odataParcelsResponse());
          },
        ],
      ],
    });
    const module = odataProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("OData discovery must remain synchronous");
    const plan = explainQuery<ParcelAttrs>({
      descriptor,
      query: { outFields: ["OBJECTID"], pagination: { limit: 1 } },
    });
    const compiled = module.compile({
      source: plan.ir.source,
      query: plan.ir.query,
      operation: "queryAll",
    });

    await expect(
      module.execute(discovered, {
        compiled,
        operation: "queryAll",
        query: { count: false, fields: [], limit: 2 },
      }),
    ).rejects.toThrow(/compiled top does not match the logical limit/);
    expect(entityRequests).toBe(0);
    await discovered.dispose();
  });

  it("keeps the bounded-local logical ceiling in the plan while OData owns the wire lookahead", () => {
    const plan = explainQuery({
      descriptor,
      query: { aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 3 },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote") throw new Error("expected a remote OData input step");

    expect(step.operation).toBe("queryAll");
    expect(step.query.pagination).toEqual({ offset: 0, limit: 3 });
    expect(step.compiled).toMatchObject({
      compiler: "odata-v4-protocol-query-v1",
      operation: "queryAll",
      top: 4,
    });
  });

  it("round-trips normal query and queryAll plans with operation-bound artifacts", () => {
    const queryPlan = explainQuery({
      descriptor,
      query: { outFields: ["OBJECTID"], pagination: { limit: 2 } },
    });
    const queryRoundTrip = parseQueryPlan(serializeQueryPlan(queryPlan));
    expect(queryRoundTrip).toEqual(queryPlan);
    const queryStep = queryRoundTrip.steps[0];
    if (!queryStep || queryStep.engine !== "remote") throw new Error("expected a remote OData query step");
    expect(queryStep.compiled).toMatchObject({
      compiler: "odata-v4-protocol-query-v1",
      operation: "query",
      top: 2,
    });

    const queryAllPlan = explainQuery({
      descriptor,
      query: { aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 1 },
    });
    const queryAllRoundTrip = parseQueryPlan(serializeQueryPlan(queryAllPlan));
    expect(queryAllRoundTrip).toEqual(queryAllPlan);
    const queryAllStep = queryAllRoundTrip.steps[0];
    if (!queryAllStep || queryAllStep.engine !== "remote") {
      throw new Error("expected a remote OData queryAll step");
    }
    expect(queryAllStep.compiled).toMatchObject({
      compiler: "odata-v4-protocol-query-v1",
      operation: "queryAll",
      top: 2,
    });
    expect(queryAllPlan.fingerprint).not.toBe(queryPlan.fingerprint);
  });

  it("validates and migrates previous-release persisted OData plans before parse or execution", async () => {
    const currentQueryPlan = explainQuery({
      descriptor,
      query: { outFields: ["OBJECTID"], pagination: { limit: 2 } },
    });
    const legacyQueryPlan = previousReleaseOdataPlan(currentQueryPlan);
    const legacyQuery = legacyQueryPlan.steps[0];
    if (!legacyQuery || legacyQuery.engine !== "remote") throw new Error("expected a legacy remote query");
    expect(legacyQuery.compiled).toMatchObject({
      compiler: "odata-v4-query-v1",
      top: 2,
    });
    expect(legacyQueryPlan.fingerprint).not.toBe(currentQueryPlan.fingerprint);
    expect(parseQueryPlan(JSON.stringify(legacyQueryPlan))).toEqual(currentQueryPlan);
    expect(serializeQueryPlan(legacyQueryPlan)).toBe(serializeQueryPlan(currentQueryPlan));

    const currentQueryAllPlan = explainQuery<ParcelAttrs>({
      descriptor,
      query: { aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 1 },
    });
    const legacyQueryAllPlan = previousReleaseOdataPlan(currentQueryAllPlan);
    const legacyRemote = legacyQueryAllPlan.steps[0];
    if (!legacyRemote || legacyRemote.engine !== "remote") throw new Error("expected a legacy remote input");
    expect(legacyRemote.query.pagination).toEqual({ offset: 0, limit: 2 });
    expect(legacyRemote.compiled).toMatchObject({
      compiler: "odata-v4-query-v1",
      top: 2,
    });
    expect(parseQueryPlan(JSON.stringify(legacyQueryAllPlan))).toEqual(currentQueryAllPlan);

    let observedTop: string | null = null;
    const client = makeMockClient({
      routes: [
        ["/odata/$metadata", () => odataMetadataResponse()],
        [
          "/odata/Parcels",
          (url) => {
            observedTop = url.searchParams.get("$top");
            return jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(0, 1), { count: 1 }));
          },
        ],
      ],
    });
    const source = createDataset({
      id: "odata-legacy-plan-migration",
      client,
      skipCompatibilityCheck: true,
      sources: [descriptor],
    }).source<ParcelAttrs>(descriptor.id);
    if (!source) throw new Error("expected OData source");

    const execution = await executeQueryPlan(legacyQueryAllPlan, source);
    expect(observedTop).toBe("2");
    expect(execution.planId).toBe(currentQueryAllPlan.id);
    expect(execution.fingerprint).toBe(currentQueryAllPlan.fingerprint);
    expect(execution.result.aggregateRows).toEqual([{ sum_ACRES: PARCEL_FEATURES[0]?.attributes.ACRES }]);
  });

  it("preserves the built-in Source escape hatch and query result behavior", async () => {
    const client = makeMockClient({
      routes: [
        ["/odata/$metadata", () => odataMetadataResponse()],
        [
          "/odata/Parcels",
          () => jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(0, 2), { count: PARCEL_FEATURES.length })),
        ],
      ],
    });
    const source = createDataset({
      id: "odata-module-parity",
      client,
      skipCompatibilityCheck: true,
      sources: [descriptor],
    }).source<ParcelAttrs>(descriptor.id);
    if (!source) throw new Error("expected OData source");

    const adapter = source.protocol("odata");
    expect(adapter).toBeInstanceOf(HonuaOdataEntitySet);
    expect(adapter?.entitySet).toBe("Parcels");

    const result = await source.query({
      where: "STATE = 'CA'",
      outFields: ["OBJECTID", "STATE"],
      pagination: { limit: 2 },
    });
    expect(result.features).toHaveLength(2);
    expect(result.features[0]?.attributes.STATE).toBe("CA");
    expect(result.totalCount).toBe(PARCEL_FEATURES.length);
  });
});
