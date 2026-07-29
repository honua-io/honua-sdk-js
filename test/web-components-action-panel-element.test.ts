// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { HonuaActionPanelElement } from "../src/web-components/index.js";

describe("<honua-action-panel> high-contrast styles", () => {
  it("uses system colors for the panel, actions, and empty/status state", () => {
    const element = new HonuaActionPanelElement();
    document.body.append(element);
    const stylesheet = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(stylesheet).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(stylesheet).toContain("background: Canvas;");
    expect(stylesheet).toContain("border-color: CanvasText;");
    expect(stylesheet).toContain("color: CanvasText;");
    expect(stylesheet).toContain(".control-panel__bar span, .empty { color: CanvasText; }");
    expect(stylesheet).toContain("background: ButtonFace;");
    expect(stylesheet).toContain("border: 2px solid ButtonText;");
    expect(stylesheet).toContain("color: ButtonText;");
    expect(stylesheet).toContain("forced-color-adjust: none;");
    expect(stylesheet).toContain("border-color: GrayText;");
  });
});
