// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type {
  HonuaChartElement,
  HonuaFeatureTableElement,
  HonuaLayerListElement,
  HonuaLegendElement,
  HonuaMapElement,
} from "../src/web-components/index.js";
import { createHonuaWebComponentController, defineHonuaWebComponents } from "../src/web-components/index.js";

const ARABIC = {
  chart: "مؤشرات الحوادث",
  featureTable: "جدول المعالم",
  layerList: "الطبقات",
  legend: "وسيلة الإيضاح",
  map: "الخريطة",
};

function stylesheet(element: Element): string {
  return element.shadowRoot?.querySelector("style")?.textContent ?? "";
}

describe("web-component RTL rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    defineHonuaWebComponents();
  });

  it("renders an Arabic map label with logical RTL map chrome styles", () => {
    const element = document.createElement("honua-map") as HonuaMapElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.map);
    document.body.append(element);

    const root = element.shadowRoot;
    expect(root?.querySelector(".map")?.getAttribute("aria-label")).toBe(ARABIC.map);
    expect(root?.querySelector(".map__title")?.textContent).toBe(ARABIC.map);
    expect(stylesheet(element)).toContain(':host([dir="rtl"]) { direction: rtl; }');
    expect(stylesheet(element)).toContain("padding-inline: 10px;");
    expect(stylesheet(element)).toContain("inset-inline-start: 10px;");
  });

  it("renders Arabic layer-list content with logical tool alignment", () => {
    const element = document.createElement("honua-layer-list") as HonuaLayerListElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.layerList);
    document.body.append(element);
    element.layers = [{ id: "roads", title: "الطرق", visible: true }];

    const root = element.shadowRoot;
    expect(root?.querySelector("legend")?.textContent).toBe(ARABIC.layerList);
    expect(root?.textContent).toContain("الطرق");
    expect(stylesheet(element)).toContain("padding-inline-start: 24px;");
    expect(stylesheet(element)).toContain("padding-inline: 10px;");
  });

  it("renders Arabic legend content with inherited RTL direction", () => {
    const element = document.createElement("honua-legend") as HonuaLegendElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.legend);
    document.body.append(element);
    element.items = [{ id: "roads", label: "الطرق الرئيسية", color: "#475569" }];

    const root = element.shadowRoot;
    expect(root?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.legend);
    expect(root?.textContent).toContain("الطرق الرئيسية");
    expect(stylesheet(element)).toContain(':host([dir="rtl"]) { direction: rtl; }');
    expect(stylesheet(element)).toContain("margin-inline: 0;");
  });

  it("renders Arabic feature-table content with start-aligned logical cells", async () => {
    const element = document.createElement("honua-feature-table") as HonuaFeatureTableElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.featureTable);
    element.setAttribute("source", "parcels");
    document.body.append(element);
    element.controller = createHonuaWebComponentController({
      featuresBySource: {
        parcels: [{ id: 1, sourceId: "parcels", attributes: { NAME: "حديقة" } }],
      },
    }) as never;
    await element.refresh();

    const root = element.shadowRoot;
    expect(root?.querySelector("h2")?.textContent).toBe(ARABIC.featureTable);
    expect(root?.textContent).toContain("حديقة");
    expect(stylesheet(element)).toContain("text-align: start;");
    expect(stylesheet(element)).toContain("padding-block: 7px;");
  });

  it("renders Arabic chart content with an RTL-directed bar fill", () => {
    const element = document.createElement("honua-chart") as HonuaChartElement;
    element.dir = "rtl";
    element.chartModel = {
      id: "incidents",
      title: ARABIC.chart,
      kind: "bar",
      status: "ready",
      data: [{ label: "حادث", value: 4 }],
    };
    document.body.append(element);

    const root = element.shadowRoot;
    expect(root?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.chart);
    expect(root?.textContent).toContain("حادث");
    expect(stylesheet(element)).toContain("inset-inline-start: 0;");
    expect(stylesheet(element)).toContain("padding-inline: 10px;");
  });
});
