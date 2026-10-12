import Ajv from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_VERSION, SCHEMA } from "../examples/nl-map-control/src/fixture.js";
import { reviewQuery } from "../examples/nl-map-control/src/map-runtime.js";
import {
  INCIDENT_TOOL_SCHEMA,
  SEMANTIC_QUERY_FORMS,
  SUGGESTIONS,
  groundedModel,
  incidentToolSchema,
  recordedModel,
} from "../examples/nl-map-control/src/model.js";
import { type QueryContext, compile, describeQuery } from "../examples/nl-map-control/src/query.js";
import type { HonuaAgentWidgetQueryRequest } from "../src/agent-tools/index.js";
import { createNlMapControl } from "../src/nl-map-control/index.js";
const context: QueryContext = {
  sourceId: "incidents",
  sourceVersion: FIXTURE_VERSION,
  schemaFingerprint: SCHEMA.fingerprint,
  authorizationContextId: "public-fixture",
  viewport: [-13619288, 6045761, -13617288, 6047761],
  mode: "recorded",
};
describe("Grounded sample query admission", () => {
  it("describes admitted operands and actual bounds without inventing a viewport scope", () => {
    const filter = {
      kind: "comparison",
      operator: "eq",
      left: { kind: "literal", value: "open" },
      right: { kind: "property", name: "status" },
    };
    expect(() => compile({ ...SEMANTIC_QUERY_FORMS.features, filter })).toThrow();
    expect(
      describeQuery(
        compile({ ...SEMANTIC_QUERY_FORMS.features, filter: SEMANTIC_QUERY_FORMS.filters.comparison }).query,
      ),
    ).toContain('status eq "literal user value"');
    const summary = describeQuery(
      compile({ ...SEMANTIC_QUERY_FORMS.features, filter: SEMANTIC_QUERY_FORMS.filters.viewport }).query,
    );
    expect(summary).toContain("EPSG:3857 bounds [0, 0, 1, 1]");
    expect(summary).not.toContain("captured viewport");
  });
  it("retains refinement conjuncts and grouping, rejecting widening before execution", () => {
    const base = {
      kind: "boolean",
      operator: "and",
      args: [SEMANTIC_QUERY_FORMS.filters.comparison, SEMANTIC_QUERY_FORMS.filters.viewport],
    };
    const previousQuery = compile({ ...SEMANTIC_QUERY_FORMS.aggregate, filter: base }).query;
    const snapshot = { ...context, previousQuery };
    const call = (
      semanticQuery: Readonly<Record<string, unknown>>,
      kind: HonuaAgentWidgetQueryRequest["kind"] = "categories",
    ) => ({
      sourceId: "incidents",
      kind,
      semanticQuery,
    });
    const retained = { kind: "boolean", operator: "and", args: [base, SEMANTIC_QUERY_FORMS.filters.distance] };
    expect(() => reviewQuery(call({ ...SEMANTIC_QUERY_FORMS.aggregate, filter: retained }), snapshot)).not.toThrow();
    expect(() =>
      reviewQuery(call({ ...SEMANTIC_QUERY_FORMS.aggregate, filter: SEMANTIC_QUERY_FORMS.filters.distance }), snapshot),
    ).toThrow("retain every previous filter");
    expect(() =>
      reviewQuery(call({ ...SEMANTIC_QUERY_FORMS.aggregate, filter: { ...retained, operator: "or" } }), snapshot),
    ).toThrow("retain every previous filter");
    expect(() => reviewQuery(call({ ...SEMANTIC_QUERY_FORMS.features, filter: retained }, "count"), snapshot)).toThrow(
      "retain the previous grouped count",
    );
    expect(() =>
      reviewQuery(
        call({ ...SEMANTIC_QUERY_FORMS.features, filter: SEMANTIC_QUERY_FORMS.filters.distance }, "count"),
        context,
      ),
    ).not.toThrow();
    expect(() =>
      reviewQuery(call({ ...SEMANTIC_QUERY_FORMS.aggregate, filter: retained }), {
        ...context,
        previousQuery: compile({ ...SEMANTIC_QUERY_FORMS.features, filter: base }).query,
      }),
    ).not.toThrow();
  });
  it("advertises only the current refinement shape without rewriting model queries", async () => {
    const previousQuery = compile({
      ...SEMANTIC_QUERY_FORMS.aggregate,
      filter: SEMANTIC_QUERY_FORMS.filters.viewport,
    }).query;
    const validate = new Ajv.default({ strict: false }).compile(incidentToolSchema({ ...context, previousQuery }));
    const call = {
      sourceId: "incidents",
      kind: "categories",
      semanticQuery: { ...SEMANTIC_QUERY_FORMS.aggregate, filter: previousQuery.filter },
    };
    expect(validate(call)).toBe(true);
    expect(
      validate({
        ...call,
        kind: "count",
        semanticQuery: { ...SEMANTIC_QUERY_FORMS.features, filter: previousQuery.filter },
      }),
    ).toBe(false);
    expect(
      validate({ ...call, semanticQuery: { ...call.semanticQuery, filter: SEMANTIC_QUERY_FORMS.filters.distance } }),
    ).toBe(false);
    expect(
      validate({
        ...call,
        semanticQuery: {
          ...call.semanticQuery,
          filter: {
            kind: "boolean",
            operator: "and",
            args: [previousQuery.filter, SEMANTIC_QUERY_FORMS.filters.distance],
          },
        },
      }),
    ).toBe(true);
    const snapshot: QueryContext = { ...context, previousQuery, selectedLocation: [0, 0] };
    const recorded = createNlMapControl({
      tools: { runtime: {}, tools: ["runWidgetQuery"] },
      llm: recordedModel(snapshot),
    });
    const plan = await recorded.propose(SUGGESTIONS[2]);
    expect(validate(plan.steps[0].call.args)).toBe(true);
    const unfiltered = compile(SEMANTIC_QUERY_FORMS.aggregate).query;
    const unfilteredSchema = new Ajv.default({ strict: false }).compile(
      incidentToolSchema({ ...context, previousQuery: unfiltered }),
    );
    expect(
      unfilteredSchema({ sourceId: "incidents", kind: "categories", semanticQuery: SEMANTIC_QUERY_FORMS.aggregate }),
    ).toBe(true);
    expect(
      unfilteredSchema({
        sourceId: "incidents",
        kind: "categories",
        semanticQuery: { ...SEMANTIC_QUERY_FORMS.aggregate, filter: SEMANTIC_QUERY_FORMS.filters.distance },
      }),
    ).toBe(true);
    expect(incidentToolSchema(context)).toBe(INCIDENT_TOOL_SCHEMA);
  });
  it("self-corrects a rejected refinement without executing the widened first proposal", async () => {
    const previousQuery = compile({
      ...SEMANTIC_QUERY_FORMS.aggregate,
      filter: SEMANTIC_QUERY_FORMS.filters.comparison,
    }).query;
    const snapshot = { ...context, previousQuery };
    const widened = { ...SEMANTIC_QUERY_FORMS.features, filter: SEMANTIC_QUERY_FORMS.filters.distance };
    const corrected = {
      ...SEMANTIC_QUERY_FORMS.aggregate,
      filter: { kind: "boolean", operator: "and", args: [previousQuery.filter, SEMANTIC_QUERY_FORMS.filters.distance] },
    };
    const provider = vi
      .fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { name: "runWidgetQuery", arguments: { sourceId: "incidents", kind: "count", semanticQuery: widened } },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: "runWidgetQuery",
            arguments: { sourceId: "incidents", kind: "categories", semanticQuery: corrected },
          },
        ],
      });
    const execute = vi.fn(async (_request: HonuaAgentWidgetQueryRequest) => ({
      sourceId: "incidents",
      kind: "categories" as const,
      data: {},
    }));
    const control = createNlMapControl({
      tools: { runtime: { runSemanticWidgetQuery: execute }, tools: ["runWidgetQuery"] },
      llm: groundedModel(snapshot, provider),
      validateStep(call) {
        try {
          if (call.name !== "runWidgetQuery") throw new Error("Unexpected tool");
          reviewQuery(call.args, snapshot);
          return [];
        } catch (error) {
          return [{ code: "capability-gap", message: String(error) }];
        }
      },
    });
    const plan = await control.propose("Within 500 metres of the selected location");
    expect(plan.attempt).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    expect(provider.mock.calls[1][0].purpose).toBe("self-correct");
    expect(JSON.stringify(provider.mock.calls[1][0])).toContain("retain every previous filter");
    expect((await control.execute(plan)).outcome).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].semanticQuery).toEqual(corrected);
  });
  it("grounds provider callbacks with executable AST syntax, actual schema and captured context", async () => {
    const provider = vi.fn(recordedModel(context));
    const control = createNlMapControl({
      tools: { runtime: {}, tools: ["runWidgetQuery"] },
      llm: groundedModel(context, provider),
    });
    await control.propose(SUGGESTIONS[0]);
    const request = provider.mock.calls[0][0];
    expect(request.system).toContain(JSON.stringify(SCHEMA));
    expect(request.system).toContain(JSON.stringify(context));
    expect(request.system).toContain(JSON.stringify(SEMANTIC_QUERY_FORMS));
    expect(request.system).toContain("Never use example coordinates as a missing selectedLocation");
    expect(request.system).toContain("map viewport and previous filters are NEVER implicit");
    expect(request.tools[0].inputSchema).toEqual(INCIDENT_TOOL_SCHEMA);
    const validate = new Ajv.default({ strict: false }).compile(INCIDENT_TOOL_SCHEMA);
    expect(validate({ sourceId: "incidents", kind: "categories", field: "kind", metric: "count" })).toBe(false);
    for (const form of [SEMANTIC_QUERY_FORMS.features, SEMANTIC_QUERY_FORMS.aggregate]) {
      for (const filter of Object.values(SEMANTIC_QUERY_FORMS.filters)) {
        expect(compile({ ...form, filter }).artifact.dialect).toBe("duckdb-sql");
        const call = {
          sourceId: "incidents",
          kind: form.kind === "features" ? "count" : "categories",
          semanticQuery: { ...form, filter },
        };
        expect(validate(call), JSON.stringify(validate.errors)).toBe(true);
        expect(() => reviewQuery({ ...call, kind: form.kind === "features" ? "categories" : "count" })).toThrow(
          "Query kind does not match",
        );
      }
    }
    const incomplete = structuredClone(SEMANTIC_QUERY_FORMS.filters.viewport) as unknown as {
      bbox: { crs: { definition: Record<string, unknown> } };
    };
    delete incomplete.bbox.crs.definition.definitionAxisOrder;
    expect(
      validate({
        sourceId: "incidents",
        kind: "count",
        semanticQuery: { ...SEMANTIC_QUERY_FORMS.features, filter: incomplete },
      }),
    ).toBe(false);
  });
  it("never routes a semantic query to a legacy host that would ignore it", async () => {
    const query = vi.fn(async () => ({ sourceId: "incidents", kind: "count" as const, data: { count: 6 } }));
    const control = createNlMapControl({
      tools: { runtime: { runWidgetQuery: query }, tools: ["runWidgetQuery"] },
      llm: recordedModel(context),
    });
    const plan = await control.propose(SUGGESTIONS[0]);
    const result = await control.execute(plan);
    expect(result.outcome).toBe("failed");
    expect(query).not.toHaveBeenCalled();
  });
  it("compiles recorded answers through the same semantic compiler with bound values and captured bbox", async () => {
    const control = createNlMapControl({
      tools: { runtime: {}, tools: ["runWidgetQuery"] },
      llm: recordedModel(context),
    });
    const plan = await control.propose(SUGGESTIONS[0]);
    const call = plan.steps[0].call;
    if (call.name !== "runWidgetQuery") throw new Error("Wrong tool");
    const review = reviewQuery(call.args);
    expect(review.compiled.artifact.dialect).toBe("duckdb-sql");
    expect(review.compiled.artifact.parameters.some((parameter) => parameter.value === "open")).toBe(true);
    expect(review.compiled.artifact.sqlTemplate).toContain("ST_Intersects");
    expect(JSON.stringify(review.compiled.query)).toContain("-13619288");
  });
  it("refuses arbitrary SQL, unknown fields, unsupported operations, excessive rows and old raw where", () => {
    for (const value of [
      {
        kind: "features",
        filter: { kind: "native", dialect: "duckdb-sql", payload: { format: "text", text: "1=1" } },
        page: { kind: "first", limit: 100 },
      },
      { kind: "features", select: ["secret"], page: { kind: "first", limit: 100 } },
      {
        kind: "features",
        filter: {
          kind: "comparison",
          operator: "oops",
          left: { kind: "property", name: "status" },
          right: { kind: "literal", value: "open" },
        },
        page: { kind: "first", limit: 100 },
      },
      { kind: "features", page: { kind: "first", limit: 101 } },
    ])
      expect(() => compile(value)).toThrow();
    expect(() => reviewQuery({ sourceId: "incidents", kind: "count", query: { where: "status = 'open'" } })).toThrow();
  });
});
