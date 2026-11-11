// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { projectAnalyticsArtifactToUplot } from "../src/analytics/adapters/uplot.js";
import { acceptScatterArtifact } from "../src/analytics/index.js";
import { FakeUplot, harness, scatter } from "./analytics-uplot-harness.js";

describe("uPlot scatter", () => {
  it("sorts points and keys together, draws no connecting path and enables a two-axis brush", () => {
    const projection = projectAnalyticsArtifactToUplot(scatter());
    expect(projection.data).toEqual([
      [10, 30],
      [20, 40],
    ]);
    expect(projection.markKeys).toEqual(["a", "b"]);
    expect(projection.xUnit).toBe("numeric");
    expect(projection.options.series[1].paths?.()).toBeNull();
    expect(projection.options.series[1].points?.show).toBe(true);
    expect(projection.options.cursor?.drag).toEqual({
      x: true,
      y: true,
      setScale: false,
    });
  });

  it("keeps an in-progress drag when hover state changes", async () => {
    const { session } = harness(scatter());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances[0];
    const drag = { left: 5, top: 10, width: 10, height: 15 };
    chart.select = drag;
    chart.fireCursor(0);
    expect(chart.select).toEqual(drag);
    session.dispose();
  });

  it("uses both screen coordinates to select points sharing an x value", async () => {
    const artifact = scatter();
    const { session, view } = harness(
      acceptScatterArtifact({
        ...artifact,
        marks: artifact.marks.map((mark) => ({ ...mark, x: 10 })),
      }),
    );
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances[0];
    chart.cursor = { idx: 0, left: 10, top: 20 };
    for (const hook of chart.options.hooks?.setCursor ?? []) hook(chart);
    expect(session.linkedState.hoveredMarkKey).toBe("a");
    chart.fireClick();
    expect(view.state.selection).toEqual([1]);
    session.dispose();
  });

  it("links both drag axes, paints peer rectangles and clears without changing peer filters", async () => {
    const { session, view } = harness(scatter());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances[0];
    chart.fireSelect({ left: 5, top: 10, width: 10, height: 15 });
    expect(session.linkedState.rectangle).toEqual({
      x: { min: 5, max: 15 },
      y: { min: 10, max: 25 },
    });
    expect(Object.values(view.state.filters)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "height", value: [5, 15] }),
        expect.objectContaining({ field: "weight", value: [10, 25] }),
      ]),
    );
    expect(chart.setSelectCalls.at(-1)).toEqual({
      left: 5,
      top: 10,
      width: 10,
      height: 15,
    });
    chart.fireCursor(0);
    chart.fireClick();
    expect(view.state.selection).toEqual([]);
    session.apply({
      kind: "clear",
      channel: "rectangle",
      adapterId: "peer",
      artifactId: "scatter",
    });
    expect(chart.setSelectCalls.at(-1)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
    chart.fireSelect({ left: 5, top: 10, width: 10, height: 0 });
    expect(session.linkedState.rectangle).toBeUndefined();
    session.dispose();
  });

  it("highlights a peer point selection without repainting an unchanged rectangle", async () => {
    const { session } = harness(scatter());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances[0];
    chart.fireSelect({ left: 5, top: 10, width: 10, height: 15 });
    const paints = chart.setSelectCalls.length;
    session.apply({
      kind: "mark-select",
      adapterId: "peer",
      artifactId: "scatter",
      markKeys: ["b"],
      replace: true,
    });
    expect(chart.setSelectCalls).toHaveLength(paints);
    expect(chart.redrawCalls).toBeGreaterThan(0);
    expect(chart.options.series[1].points?.stroke).toBeUndefined();
    const draw = chart.options.hooks?.draw?.[0];
    expect(typeof draw).toBe("function");
    const arcs: number[] = [];
    const fills: string[] = [];
    const clips: Array<{ x: number; y: number; width: number; height: number }> = [];
    chart.bbox = { left: 0, top: 0, width: 100, height: 80 };
    chart.ctx = {
      fillStyle: "",
      beginPath() {},
      rect(x: number, y: number, width: number, height: number) {
        clips.push({ x, y, width, height });
      },
      moveTo() {},
      arc(x: number) {
        arcs.push(x);
      },
      clip() {},
      fill() {
        fills.push(String(this.fillStyle));
      },
      save() {},
      restore() {},
    };
    draw?.(chart);
    expect(clips).toEqual([{ x: 0, y: 0, width: 100, height: 80 }]);
    expect(arcs).toEqual([30]);
    expect(fills).toEqual(["#9a3412"]);
    session.dispose();
  });

  it("keeps the rectangle when a repeated drag does not change the brush bounds", async () => {
    const { session, view } = harness(scatter());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances[0];
    chart.fireSelect({ left: 5, top: 10, width: 10, height: 15 });
    const filters = { ...view.state.filters };
    chart.cursor = { idx: 0, left: 10, top: 20 };
    const dispatch = (type: string, x: number, y: number): void => {
      for (const listener of chart.listeners.get(type) ?? []) {
        listener(new MouseEvent(type, { clientX: x, clientY: y }));
      }
    };
    dispatch("mousedown", 5, 10);
    dispatch("mousemove", 15, 25);
    chart.fireClick();
    expect(view.state.filters).toEqual(filters);
    expect(view.state.selection).toEqual([]);
    session.dispose();
  });

  it("repaints the active rectangle after a double-click reset", async () => {
    const { session } = harness(scatter());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances[0];
    chart.fireSelect({ left: 5, top: 10, width: 10, height: 15 });
    const paints = chart.setSelectCalls.length;
    chart.select = { left: 0, top: 0, width: 0, height: 0 };
    for (const listener of chart.listeners.get("dblclick") ?? []) listener({});
    expect(chart.setSelectCalls.length).toBeGreaterThan(paints);
    expect(chart.setSelectCalls.at(-1)).toEqual({ left: 5, top: 10, width: 10, height: 15 });
    session.dispose();
  });
});
