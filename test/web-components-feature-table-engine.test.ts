import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Query, Result, SortSpec, SourceDescriptor } from "../src/contract/index.js";
import { createExplorationContext } from "../src/exploration/index.js";
import type { FilterClause } from "../src/filter-registry/index.js";
import type { QueryExecutionPlan } from "../src/query-planner/index.js";
import type {
  HonuaFeatureTable,
  HonuaFeatureTableQuerySource,
  HonuaFeatureTableRealtimeDiff,
} from "../src/web-components/index.js";
import {
  DEFAULT_FEATURE_TABLE_BUDGETS,
  createHonuaFeatureTable,
  describeFeatureTableCount,
  explorationClauseToFilterClause,
  featureTableAriaRowCount,
  featureTableAriaSort,
  featureTablePageCacheKey,
  featureTableWindow,
  featureTableWorkByTier,
  formatFeatureTableCell,
  linkFeatureTableToExploration,
} from "../src/web-components/index.js";

/**
 * Bounded feature-table engine (issue #681).
 *
 * The fixture below is deliberately larger than any budget the tests configure,
 * so "sorted / filtered / paged / selected without full materialization" is an
 * observable property (the fixture counts every row it hands out) rather than a
 * claim.
 */

type Row = { OBJECTID: number; NAME: string; STATUS: string; SEVERITY: number };

const TOTAL_ROWS = 5_000;

interface Fixture {
  readonly source: HonuaFeatureTableQuerySource<Row>;
  readonly requests: Query<Row>[];
  rowsServed: number;
}

function descriptor(): SourceDescriptor {
  return {
    id: "incidents",
    protocol: "geoservices-feature-service",
    locator: { url: "https://example.test/FeatureServer/0" },
    capabilities: new Set(["query", "stream"]),
    schema: { primaryKey: "OBJECTID" },
  };
}

function makeRow(index: number): Row {
  return {
    OBJECTID: index + 1,
    NAME: `Incident ${index + 1}`,
    STATUS: index % 3 === 0 ? "open" : "closed",
    SEVERITY: (index % 5) + 1,
  };
}

/** Materializes only the page it is asked for — never the whole fixture. */
function makeFixture(
  options: {
    readonly totalRows?: number;
    readonly reportTotalCount?: boolean;
    readonly rows?: (index: number) => Row;
  } = {},
): Fixture {
  const total = options.totalRows ?? TOTAL_ROWS;
  const build = options.rows ?? makeRow;
  const requests: Query<Row>[] = [];
  const fixture: Fixture = {
    requests,
    rowsServed: 0,
    source: {
      descriptor: descriptor(),
      async query(request?: Query<Row>): Promise<Result<Row>> {
        requests.push(request ?? {});
        const offset = request?.pagination?.offset ?? 0;
        const limit = request?.pagination?.limit ?? 10;
        const features = [];
        for (let index = offset; index < Math.min(offset + limit, total); index += 1) {
          features.push({ attributes: build(index) });
        }
        fixture.rowsServed += features.length;
        return {
          features,
          exceededTransferLimit: offset + features.length < total,
          ...(options.reportTotalCount === false ? {} : { totalCount: total }),
        };
      },
      async *stream(request?: Query<Row>): AsyncGenerator<Result<Row>, void, undefined> {
        const limit = request?.pagination?.limit ?? 10;
        for (let offset = 0; offset < total; offset += limit) {
          const features = [];
          for (let index = offset; index < Math.min(offset + limit, total); index += 1) {
            features.push({ attributes: build(index) });
          }
          fixture.rowsServed += features.length;
          yield { features, exceededTransferLimit: offset + features.length < total };
        }
      },
    },
  };
  return fixture;
}

const COLUMNS = [
  { field: "OBJECTID", label: "ID", type: "integer" as const },
  { field: "NAME", label: "Name", type: "string" as const },
  { field: "STATUS", label: "Status", type: "string" as const },
  { field: "SEVERITY", label: "Severity", type: "number" as const },
];

function makeTable(fixture: Fixture, overrides: Record<string, unknown> = {}): HonuaFeatureTable<Row> {
  return createHonuaFeatureTable<Row>({
    source: fixture.source,
    sourceId: "incidents",
    columns: COLUMNS,
    budgets: { pageSize: 50, maxCachedRows: 150, windowOverscan: 0 },
    ...overrides,
  });
}

function statusFilter(value: string): FilterClause {
  return {
    id: "status",
    owner: { kind: "table", id: "grid" },
    field: "STATUS",
    operator: "=",
    value,
    effect: "filter",
  };
}

describe("bounded feature table: paging, sort, filter, selection without materialization", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  it("loads only the window's pages and never materializes the fixture", async () => {
    const table = makeTable(fixture);
    const snapshot = await table.refresh();

    expect(snapshot.state).toBe("partial");
    expect(snapshot.count).toMatchObject({ kind: "known", value: TOTAL_ROWS, evidence: "result-total-count" });
    expect(snapshot.count.loaded).toBe(50);
    expect(fixture.rowsServed).toBe(50);
    expect(fixture.rowsServed).toBeLessThan(TOTAL_ROWS);
    expect(snapshot.paging).toMatchObject({ mode: "offset", pageSize: 50, loadedPages: 1, exhausted: false });
  });

  it("pages through the middle of a 5,000-row fixture from scroll geometry alone", async () => {
    const table = makeTable(fixture);
    await table.refresh();

    const snapshot = await table.setScroll({ scrollTop: 2_000 * 32, rowHeight: 32, viewportHeight: 320 });

    expect(snapshot.window.startIndex).toBe(2_000);
    expect(snapshot.rows[0]?.attributes.OBJECTID).toBe(2_001);
    expect(snapshot.rows[0]?.index).toBe(2_000);
    // Two pages of 50 rows each, plus the original first page — nothing more.
    expect(fixture.rowsServed).toBeLessThanOrEqual(150);
  });

  it("pushes multi-column sort into Query.orderBy and invalidates cached pages", async () => {
    const table = makeTable(fixture);
    await table.refresh();
    fixture.requests.length = 0;

    const snapshot = await table.setSort([
      { field: "SEVERITY", direction: "desc" },
      { field: "NAME", direction: "asc" },
    ]);

    expect(snapshot.sort).toEqual([
      { field: "SEVERITY", direction: "desc" },
      { field: "NAME", direction: "asc" },
    ]);
    expect(fixture.requests.at(-1)?.orderBy).toEqual([
      { field: "SEVERITY", direction: "desc" },
      { field: "NAME", direction: "asc" },
    ]);
  });

  it("cycles one column asc → desc → unsorted through toggleSort", async () => {
    const table = makeTable(fixture);
    await table.refresh();

    expect((await table.toggleSort("NAME")).sort).toEqual([{ field: "NAME", direction: "asc" }]);
    expect((await table.toggleSort("NAME")).sort).toEqual([{ field: "NAME", direction: "desc" }]);
    expect((await table.toggleSort("NAME")).sort).toEqual([]);
  });

  it("keeps other sort keys when a header is toggled additively", async () => {
    const table = makeTable(fixture, { sort: [{ field: "STATUS", direction: "asc" }] as readonly SortSpec[] });
    await table.refresh();

    const snapshot = await table.toggleSort("SEVERITY", { additive: true });

    expect(snapshot.sort).toEqual([
      { field: "STATUS", direction: "asc" },
      { field: "SEVERITY", direction: "asc" },
    ]);
  });

  it("compiles typed filters into a pushed-down where clause", async () => {
    const table = makeTable(fixture);
    await table.setFilters([statusFilter("open")]);

    expect(fixture.requests.at(-1)?.where).toContain("STATUS");
    expect(fixture.requests.at(-1)?.where).toContain("'open'");
    expect(table.snapshot.filters).toHaveLength(1);
  });

  it("projects only the visible columns plus the identity field", async () => {
    const table = makeTable(fixture);
    await table.refresh();
    await table.setColumnVisibility("SEVERITY", false);

    expect(fixture.requests.at(-1)?.outFields).toEqual(["OBJECTID", "NAME", "STATUS"]);
  });

  it("keeps a hidden identity field in the projection so row keys stay stable", async () => {
    const table = makeTable(fixture);
    await table.refresh();
    await table.setColumnVisibility("OBJECTID", false);

    expect(fixture.requests.at(-1)?.outFields).toEqual(["NAME", "STATUS", "SEVERITY", "OBJECTID"]);
    expect(table.snapshot.rows[0]?.key).toBe("incidents:1");
  });

  it("selects rows by stable key across a page change", async () => {
    const table = makeTable(fixture);
    await table.refresh();
    const key = table.snapshot.rows[3]?.key;
    table.select([key as string]);

    await table.setScroll({ scrollTop: 1_000 * 32, rowHeight: 32, viewportHeight: 320 });

    expect(table.snapshot.selection).toEqual(["incidents:4"]);
  });
});

describe("budgets and virtualization (REQ-002)", () => {
  it("evicts least-recently-used pages to hold the row ceiling", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture, { budgets: { pageSize: 50, maxCachedRows: 100, windowOverscan: 0 } });
    await table.refresh();
    await table.setScroll({ scrollTop: 500 * 32, rowHeight: 32, viewportHeight: 320 });
    await table.setScroll({ scrollTop: 2_000 * 32, rowHeight: 32, viewportHeight: 320 });

    const snapshot = table.snapshot;
    expect(snapshot.count.loaded).toBeLessThanOrEqual(100);
    expect(snapshot.ledger.evictedRows).toBeGreaterThan(0);
    expect(snapshot.ledger.exhausted).toContain("rows");
  });

  it("stops issuing requests once the request ceiling is reached", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture, { budgets: { pageSize: 50, maxRequests: 2, windowOverscan: 0 } });
    await table.refresh();
    await table.setScroll({ scrollTop: 500 * 32, rowHeight: 32, viewportHeight: 320 });
    await table.setScroll({ scrollTop: 1_500 * 32, rowHeight: 32, viewportHeight: 320 });

    expect(table.snapshot.ledger.requests).toBe(2);
    expect(table.snapshot.ledger.exhausted).toContain("requests");
    expect(fixture.requests).toHaveLength(2);
  });

  it("evicts to hold the byte ceiling", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture, { budgets: { pageSize: 50, maxCachedBytes: 1_000, windowOverscan: 0 } });
    await table.refresh();
    await table.setScroll({ scrollTop: 500 * 32, rowHeight: 32, viewportHeight: 320 });

    expect(table.snapshot.ledger.exhausted).toContain("bytes");
    expect(table.snapshot.ledger.bytes).toBeGreaterThan(1_000);
  });

  it("renders undefined placeholders for window rows whose page is not resident", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture, { budgets: { pageSize: 50, maxRequests: 1, windowOverscan: 0 } });
    await table.refresh();
    const snapshot = await table.setScroll({ scrollTop: 0, rowHeight: 32, viewportHeight: 100 * 32 });

    expect(snapshot.rows.some((row) => row === undefined)).toBe(true);
    expect(snapshot.rows.filter((row) => row !== undefined)).toHaveLength(50);
  });

  it("computes the visible window purely from scroll geometry", () => {
    expect(featureTableWindow({ scrollTop: 320, rowHeight: 32, viewportHeight: 320 })).toEqual({
      startIndex: 10,
      endIndex: 20,
    });
    expect(featureTableWindow({ scrollTop: 320, rowHeight: 32, viewportHeight: 320 }, { overscan: 5 })).toEqual({
      startIndex: 5,
      endIndex: 25,
    });
    expect(
      featureTableWindow({ scrollTop: 320, rowHeight: 32, viewportHeight: 320 }, { overscan: 5, totalRows: 12 }),
    ).toEqual({ startIndex: 5, endIndex: 12 });
  });

  it("ships conservative default budgets", () => {
    expect(DEFAULT_FEATURE_TABLE_BUDGETS.maxCachedRows).toBeLessThan(TOTAL_ROWS);
    expect(DEFAULT_FEATURE_TABLE_BUDGETS.maxExportRows).toBeGreaterThan(DEFAULT_FEATURE_TABLE_BUDGETS.maxCachedRows);
  });
});

describe("result truth (REQ-004)", () => {
  it("reports a known total when the result carried one", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();

    expect(table.snapshot.count).toMatchObject({ kind: "known", value: TOTAL_ROWS, evidence: "result-total-count" });
  });

  it("reports partial with no value when nothing supplies a total", async () => {
    const table = makeTable(makeFixture({ reportTotalCount: false }));
    await table.refresh();

    expect(table.snapshot.count).toEqual({ kind: "partial", loaded: 50, evidence: "loaded-rows" });
    expect(table.snapshot.count.value).toBeUndefined();
    expect(describeFeatureTableCount(table.snapshot.count)).toBe("at least 50 rows loaded; total unknown");
    expect(featureTableAriaRowCount(table.snapshot.count)).toBe(-1);
  });

  it("reports an estimated total from the accepted plan, labelled as an estimate", async () => {
    const fixture = makeFixture({ reportTotalCount: false });
    const table = makeTable(fixture, {
      planner: () => ({ id: "plan-1", fingerprint: "sha256:abc", pushdown: "full", estimates: { rows: 4_900 } }),
    });
    await table.refresh();

    expect(table.snapshot.count).toMatchObject({ kind: "estimated", value: 4_900, evidence: "plan-estimate" });
    expect(describeFeatureTableCount(table.snapshot.count)).toBe("about 4900 rows (estimated)");
  });

  it("reports a known total from exhausted pages when the source drains", async () => {
    const table = makeTable(makeFixture({ totalRows: 12, reportTotalCount: false }));
    await table.refresh();

    expect(table.snapshot.state).toBe("ready");
    expect(table.snapshot.count).toEqual({ kind: "known", value: 12, loaded: 12, evidence: "exhausted-pages" });
  });

  it("reports unknown before any load, never zero", () => {
    const table = makeTable(makeFixture());

    expect(table.snapshot.state).toBe("idle");
    expect(table.snapshot.count).toEqual({ kind: "unknown", loaded: 0, evidence: "none" });
  });

  it("surfaces error state with the thrown cause", async () => {
    const table = createHonuaFeatureTable<Row>({
      source: {
        descriptor: descriptor(),
        query: async () => {
          throw new Error("upstream 503");
        },
      },
      sourceId: "incidents",
      columns: COLUMNS,
    });
    const snapshot = await table.refresh();

    expect(snapshot.state).toBe("error");
    expect(snapshot.message).toBe("upstream 503");
    expect(snapshot.error).toBeInstanceOf(Error);
  });

  it("distinguishes cancelled from error", async () => {
    const controller = new AbortController();
    const table = createHonuaFeatureTable<Row>({
      source: {
        descriptor: descriptor(),
        query: async () => {
          controller.abort();
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
      },
      sourceId: "incidents",
      columns: COLUMNS,
    });

    const snapshot = await table.refresh({ signal: controller.signal });

    expect(snapshot.state).toBe("cancelled");
    expect(snapshot.error).toBeUndefined();
  });

  it("reports unsupported without a resolvable stable row identity", () => {
    const table = createHonuaFeatureTable<Row>({
      source: { query: async () => ({ features: [], exceededTransferLimit: false }) },
      sourceId: "incidents",
      columns: COLUMNS,
    });

    expect(table.snapshot.state).toBe("unsupported");
    expect(table.snapshot.message).toContain("stable row identity");
  });

  it("reports unsupported when the descriptor explicitly omits query capability", () => {
    const table = createHonuaFeatureTable<Row>({
      source: {
        descriptor: { ...descriptor(), capabilities: new Set(["render"]) },
        query: async () => ({ features: [], exceededTransferLimit: false }),
      },
      sourceId: "incidents",
      columns: COLUMNS,
    });

    expect(table.snapshot.state).toBe("unsupported");
    expect(table.snapshot.message).toContain("canonical `query` capability");
  });

  it("reports unsupported for cursor paging on a source without stream", async () => {
    const table = createHonuaFeatureTable<Row>({
      source: { descriptor: descriptor(), query: async () => ({ features: [], exceededTransferLimit: false }) },
      sourceId: "incidents",
      columns: COLUMNS,
      pagingMode: "cursor",
    });
    const snapshot = await table.refresh();

    expect(snapshot.state).toBe("unsupported");
    expect(snapshot.message).toContain("stream");
  });

  it("marks resident pages stale without discarding them", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    table.markStale("Upstream watermark advanced.");

    expect(table.snapshot.state).toBe("stale");
    expect(table.snapshot.stale).toBe(true);
    expect(table.snapshot.count.loaded).toBe(50);
  });
});

describe("cursor paging (REQ-001)", () => {
  it("drains forward pages through the source stream", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture, { pagingMode: "cursor" });

    await table.refresh();
    expect(table.snapshot.rows[0]?.attributes.OBJECTID).toBe(1);

    const snapshot = await table.setScroll({ scrollTop: 50 * 32, rowHeight: 32, viewportHeight: 320 });
    expect(snapshot.state).toBe("partial");
    expect(snapshot.rows[0]?.attributes.OBJECTID).toBe(51);
  });

  it("reports unsupported instead of guessing when a jump passes the frontier", async () => {
    const table = makeTable(makeFixture(), { pagingMode: "cursor" });
    await table.refresh();

    const snapshot = await table.setScroll({ scrollTop: 2_000 * 32, rowHeight: 32, viewportHeight: 320 });

    expect(snapshot.state).toBe("unsupported");
    expect(snapshot.message).toContain("forward-only");
  });
});

describe("query evidence: server pushdown, residuals, presentation work", () => {
  function plan(overrides: Partial<QueryExecutionPlan> = {}): QueryExecutionPlan {
    return {
      id: "plan-1",
      fingerprint: "sha256:deadbeef",
      pushdown: "partial",
      fidelity: "equivalent",
      estimates: {},
      steps: [
        {
          id: "step-remote",
          engine: "remote",
          operation: "query",
          pushdown: "partial",
          fidelity: "equivalent",
          reason: "where pushed down",
        },
        {
          id: "step-local",
          engine: "client",
          operation: "aggregate",
          reason: "aggregation unsupported",
          maxRows: 1_000,
        },
      ],
      ...overrides,
    } as unknown as QueryExecutionPlan;
  }

  it("attributes remote steps to the server tier and local steps to the residual tier", async () => {
    const table = makeTable(makeFixture(), { planner: () => plan(), residualExecution: "worker" });
    await table.refresh();

    const evidence = table.snapshot.evidence;
    expect(evidence.planId).toBe("plan-1");
    expect(evidence.planFingerprint).toBe("sha256:deadbeef");
    expect(evidence.pushdown).toBe("partial");
    expect(featureTableWorkByTier(evidence, "server").map((item) => item.planStepId)).toContain("step-remote");
    expect(featureTableWorkByTier(evidence, "worker").map((item) => item.planStepId)).toContain("step-local");
  });

  it("always records client presentation work distinctly from query work", async () => {
    const table = makeTable(makeFixture(), {
      columns: [...COLUMNS.slice(0, 3), { field: "SEVERITY", label: "Severity", format: (v: unknown) => `S${v}` }],
    });
    await table.refresh();

    const client = featureTableWorkByTier(table.snapshot.evidence, "client");
    expect(client.map((item) => item.concern)).toContain("virtualization");
    expect(client.map((item) => item.concern)).toContain("format");
  });

  it("records filter degradation as a residual, not as pushdown", async () => {
    const fixture = makeFixture();
    const wmsSource: HonuaFeatureTableQuerySource<Row> = {
      ...fixture.source,
      descriptor: { ...descriptor(), protocol: "wms" },
    };
    const table = createHonuaFeatureTable<Row>({
      source: wmsSource,
      sourceId: "incidents",
      columns: COLUMNS,
      identityField: "OBJECTID",
      filters: [statusFilter("open")],
      budgets: { pageSize: 50 },
    });
    await table.refresh();

    expect(table.snapshot.evidence.degraded.length).toBeGreaterThan(0);
    expect(
      featureTableWorkByTier(table.snapshot.evidence, "client")
        .map((item) => item.detail)
        .join(" "),
    ).toContain("residual");
  });
});

describe("page-cache identity", () => {
  it("changes when any identity component changes", () => {
    const base = {
      sourceId: "incidents",
      filterKey: "f1",
      sortKey: "NAME:asc",
      projectionKey: "OBJECTID,NAME",
      authorizationScope: ["org:acme"],
      freshness: "snapshot:",
    };
    const key = featureTablePageCacheKey(base, { offset: 0, limit: 50 });

    expect(featureTablePageCacheKey({ ...base, sourceVersion: "v2" }, { offset: 0, limit: 50 })).not.toBe(key);
    expect(featureTablePageCacheKey({ ...base, schemaVersion: "sha256:1" }, { offset: 0, limit: 50 })).not.toBe(key);
    expect(featureTablePageCacheKey({ ...base, planFingerprint: "sha256:2" }, { offset: 0, limit: 50 })).not.toBe(key);
    expect(featureTablePageCacheKey({ ...base, filterKey: "f2" }, { offset: 0, limit: 50 })).not.toBe(key);
    expect(featureTablePageCacheKey({ ...base, sortKey: "NAME:desc" }, { offset: 0, limit: 50 })).not.toBe(key);
    expect(featureTablePageCacheKey({ ...base, projectionKey: "OBJECTID" }, { offset: 0, limit: 50 })).not.toBe(key);
    expect(featureTablePageCacheKey({ ...base, authorizationScope: ["org:other"] }, { offset: 0, limit: 50 })).not.toBe(
      key,
    );
    expect(featureTablePageCacheKey({ ...base, freshness: "cursor:1000" }, { offset: 0, limit: 50 })).not.toBe(key);
    expect(featureTablePageCacheKey(base, { offset: 50, limit: 50 })).not.toBe(key);
  });

  it("is stable across authorization-scope ordering", () => {
    const left = featureTablePageCacheKey({
      sourceId: "s",
      filterKey: "",
      sortKey: "",
      projectionKey: "",
      authorizationScope: ["b", "a"],
      freshness: "",
    });
    const right = featureTablePageCacheKey({
      sourceId: "s",
      filterKey: "",
      sortKey: "",
      projectionKey: "",
      authorizationScope: ["a", "b"],
      freshness: "",
    });

    expect(left).toBe(right);
  });

  it("re-serves a resident page from cache without a new request", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture);
    await table.refresh();
    const requests = fixture.requests.length;

    await table.setScroll({ scrollTop: 32, rowHeight: 32, viewportHeight: 320 });

    expect(fixture.requests).toHaveLength(requests);
  });
});

describe("bounded export (REQ-001)", () => {
  it("drains through the paged query path and clamps to the export budget", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture, { budgets: { pageSize: 50, maxExportRows: 120, maxRequests: 100 } });
    await table.refresh();

    const result = await table.export({ format: "csv" });

    expect(result.rowCount).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.limit).toBe("export-rows");
    expect(result.content.split("\n")[0]).toBe("OBJECTID,NAME,STATUS,SEVERITY");
    expect(fixture.rowsServed).toBeLessThan(TOTAL_ROWS);
  });

  it("cannot raise the policy ceiling from the request", async () => {
    const table = makeTable(makeFixture(), { budgets: { pageSize: 50, maxExportRows: 60, maxRequests: 100 } });
    await table.refresh();

    const result = await table.export({ format: "json", maxRows: 5_000 });

    expect(result.rowCount).toBe(60);
    expect(result.truncated).toBe(true);
    expect(JSON.parse(result.content)).toHaveLength(60);
  });

  it("stops at the request ceiling and says so", async () => {
    const table = makeTable(makeFixture(), { budgets: { pageSize: 50, maxExportRows: 10_000, maxRequests: 3 } });
    const result = await table.export({ format: "csv" });

    expect(result.limit).toBe("requests");
    expect(result.rowCount).toBe(150);
  });

  it("exports only the selection when asked", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    table.select(["incidents:2", "incidents:5"]);

    const result = await table.export({ format: "json", selectionOnly: true });

    expect(result.rowCount).toBe(2);
    expect(JSON.parse(result.content).map((row: { id: number }) => row.id)).toEqual([2, 5]);
  });

  it("quotes CSV cells that contain the delimiter or a quote", async () => {
    const table = makeTable(
      makeFixture({
        totalRows: 1,
        rows: () => ({ OBJECTID: 1, NAME: 'A, "B"', STATUS: "open", SEVERITY: 1 }),
      }),
    );
    await table.refresh();

    const result = await table.export({ format: "csv" });

    expect(result.content.split("\n")[1]).toBe('1,"A, ""B""",open,1');
  });
});

describe("keyboard focus model (NFR-001)", () => {
  it("moves the focused cell across rows and columns", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    table.setFocus({ rowKey: "incidents:1", field: "OBJECTID" });

    expect((await table.moveFocus("down")).focus).toEqual({ rowKey: "incidents:2", field: "OBJECTID" });
    expect((await table.moveFocus("right")).focus).toEqual({ rowKey: "incidents:2", field: "NAME" });
    expect((await table.moveFocus("row-end")).focus).toEqual({ rowKey: "incidents:2", field: "SEVERITY" });
    expect((await table.moveFocus("row-start")).focus).toEqual({ rowKey: "incidents:2", field: "OBJECTID" });
  });

  it("clamps at the first row and first column", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    table.setFocus({ rowKey: "incidents:1", field: "OBJECTID" });

    expect((await table.moveFocus("up")).focus).toEqual({ rowKey: "incidents:1", field: "OBJECTID" });
    expect((await table.moveFocus("left")).focus).toEqual({ rowKey: "incidents:1", field: "OBJECTID" });
  });

  it("loads the page a page-down lands on", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture, { budgets: { pageSize: 50, windowOverscan: 0, maxRequests: 20 } });
    await table.setScroll({ scrollTop: 0, rowHeight: 32, viewportHeight: 10 * 32 });
    table.setFocus({ rowKey: "incidents:1", field: "NAME" });

    const snapshot = await table.moveFocus("page-down");

    expect(snapshot.focus?.rowKey).toBe("incidents:11");
    expect(fixture.rowsServed).toBeLessThan(TOTAL_ROWS);
  });

  it("jumps to the last known row on grid-end", async () => {
    const table = makeTable(makeFixture({ totalRows: 120, reportTotalCount: false }));
    await table.refresh();
    table.setFocus({ rowKey: "incidents:1", field: "OBJECTID" });

    const snapshot = await table.moveFocus("grid-end");

    expect(snapshot.focus).toEqual({ rowKey: "incidents:50", field: "SEVERITY" });
  });

  it("maps sort direction to the ARIA grid vocabulary", () => {
    expect(featureTableAriaSort("NAME", [])).toBe("none");
    expect(featureTableAriaSort("NAME", [{ field: "NAME", direction: "asc" }])).toBe("ascending");
    expect(featureTableAriaSort("NAME", [{ field: "NAME", direction: "desc" }])).toBe("descending");
    expect(
      featureTableAriaSort("NAME", [
        { field: "STATUS", direction: "asc" },
        { field: "NAME", direction: "asc" },
      ]),
    ).toBe("other");
  });
});

describe("realtime reconciliation (REQ-005)", () => {
  function diff(changes: HonuaFeatureTableRealtimeDiff<Row>["changes"]): HonuaFeatureTableRealtimeDiff<Row> {
    return { changes, reset: false };
  }

  function upsert(id: number, attributes: Row, kind: "create" | "update" = "update") {
    return { kind, key: `incidents:${id}`, id, sourceId: "incidents", record: { feature: { attributes } } } as const;
  }

  it("patches an update in place, preserving focus, selection, sort, and window", async () => {
    const table = makeTable(makeFixture(), { sort: [{ field: "NAME", direction: "asc" }] });
    await table.refresh();
    table.select(["incidents:3"]);
    table.setFocus({ rowKey: "incidents:3", field: "NAME" });
    const before = table.snapshot;

    const outcome = table.applyRealtimeDiff(
      diff([upsert(3, { OBJECTID: 3, NAME: "Incident 3", STATUS: "closed", SEVERITY: 9 })]),
    );

    expect(outcome.preserved).toBe(true);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.focus).toEqual({ rowKey: "incidents:3", field: "NAME" });
    expect(outcome.selection).toEqual(["incidents:3"]);
    expect(outcome.sort).toEqual(before.sort);
    expect(outcome.window).toEqual(before.window);
    expect(outcome.patchedRowKeys).toEqual(["incidents:3"]);
    expect(table.snapshot.rows[2]?.attributes.SEVERITY).toBe(9);
    expect(table.snapshot.rows[2]?.index).toBe(2);
  });

  it("announces a documented conflict when an update changes a sorted column", async () => {
    const table = makeTable(makeFixture(), { sort: [{ field: "SEVERITY", direction: "asc" }] });
    await table.refresh();

    const outcome = table.applyRealtimeDiff(
      diff([upsert(3, { OBJECTID: 3, NAME: "Incident 3", STATUS: "open", SEVERITY: 99 })]),
    );

    expect(outcome.preserved).toBe(false);
    expect(outcome.conflicts.map((conflict) => conflict.code)).toEqual(["sort-key-changed"]);
    expect(outcome.conflicts[0]?.message).toContain("refresh to re-order");
    // The row is patched, never silently reordered underneath the user.
    expect(table.snapshot.rows[2]?.attributes.SEVERITY).toBe(99);
  });

  it("drops a deleted row from the selection and announces it", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    table.select(["incidents:2", "incidents:4"]);

    const outcome = table.applyRealtimeDiff(
      diff([{ kind: "delete", key: "incidents:2", id: 2, sourceId: "incidents" }]),
    );

    expect(outcome.selection).toEqual(["incidents:4"]);
    expect(outcome.conflicts.map((conflict) => conflict.code)).toContain("selection-invalidated");
    expect(outcome.invalidations).toEqual([{ key: "incidents:2", reason: "feature-deleted" }]);
    expect(table.snapshot.rows.some((row) => row?.key === "incidents:2")).toBe(false);
  });

  it("moves focus off a deleted row and announces the conflict", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    table.setFocus({ rowKey: "incidents:1", field: "NAME" });

    const outcome = table.applyRealtimeDiff(
      diff([{ kind: "delete", key: "incidents:1", id: 1, sourceId: "incidents" }]),
    );

    expect(outcome.conflicts.map((conflict) => conflict.code)).toContain("focused-row-deleted");
    expect(outcome.focus?.rowKey).not.toBe("incidents:1");
    expect(outcome.focus?.field).toBe("NAME");
  });

  it("ignores a create that lands outside the resident window rather than fabricating order", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();

    const outcome = table.applyRealtimeDiff(
      diff([upsert(9_999, { OBJECTID: 9_999, NAME: "New", STATUS: "open", SEVERITY: 1 }, "create")]),
    );

    expect(outcome.preserved).toBe(true);
    expect(outcome.patchedRowKeys).toEqual([]);
    expect(table.snapshot.rows.some((row) => row?.key === "incidents:9999")).toBe(false);
  });

  it("announces a snapshot reset, drops the cache, and keeps user sort intent", async () => {
    const table = makeTable(makeFixture(), { sort: [{ field: "NAME", direction: "desc" }] });
    await table.refresh();
    table.select(["incidents:1"]);

    const outcome = table.applyRealtimeDiff({ changes: [], reset: true, resetReason: "replacement-snapshot" });

    expect(outcome.conflicts.map((conflict) => conflict.code)).toEqual(["snapshot-reset"]);
    expect(outcome.selection).toEqual([]);
    expect(outcome.sort).toEqual([{ field: "NAME", direction: "desc" }]);
    expect(table.snapshot.state).toBe("stale");
    expect(table.snapshot.paging.loadedPages).toBe(0);
  });

  it("distinguishes a schema-change reset", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();

    const outcome = table.applyRealtimeDiff({ changes: [], reset: true, resetReason: "schema-changed" });

    expect(outcome.conflicts.map((conflict) => conflict.code)).toEqual(["schema-changed"]);
    expect(table.snapshot.message).toContain("schema changed");
  });
});

describe("linked exploration state (REQ-003)", () => {
  it("propagates table selection to the shared context and back", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture);
    await table.refresh();
    const context = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const grid = context.connectView({ id: "grid", role: "grid" });
    const unlink = linkFeatureTableToExploration(table, grid);

    // table → map
    table.select(["incidents:3"]);
    expect(context.state.selection).toEqual([{ sourceId: "incidents", id: 3 }]);

    // map → table
    const map = context.connectView({ id: "map", role: "map" });
    map.select([{ sourceId: "incidents", id: 7 }], { replace: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(table.snapshot.selection).toEqual(["incidents:7"]);

    unlink();
  });

  it("resolves map selection targets to table row keys deterministically", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();

    expect(table.keysForTargets([{ sourceId: "incidents", id: 2 }])).toEqual(["incidents:2"]);
    // A target for a different source never resolves to this table's rows.
    expect(table.keysForTargets([{ sourceId: "other", id: 2 }])).toEqual([]);
    // Round-trips: keys → targets → keys.
    table.select(["incidents:2", "incidents:9"]);
    expect(table.keysForTargets(table.selectionTargets())).toEqual(["incidents:2", "incidents:9"]);
  });

  it("accepts sort and filters pushed from the shared context", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    const context = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const grid = context.connectView({ id: "grid", role: "grid" });
    const unlink = linkFeatureTableToExploration(table, grid);
    const filters = context.connectView({ id: "filters", role: "filter" });

    filters.setSort([{ field: "SEVERITY", direction: "desc" }]);
    filters.setFilter("severe", { field: "SEVERITY", operator: ">=", value: 4 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(table.snapshot.sort).toEqual([{ field: "SEVERITY", direction: "desc" }]);
    expect(table.snapshot.filters.map((clause) => clause.field)).toContain("SEVERITY");

    unlink();
  });

  it("publishes the virtualization window as the shared page slice", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    const context = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const grid = context.connectView({ id: "grid", role: "grid" });
    const unlink = linkFeatureTableToExploration(table, grid);

    await table.setScroll({ scrollTop: 100 * 32, rowHeight: 32, viewportHeight: 320 });

    expect(context.state.page).toEqual({ offset: 100, limit: 10 });

    unlink();
  });

  it("stops syncing after unlink", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    const context = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const grid = context.connectView({ id: "grid", role: "grid" });
    linkFeatureTableToExploration(table, grid)();

    table.select(["incidents:1"]);

    expect(context.state.selection).toEqual([]);
  });

  it("projects an exploration clause onto a table-owned registry clause", () => {
    const clause = explorationClauseToFilterClause("severe", {
      field: "SEVERITY",
      operator: ">=",
      value: 4,
      appliesTo: ["incidents"],
    });

    expect(clause).toEqual({
      id: "severe",
      owner: { kind: "table", id: "honua-feature-table" },
      field: "SEVERITY",
      operator: ">=",
      value: 4,
      sourceScope: ["incidents"],
      effect: "filter",
    });
  });
});

describe("engine lifecycle", () => {
  it("notifies subscribers and stops after unsubscribe", async () => {
    const table = makeTable(makeFixture());
    const listener = vi.fn();
    const unsubscribe = table.subscribe(listener);

    await table.refresh();
    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls.length;

    unsubscribe();
    table.select(["incidents:1"]);
    expect(listener.mock.calls).toHaveLength(calls);
  });

  it("settles cancelled when an in-flight refresh is cancelled", async () => {
    let release: (() => void) | undefined;
    const table = createHonuaFeatureTable<Row>({
      source: {
        descriptor: descriptor(),
        query: () =>
          new Promise((resolve) => {
            release = () => resolve({ features: [], exceededTransferLimit: false });
          }),
      },
      sourceId: "incidents",
      columns: COLUMNS,
    });

    const pending = table.refresh();
    table.cancel();
    expect(table.snapshot.state).toBe("cancelled");
    release?.();
    await pending;
  });

  it("drops listeners and cached pages on dispose", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    const listener = vi.fn();
    table.subscribe(listener);

    table.dispose();
    table.select(["incidents:1"]);

    expect(listener).not.toHaveBeenCalled();
  });

  it("formats cells without inventing null/undefined text", () => {
    expect(formatFeatureTableCell(null)).toBe("");
    expect(formatFeatureTableCell(undefined)).toBe("");
    expect(formatFeatureTableCell(0)).toBe("0");
    expect(formatFeatureTableCell(false)).toBe("false");
    expect(formatFeatureTableCell(Number.NaN)).toBe("");
    expect(formatFeatureTableCell({ a: 1 })).toBe('{"a":1}');
    expect(
      formatFeatureTableCell(5, {
        field: "x",
        label: "x",
        type: "number",
        visible: true,
        sortable: true,
        format: (v) => `#${v}`,
      }),
    ).toBe("#5");
  });
});

/**
 * Regression tests for the PR #801 code-quality review findings. Each of these
 * fails on the pre-fix engine.
 */
describe("review regressions (PR #801)", () => {
  it("discards a superseded generation's late response instead of publishing the wrong rows", async () => {
    // `Source.query` is not required to reject on abort, so a stale response can
    // resolve normally long after the filter moved on (finding 2).
    const pending: { request: Query<Row>; resolve: (result: Result<Row>) => void }[] = [];
    const page = (name: string): Result<Row> => ({
      features: Array.from({ length: 50 }, (_unused, index) => ({
        attributes: { OBJECTID: index + 1, NAME: `${name} ${index + 1}`, STATUS: "open", SEVERITY: 1 },
      })),
      exceededTransferLimit: true,
      totalCount: TOTAL_ROWS,
    });
    const table = createHonuaFeatureTable<Row>({
      source: {
        descriptor: descriptor(),
        query: (request?: Query<Row>) =>
          new Promise<Result<Row>>((resolve) => {
            pending.push({ request: request ?? {}, resolve });
          }),
      },
      sourceId: "incidents",
      columns: COLUMNS,
      budgets: { pageSize: 50, windowOverscan: 0 },
    });

    const stale = table.refresh();
    const fresh = table.setFilters([statusFilter("open")]);
    expect(pending).toHaveLength(2);

    // The new generation lands first; the superseded one resolves afterwards.
    pending[1]?.resolve(page("fresh"));
    await Promise.resolve();
    pending[0]?.resolve(page("stale"));
    await Promise.all([stale, fresh]);

    expect(table.snapshot.rows[0]?.attributes.NAME).toBe("fresh 1");
    expect(table.snapshot.rows.every((row) => !row || !String(row.attributes.NAME).startsWith("stale"))).toBe(true);
    // The superseded run must not clobber the newer run's verdict either.
    expect(table.snapshot.state).toBe("partial");
    expect(table.snapshot.paging.loadedPages).toBe(1);
  });

  it("gives a new filter identity its own request allowance", async () => {
    // Carrying the previous identity's request count forward left an exhausted
    // table unable to ever load a new question (finding 3).
    const table = makeTable(makeFixture(), { budgets: { pageSize: 50, maxRequests: 1, windowOverscan: 0 } });
    await table.refresh();
    await table.setScroll({ scrollTop: 1_000 * 32, rowHeight: 32, viewportHeight: 320 });
    expect(table.snapshot.ledger.exhausted).toContain("requests");

    const snapshot = await table.setFilters([statusFilter("open")]);

    expect(snapshot.count.loaded).toBe(50);
    expect(snapshot.ledger.requests).toBe(1);
    expect(snapshot.ledger.exhausted).toEqual([]);
    // Lifetime consumption is still reported, just kept separate.
    expect(snapshot.ledger.lifetimeRequests).toBe(2);
  });

  it("keeps the per-identity allowance separate from lifetime totals across a sort change", async () => {
    const table = makeTable(makeFixture(), { budgets: { pageSize: 50, maxRequests: 2, windowOverscan: 0 } });
    await table.refresh();
    await table.setSort([{ field: "NAME", direction: "asc" }]);

    expect(table.snapshot.ledger.requests).toBe(1);
    expect(table.snapshot.ledger.lifetimeRequests).toBe(2);
  });

  it("reports unsupported instead of manufacturing a positional id for a row missing its identity", async () => {
    // The positional fallback reintroduced exactly the selection corruption the
    // unsupported-identity state exists to prevent (finding 4).
    const table = makeTable(
      makeFixture({
        totalRows: 3,
        rows: (index) =>
          (index === 1
            ? { NAME: `Incident ${index + 1}`, STATUS: "open", SEVERITY: 1 }
            : { OBJECTID: index + 1, NAME: `Incident ${index + 1}`, STATUS: "open", SEVERITY: 1 }) as Row,
      }),
    );

    const snapshot = await table.refresh();

    expect(snapshot.state).toBe("unsupported");
    expect(snapshot.message).toContain("no stable identity");
    expect(snapshot.message).toContain("absent");
    // Nothing positional was cached.
    expect(snapshot.rows.filter((row) => row !== undefined)).toHaveLength(0);
    expect(snapshot.paging.loadedPages).toBe(0);
  });

  it("reports unsupported for a null or non-scalar identity value", async () => {
    for (const [value, described] of [
      [null, "null"],
      [{ nested: 1 }, "a object"],
      [["a"], "a array"],
    ] as const) {
      const table = makeTable(
        makeFixture({
          totalRows: 1,
          rows: () => ({ OBJECTID: value, NAME: "x", STATUS: "open", SEVERITY: 1 }) as unknown as Row,
        }),
      );

      const snapshot = await table.refresh();

      expect(snapshot.state).toBe("unsupported");
      expect(snapshot.message).toContain(described);
    }
  });

  it("still accepts a legitimate zero or empty-string identity", async () => {
    const table = makeTable(
      makeFixture({
        totalRows: 2,
        rows: (index) => ({ OBJECTID: index === 0 ? 0 : "", NAME: "x", STATUS: "open", SEVERITY: 1 }) as unknown as Row,
      }),
    );

    const snapshot = await table.refresh();

    expect(snapshot.state).toBe("ready");
    expect(snapshot.rows.filter((row) => row !== undefined).map((row) => row.key)).toEqual([
      "incidents:0",
      "incidents:",
    ]);
  });

  it("drops an oversized page rather than holding the cache above its byte ceiling", async () => {
    // Protecting the just-fetched page from eviction left the cache above a
    // ceiling documented as hard (finding 6).
    const table = makeTable(makeFixture(), { budgets: { pageSize: 50, maxCachedBytes: 64, windowOverscan: 0 } });

    const snapshot = await table.refresh();

    expect(snapshot.ledger.exhausted).toContain("bytes");
    expect(snapshot.count.loaded).toBe(0);
    expect(snapshot.message).toContain("memory budget");
    // The window reports placeholders rather than pretending rows are resident.
    expect(snapshot.rows.every((row) => row === undefined)).toBe(true);
  });

  it("reports unsupported when pageSize can never fit inside maxCachedRows", async () => {
    const fixture = makeFixture();
    const table = makeTable(fixture, { budgets: { pageSize: 100, maxCachedRows: 50 } });

    expect(table.snapshot.state).toBe("unsupported");
    expect(table.snapshot.message).toContain("maxCachedRows");
    // A misconfigured table performs no I/O at all.
    expect((await table.refresh()).paging.loadedPages).toBe(0);
    expect(fixture.requests).toHaveLength(0);
  });

  it("resolves a same-source selection target that is outside the cached pages", async () => {
    // Residency-dependent resolution let a linked view's off-window selection
    // silently clear the table's selection (finding 7).
    const table = makeTable(makeFixture());
    await table.refresh();

    expect(table.keysForTargets([{ sourceId: "incidents", id: 4_000 }])).toEqual(["incidents:4000"]);
    expect(table.keysForTargets([{ sourceId: "other", id: 1 }])).toEqual([]);
    // Bare ids are the single-source exploration form and belong to this table.
    expect(table.keysForTargets([4_000])).toEqual(["incidents:4000"]);
  });

  it("round-trips an off-window selection back to an exploration target", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();

    table.select(table.keysForTargets([{ sourceId: "incidents", id: 4_000 }]));

    expect(table.snapshot.selection).toEqual(["incidents:4000"]);
    expect(table.selectionTargets()).toEqual([{ sourceId: "incidents", id: 4_000 }]);
  });

  it("keeps an off-window linked selection instead of replacing it with empty", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    const context = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const grid = context.connectView({ id: "grid", role: "grid" });
    const unlink = linkFeatureTableToExploration(table, grid);
    const map = context.connectView({ id: "map", role: "map" });

    map.select([{ sourceId: "incidents", id: 4_000 }], { replace: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(table.snapshot.selection).toEqual(["incidents:4000"]);
    expect(context.state.selection).toEqual([{ sourceId: "incidents", id: 4_000 }]);

    unlink();
  });

  it("does not drop a peer source's selection when publishing its own", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();
    const context = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents", "hydrants"] });
    const grid = context.connectView({ id: "grid", role: "grid" });
    const unlink = linkFeatureTableToExploration(table, grid);
    const map = context.connectView({ id: "map", role: "map" });

    map.select([{ sourceId: "hydrants", id: 9 }], { replace: true });
    await Promise.resolve();
    await Promise.resolve();
    table.select(["incidents:2"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(context.state.selection).toEqual([
      { sourceId: "hydrants", id: 9 },
      { sourceId: "incidents", id: 2 },
    ]);

    unlink();
  });

  it("prunes the selection target index to the live selection", async () => {
    const table = makeTable(makeFixture());
    await table.refresh();

    table.select(table.keysForTargets([{ sourceId: "incidents", id: 4_000 }]));
    expect(table.selectionTargets()).toHaveLength(1);

    table.deselect();
    table.select(["incidents:2"]);

    expect(table.selectionTargets()).toEqual([{ sourceId: "incidents", id: 2 }]);
  });
});
