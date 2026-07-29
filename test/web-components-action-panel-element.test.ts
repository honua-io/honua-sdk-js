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

describe("<honua-action-panel> localization", () => {
  it("renders German panel strings while preserving caller action labels", () => {
    const element = new HonuaActionPanelElement();
    element.messages = {
      label: "Aktionen",
      status: { ready: "Bereit", unsupported: "Nicht verfügbar" },
      empty: "Keine Aktionen konfiguriert.",
    };
    document.body.append(element);

    expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe("Aktionen");
    expect(element.shadowRoot?.querySelector(".control-panel__bar span")?.textContent).toBe("Nicht verfügbar");
    expect(element.shadowRoot?.querySelector(".empty")?.textContent).toBe("Keine Aktionen konfiguriert.");

    element.setAttribute("actions", JSON.stringify([{ id: "refresh", label: "Refresh sources" }]));

    expect(element.shadowRoot?.querySelector(".control-panel__bar span")?.textContent).toBe("Bereit");
    expect(element.shadowRoot?.querySelector("button")?.textContent).toBe("Refresh sources");
  });
});
