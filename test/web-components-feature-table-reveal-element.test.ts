// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHonuaApplicationContext,
  createHonuaFeatureTable,
  mountHonuaApplication,
} from "../src/web-components/index.js";
import { contrast } from "./contrast.js";
import { type Row, makeEngine, mount, orderedSource, shadow } from "./feature-table-element-fixture.js";

describe("<honua-feature-table> pointer, reveal, and theme", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("paints headers and selected rows with theme colors that stay readable in both themes", () => {
    const stylesheet = shadow(mount()).querySelector("style")?.textContent ?? "";
    expect(stylesheet).toContain("th { background: var(--honua-ui-surface); color: var(--honua-ui-fg);");
    expect(stylesheet).toContain(
      'tr[aria-selected="true"] td { background: var(--honua-ui-accent); color: var(--honua-ui-accent-fg);',
    );
    expect(stylesheet).not.toMatch(/th \{ background: #f8fafc/);
    expect(stylesheet).not.toContain("#dbeafe");

    const lightHeader = contrast("#172033", "#f8fafc");
    const darkHeader = contrast("#e8f1f3", "#142e39");
    const selected = contrast("#ffffff", "#1d4ed8");
    expect(lightHeader).toBeGreaterThanOrEqual(4.5);
    expect(darkHeader).toBeGreaterThanOrEqual(4.5);
    expect(selected).toBeGreaterThanOrEqual(4.5);
  });

  it("selects the row on the first pointer press before focus replaces the grid", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const cell = shadow(element).querySelector<HTMLTableCellElement>(
      "tbody tr[data-row-key='incidents:1'] [role='gridcell']",
    );
    if (!cell) throw new Error("no cell");
    cell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    cell.dispatchEvent(new FocusEvent("focus"));

    expect(cell.isConnected).toBe(false);
    expect(engine.snapshot.selection).toEqual(["incidents:1"]);
    const focused = shadow(element).activeElement?.closest("tr");
    expect(focused?.getAttribute("data-row-key")).toBe("incidents:1");
    expect(focused?.getAttribute("aria-selected")).toBe("true");
  });

  it("suppresses the gesture click until the pointer is released or cancelled", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    let selections = 0;
    element.addEventListener("honua-selection-change", () => {
      selections += 1;
    });
    const cell = shadow(element).querySelector<HTMLTableCellElement>(
      "tbody tr[data-row-key='incidents:1'] [role='gridcell']",
    );
    if (!cell) throw new Error("no cell");
    cell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const row = shadow(element).querySelector<HTMLTableRowElement>("tbody tr[data-row-key='incidents:1']");
    if (!row) throw new Error("no row");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(selections).toBe(1);

    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(selections).toBe(2);

    const next = shadow(element).querySelector<HTMLTableCellElement>(
      "tbody tr[data-row-key='incidents:2'] [role='gridcell']",
    );
    if (!next) throw new Error("no second cell");
    next.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const nextRow = shadow(element).querySelector<HTMLTableRowElement>("tbody tr[data-row-key='incidents:2']");
    nextRow?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(selections).toBe(4);
  });

  it("selects another row after the pointer is released outside the table", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    const cell = shadow(element).querySelector<HTMLTableCellElement>(
      "tbody tr[data-row-key='incidents:1'] [role='gridcell']",
    );
    if (!cell) throw new Error("no cell");
    cell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, composed: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const next = shadow(element).querySelector<HTMLTableRowElement>("tbody tr[data-row-key='incidents:2']");
    if (!next) throw new Error("no second row");
    next.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(engine.snapshot.selection).toEqual(["incidents:2"]);
  });

  it("scrolls the revealed row into the window when the table itself is not focused", async () => {
    const element = mount();
    element.setAttribute("row-height", "32");
    const engine = createHonuaFeatureTable<Row>({
      source: orderedSource(400),
      sourceId: "incidents",
      columns: [
        { field: "OBJECTID", label: "ID", type: "integer" },
        { field: "NAME", label: "Name", type: "string" },
        { field: "SEVERITY", label: "Severity", type: "number" },
      ],
      budgets: { pageSize: 10, maxCachedRows: 40, windowOverscan: 0 },
    });
    element.table = engine;
    await engine.refresh();
    document.body.focus();

    const revealed = await engine.reveal({ sourceId: "incidents", id: 75 });

    expect(revealed).toMatchObject({ status: "visible", index: 74 });
    const scroller = shadow(element).querySelector<HTMLElement>("[data-scroller]");
    const row = shadow(element).querySelector<HTMLElement>("tr[data-feature-id='75']");
    expect(row).not.toBeNull();
    expect(scroller?.scrollTop).toBe(70 * 32);
    expect(shadow(element).activeElement).toBeNull();
  });

  it("scrolls a default-budget reveal so the target row is inside the viewport", async () => {
    const element = mount();
    element.setAttribute("row-height", "32");
    const engine = createHonuaFeatureTable<Row>({
      source: orderedSource(400),
      sourceId: "incidents",
      columns: [
        { field: "OBJECTID", label: "ID", type: "integer" },
        { field: "NAME", label: "Name", type: "string" },
      ],
    });
    element.table = engine;
    await engine.refresh();
    document.body.focus();
    const viewportHeight = 300;
    const rowHeight = 32;
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.scroller === undefined ? 0 : viewportHeight;
    });
    try {
      const revealed = await engine.reveal({ sourceId: "incidents", id: 300 });
      expect(revealed).toMatchObject({ status: "visible", index: 299 });
      const scroller = shadow(element).querySelector<HTMLElement>("[data-scroller]");
      const targetTop = 299 * rowHeight;
      const centered = targetTop - (viewportHeight - rowHeight) / 2;
      expect(scroller?.scrollTop).toBe(centered);
      expect(centered).toBeLessThanOrEqual(targetTop);
      expect(centered + viewportHeight).toBeGreaterThanOrEqual(targetTop + rowHeight);
      expect(shadow(element).activeElement).toBeNull();
    } finally {
      height.mockRestore();
    }
  });

  it("applies application filters before revealing the initial selection", async () => {
    const element = mount();
    const engine = createHonuaFeatureTable<Row>({
      source: orderedSource(400),
      sourceId: "incidents",
      columns: [
        { field: "OBJECTID", label: "ID", type: "integer" },
        { field: "NAME", label: "Name", type: "string" },
      ],
      budgets: { pageSize: 10, maxCachedRows: 40, windowOverscan: 0 },
    });
    element.table = engine;
    await engine.refresh();
    const context = createHonuaApplicationContext<Row>({
      status: "ready",
      binding: { sourceIdentity: "incidents" },
      authorization: { status: "authorized", scopes: ["incidents:read"] },
      selection: [{ sourceId: "incidents", id: 75 }],
      filters: [
        {
          id: "open-id",
          owner: { kind: "table", id: "application" },
          field: "OBJECTID",
          operator: ">",
          value: 0,
          effect: "filter",
        },
      ],
    });

    element.applicationContext = context;
    await vi.waitFor(() => expect(engine.snapshot.rows.some((row) => row?.id === 75)).toBe(true));

    expect(engine.snapshot.window.startIndex).toBeGreaterThan(0);
    expect(engine.snapshot.selection).toEqual(["incidents:75"]);
    context.dispose();
  });

  it("keeps a newer application selection when an older reveal is still locating", async () => {
    let releaseOlder: (() => void) | undefined;
    const source = orderedSource(400);
    const original = source.query.bind(source);
    source.query = async (request) => {
      if (request?.where?.includes("OBJECTID = 75") && request.where.includes(" OR ") !== true) {
        await new Promise<void>((resolve) => {
          releaseOlder = resolve;
        });
      }
      return original(request);
    };
    const element = mount();
    const engine = createHonuaFeatureTable<Row>({
      source,
      sourceId: "incidents",
      columns: [
        { field: "OBJECTID", label: "ID", type: "integer" },
        { field: "NAME", label: "Name", type: "string" },
      ],
      budgets: { pageSize: 10, maxCachedRows: 40, windowOverscan: 0 },
    });
    element.table = engine;
    await engine.refresh();
    const context = createHonuaApplicationContext<Row>({
      status: "ready",
      binding: { sourceIdentity: "incidents" },
      authorization: { status: "authorized", scopes: ["incidents:read"] },
      selection: [{ sourceId: "incidents", id: 75 }],
    });
    const mounted = await mountHonuaApplication({ host: document.body, context, register: false });
    await vi.waitFor(() => expect(releaseOlder).toBeTypeOf("function"));
    const staleWindows: number[] = [];
    engine.subscribe((snapshot) => {
      if (snapshot.selection.includes("incidents:40") && snapshot.window.startIndex >= 70) {
        staleWindows.push(snapshot.window.startIndex);
      }
    });

    context.update({ selection: [{ sourceId: "incidents", id: 40 }] });
    releaseOlder?.();
    await vi.waitFor(() => {
      expect(engine.snapshot.selection).toEqual(["incidents:40"]);
      expect(engine.snapshot.rows.some((row) => row?.id === 40)).toBe(true);
    });

    expect(staleWindows).toEqual([]);
    expect(context.snapshot.selection).toMatchObject([{ sourceId: "incidents", id: 40 }]);
    expect(engine.snapshot.rows.some((row) => row?.id === 75)).toBe(false);
    mounted.dispose();
    context.dispose();
  });

  it("keeps the newer application selection when its reveal query fails", async () => {
    let releaseOlder: (() => void) | undefined;
    const source = orderedSource(400);
    const original = source.query.bind(source);
    source.query = async (request) => {
      const where = request?.where ?? "";
      if (where.includes("OBJECTID = 75") && where.includes(" OR ") !== true) {
        await new Promise<void>((resolve) => {
          releaseOlder = resolve;
        });
      }
      if (where.includes("OBJECTID = 40") && where.includes(" OR ") !== true) {
        throw new Error("newer reveal query failed");
      }
      return original(request);
    };
    const element = mount();
    const engine = createHonuaFeatureTable<Row>({
      source,
      sourceId: "incidents",
      columns: [
        { field: "OBJECTID", label: "ID", type: "integer" },
        { field: "NAME", label: "Name", type: "string" },
      ],
      budgets: { pageSize: 10, maxCachedRows: 40, windowOverscan: 0 },
    });
    element.table = engine;
    await engine.refresh();
    const context = createHonuaApplicationContext<Row>({
      status: "ready",
      binding: { sourceIdentity: "incidents" },
      authorization: { status: "authorized", scopes: ["incidents:read"] },
      selection: [{ sourceId: "incidents", id: 75 }],
    });
    const mounted = await mountHonuaApplication({ host: document.body, context, register: false });
    await vi.waitFor(() => expect(releaseOlder).toBeTypeOf("function"));

    context.update({ selection: [{ sourceId: "incidents", id: 40 }] });
    releaseOlder?.();
    await vi.waitFor(() => expect(engine.snapshot.selection).toEqual(["incidents:40"]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.snapshot.selection).toEqual(["incidents:40"]);
    expect(engine.snapshot.window.startIndex).toBeLessThan(70);
    mounted.dispose();
    context.dispose();
  });
});
