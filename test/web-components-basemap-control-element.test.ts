// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { HonuaBasemapControlElement, createHonuaWebComponentController } from "../src/web-components/index.js";

describe("<honua-basemap-control> high-contrast styles", () => {
  it("uses system colors for basemap radio controls and active state", () => {
    const element = new HonuaBasemapControlElement();
    document.body.append(element);
    element.controller = createHonuaWebComponentController({
      layers: [
        { id: "streets", title: "Streets", type: "background", visible: true },
        { id: "imagery", title: "Imagery", type: "background", visible: false },
      ],
    });
    const stylesheet = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(stylesheet).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(stylesheet).toContain("background: Canvas;");
    expect(stylesheet).toContain("border-color: CanvasText;");
    expect(stylesheet).toContain("color: CanvasText;");
    expect(stylesheet).toContain(".segmented button {");
    expect(stylesheet).toContain("background: ButtonFace;");
    expect(stylesheet).toContain("border: 2px solid ButtonText;");
    expect(stylesheet).toContain("color: ButtonText;");
    expect(stylesheet).toContain("forced-color-adjust: none;");
    expect(stylesheet).toContain('.segmented button[aria-pressed="true"]');
    expect(stylesheet).toContain("background: Highlight;");
    expect(stylesheet).toContain("color: HighlightText;");
    expect(stylesheet).toContain("outline: 2px solid Highlight;");
  });
});
