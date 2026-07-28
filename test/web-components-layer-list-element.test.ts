// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type {
  HonuaLayerListElement,
  HonuaLayerOpacityChangeDetail,
  HonuaLayerOrderChangeDetail,
  HonuaLayerVisibilityChangeDetail,
  HonuaWebComponentController,
} from "../src/web-components/index.js";
import { createHonuaWebComponentController, defineHonuaWebComponents } from "../src/web-components/index.js";

/**
 * Survival-tier `<honua-layer-list>` (issue #493): rendering from controller
 * state, visibility toggles, opacity slider, keyboard reorder buttons, and
 * drag-and-drop reorder, plus the ARIA contract each control carries.
 */

function makeController(): HonuaWebComponentController {
  return createHonuaWebComponentController({
    layers: [
      { id: "base", title: "Base map", visible: true, opacity: 0.8 },
      { id: "mid", title: "Middle overlay", visible: true },
      { id: "top", title: "Top overlay", visible: false },
    ],
  });
}

function mountList(controller: HonuaWebComponentController): HonuaLayerListElement {
  defineHonuaWebComponents();
  const element = document.createElement("honua-layer-list") as HonuaLayerListElement;
  document.body.append(element);
  element.controller = controller;
  return element;
}

function shadow(element: HonuaLayerListElement): ShadowRoot {
  const root = element.shadowRoot;
  if (!root) throw new Error("missing shadow root");
  return root;
}

describe("<honua-layer-list> (survival tier)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders one accessible row per layer with checkbox state from the controller", () => {
    const element = mountList(makeController());
    const root = shadow(element);

    expect(root.querySelector("[role='list']")).not.toBeNull();
    const rows = root.querySelectorAll("[role='listitem']");
    expect(rows).toHaveLength(3);

    const checkboxes = root.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    expect([...checkboxes].map((input) => input.checked)).toEqual([true, true, false]);
    expect(root.textContent).toContain("Base map");
    expect(root.textContent).toContain("Top overlay");
    const css = root.querySelector("style")?.textContent ?? "";
    expect(css).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(css).toContain("border-top-color: CanvasText");
    expect(css).toContain("color: Highlight");
    expect(css).toContain("border-color: ButtonText");
  });

  it("toggles visibility through the controller and dispatches honua-layer-visibility-change", () => {
    const controller = makeController();
    const element = mountList(controller);
    const events: HonuaLayerVisibilityChangeDetail[] = [];
    element.addEventListener("honua-layer-visibility-change", (event) => {
      events.push((event as CustomEvent<HonuaLayerVisibilityChangeDetail>).detail);
    });

    const checkbox = shadow(element).querySelector<HTMLInputElement>("input[data-layer-id='base']");
    if (!checkbox) throw new Error("missing base checkbox");
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    expect(controller.getState().layers.find((layer) => layer.id === "base")?.visible).toBe(false);
    expect(events).toEqual([{ layerId: "base", visible: false }]);
    // Re-rendered row reflects the new state.
    expect(shadow(element).querySelector<HTMLInputElement>("input[data-layer-id='base']")?.checked).toBe(false);
  });

  it("renders an opacity slider per row and commits changes on the change event", () => {
    const controller = makeController();
    const element = mountList(controller);
    const events: HonuaLayerOpacityChangeDetail[] = [];
    element.addEventListener("honua-layer-opacity-change", (event) => {
      events.push((event as CustomEvent<HonuaLayerOpacityChangeDetail>).detail);
    });

    const slider = shadow(element).querySelector<HTMLInputElement>("input[data-layer-opacity='base']");
    if (!slider) throw new Error("missing opacity slider");
    expect(slider.getAttribute("aria-label")).toBe("Opacity");
    expect(slider.value).toBe("80");

    slider.value = "35";
    slider.dispatchEvent(new Event("change"));

    expect(controller.getState().layers.find((layer) => layer.id === "base")?.opacity).toBeCloseTo(0.35);
    expect(events).toEqual([{ layerId: "base", opacity: 0.35 }]);
    // Sliders default to fully opaque when a layer carries no opacity.
    expect(shadow(element).querySelector<HTMLInputElement>("input[data-layer-opacity='mid']")?.value).toBe("100");
  });

  it("reorders layers with keyboard-operable move buttons and disables the ends", () => {
    const controller = makeController();
    const element = mountList(controller);
    const events: HonuaLayerOrderChangeDetail[] = [];
    element.addEventListener("honua-layer-order-change", (event) => {
      events.push((event as CustomEvent<HonuaLayerOrderChangeDetail>).detail);
    });

    const root = shadow(element);
    const upFirst = root.querySelector<HTMLButtonElement>("button[data-move='up:base']");
    const downLast = root.querySelector<HTMLButtonElement>("button[data-move='down:top']");
    expect(upFirst?.disabled).toBe(true);
    expect(downLast?.disabled).toBe(true);
    expect(upFirst?.getAttribute("aria-label")).toBe("Move up");
    expect(downLast?.getAttribute("aria-label")).toBe("Move down");

    root.querySelector<HTMLButtonElement>("button[data-move='down:base']")?.click();
    expect(controller.getState().layers.map((layer) => layer.id)).toEqual(["mid", "base", "top"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ layerId: "base", beforeId: "top", order: ["mid", "base", "top"] });

    // Move the (now middle) layer back up.
    shadow(element).querySelector<HTMLButtonElement>("button[data-move='up:base']")?.click();
    expect(controller.getState().layers.map((layer) => layer.id)).toEqual(["base", "mid", "top"]);

    // Moving the last row down goes to the end of the stack (beforeId omitted).
    shadow(element).querySelector<HTMLButtonElement>("button[data-move='down:mid']")?.click();
    expect(controller.getState().layers.map((layer) => layer.id)).toEqual(["base", "top", "mid"]);
    expect(events.at(-1)?.beforeId).toBeUndefined();
  });

  it("reorders layers via drag-and-drop between rows", () => {
    const controller = makeController();
    const element = mountList(controller);
    const root = shadow(element);

    const topRow = root.querySelector<HTMLElement>("[data-layer-row='top']");
    const baseRow = root.querySelector<HTMLElement>("[data-layer-row='base']");
    if (!topRow || !baseRow) throw new Error("missing rows");
    expect(topRow.getAttribute("draggable")).toBe("true");

    topRow.dispatchEvent(new Event("dragstart"));
    baseRow.dispatchEvent(new Event("drop"));

    expect(controller.getState().layers.map((layer) => layer.id)).toEqual(["top", "base", "mid"]);
  });

  it("hides opacity and reorder affordances when the controller does not implement them", () => {
    const controller = makeController();
    // A delegating wrapper without the optional layer-state extensions.
    const limited: HonuaWebComponentController = {
      getState: () => controller.getState(),
      subscribe: (listener) => controller.subscribe(listener),
      setLayerVisibility: (id, visible) => controller.setLayerVisibility(id, visible),
      setViewport: (viewport) => controller.setViewport(viewport),
      setFilter: (filter) => controller.setFilter(filter),
      selectFeature: (selection) => controller.selectFeature(selection),
      clearSelection: () => controller.clearSelection(),
      setFeatureState: (target, state) => controller.setFeatureState(target, state),
      removeFeatureState: (target, key) => controller.removeFeatureState(target, key),
      queryFeatures: (sourceId, options) => controller.queryFeatures(sourceId, options),
      search: (query, options) => controller.search(query, options),
      canMeasure: () => false,
      canSketch: () => false,
      setMeasureMode: (mode) => controller.setMeasureMode(mode),
      setSketchMode: (mode) => controller.setSketchMode(mode),
    };
    const element = mountList(limited);

    const root = shadow(element);
    expect(root.querySelector("input[data-layer-opacity]")).toBeNull();
    expect(root.querySelector("button[data-move]")).toBeNull();
    expect(root.querySelector("[data-layer-row]")?.getAttribute("draggable")).toBeNull();
  });

  it("supports headless layer overrides for widget-host delegation", () => {
    defineHonuaWebComponents();
    const element = document.createElement("honua-layer-list") as HonuaLayerListElement;
    document.body.append(element);
    element.layers = [{ id: "roads", title: "Roads", visible: true }];

    const root = shadow(element);
    expect(root.textContent).toContain("Roads");
    const events: HonuaLayerVisibilityChangeDetail[] = [];
    element.addEventListener("honua-layer-visibility-change", (event) => {
      events.push((event as CustomEvent<HonuaLayerVisibilityChangeDetail>).detail);
    });
    const checkbox = root.querySelector<HTMLInputElement>("input[data-layer-id='roads']");
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change"));
    expect(events).toEqual([{ layerId: "roads", visible: false }]);
  });
});
