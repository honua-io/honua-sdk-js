// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type {
  HonuaActionPanelElement,
  HonuaBasemapControlElement,
  HonuaBookmarksElement,
  HonuaEditorElement,
  HonuaLocateControlElement,
  HonuaMeasureControlElement,
  HonuaMeasurementElement,
  HonuaPrintExportElement,
  HonuaSearchElement,
  HonuaSketchControlElement,
  HonuaTimeSliderElement,
} from "../src/web-components/index.js";
import { defineHonuaMeasurement, defineHonuaWebComponents } from "../src/web-components/index.js";

const ARABIC = {
  actionPanel: "الإجراءات",
  basemap: "خرائط الأساس",
  bookmarks: "الإشارات المرجعية",
  editor: "المحرر",
  locate: "تحديد الموقع",
  measure: "القياس",
  measurement: "قياس المسافة",
  printExport: "الطباعة والتصدير",
  search: "بحث",
  sketch: "الرسم",
  timeSlider: "شريط الزمن",
};

function stylesheet(element: Element): string {
  return element.shadowRoot?.querySelector("style")?.textContent ?? "";
}

function expectRtlDirection(element: Element): void {
  expect(element.getAttribute("dir")).toBe("rtl");
  expect(stylesheet(element)).toContain(':host([dir="rtl"]) { direction: rtl; }');
}

describe("remaining web-component RTL rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    defineHonuaWebComponents();
    defineHonuaMeasurement();
  });

  it("renders an Arabic search label with logical input and result alignment", () => {
    const element = document.createElement("honua-search") as HonuaSearchElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.search);
    element.setAttribute("placeholder", "ابحث عن معلم");
    element.setAttribute("submit-label", "تنفيذ البحث");
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.search);
    expect(element.shadowRoot?.querySelector("input")?.getAttribute("placeholder")).toBe("ابحث عن معلم");
    expect(element.shadowRoot?.querySelector("button")?.textContent).toBe("تنفيذ البحث");
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("padding-inline: 9px;");
    expect(stylesheet(element)).toContain("text-align: start;");
  });

  it("renders an Arabic editor label with logical panel spacing", () => {
    const element = document.createElement("honua-editor") as HonuaEditorElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.editor);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.editor);
    expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe(ARABIC.editor);
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("padding-block: 10px;");
    expect(stylesheet(element)).toContain("margin-block: 10px 4px;");
  });

  it("renders an Arabic basemap-control label with logical segmented padding", () => {
    const element = document.createElement("honua-basemap-control") as HonuaBasemapControlElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.basemap);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.basemap);
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("padding-inline: 8px;");
  });

  it("renders an Arabic bookmark button with RTL control-panel styles", () => {
    const element = document.createElement("honua-bookmarks") as HonuaBookmarksElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.bookmarks);
    element.setAttribute(
      "bookmarks",
      JSON.stringify([{ id: "harbor", label: "الميناء", viewport: { center: [-157.87, 21.3], zoom: 13 } }]),
    );
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe(ARABIC.bookmarks);
    expect(element.shadowRoot?.querySelector("button")?.textContent).toBe("الميناء");
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("text-align: start;");
  });

  it("renders Arabic locate-control messages with logical panel padding", () => {
    const element = document.createElement("honua-locate-control") as HonuaLocateControlElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.locate);
    element.setAttribute("latitude", "not-a-coordinate");
    element.setAttribute("longitude", "not-a-coordinate");
    element.messages = {
      actionLabel: "استخدم الموقع",
      unavailable: "الموقع الجغرافي غير متاح",
    };
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe(ARABIC.locate);
    expect(element.shadowRoot?.querySelector("p[role='status']")?.textContent).toBe("الموقع الجغرافي غير متاح");
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("padding-block: 10px;");
  });

  it("renders an Arabic measure-control group with start-aligned actions", () => {
    const element = document.createElement("honua-measure-control") as HonuaMeasureControlElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.measure);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.measure);
    expect(element.shadowRoot?.querySelector("[role='group']")?.getAttribute("aria-label")).toBe(ARABIC.measure);
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("text-align: start;");
  });

  it("renders an Arabic measurement label with logical map-widget spacing", () => {
    const element = document.createElement("honua-measurement") as HonuaMeasurementElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.measurement);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.measurement);
    expect(element.shadowRoot?.querySelector("[role='group']")?.getAttribute("aria-label")).toBe(
      `${ARABIC.measurement} mode`,
    );
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("padding-inline: 10px;");
  });

  it("renders an Arabic time slider with logical thumb offsets and mirrored arrow stepping", () => {
    const element = document.createElement("honua-time-slider") as HonuaTimeSliderElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.timeSlider);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.timeSlider);
    expect(element.shadowRoot?.querySelector("[role='group']")?.getAttribute("aria-label")).toBe(
      `${ARABIC.timeSlider} playback`,
    );
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("padding-inline: 10px;");
    expect(stylesheet(element)).toContain("text-align: start;");
    expect(stylesheet(element)).toContain("inset-inline-start: 0%;");
    expect(stylesheet(element)).toContain(':host([dir="rtl"]) .thumb { transform: translateX(50%); }');

    // The inline axis mirrors: ArrowRight must move the window *back* in RTL.
    const start = Date.parse("2026-06-01T00:00:00Z");
    const day = 86_400_000;
    const scrubbed: number[] = [];
    element.playback = {
      playing: false,
      window: { start: start + 5 * day, end: start + 6 * day },
      extent: { start, end: start + 30 * day },
      stepMs: day,
      play: () => undefined,
      pause: () => undefined,
      scrub: (time: number) => scrubbed.push(time),
      on: () => ({ remove: () => undefined }),
    };
    const slider = element.shadowRoot?.querySelector("[data-time-slider]");
    slider?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(scrubbed).toEqual([start + 4 * day]);
  });

  it("renders an Arabic sketch-control group with logical control padding", () => {
    const element = document.createElement("honua-sketch-control") as HonuaSketchControlElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.sketch);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.sketch);
    expect(element.shadowRoot?.querySelector("[role='group']")?.getAttribute("aria-label")).toBe(ARABIC.sketch);
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("padding-inline: 8px;");
  });

  it("renders an Arabic print-export label with start-aligned export actions", () => {
    const element = document.createElement("honua-print-export") as HonuaPrintExportElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.printExport);
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.printExport);
    expect(element.shadowRoot?.querySelector("[data-export-kind='print']")?.textContent).toBe("Print");
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("text-align: start;");
  });

  it("renders an Arabic action-panel label and action with logical styles", () => {
    const element = document.createElement("honua-action-panel") as HonuaActionPanelElement;
    element.dir = "rtl";
    element.setAttribute("label", ARABIC.actionPanel);
    element.setAttribute("actions", JSON.stringify([{ id: "refresh", label: "تحديث البيانات" }]));
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe(ARABIC.actionPanel);
    expect(element.shadowRoot?.querySelector("button")?.textContent).toBe("تحديث البيانات");
    expectRtlDirection(element);
    expect(stylesheet(element)).toContain("text-align: start;");
    expect(stylesheet(element)).toContain("padding-inline: 10px;");
  });
});
