// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  HonuaLayerListElement as ControlsLayerListElement,
  HonuaLegendElement as ControlsLegendElement,
  HonuaBasemapSwitcherElement,
  HonuaSwipeControlElement,
} from "../src/controls/index.js";
import {
  HONUA_COMPONENT_CATALOG,
  HonuaFeatureEditorElement,
  HonuaMeasurementElement,
  defineHonuaWebComponents,
} from "../src/web-components/index.js";
import { assertPseudoLabelPreserved, pseudoLocale } from "./pseudo-locale.js";

type ElementFactory = () => HTMLElement;

const factories: Readonly<Record<string, ElementFactory>> = {
  "controls.basemap-switcher": () => document.createElement("honua-qualification-controls-basemap-switcher"),
  "controls.swipe-control": () => document.createElement("honua-qualification-controls-swipe"),
  "controls.legend": () => document.createElement("honua-qualification-controls-legend"),
  "controls.layer-list": () => document.createElement("honua-qualification-controls-layer-list"),
  "web-components.map": () => document.createElement("honua-map"),
  "web-components.layer-list": () => document.createElement("honua-layer-list"),
  "web-components.legend": () => document.createElement("honua-legend"),
  "web-components.feature-table": () => document.createElement("honua-feature-table"),
  "web-components.search": () => document.createElement("honua-search"),
  "web-components.editor": () => document.createElement("honua-editor"),
  "web-components.feature-inspection": () => document.createElement("honua-feature-inspection"),
  "web-components.feature-editor": () => new HonuaFeatureEditorElement(),
  "web-components.chart": () => document.createElement("honua-chart"),
  "web-components.basemap-control": () => document.createElement("honua-basemap-control"),
  "web-components.bookmarks": () => document.createElement("honua-bookmarks"),
  "web-components.locate-control": () => document.createElement("honua-locate-control"),
  "web-components.measure-control": () => document.createElement("honua-measure-control"),
  "web-components.measurement": () => new HonuaMeasurementElement(),
  "web-components.time-slider": () => document.createElement("honua-time-slider"),
  "web-components.sketch-control": () => document.createElement("honua-sketch-control"),
  "web-components.print-export": () => document.createElement("honua-print-export"),
  "web-components.map-status": () => document.createElement("honua-map-status"),
  "web-components.action-panel": () => document.createElement("honua-action-panel"),
};

function defineNativeTestElements(): void {
  const definitions = [
    ["honua-qualification-controls-basemap-switcher", class extends HonuaBasemapSwitcherElement {}],
    ["honua-qualification-controls-swipe", class extends HonuaSwipeControlElement {}],
    ["honua-qualification-controls-legend", class extends ControlsLegendElement {}],
    ["honua-qualification-controls-layer-list", class extends ControlsLayerListElement {}],
  ] as const;
  for (const [tag, elementClass] of definitions) {
    if (!customElements.get(tag)) customElements.define(tag, elementClass);
  }
}

function shadow(element: HTMLElement): ShadowRoot {
  if (!element.shadowRoot) throw new Error("component did not attach a shadow root");
  return element.shadowRoot;
}

describe("component catalog pseudo-locale render gate", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    defineNativeTestElements();
    defineHonuaWebComponents();
  });

  it("covers every catalog entry through its actual render path", () => {
    expect(Object.keys(factories).sort()).toEqual(HONUA_COMPONENT_CATALOG.map(({ id }) => id).sort());

    for (const entry of HONUA_COMPONENT_CATALOG) {
      const sourceLabel = `Qualification ${entry.id}`;
      const localizedLabel = pseudoLocale(sourceLabel);
      const element = factories[entry.id]?.();
      if (!element) throw new Error(`missing pseudo-locale factory for ${entry.id}`);
      element.setAttribute(entry.id === "controls.legend" ? "heading" : "label", localizedLabel);
      document.body.append(element);

      const root = shadow(element);
      try {
        assertPseudoLabelPreserved(root, localizedLabel);
      } catch (error) {
        throw new Error(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      expect(
        root.textContent?.includes(localizedLabel) || root.querySelector(`[aria-label="${localizedLabel}"]`),
      ).toBeTruthy();
    }
  });

  it("does not silently shorten expanded labels during a re-render", () => {
    const label = pseudoLocale("A deliberately long component label for overflow checks");
    const element = document.createElement("honua-map");
    element.setAttribute("label", label);
    document.body.append(element);

    const root = shadow(element);
    expect(root.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(label);
    element.setAttribute("label", `${label} updated`);
    const updatedRoot = shadow(element);
    expect(updatedRoot.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(`${label} updated`);
    assertPseudoLabelPreserved(updatedRoot, `${label} updated`);
  });
});
