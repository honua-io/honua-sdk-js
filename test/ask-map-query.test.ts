import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_VERSION, SCHEMA } from "../examples/nl-map-control/src/fixture.js";
import { reviewQuery } from "../examples/nl-map-control/src/map-runtime.js";
import {
  INCIDENT_TOOL_SCHEMA,
  SEMANTIC_QUERY_FORMS,
  SUGGESTIONS,
  groundedModel,
  recordedModel,
} from "../examples/nl-map-control/src/model.js";
import { type QueryContext, compile, describeQuery } from "../examples/nl-map-control/src/query.js";
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
  it("describes actual bounds and reversed comparison operands without inventing a viewport scope", () => {
    const filter = {
      kind: "comparison",
      operator: "eq",
      left: { kind: "literal", value: "open" },
      right: { kind: "property", name: "status" },
    };
    expect(describeQuery(compile({ ...SEMANTIC_QUERY_FORMS.features, filter }).query)).toContain('"open" eq status');
    const summary = describeQuery(
      compile({ ...SEMANTIC_QUERY_FORMS.features, filter: SEMANTIC_QUERY_FORMS.filters.viewport }).query,
    );
    expect(summary).toContain("EPSG:3857 bounds [0, 0, 1, 1]");
    expect(summary).not.toContain("captured viewport");
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
        expect(validate({ ...call, kind: form.kind === "features" ? "categories" : "count" })).toBe(false);
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
