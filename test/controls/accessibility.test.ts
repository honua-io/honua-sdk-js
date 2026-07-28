// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { HonuaBasemapSwitcherElement } from "../../src/controls/basemap-switcher.js";
import { HonuaLayerListElement, defineHonuaLayerList } from "../../src/controls/layer-list.js";
import { HonuaLegendElement, defineHonuaLegend } from "../../src/controls/legend.js";
import { HonuaSwipeControlElement } from "../../src/controls/swipe-control.js";

defineHonuaLayerList();
defineHonuaLegend();

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) element.remove();
});

function mount<T extends HTMLElement>(element: T): T {
  document.body.append(element);
  mounted.push(element);
  return element;
}

describe("controls accessibility semantics", () => {
  it("exposes basemap choices as a named radio group", () => {
    const element = mount(new HonuaBasemapSwitcherElement());
    element.setAttribute("label", "Fonds de carte");
    element.bases = [
      { id: "streets", label: "Streets", kind: "vector", sources: {}, layers: [] },
      { id: "imagery", label: "Imagery", kind: "raster", sources: {}, layers: [] },
    ];

    const group = element.shadowRoot?.querySelector('[role="radiogroup"]');
    const radios = [...(element.shadowRoot?.querySelectorAll('[role="radio"]') ?? [])];
    expect(group?.getAttribute("aria-label")).toBe("Fonds de carte");
    expect(radios.map((radio) => radio.textContent?.trim())).toEqual(["Streets", "Imagery"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("exposes the swipe divider as a labelled range", () => {
    const element = mount(new HonuaSwipeControlElement());
    const divider = element.shadowRoot?.querySelector('[role="slider"]');
    const styles = element.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(divider?.getAttribute("aria-label")).toBeNull();
    expect(divider?.getAttribute("aria-valuemin")).toBe("0");
    expect(divider?.getAttribute("aria-valuemax")).toBe("100");
    expect(divider?.getAttribute("aria-valuenow")).toBe("50");
    expect(divider?.getAttribute("aria-orientation")).toBe("horizontal");
    expect(styles).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(styles).toContain("border-color: ButtonText");
    expect(styles).toContain("outline: 2px solid Canvas");

    element.orientation = "horizontal";
    expect(element.shadowRoot?.querySelector('[role="slider"]')?.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("exposes layer toggles through a named group and native checkbox labels", () => {
    const element = mount(new HonuaLayerListElement());
    const layers: Record<string, { visibility?: string }> = {
      "roads-layer": {},
      "parks-layer": { visibility: "none" },
    };
    element.connect({
      getLayer: (id: string) => layers[id],
      getLayoutProperty: (id: string, name: string) => (name === "visibility" ? layers[id]?.visibility : undefined),
      setLayoutProperty: (id: string, _name: string, value: unknown) => {
        layers[id].visibility = String(value);
      },
    });
    element.overlays = [
      { id: "roads", label: "Roads", layers: ["roads-layer"] },
      { id: "parks", label: "Parks", layers: ["parks-layer"] },
      { id: "future", label: "Future", layers: ["future-layer"] },
    ];

    const root = element.shadowRoot?.querySelector('[role="group"]');
    const checkbox = element.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const label = element.shadowRoot?.querySelector("label");
    expect(root?.getAttribute("aria-label")).toBe("Layers");
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
    expect(label?.textContent).toContain("Roads");
    expect(label?.querySelector('input[type="checkbox"]')).toBe(checkbox);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>('input[data-overlay-id="parks"]')?.checked).toBe(false);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>('input[data-overlay-id="future"]')?.disabled).toBe(true);
  });

  it("mounts and disconnects native controls without console errors", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const element of [
        new HonuaBasemapSwitcherElement(),
        new HonuaSwipeControlElement(),
        new HonuaLegendElement(),
        new HonuaLayerListElement(),
      ]) {
        mount(element);
      }
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("does not duplicate basemap handlers across repeated rerenders", () => {
    const element = mount(new HonuaBasemapSwitcherElement());
    element.bases = [
      { id: "streets", label: "Streets", kind: "vector", sources: {}, layers: [] },
      { id: "imagery", label: "Imagery", kind: "raster", sources: {}, layers: [] },
    ];
    const changes: Event[] = [];
    element.addEventListener("change", (event) => changes.push(event));
    for (let index = 0; index < 4; index += 1) {
      element.bases = element.bases;
    }
    changes.splice(0);
    const imagery = element.shadowRoot?.querySelector<HTMLElement>('[data-base-id="imagery"]');
    imagery?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(changes).toHaveLength(1);
  });

  it("restores focus to the selected basemap after a rerender", () => {
    const element = mount(new HonuaBasemapSwitcherElement());
    element.bases = [
      { id: "streets", label: "Streets", kind: "vector", sources: {}, layers: [] },
      { id: "imagery", label: "Imagery", kind: "raster", sources: {}, layers: [] },
    ];
    const imagery = element.shadowRoot?.querySelector<HTMLElement>('[data-base-id="imagery"]');
    imagery?.focus();
    element.bases = element.bases;
    expect(element.shadowRoot?.activeElement?.getAttribute("data-base-id")).toBe("imagery");
  });

  it("keeps the swipe divider focused while its value rerenders", () => {
    const element = mount(new HonuaSwipeControlElement());
    const divider = element.shadowRoot?.querySelector<HTMLElement>('[role="slider"]');
    divider?.focus();
    element.position = 65;
    expect(element.shadowRoot?.activeElement).toBe(divider);
  });

  it("restores focus to a layer checkbox after a rerender", () => {
    const element = mount(new HonuaLayerListElement());
    element.map = {
      getLayer: () => ({}),
      getLayoutProperty: () => "visible",
      setLayoutProperty: () => undefined,
    };
    element.overlays = [{ id: "roads", label: "Roads", layers: ["roads-layer"] }];
    const checkbox = element.shadowRoot?.querySelector<HTMLInputElement>('input[data-overlay-id="roads"]');
    checkbox?.focus();
    element.overlays = element.overlays;
    expect(element.shadowRoot?.activeElement?.getAttribute("data-overlay-id")).toBe("roads");
  });

  it("does not duplicate layer checkbox handlers across rerenders", () => {
    const element = mount(new HonuaLayerListElement());
    element.map = {
      getLayer: () => ({}),
      getLayoutProperty: () => "visible",
      setLayoutProperty: () => undefined,
    };
    const overlays = [{ id: "roads", label: "Roads", layers: ["roads-layer"] }];
    element.overlays = overlays;
    const changes: Event[] = [];
    element.addEventListener("change", (event) => changes.push(event));
    for (let index = 0; index < 4; index += 1) element.overlays = overlays;
    changes.splice(0);
    const checkbox = element.shadowRoot?.querySelector<HTMLInputElement>('input[data-overlay-id="roads"]');
    checkbox?.click();
    expect(changes).toHaveLength(1);
  });
});
