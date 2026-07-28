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
