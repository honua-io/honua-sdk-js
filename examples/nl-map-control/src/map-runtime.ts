import type { HonuaAgentRuntime, HonuaAgentWidgetQueryRequest } from "@honua/sdk-js/agent-tools";
import { HonuaNlMapControlError } from "@honua/sdk-js/nl-map-control";
import type { DuckDbDriver } from "../../../src/geoparquet/driver.js";
import { FIXTURE_VERSION, INCIDENTS, ORIGIN, SCHEMA } from "./fixture.js";
import { type QueryContext, compile } from "./query.js";

export interface QueryResult {
  readonly features: readonly { id: number; status: string; kind: string }[];
  readonly groups?: readonly Record<string, unknown>[];
  readonly queries: readonly unknown[];
}
export async function initializeFixture(driver: DuckDbDriver): Promise<void> {
  // Only committed numeric/string constants enter this bootstrap SQL. All user
  // query literals go through the compiler's ordered prepared-statement binds.
  const rows = INCIDENTS.map(
    (row) => `(${row.id},'${row.status}','${row.kind}',${ORIGIN[0] + row.x},${ORIGIN[1] + row.y})`,
  ).join(",");
  await driver.run(
    `COPY (SELECT id::INTEGER AS id, status, kind, ST_AsWKB(ST_Point(x, y))::BLOB AS shape FROM (VALUES ${rows}) AS fixture(id,status,kind,x,y)) TO 'ask-map-incidents.parquet' (FORMAT PARQUET)`,
  );
  // Keep the fixture's physical column a BLOB. DuckDB's WKB_BLOB logical
  // annotation otherwise auto-promotes it to GEOMETRY on Parquet read, which
  // would contradict the compiler's explicit WKB decoder contract.
  const fields = await driver.query("DESCRIBE SELECT * FROM read_parquet('ask-map-incidents.parquet')");
  const expected = { id: "INTEGER", status: "VARCHAR", kind: "VARCHAR", shape: "BLOB" };
  if (
    fields.length !== 4 ||
    fields.some((field) => expected[field.column_name as keyof typeof expected] !== field.column_type)
  )
    throw new Error("Fixture physical schema differs from the admitted logical schema.");
}
export function reviewQuery(request: HonuaAgentWidgetQueryRequest) {
  if (
    request.sourceId !== "incidents" ||
    request.query ||
    !request.semanticQuery ||
    !["count", "categories"].includes(request.kind)
  ) {
    throw new HonuaNlMapControlError("refusal", "This source admits structured incident feature/count queries only.");
  }
  const compiled = compile(request.semanticQuery);
  if (compiled.query.kind === "features") {
    const selection = compiled.query.select;
    if (
      compiled.query.geometry !== "omit" ||
      selection?.length !== 3 ||
      !["id", "status", "kind"].every((field) => selection?.includes(field))
    ) {
      throw new HonuaNlMapControlError(
        "refusal",
        "Feature queries must select id, status and kind, with geometry omitted; map geometry comes from the admitted fixture.",
      );
    }
  } else if (
    compiled.query.groupBy.length !== 1 ||
    compiled.query.groupBy[0] !== "kind" ||
    compiled.query.metrics.length !== 1 ||
    compiled.query.metrics[0]?.fn !== "count" ||
    compiled.query.metrics[0]?.as !== "count" ||
    compiled.query.metrics[0]?.field
  ) {
    throw new HonuaNlMapControlError(
      "refusal",
      "This sample admits only grouped count(*) by kind; other aggregations are unavailable.",
    );
  }
  if ((compiled.query.kind === "aggregate") !== (request.kind === "categories"))
    throw new HonuaNlMapControlError("refusal", "Query kind does not match the reviewed result kind.");
  const featureQuery =
    compiled.query.kind === "aggregate"
      ? compile({
          kind: "features",
          filter: compiled.query.filter,
          geometry: "omit",
          select: ["id", "status", "kind"],
          page: { kind: "first", limit: 100 },
        })
      : compiled;
  return { compiled, featureQuery };
}
export function createIncidentRuntime(
  driver: DuckDbDriver,
  context: QueryContext,
  signal: AbortSignal,
): HonuaAgentRuntime {
  return {
    id: "ask-map-fixture",
    listSources: () => [
      {
        id: "incidents",
        title: "Incident fixtures — projected metres, EPSG:3857",
        protocol: "geoparquet",
        capabilities: ["query", "queryAggregate"],
        metadata: {
          schema: SCHEMA,
          sourceVersion: FIXTURE_VERSION,
          authorization: context.authorizationContextId,
          capturedContext: context,
          supported:
            "read-only features, attribute filters, bbox, polygon, planar metre distance, aggregation; no dates or geodesic distance",
          maxRows: 100,
        },
      },
    ],
    async runSemanticWidgetQuery(request) {
      const { compiled, featureQuery } = reviewQuery(request);
      async function run(artifact: typeof compiled.artifact) {
        signal.throwIfAborted();
        const sql = artifact.sqlTemplate.replace("honua-resource://resolve-at-execution", "ask-map-incidents.parquet");
        const rows = await driver.query(sql, {
          signal,
          parameters: artifact.parameters.map((parameter) => parameter.value),
        });
        signal.throwIfAborted();
        if (rows.length > 100) throw new Error("The query exceeded its row bound.");
        return rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value,
            ]),
          ),
        );
      }
      const rows = await run(compiled.artifact);
      const features = compiled.query.kind === "aggregate" ? await run(featureQuery.artifact) : rows;
      return {
        sourceId: "incidents",
        kind: request.kind,
        data: {
          features,
          ...(compiled.query.kind === "aggregate" ? { groups: rows } : {}),
          queries: [compiled.artifact, ...(compiled.query.kind === "aggregate" ? [featureQuery.artifact] : [])],
        } satisfies Omit<QueryResult, "features"> & { features: typeof features },
      };
    },
  };
}
