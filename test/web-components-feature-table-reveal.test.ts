import { describe, expect, it, vi } from "vitest";

import type { Query, Result } from "../src/contract/index.js";
import { createExplorationContext } from "../src/exploration/index.js";
import type { HonuaFeatureTableQuerySource } from "../src/web-components/index.js";
import { createHonuaFeatureTable, linkFeatureTableToExploration } from "../src/web-components/index.js";
import {
  COLUMNS,
  type Row,
  TOTAL_ROWS,
  descriptor,
  locatingFixture,
  makeRow,
  makeTable,
  matchesWhere,
  openSortedIndex,
  statusFilter,
  tiedRow,
} from "./feature-table-engine-fixture.js";

describe("feature table reveal", () => {
  it("reveals an off-window target without scanning the layer", async () => {
    const located = locatingFixture();
    const table = makeTable(located);
    await table.refresh();
    const before = located.rowsServed;

    const revealed = await table.reveal({ sourceId: "incidents", id: 4_000 });

    expect(revealed).toEqual({ status: "visible", key: "incidents:4000", index: 3_999 });
    expect(table.snapshot.selection).toEqual(["incidents:4000"]);
    expect(table.snapshot.rows.some((row) => row?.id === 4_000)).toBe(true);
    expect(located.requests.length).toBeLessThan(8);
    expect(located.rowsServed - before).toBeLessThan(200);
  });

  it("reveals a sorted, filtered target and reports rows the filter hides", async () => {
    const located = locatingFixture();
    const table = makeTable(located);
    await table.refresh();
    await table.setSort([{ field: "SEVERITY", direction: "asc" }]);
    await table.setFilters([statusFilter("open")]);

    const hidden = await table.reveal({ sourceId: "incidents", id: 2 });
    expect(hidden.status).toBe("filtered-out");
    expect(table.snapshot.window.startIndex).toBe(0);

    const revealed = await table.reveal({ sourceId: "incidents", id: 4 });
    expect(revealed).toEqual({ status: "visible", key: "incidents:4", index: openSortedIndex(4) });
    expect(located.rowsServed).toBeLessThan(TOTAL_ROWS);
  });

  it("reports a target the layer does not contain", async () => {
    const table = makeTable(locatingFixture());
    await table.refresh();
    expect(await table.reveal({ sourceId: "incidents", id: 90_000 })).toEqual({ status: "missing" });
  });

  it("cancels a reveal when the query changes or the caller aborts", async () => {
    const located = locatingFixture();
    let release: (() => void) | undefined;
    const original = located.source.query.bind(located.source);
    located.source.query = async (request) => {
      if (request?.where?.includes("OBJECTID = 4000")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(request);
    };
    const table = makeTable(located);
    await table.refresh();
    const pending = table.reveal({ sourceId: "incidents", id: 4_000 });
    await Promise.resolve();
    const refresh = table.setFilters([statusFilter("open")]);
    release?.();
    expect(await pending).toEqual({ status: "cancelled" });
    await refresh;

    const aborted = new AbortController();
    aborted.abort();
    expect((await table.reveal({ sourceId: "incidents", id: 4 }, { signal: aborted.signal })).status).toBe("cancelled");
  });

  it("scrolls a linked map selection onto a later page", async () => {
    const located = locatingFixture();
    const table = makeTable(located);
    await table.refresh();
    const context = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
    const grid = context.connectView({ id: "grid", role: "grid" });
    const unlink = linkFeatureTableToExploration(table, grid);
    const map = context.connectView({ id: "map", role: "map" });

    map.select([{ sourceId: "incidents", id: 4_000 }], { replace: true });
    await vi.waitFor(() => expect(table.snapshot.rows.some((row) => row?.id === 4_000)).toBe(true));

    expect(table.snapshot.selection).toEqual(["incidents:4000"]);
    expect(located.rowsServed).toBeLessThan(TOTAL_ROWS);
    unlink();
  });

  it("keeps the identity tie-break when scrolling after a reveal", async () => {
    const requests: Query<Row>[] = [];
    const total = 100;
    const source: HonuaFeatureTableQuerySource<Row> = {
      descriptor: descriptor(),
      async query(request?: Query<Row>): Promise<Result<Row>> {
        requests.push(request ?? {});
        const ids = Array.from({ length: total }, (_, index) => index + 1);
        const tied = request?.orderBy?.some((entry) => entry.field === "OBJECTID") === true;
        if (!tied) ids.reverse();
        const where = request?.where;
        const matched = ids.filter((id) => matchesWhere(where, tiedRow(id)));
        const offset = request?.pagination?.offset ?? 0;
        const limit = request?.pagination?.limit ?? 10;
        const page = matched.slice(offset, offset + limit);
        return {
          features: page.map((id) => ({ attributes: tiedRow(id) })),
          exceededTransferLimit: offset + page.length < matched.length,
          totalCount: matched.length,
        };
      },
    };
    const table = createHonuaFeatureTable<Row>({
      source,
      sourceId: "incidents",
      columns: COLUMNS,
      budgets: { pageSize: 10, maxCachedRows: 40, windowOverscan: 0 },
    });
    await table.refresh();
    await table.setSort([{ field: "STATUS", direction: "asc" }]);

    const revealed = await table.reveal({ sourceId: "incidents", id: 75 });
    expect(revealed).toEqual({ status: "visible", key: "incidents:75", index: 74 });
    expect(table.snapshot.rows.map((row) => row?.id)).toEqual([71, 72, 73, 74, 75, 76, 77, 78, 79, 80]);

    const next = await table.setScroll({ scrollTop: 80 * 32, rowHeight: 32, viewportHeight: 320 });
    expect(next.rows.map((row) => row?.id)).toEqual([81, 82, 83, 84, 85, 86, 87, 88, 89, 90]);
    expect(requests.at(-1)?.orderBy).toEqual([
      { field: "STATUS", direction: "asc" },
      { field: "OBJECTID", direction: "asc" },
    ]);
  });

  it("does not commit selection when the source ignores the rank predicate", async () => {
    const source: HonuaFeatureTableQuerySource<Row> = {
      descriptor: descriptor(),
      async query(request?: Query<Row>): Promise<Result<Row>> {
        const identity = /OBJECTID = (\d+)/.exec(request?.where ?? "");
        const ranked = request?.where?.includes(" OR ") === true || request?.where?.includes("OBJECTID <") === true;
        if (identity && !ranked) {
          return {
            features: [{ attributes: makeRow(Number(identity[1]) - 1) }],
            totalCount: 1,
            exceededTransferLimit: false,
          };
        }
        const offset = request?.pagination?.offset ?? 0;
        const limit = request?.pagination?.limit ?? 10;
        const features = [];
        for (let index = offset; index < Math.min(offset + limit, 100); index += 1) {
          features.push({ attributes: makeRow(index) });
        }
        return { features, totalCount: 100, exceededTransferLimit: offset + features.length < 100 };
      },
    };
    const table = createHonuaFeatureTable<Row>({
      source,
      sourceId: "incidents",
      columns: COLUMNS,
      budgets: { pageSize: 10, maxCachedRows: 20, windowOverscan: 0 },
    });
    await table.refresh();
    table.select(["incidents:2"]);
    const seen: { selection: readonly string[]; focus?: string }[] = [];
    table.subscribe((snapshot) => {
      seen.push({ selection: snapshot.selection, focus: snapshot.focus?.rowKey });
    });

    const revealed = await table.reveal({ sourceId: "incidents", id: 75 });

    expect(revealed.status).toBe("unsupported");
    expect(table.snapshot.window).toEqual({ startIndex: 0, endIndex: 10 });
    expect(table.snapshot.selection).toEqual(["incidents:2"]);
    expect(table.snapshot.focus).toBeUndefined();
    expect(table.snapshot.rows.map((row) => row?.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seen.some((snapshot) => snapshot.selection.includes("incidents:75"))).toBe(false);
  });

  it("lets the newer reveal win when an older lookup is still in flight", async () => {
    let releaseOlder: (() => void) | undefined;
    const located = locatingFixture();
    const original = located.source.query.bind(located.source);
    located.source.query = async (request) => {
      if (request?.where?.includes("OBJECTID = 75") && request.where.includes(" OR ") !== true) {
        await new Promise<void>((resolve) => {
          releaseOlder = resolve;
        });
      }
      return original(request);
    };
    const table = makeTable(located, { budgets: { pageSize: 10, maxCachedRows: 40, windowOverscan: 0 } });
    await table.refresh();

    const older = table.reveal({ sourceId: "incidents", id: 75 });
    await vi.waitFor(() => expect(releaseOlder).toBeTypeOf("function"));
    const newer = await table.reveal({ sourceId: "incidents", id: 40 });
    releaseOlder?.();
    expect(await older).toEqual({ status: "cancelled" });

    expect(newer).toEqual({ status: "visible", key: "incidents:40", index: 39 });
    expect(table.snapshot.selection).toEqual(["incidents:40"]);
    expect(table.snapshot.rows.some((row) => row?.id === 40)).toBe(true);
    expect(table.snapshot.rows.some((row) => row?.id === 75)).toBe(false);
  });

  it("returns cancelled when an in-flight locate query rejects AbortError", async () => {
    const located = locatingFixture();
    const original = located.source.query.bind(located.source);
    let locateStarted = false;
    located.source.query = async (request) => {
      if (request?.where?.includes("OBJECTID = 75")) {
        locateStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return original(request);
    };
    const table = makeTable(located);
    await table.refresh();
    const controller = new AbortController();
    const pending = table.reveal({ sourceId: "incidents", id: 75 }, { signal: controller.signal });
    await vi.waitFor(() => expect(locateStarted).toBe(true));
    controller.abort();

    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(table.snapshot.selection).toEqual([]);
    expect(table.snapshot.window.startIndex).toBe(0);
  });
});
