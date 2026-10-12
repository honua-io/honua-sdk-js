import { describe, expect, it, vi } from "vitest";
import { FIXTURE_VERSION, SCHEMA } from "../examples/nl-map-control/src/fixture.js";
import { reviewQuery } from "../examples/nl-map-control/src/map-runtime.js";
import { SUGGESTIONS, recordedModel } from "../examples/nl-map-control/src/model.js";
import { type QueryContext, compile } from "../examples/nl-map-control/src/query.js";
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
