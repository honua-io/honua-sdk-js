// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { HonuaLegendElement, HonuaWebComponentController } from "../src/web-components/index.js";
import { createHonuaWebComponentController, defineHonuaWebComponents } from "../src/web-components/index.js";

/**
 * Survival-tier `<honua-legend>` (issue #493): renders legend entries from
 * the controller's runtime legend model and reacts to layer visibility
 * changes; supports headless item overrides for widget-host delegation.
 */

function makeController(): HonuaWebComponentController {
  return createHonuaWebComponentController({
    layers: [
      { id: "parcels", title: "Parcels", visible: true },
      { id: "roads", title: "Roads", visible: true },
    ],
    legend: [
      { id: "parcels-entry", label: "Residential parcels", color: "#facc15", layerId: "parcels" },
      { id: "roads-entry", label: "Arterial roads", color: "#475569", layerId: "roads" },
      { id: "global-entry", label: "Study boundary", color: "#0f172a" },
    ],
  });
}

function mountLegend(controller?: HonuaWebComponentController): HonuaLegendElement {
  defineHonuaWebComponents();
  const element = document.createElement("honua-legend") as HonuaLegendElement;
  document.body.append(element);
  if (controller) element.controller = controller;
  return element;
}

function shadowText(element: HonuaLegendElement): string {
  return element.shadowRoot?.textContent ?? "";
}

describe("<honua-legend> (survival tier)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders legend entries from controller state as an accessible list", () => {
    const element = mountLegend(makeController());
    const root = element.shadowRoot;
    expect(root?.querySelector("ul[role='list']")).not.toBeNull();
    expect(root?.querySelectorAll("li[role='listitem']")).toHaveLength(3);
    expect(shadowText(element)).toContain("Residential parcels");
    expect(shadowText(element)).toContain("Study boundary");
    // Swatches are presentation only; labels carry the meaning.
    for (const swatch of root?.querySelectorAll(".swatch") ?? []) {
      expect(swatch.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("hides entries for layers toggled off and restores them when re-shown", () => {
    const controller = makeController();
    const element = mountLegend(controller);

    controller.setLayerVisibility("parcels", false);
    expect(shadowText(element)).not.toContain("Residential parcels");
    // Entries without a layerId and entries for visible layers stay.
    expect(shadowText(element)).toContain("Arterial roads");
    expect(shadowText(element)).toContain("Study boundary");

    controller.setLayerVisibility("parcels", true);
    expect(shadowText(element)).toContain("Residential parcels");
  });

  it("keeps hidden-layer entries when include-hidden is set", () => {
    const controller = makeController();
    const element = mountLegend(controller);
    element.setAttribute("include-hidden", "");

    controller.setLayerVisibility("parcels", false);
    expect(shadowText(element)).toContain("Residential parcels");
  });

  it("renders headless item overrides (widget-host delegation) without a controller", () => {
    const element = mountLegend();
    element.items = [
      { id: "a", label: "Zone A", color: "#dc2626" },
      { id: "b", label: "Zone B", iconUrl: "data:image/png;base64,QQ==" },
    ];

    expect(shadowText(element)).toContain("Zone A");
    expect(shadowText(element)).toContain("Zone B");
    const icon = element.shadowRoot?.querySelector("img.swatch");
    expect(icon?.getAttribute("src")).toBe("data:image/png;base64,QQ==");
  });

  it("emits system-color styles that keep swatches distinct from labels in high contrast", () => {
    const element = mountLegend(makeController());
    const stylesheet = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(stylesheet).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(stylesheet).toContain(".legend li { color: CanvasText; }");
    expect(stylesheet).toContain("background: Canvas;");
    expect(stylesheet).toContain("border: 2px solid CanvasText;");
    expect(stylesheet).toContain("forced-color-adjust: none;");
  });

  it("emits narrow-container-safe legend rules", () => {
    const element = mountLegend(makeController());
    const stylesheet = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(stylesheet).toContain("@media (max-width: 320px)");
    expect(stylesheet).toContain(".legend li { align-items: flex-start; min-width: 0; }");
    expect(stylesheet).toContain("overflow-wrap: anywhere;");
  });
});
