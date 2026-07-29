// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { HonuaMapStatusElement } from "../src/web-components/index.js";

describe("<honua-map-status> high-contrast styles", () => {
  it("preserves status text, state meaning, and action distinction with system colors", () => {
    const element = new HonuaMapStatusElement();
    document.body.append(element);
    const stylesheet = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(stylesheet).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(stylesheet).toContain("background: Canvas;");
    expect(stylesheet).toContain("border-color: CanvasText;");
    expect(stylesheet).toContain(".map-status span { color: CanvasText; }");
    expect(stylesheet).toContain(':host([data-status="unsupported"]) .map-status');
    expect(stylesheet).toContain("border-color: GrayText;");
    expect(stylesheet).toContain(':host([data-status="error"]) .map-status');
    expect(stylesheet).toContain("border-color: Mark;");
    expect(stylesheet).toContain("color: MarkText;");
    expect(stylesheet).toContain("background: ButtonFace;");
    expect(stylesheet).toContain("border: 2px solid ButtonText;");
    expect(stylesheet).toContain("color: ButtonText;");
    expect(stylesheet).toContain("forced-color-adjust: none;");
  });
});

describe("<honua-map-status> RTL layout", () => {
  it("inherits RTL direction while preserving logical readout order and labels", () => {
    const element = new HonuaMapStatusElement();
    element.setAttribute("dir", "rtl");
    element.setAttribute("label", "حالة الخريطة");
    element.setAttribute("attribution", "بيانات هونوا");
    document.body.append(element);

    const section = element.shadowRoot?.querySelector("section.map-status");
    const readouts = section?.querySelectorAll("span");
    const button = section?.querySelector("button[data-fullscreen]");
    const stylesheet = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(element.getAttribute("dir")).toBe("rtl");
    expect(section?.getAttribute("dir")).toBeNull();
    expect(section?.getAttribute("aria-label")).toBe("حالة الخريطة");
    expect(readouts?.[0]?.getAttribute("aria-label")).toBe("Approximate scale");
    expect(readouts?.[1]?.textContent).toBe("بيانات هونوا");
    expect(button?.textContent).toBe("Fullscreen");
    expect(stylesheet).toContain("direction: inherit;");
    expect(stylesheet).toContain("padding-block: 6px;");
    expect(stylesheet).toContain("padding-inline: 8px;");
    expect(stylesheet).toContain("text-align: start;");
  });
});
