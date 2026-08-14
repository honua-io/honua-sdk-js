// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Query, Result, SourceDescriptor } from "../src/contract/index.js";
import type {
  HonuaFeatureTable,
  HonuaFeatureTableConflictDetail,
  HonuaFeatureTableElement,
  HonuaSelectionChangeDetail,
} from "../src/web-components/index.js";
import {
  createHonuaApplicationContext,
  createHonuaFeatureTable,
  createHonuaWebComponentController,
  defineHonuaWebComponents,
  describeFeatureTableState,
  featureTableFocusMoveForKey,
  featureTableGridHtml,
  featureTableViewModel,
  legacyFeatureTableViewModel,
  mountHonuaApplication,
} from "../src/web-components/index.js";

/**
 * `<honua-feature-table>` production grid (issue #681): the WAI-ARIA grid
 * contract, roving tabindex, keyboard navigation, virtualization spacers,
 * header sort, conflict announcement, and the unchanged controller lane.
 */

type Row = { OBJECTID: number; NAME: string; SEVERITY: number };

const TOTAL = 400;

function descriptor(): SourceDescriptor {
  return {
    id: "incidents",
    protocol: "geoservices-feature-service",
    locator: { url: "https://example.test/FeatureServer/0" },
    capabilities: new Set(["query"]),
    schema: { primaryKey: "OBJECTID" },
  };
}

function makeEngine(): HonuaFeatureTable<Row> {
  return createHonuaFeatureTable<Row>({
    source: {
      descriptor: descriptor(),
      async query(request?: Query<Row>): Promise<Result<Row>> {
        const offset = request?.pagination?.offset ?? 0;
        const limit = request?.pagination?.limit ?? 10;
        const features = [];
        for (let index = offset; index < Math.min(offset + limit, TOTAL); index += 1) {
          features.push({ attributes: { OBJECTID: index + 1, NAME: `Incident ${index + 1}`, SEVERITY: index % 5 } });
        }
        return { features, exceededTransferLimit: offset + features.length < TOTAL, totalCount: TOTAL };
      },
    },
    sourceId: "incidents",
    columns: [
      { field: "OBJECTID", label: "ID", type: "integer" },
      { field: "NAME", label: "Name", type: "string" },
      { field: "SEVERITY", label: "Severity", type: "number" },
    ],
    budgets: { pageSize: 20, windowOverscan: 0 },
  });
}

function mount(): HonuaFeatureTableElement<Row> {
  defineHonuaWebComponents();
  const element = document.createElement("honua-feature-table") as HonuaFeatureTableElement<Row>;
  document.body.append(element);
  return element;
}

function shadow(element: HonuaFeatureTableElement<Row>): ShadowRoot {
  const root = element.shadowRoot;
  if (!root) throw new Error("missing shadow root");
  return root;
}

function press(cell: Element, key: string, init: KeyboardEventInit = {}): void {
  cell.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

describe("<honua-feature-table> bounded lane", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders an ARIA grid with absolute row/column indices for the loaded window", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const root = shadow(element);
    const grid = root.querySelector("[role='grid']");
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute("aria-rowcount")).toBe(String(TOTAL + 1));
    expect(grid?.getAttribute("aria-colcount")).toBe("3");
    expect(root.querySelectorAll("[role='columnheader']")).toHaveLength(3);

    const rows = root.querySelectorAll("tbody tr[role='row']");
    expect(rows).toHaveLength(20);
    expect(rows[0]?.getAttribute("aria-rowindex")).toBe("2");
    const cells = rows[0]?.querySelectorAll("[role='gridcell']") ?? [];
    expect([...cells].map((cell) => cell.getAttribute("aria-colindex"))).toEqual(["1", "2", "3"]);
    expect(cells[1]?.textContent).toBe("Incident 1");
  });

  it("joins application selection, filters, authorization, status, and diagnostics without a second owner", async () => {
    defineHonuaWebComponents();
    const engine = makeEngine();
    const element = document.createElement("honua-feature-table") as HonuaFeatureTableElement<Row>;
    element.table = engine;
    const host = document.createElement("main");
    host.append(element);
    document.body.append(host);
    const context = createHonuaApplicationContext<Row>({
      status: "ready",
      binding: { sourceIdentity: "incidents" },
      authorization: { status: "authorized", scopes: ["incidents:read"] },
    });
    const application = await mountHonuaApplication({ host, context, register: false });
    await engine.refresh();

    context.update({ selection: [{ sourceId: "incidents", id: 1 }] });
    expect(engine.snapshot.selection).toEqual(["incidents:1"]);

    engine.select(["incidents:2"]);
    expect(context.snapshot.selection).toEqual([
      expect.objectContaining({ sourceId: "incidents", id: 2, attributes: expect.objectContaining({ OBJECTID: 2 }) }),
    ]);

    const inboundFilter = {
      id: "application-status",
      owner: { kind: "table" as const, id: "application" },
      field: "NAME",
      operator: "=" as const,
      value: "Incident 2",
      effect: "filter" as const,
    };
    context.update({ filters: [inboundFilter] });
    await vi.waitFor(() => expect(engine.snapshot.filters).toEqual([inboundFilter]));

    const localFilter = { ...inboundFilter, id: "local-status", value: "Incident 3" };
    await engine.setFilters([localFilter]);
    expect(context.snapshot.filters).toEqual([localFilter]);

    context.replaceAuthorization({ status: "unauthorized", scopes: [] });
    expect(element.getAttribute("aria-disabled")).toBe("");
    expect(element.shadowRoot?.querySelector("[data-application-status]")?.textContent).toBe(
      "Authorization is required",
    );

    application.dispose();
    context.dispose();
    engine.dispose();
  });

  it("keeps the panel shrinkable without forcing horizontal overflow", () => {
    const stylesheet = shadow(mount()).querySelector("style")?.textContent ?? "";

    expect(stylesheet).toContain(".table-panel { max-width: 100%; min-width: 0; }");
    expect(stylesheet).toContain(".table-wrap { max-width: 100%; overflow-x: auto; overflow-y: auto; }");
    expect(stylesheet).toContain(".table-wrap table { min-width: 100%; width: max-content; }");
  });

  it("keeps exactly one tabbable cell (roving tabindex)", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const tabbable = shadow(element).querySelectorAll("tbody [role='gridcell'][tabindex='0']");
    expect(tabbable).toHaveLength(1);
  });

  it("moves the roving tabindex with the engine focus", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    engine.setFocus({ rowKey: "incidents:3", field: "SEVERITY" });

    const tabbable = shadow(element).querySelector("tbody [role='gridcell'][tabindex='0']");
    expect(tabbable?.getAttribute("data-field")).toBe("SEVERITY");
    expect(tabbable?.closest("tr")?.getAttribute("data-row-key")).toBe("incidents:3");
  });

  it("navigates cells from the keyboard and preventDefaults the grid keys", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    engine.setFocus({ rowKey: "incidents:1", field: "OBJECTID" });

    const cell = shadow(element).querySelector("tbody [role='gridcell'][tabindex='0']");
    if (!cell) throw new Error("no roving cell");
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    cell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.snapshot.focus).toEqual({ rowKey: "incidents:2", field: "OBJECTID" });
  });

  it("does not swallow keys the grid pattern leaves to the page", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const cell = shadow(element).querySelector("tbody [role='gridcell']");
    if (!cell) throw new Error("no cell");
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    cell.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("selects the focused row on Enter and dispatches honua-selection-change", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    const events: HonuaSelectionChangeDetail<Row>[] = [];
    element.addEventListener("honua-selection-change", (event) => {
      events.push((event as CustomEvent<HonuaSelectionChangeDetail<Row>>).detail);
    });

    const cell = shadow(element).querySelector("tbody tr[data-row-key='incidents:2'] [role='gridcell']");
    if (!cell) throw new Error("no cell");
    press(cell, "Enter");

    expect(engine.snapshot.selection).toEqual(["incidents:2"]);
    expect(events.at(-1)).toMatchObject({ sourceId: "incidents", featureId: "2" });
  });

  it("marks the selected row with aria-selected", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    engine.select(["incidents:4"]);

    const selected = shadow(element).querySelectorAll("tbody tr[aria-selected='true']");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-row-key")).toBe("incidents:4");
  });

  it("toggles sort from a column header button and reflects aria-sort", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const button = shadow(element).querySelector<HTMLButtonElement>("[data-sort-field='NAME']");
    button?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.snapshot.sort).toEqual([{ field: "NAME", direction: "asc" }]);
    expect(shadow(element).querySelector("[data-field='NAME'][role='columnheader']")?.getAttribute("aria-sort")).toBe(
      "ascending",
    );
  });

  it("offers accessible column visibility controls", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const controls = shadow(element).querySelector("[data-column-controls]");
    expect(controls?.querySelector("summary")?.textContent).toBe("Columns");
    const name = controls?.querySelector<HTMLInputElement>("[data-column-field='NAME']");
    expect(name?.checked).toBe(true);
    if (!name) throw new Error("missing column control");
    name.checked = false;
    name.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(engine.snapshot.visibleColumns.map((column) => column.field)).not.toContain("NAME"));
    expect(shadow(element).querySelector("[role='columnheader'][data-field='NAME']")).toBeNull();
  });

  it("virtualizes columns horizontally while preserving absolute ARIA positions", async () => {
    const columns = Array.from({ length: 40 }, (_unused, index) => ({
      field: `FIELD_${index}`,
      label: `Field ${index}`,
    }));
    const attributes = Object.fromEntries(columns.map((column, index) => [column.field, index]));
    attributes.FIELD_0 = 1;
    const engine = createHonuaFeatureTable<Record<string, unknown>>({
      source: {
        descriptor: { ...descriptor(), schema: { primaryKey: "FIELD_0" } },
        query: async () => ({ features: [{ attributes }], totalCount: 1, exceededTransferLimit: false }),
      },
      sourceId: "incidents",
      columns,
      budgets: { pageSize: 1, maxFields: 32, maxRenderedColumns: 5 },
    });
    defineHonuaWebComponents();
    const element = document.createElement("honua-feature-table") as HonuaFeatureTableElement<Record<string, unknown>>;
    element.table = engine;
    document.body.append(element);
    await engine.refresh();
    engine.setColumnScroll({ scrollLeft: 20 * 160, columnWidth: 160, viewportWidth: 3 * 160 });

    const root = element.shadowRoot;
    const grid = root?.querySelector("[role='grid']");
    expect(grid?.getAttribute("aria-colcount")).toBe("32");
    const headers = [...(root?.querySelectorAll("[role='columnheader']") ?? [])];
    expect(headers).toHaveLength(5);
    expect(headers.map((header) => header.getAttribute("aria-colindex"))).toEqual(["20", "21", "22", "23", "24"]);
    expect(root?.querySelectorAll("tbody [role='gridcell']")).toHaveLength(5);
    expect(root?.querySelector("[data-column-leading]")).not.toBeNull();
    expect(root?.querySelector("[data-column-trailing]")).not.toBeNull();
  });

  it("sizes virtualization spacers so scroll height reflects the known total", async () => {
    const element = mount();
    element.setAttribute("row-height", "40");
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    await engine.setScroll({ scrollTop: 100 * 40, rowHeight: 40, viewportHeight: 400 });

    const root = shadow(element);
    const stylesheet = [...root.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
    expect(stylesheet).toContain(`[data-leading] { height: ${100 * 40}px; }`);
    expect(stylesheet).toContain(`[data-trailing] { height: ${(TOTAL - 110) * 40}px; }`);
  });

  it("announces result truth in a polite live region and never fabricates a total", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const status = shadow(element).querySelector("[data-status]");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent?.trim()).toBe("Partial results — 400 rows");
    expect(shadow(element).querySelector("[data-count]")?.textContent?.trim()).toBe("400 rows");
  });

  it("announces realtime conflicts in the live region and as an event", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    engine.select(["incidents:2"]);
    const conflicts: HonuaFeatureTableConflictDetail[] = [];
    element.addEventListener("honua-table-conflict", (event) => {
      conflicts.push((event as CustomEvent<HonuaFeatureTableConflictDetail>).detail);
    });

    engine.applyRealtimeDiff({
      changes: [{ kind: "delete", key: "incidents:2", id: 2, sourceId: "incidents" }],
      reset: false,
    });

    expect(conflicts.map((conflict) => conflict.code)).toEqual(["selection-invalidated"]);
    expect(shadow(element).querySelector("[data-status]")?.textContent).toContain("deleted upstream");
  });

  it("renders placeholder rows without inventing cell values", async () => {
    const element = mount();
    const engine = createHonuaFeatureTable<Row>({
      source: { descriptor: descriptor(), query: async () => ({ features: [], exceededTransferLimit: true }) },
      sourceId: "incidents",
      columns: [{ field: "OBJECTID" }],
      budgets: { pageSize: 20, maxRequests: 0, windowOverscan: 0 },
    });
    element.table = engine;
    await engine.refresh();
    await engine.setScroll({ scrollTop: 0, rowHeight: 32, viewportHeight: 32 * 5 });

    const placeholders = shadow(element).querySelectorAll("tbody tr[data-placeholder='true']");
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders[0]?.querySelector("[role='gridcell']")?.textContent).toBe("");
    expect(placeholders[0]?.hasAttribute("data-feature-id")).toBe(false);
  });

  it("reports aria-busy while loading", () => {
    const element = mount();
    const engine = createHonuaFeatureTable<Row>({
      source: { descriptor: descriptor(), query: () => new Promise(() => {}) },
      sourceId: "incidents",
      columns: [{ field: "OBJECTID" }],
    });
    element.table = engine;
    void engine.refresh();

    expect(shadow(element).querySelector("[role='grid']")?.getAttribute("aria-busy")).toBe("true");
  });

  it("renders accepted-plan execution tiers as accessible diagnostics", async () => {
    const element = mount();
    const engine = createHonuaFeatureTable<Row>({
      source: {
        descriptor: descriptor(),
        query: async () => ({
          features: [{ attributes: { OBJECTID: 1, NAME: "Incident 1", SEVERITY: 1 } }],
          exceededTransferLimit: false,
          totalCount: 1,
        }),
      },
      sourceId: "incidents",
      columns: [{ field: "OBJECTID" }, { field: "NAME", format: (value) => String(value) }],
      planner: () =>
        ({
          id: "table-plan",
          fingerprint: "sha256:table-plan",
          pushdown: "partial",
          fidelity: "exact",
          estimates: {},
          steps: [
            {
              id: "remote-page",
              engine: "remote",
              operation: "query",
              pushdown: "partial",
              fidelity: "exact",
              reason: "server filter and page",
            },
            {
              id: "local-residual",
              engine: "client",
              operation: "filter",
              pushdown: "none",
              fidelity: "exact",
              reason: "bounded residual",
              inputStepId: "remote-page",
              maxRows: 20,
            },
          ],
        }) as never,
    });
    element.table = engine;
    await engine.refresh();

    const diagnostics = shadow(element).querySelector("[data-work-badges]");
    expect(diagnostics?.getAttribute("aria-label")).toBe("Query execution");
    expect(diagnostics?.querySelector("[data-work-tier='server']")?.textContent).toBe("Server · 1");
    expect(diagnostics?.querySelector("[data-work-tier='client']")?.textContent).toBe("Client · 3");
    expect(diagnostics?.querySelector("[data-work-tier='client']")?.getAttribute("title")).toContain(
      "bounded residual",
    );
    expect(diagnostics?.querySelector("[data-work-tier='client']")?.getAttribute("aria-label")).toContain(
      "filter: residual",
    );
  });

  it("keeps bounded query, paging, sorting, and realtime conflicts free of console errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const element = mount();
      const engine = makeEngine();
      element.table = engine;
      await engine.refresh();
      await engine.setScroll({ scrollTop: 200 * 32, rowHeight: 32, viewportHeight: 10 * 32 });
      await engine.setSort([{ field: "SEVERITY", direction: "desc" }]);
      engine.applyRealtimeDiff({ changes: [{ kind: "delete", key: "incidents:201", id: 201 }], reset: false });
      element.remove();

      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("stops observing the engine after detach", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    element.remove();

    engine.select(["incidents:1"]);

    expect(shadow(element).querySelectorAll("tbody tr[aria-selected='true']")).toHaveLength(0);
  });

  it("projects the bounded snapshot back onto the legacy refresh() model", async () => {
    const element = mount();
    element.table = makeEngine();

    const model = await element.refresh();

    expect(model?.sourceId).toBe("incidents");
    expect(model?.status).toBe("ready");
    expect(model?.fields).toEqual(["OBJECTID", "NAME", "SEVERITY"]);
    expect(model?.rows).toHaveLength(20);
    expect(model?.totalCount).toBe(TOTAL);
  });
});

describe("<honua-feature-table> controller lane (unchanged behavior)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function controller() {
    return createHonuaWebComponentController({
      featuresBySource: {
        parcels: [
          { id: 1, sourceId: "parcels", attributes: { OBJECTID: 1, NAME: "Alpha" } },
          { id: 2, sourceId: "parcels", attributes: { OBJECTID: 2, NAME: "Beta" } },
          { id: 3, sourceId: "parcels", attributes: { OBJECTID: 3, NAME: "Gamma" } },
        ],
      },
    });
  }

  it("renders the controller's page through the same accessible grid", async () => {
    const element = mount();
    element.setAttribute("source", "parcels");
    element.controller = controller() as never;
    await element.refresh();

    const root = shadow(element);
    expect(root.querySelector("[role='grid']")?.getAttribute("aria-rowcount")).toBe("4");
    expect(root.querySelectorAll("tbody tr[role='row']")).toHaveLength(3);
    expect(root.querySelectorAll("tbody [role='gridcell'][tabindex='0']")).toHaveLength(1);
    expect(root.textContent).toContain("Alpha");
  });

  it("still selects a row on click and dispatches honua-selection-change", async () => {
    const element = mount();
    element.setAttribute("source", "parcels");
    element.controller = controller() as never;
    await element.refresh();
    const events: HonuaSelectionChangeDetail[] = [];
    element.addEventListener("honua-selection-change", (event) => {
      events.push((event as CustomEvent<HonuaSelectionChangeDetail>).detail);
    });

    shadow(element).querySelector<HTMLTableRowElement>("tbody tr[data-feature-id='2']")?.click();

    expect(events.at(-1)).toMatchObject({ sourceId: "parcels", featureId: "2" });
  });

  it("moves DOM focus with the arrow keys without paging", async () => {
    const element = mount();
    element.setAttribute("source", "parcels");
    element.controller = controller() as never;
    await element.refresh();

    const first = shadow(element).querySelector<HTMLTableCellElement>("tbody tr [role='gridcell']");
    first?.focus();
    if (!first) throw new Error("no cell");
    press(first, "ArrowDown");

    const active = shadow(element).activeElement;
    expect(active?.closest("tr")?.getAttribute("data-feature-id")).toBe("2");
  });
});

describe("feature-table view helpers", () => {
  it("maps keys onto grid moves, with Ctrl/Cmd widening Home/End", () => {
    expect(featureTableFocusMoveForKey("ArrowUp")).toBe("up");
    expect(featureTableFocusMoveForKey("ArrowDown")).toBe("down");
    expect(featureTableFocusMoveForKey("ArrowLeft")).toBe("left");
    expect(featureTableFocusMoveForKey("ArrowRight")).toBe("right");
    expect(featureTableFocusMoveForKey("Home")).toBe("row-start");
    expect(featureTableFocusMoveForKey("End")).toBe("row-end");
    expect(featureTableFocusMoveForKey("Home", { ctrl: true })).toBe("grid-start");
    expect(featureTableFocusMoveForKey("End", { meta: true })).toBe("grid-end");
    expect(featureTableFocusMoveForKey("PageUp")).toBe("page-up");
    expect(featureTableFocusMoveForKey("PageDown")).toBe("page-down");
    expect(featureTableFocusMoveForKey("a")).toBeUndefined();
    expect(featureTableFocusMoveForKey("Escape")).toBeUndefined();
  });

  it("describes every lifecycle state", () => {
    const count = { kind: "known", value: 3, loaded: 3, evidence: "result-total-count" } as const;
    expect(describeFeatureTableState("idle", count, undefined)).toBe("Not loaded");
    expect(describeFeatureTableState("loading", count, undefined)).toBe("Loading rows");
    expect(describeFeatureTableState("ready", count, undefined)).toBe("3 rows");
    expect(describeFeatureTableState("partial", count, undefined)).toContain("Partial results");
    expect(describeFeatureTableState("stale", count, "watermark moved")).toContain("watermark moved");
    expect(describeFeatureTableState("cancelled", count, undefined)).toBe("The request was cancelled");
    expect(describeFeatureTableState("unsupported", count, "no stream")).toBe("no stream");
    expect(describeFeatureTableState("error", count, "boom")).toBe("boom");
  });

  it("escapes untrusted attribute text in cells and headers", () => {
    const model = legacyFeatureTableViewModel({
      sourceId: "s",
      status: "ready",
      fields: ["<img>"],
      rows: [{ id: 1, sourceId: "s", attributes: { "<img>": '"><script>alert(1)</script>' } }],
      totalCount: 1,
    });

    const html = featureTableGridHtml(model);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("reports aria-rowcount of -1 when the total is genuinely unknown", async () => {
    const engine = createHonuaFeatureTable<Row>({
      source: {
        descriptor: descriptor(),
        query: async () => ({
          features: [{ attributes: { OBJECTID: 1, NAME: "a", SEVERITY: 0 } }],
          exceededTransferLimit: true,
        }),
      },
      sourceId: "incidents",
      columns: [{ field: "OBJECTID" }],
      budgets: { pageSize: 1, maxRequests: 1 },
    });
    await engine.refresh();

    const model = featureTableViewModel(engine.snapshot);
    expect(model.ariaRowCount).toBe(-1);
    expect(featureTableGridHtml(model)).toContain('aria-rowcount="-1"');
  });

  it("does not claim server execution without accepted-plan evidence", async () => {
    const engine = makeEngine();
    await engine.setSort([{ field: "NAME", direction: "asc" }]);

    const model = featureTableViewModel(engine.snapshot);
    expect(model.workBadges.some((badge) => badge.tier === "server")).toBe(false);
    expect(model.workBadges.some((badge) => badge.tier === "client")).toBe(true);
  });
});

/**
 * Regression tests for the PR #801 code-quality review findings. Each of these
 * fails on the pre-fix element.
 */
describe("<honua-feature-table> review regressions (PR #801)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the scroll offset when a render replaces the scroll container", async () => {
    // `setScroll` synchronously publishes a loading snapshot, and rendering
    // replaces the whole shadow tree; a fresh scroller starts at 0, which snapped
    // the grid back to the top mid-scroll (finding 1).
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const scroller = shadow(element).querySelector<HTMLElement>("[data-scroller]");
    if (!scroller) throw new Error("no scroller");
    scroller.scrollTop = 100 * 32;
    scroller.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A new node — the point of the test — but at the same offset.
    const current = shadow(element).querySelector<HTMLElement>("[data-scroller]");
    expect(current).not.toBe(scroller);
    expect(current?.scrollTop).toBe(100 * 32);
    // And the window actually moved, so the offset is not stale.
    expect(engine.snapshot.window.startIndex).toBe(100);
    expect([...shadow(element).querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n")).toContain(
      `[data-leading] { height: ${100 * 32}px; }`,
    );
  });

  it("keeps the scroll offset across an unrelated engine publish", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    const scroller = shadow(element).querySelector<HTMLElement>("[data-scroller]");
    if (!scroller) throw new Error("no scroller");
    scroller.scrollTop = 640;

    // A selection change re-renders without any scroll involvement.
    engine.select(["incidents:2"]);

    expect(shadow(element).querySelector<HTMLElement>("[data-scroller]")?.scrollTop).toBe(640);
  });

  it("does not feed the restore echo back into the engine as a user scroll", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    const scroller = shadow(element).querySelector<HTMLElement>("[data-scroller]");
    if (!scroller) throw new Error("no scroller");
    scroller.scrollTop = 320;
    engine.select(["incidents:1"]);

    const revisionAfterRestore = engine.snapshot.revision;
    await Promise.resolve();
    await Promise.resolve();

    // No extra setScroll round trip was triggered by restoring the offset.
    expect(engine.snapshot.revision).toBe(revisionAfterRestore);
    expect(engine.snapshot.window.startIndex).toBe(0);
  });

  it("selects when Enter is pressed while the row itself holds focus", async () => {
    // The ARIA-grid rewrite moved focus from the row to its cells, which left
    // rows unfocusable and broke `row.focus()` + Enter — the interaction the
    // browser smoke suite drives. Rows are focusable again at `tabindex="-1"`.
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const row = shadow(element).querySelector<HTMLTableRowElement>("tbody tr[data-feature-id='2']");
    if (!row) throw new Error("no row");
    expect(row.getAttribute("tabindex")).toBe("-1");
    row.focus();
    expect(shadow(element).activeElement).toBe(row);
    press(row, "Enter");

    expect(engine.snapshot.selection).toEqual(["incidents:2"]);
  });

  it("keeps rows out of the tab sequence so the cells own the single tab stop", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const root = shadow(element);
    expect(root.querySelectorAll("tbody tr[tabindex='0']")).toHaveLength(0);
    expect(root.querySelectorAll("tbody [tabindex='0']")).toHaveLength(1);
    expect(root.querySelector("tbody [tabindex='0']")?.getAttribute("role")).toBe("gridcell");
  });

  it("does not double-handle Enter when a cell inside the row is focused", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    const events: HonuaSelectionChangeDetail<Row>[] = [];
    element.addEventListener("honua-selection-change", (event) => {
      events.push((event as CustomEvent<HonuaSelectionChangeDetail<Row>>).detail);
    });

    const cell = shadow(element).querySelector("tbody tr[data-feature-id='3'] [role='gridcell']");
    if (!cell) throw new Error("no cell");
    press(cell, "Enter");

    // The cell handler fires once; the row handler must ignore the bubbled event.
    expect(events).toHaveLength(1);
    expect(engine.snapshot.selection).toEqual(["incidents:3"]);
  });

  it("hands focus to the first cell when a navigation key arrives on the row", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const row = shadow(element).querySelector<HTMLTableRowElement>("tbody tr[data-feature-id='2']");
    if (!row) throw new Error("no row");
    row.focus();
    press(row, "ArrowDown");

    const active = shadow(element).activeElement;
    expect(active?.getAttribute("role")).toBe("gridcell");
    expect(active?.closest("tr")?.getAttribute("data-feature-id")).toBe("2");
  });

  it("keeps the controller lane's rows focusable and selectable from the keyboard", async () => {
    const element = mount();
    element.setAttribute("source", "parcels");
    element.controller = createHonuaWebComponentController({
      featuresBySource: {
        parcels: [
          { id: 1, sourceId: "parcels", attributes: { OBJECTID: 1, NAME: "Alpha" } },
          { id: 2, sourceId: "parcels", attributes: { OBJECTID: 2, NAME: "Beta" } },
        ],
      },
    }) as never;
    await element.refresh();
    const events: HonuaSelectionChangeDetail[] = [];
    element.addEventListener("honua-selection-change", (event) => {
      events.push((event as CustomEvent<HonuaSelectionChangeDetail>).detail);
    });

    const row = shadow(element).querySelector<HTMLTableRowElement>("tbody tr[data-feature-id='2']");
    if (!row) throw new Error("no row");
    row.focus();
    press(row, "Enter");

    expect(events.at(-1)).toMatchObject({ sourceId: "parcels", featureId: "2" });
  });

  it("keeps focus on the exact cell that had it across the re-render focusing causes", async () => {
    // Focusing a cell sets engine focus, which publishes and re-renders. The
    // kit restores focus by matching the active element's first `data-`
    // attribute, and `data-field` alone matched the same column in every row,
    // dragging focus to row 1. Cells now carry a grid-unique `data-cell-key`.
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    const cell = shadow(element).querySelector<HTMLTableCellElement>(
      "tbody tr[data-feature-id='4'] [data-field='NAME']",
    );
    if (!cell) throw new Error("no cell");
    cell.focus();

    const active = shadow(element).activeElement;
    expect(active?.getAttribute("data-field")).toBe("NAME");
    expect(active?.closest("tr")?.getAttribute("data-feature-id")).toBe("4");
    expect(engine.snapshot.focus).toEqual({ rowKey: "incidents:4", field: "NAME" });
  });

  it("resubscribes to the engine after a detach and reinsert", async () => {
    // `disconnectedCallback` dropped the subscription permanently, so a
    // reinserted grid went dead (finding 5).
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    element.remove();
    document.body.append(element);
    engine.select(["incidents:3"]);

    const selected = shadow(element).querySelectorAll("tbody tr[aria-selected='true']");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-row-key")).toBe("incidents:3");
  });

  it("resubscribes when the same engine is re-assigned after a detach", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    element.remove();
    document.body.append(element);
    // Re-assigning the identical instance used to early-return before
    // re-subscribing.
    element.table = engine;
    engine.select(["incidents:4"]);

    expect(shadow(element).querySelectorAll("tbody tr[aria-selected='true']")).toHaveLength(1);
  });

  it("holds exactly one subscription after reconnecting and re-assigning", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    element.remove();
    document.body.append(element);
    element.table = engine;

    const conflicts: HonuaFeatureTableConflictDetail[] = [];
    element.addEventListener("honua-table-conflict", (event) => {
      conflicts.push((event as CustomEvent<HonuaFeatureTableConflictDetail>).detail);
    });
    engine.select(["incidents:2"]);
    engine.applyRealtimeDiff({
      changes: [{ kind: "delete", key: "incidents:2", id: 2, sourceId: "incidents" }],
      reset: false,
    });

    // A double subscription would announce the same conflict twice.
    expect(conflicts).toHaveLength(1);
  });

  it("re-reads the engine snapshot it missed while detached", async () => {
    const element = mount();
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();

    element.remove();
    engine.select(["incidents:5"]);
    document.body.append(element);

    const selected = shadow(element).querySelectorAll("tbody tr[aria-selected='true']");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-row-key")).toBe("incidents:5");
  });

  it("does not re-query the source on reconnect", async () => {
    let queries = 0;
    const engine = createHonuaFeatureTable<Row>({
      source: {
        descriptor: descriptor(),
        query: async (request?: Query<Row>) => {
          queries += 1;
          const offset = request?.pagination?.offset ?? 0;
          return {
            features: [{ attributes: { OBJECTID: offset + 1, NAME: "a", SEVERITY: 0 } }],
            exceededTransferLimit: false,
            totalCount: 1,
          };
        },
      },
      sourceId: "incidents",
      columns: [{ field: "OBJECTID" }],
      budgets: { pageSize: 20 },
    });
    const element = mount();
    element.table = engine;
    await engine.refresh();
    const before = queries;

    element.remove();
    document.body.append(element);
    await Promise.resolve();
    await Promise.resolve();

    expect(queries).toBe(before);
  });

  it("renders caller-supplied German table labels and lifecycle status", () => {
    const element = mount();
    element.messages = {
      label: "Vorfälle",
      count: () => "400 Datensätze",
      status: { idle: "Nicht geladen", loading: "Laden", ready: "Bereit" },
    };
    const root = shadow(element);
    expect(root.querySelector("h2")?.textContent).toBe("Vorfälle");
    expect(root.querySelector("[data-count]")?.textContent).toBe("400 Datensätze");
    expect(root.querySelector("[data-status]")?.textContent).toBe("Nicht geladen");
  });
});
