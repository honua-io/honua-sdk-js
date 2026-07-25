// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { Query, Result, SourceDescriptor } from "../src/contract/index.js";
import type {
  HonuaFeatureTable,
  HonuaFeatureTableConflictDetail,
  HonuaFeatureTableElement,
  HonuaSelectionChangeDetail,
} from "../src/web-components/index.js";
import {
  createHonuaFeatureTable,
  createHonuaWebComponentController,
  defineHonuaWebComponents,
  describeFeatureTableState,
  featureTableFocusMoveForKey,
  featureTableGridHtml,
  featureTableViewModel,
  legacyFeatureTableViewModel,
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

  it("sizes virtualization spacers so scroll height reflects the known total", async () => {
    const element = mount();
    element.setAttribute("row-height", "40");
    const engine = makeEngine();
    element.table = engine;
    await engine.refresh();
    await engine.setScroll({ scrollTop: 100 * 40, rowHeight: 40, viewportHeight: 400 });

    const root = shadow(element);
    expect(root.querySelector<HTMLElement>("[data-leading]")?.style.height).toBe(`${100 * 40}px`);
    expect(root.querySelector<HTMLElement>("[data-trailing]")?.style.height).toBe(`${(TOTAL - 110) * 40}px`);
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
    expect(shadow(element).querySelector<HTMLElement>("[data-leading]")?.style.height).toBe(`${100 * 32}px`);
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
});
