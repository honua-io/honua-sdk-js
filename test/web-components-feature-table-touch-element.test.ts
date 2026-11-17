// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { HonuaFeatureTableElement } from "../src/web-components/index.js";
import { type Row, makeEngine, mount, shadow } from "./feature-table-element-fixture.js";

type Pointer = { readonly pointerType: string; readonly x?: number; readonly y?: number; readonly id?: number };

function pointer(type: string, { pointerType, x = 0, y = 0, id = 7 }: Pointer): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  Object.defineProperty(event, "pointerId", { value: id });
  return event;
}

async function mountTable() {
  const element = mount();
  const engine = makeEngine();
  element.table = engine;
  await engine.refresh();
  const selections: unknown[] = [];
  element.addEventListener("honua-selection-change", (event) => selections.push((event as CustomEvent).detail));
  const cell = shadow(element).querySelector<HTMLTableCellElement>(
    "tbody tr[data-row-key='incidents:1'] [role='gridcell']",
  );
  if (!cell) throw new Error("no cell");
  return { element, engine, selections, cell };
}

async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function clickRow(element: HonuaFeatureTableElement<Row>, rowKey: string): void {
  shadow(element)
    .querySelector<HTMLTableRowElement>(`tbody tr[data-row-key='${rowKey}']`)
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

const start = { x: 40, y: 20 };

describe("<honua-feature-table> touch and pen taps", () => {
  it("does not select on a touch press, and selects once on the completed tap", async () => {
    const { element, engine, selections, cell } = await mountTable();
    const touch = { pointerType: "touch", ...start };

    cell.dispatchEvent(pointer("pointerdown", touch));
    expect(selections).toHaveLength(0);
    expect(engine.snapshot.selection).toEqual([]);

    document.body.dispatchEvent(pointer("pointerup", { ...touch, x: 44, y: 23 }));
    await settle();
    clickRow(element, "incidents:1");
    expect(selections).toHaveLength(1);
    expect(engine.snapshot.selection).toEqual(["incidents:1"]);

    await settle(550);
    clickRow(element, "incidents:1");
    expect(selections).toHaveLength(2);
  });

  it("ignores another finger lifting while the press is held", async () => {
    const { selections, cell } = await mountTable();
    const touch = { pointerType: "touch", ...start };

    cell.dispatchEvent(pointer("pointerdown", touch));
    document.body.dispatchEvent(pointer("pointerup", { ...touch, id: 8 }));
    expect(selections).toHaveLength(0);
    document.body.dispatchEvent(pointer("pointerup", touch));
    expect(selections).toHaveLength(1);
  });

  it("keeps mouse selection on pointerdown", async () => {
    const { engine, selections, cell } = await mountTable();

    cell.dispatchEvent(pointer("pointerdown", { pointerType: "mouse" }));

    expect(selections).toHaveLength(1);
    expect(engine.snapshot.selection).toEqual(["incidents:1"]);
  });
});

describe("<honua-feature-table> cancelled or moved touch and pen gestures", () => {
  it.each([
    ["the browser cancels the touch to scroll", "touch", [["pointercancel", start]]],
    ["a touch is released beyond the tap slop", "touch", [["pointerup", { x: 40, y: 60 }]]],
    [
      "a pen drag travels beyond the tap slop, even if it ends near the start",
      "pen",
      [
        ["pointermove", { x: 40, y: 80 }],
        ["pointerup", { x: 40, y: 22 }],
      ],
    ],
  ] as const)("selects nothing when %s", async (_case, pointerType, steps) => {
    const { element, engine, selections, cell } = await mountTable();

    cell.dispatchEvent(pointer("pointerdown", { pointerType, ...start }));
    for (const [type, at] of steps) document.body.dispatchEvent(pointer(type, { pointerType, ...at }));
    await settle();
    clickRow(element, "incidents:1");

    expect(selections).toHaveLength(0);
    expect(engine.snapshot.selection).toEqual([]);
  });
});
