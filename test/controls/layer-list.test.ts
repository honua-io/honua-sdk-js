import { afterEach, describe, expect, test, vi } from "vitest";

import { defineHonuaControls } from "../../src/controls/basemap-switcher.js";
import { HonuaLayerListElement, defineHonuaLayerList } from "../../src/controls/layer-list.js";
import type { HonuaLayerListChangeDetail, HonuaLayerListOverlay } from "../../src/controls/types.js";

interface MockLayer {
  layout?: Record<string, unknown>;
}

interface MockMap {
  layers: Record<string, MockLayer>;
  calls: Array<[string, string, unknown]>;
  getLayer(id: string): unknown;
  getLayoutProperty(layerId: string, name: string): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): void;
  on(type: string, listener: () => void): void;
  off(type: string, listener: () => void): void;
  emit(type: string): void;
  listenerCount(type: string): number;
}

/**
 * Duck-typed MapLibre map stub following the mock pattern of the other
 * controls tests, with layout bookkeeping and a tiny `styledata` emitter.
 */
function makeMockMap(layers: Record<string, MockLayer>): MockMap {
  const listeners = new Map<string, Set<() => void>>();
  return {
    layers,
    calls: [],
    getLayer(id) {
      return layers[id];
    },
    getLayoutProperty(layerId, name) {
      return layers[layerId]?.layout?.[name];
    },
    setLayoutProperty(layerId, name, value) {
      this.calls.push([layerId, name, value]);
      const layer = layers[layerId];
      if (!layer) throw new Error(`Layer "${layerId}" does not exist.`);
      layer.layout = { ...layer.layout, [name]: value };
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function makeOverlays(): HonuaLayerListOverlay[] {
  return [
    { id: "parcels", label: "Parcels", layers: ["parcels-fill", "parcels-outline"], attribution: "County GIS" },
    { id: "incidents", label: "Incidents", layers: ["incident-points"] },
  ];
}

function makeElement(): {
  element: HonuaLayerListElement;
  attributes: Map<string, string>;
  shadow: {
    innerHTML: string;
    querySelector: typeof document.querySelector;
    querySelectorAll: typeof document.querySelectorAll;
  };
  events: CustomEvent<HonuaLayerListChangeDetail>[];
} {
  const element = new HonuaLayerListElement();
  const attributes = new Map<string, string>();
  // A tiny DOM-ish shadow root: parse rows out of innerHTML lazily so the
  // element can re-sync individual checkboxes via querySelector.
  const inputs = new Map<string, { checked: boolean }>();
  const shadow = {
    innerHTML: "",
    querySelector(selector: string): unknown {
      const match = /data-overlay-id="([^"]+)"/.exec(selector);
      if (!match) return null;
      const id = match[1];
      let input = inputs.get(id);
      if (!input) {
        input = { checked: false };
        inputs.set(id, input);
      }
      return input;
    },
    querySelectorAll(): unknown[] {
      return [];
    },
  } as unknown as {
    innerHTML: string;
    querySelector: typeof document.querySelector;
    querySelectorAll: typeof document.querySelectorAll;
  };
  const events: CustomEvent<HonuaLayerListChangeDetail>[] = [];
  Object.assign(element, {
    shadowRoot: shadow,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    hasAttribute: (name: string) => attributes.has(name),
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
    dispatchEvent: (event: Event) => {
      events.push(event as CustomEvent<HonuaLayerListChangeDetail>);
      return true;
    },
  });
  return { element, attributes, shadow, events };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HonuaLayerListElement", () => {
  test("is opt-in via defineHonuaLayerList and not auto-registered by defineHonuaControls", () => {
    const defined: Record<string, CustomElementConstructor> = {};
    const registry = {
      get: (name: string) => defined[name],
      define: (name: string, ctor: CustomElementConstructor) => {
        defined[name] = ctor;
      },
    } as unknown as CustomElementRegistry;
    // The blanket controls registration must NOT claim honua-layer-list — the
    // tag is shared with the controller-driven web-components element.
    defineHonuaControls(registry);
    expect(defined["honua-layer-list"]).toBeUndefined();
    // Explicit opt-in registers it.
    defineHonuaLayerList(registry);
    expect(defined["honua-layer-list"]).toBe(HonuaLayerListElement);
    // Idempotent: re-defining must not throw.
    defineHonuaLayerList(registry);
  });

  test("renders a checkbox row per overlay with accessible label/checkbox parts", () => {
    const { element, shadow } = makeElement();
    element.connect(
      makeMockMap({
        "parcels-fill": {},
        "parcels-outline": {},
        "incident-points": {},
      }),
    );
    element.overlays = makeOverlays();

    expect(shadow.innerHTML).toContain('part="root"');
    expect(shadow.innerHTML).toContain('part="row"');
    expect(shadow.innerHTML).toContain('part="checkbox"');
    expect(shadow.innerHTML).toContain('part="label"');
    expect(shadow.innerHTML).toContain('type="checkbox"');
    expect(shadow.innerHTML).toContain("Parcels");
    expect(shadow.innerHTML).toContain("Incidents");
    expect(shadow.innerHTML).toContain('data-overlay-id="parcels"');
    // Visible (no visibility:none) overlays render checked.
    expect(shadow.innerHTML).toContain("checked");
    // Attribution is rendered as a hint.
    expect(shadow.innerHTML).toContain("County GIS");
  });

  test("emits forced-colors and prefers-contrast state styles", () => {
    const { element, shadow } = makeElement();
    element.connect(makeMockMap({ "parcels-fill": {}, "incident-points": {} }));
    element.overlays = makeOverlays();

    expect(shadow.innerHTML).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(shadow.innerHTML).toContain(".row:has(.checkbox:checked) { outline: 2px solid CanvasText");
    expect(shadow.innerHTML).toContain(".row[data-not-seeded] { color: GrayText");
  });

  test("setVisible writes visibility on every overlay layer and emits change", () => {
    const { element, events } = makeElement();
    const map = makeMockMap({ "parcels-fill": {}, "parcels-outline": {}, "incident-points": {} });
    element.connect(map);
    element.overlays = makeOverlays();

    expect(element.setVisible("parcels", false)).toBe(true);
    expect(map.calls).toEqual([
      ["parcels-fill", "visibility", "none"],
      ["parcels-outline", "visibility", "none"],
    ]);
    expect(map.layers["parcels-fill"].layout?.visibility).toBe("none");
    expect(map.layers["parcels-outline"].layout?.visibility).toBe("none");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("change");
    expect(events[0]?.bubbles).toBe(true);
    expect(events[0]?.composed).toBe(true);
    expect(events[0]?.detail).toEqual({ id: "parcels", visible: false });

    // Toggling back to visible.
    element.setVisible("parcels", true);
    expect(map.layers["parcels-fill"].layout?.visibility).toBe("visible");
    expect(events[1]?.detail).toEqual({ id: "parcels", visible: true });
  });

  test("auto-refresh subscribes to styledata and re-syncs checked state from the map", () => {
    const { element, attributes, shadow } = makeElement();
    attributes.set("auto-refresh", "");
    const map = makeMockMap({ "parcels-fill": {}, "parcels-outline": {}, "incident-points": {} });
    element.connect(map);
    element.overlays = makeOverlays();
    element.connectedCallback();
    expect(map.listenerCount("styledata")).toBe(1);

    // Initially the parcels row renders checked (visible).
    expect(shadow.innerHTML).toMatch(/data-overlay-id="parcels"[\s\S]*?checked/);

    // External edit hides the parcels layers, then styledata fires.
    map.layers["parcels-fill"].layout = { visibility: "none" };
    map.layers["parcels-outline"].layout = { visibility: "none" };
    map.emit("styledata");

    // After re-render the parcels checkbox is unchecked, incidents stays checked.
    const rows = [...shadow.innerHTML.matchAll(/<label part="row"[\s\S]*?<\/label>/g)].map((m) => m[0]);
    const parcelsRow = rows.find((row) => row.includes('data-overlay-id="parcels"')) ?? "";
    const incidentsRow = rows.find((row) => row.includes('data-overlay-id="incidents"')) ?? "";
    expect(parcelsRow).not.toContain("checked");
    expect(incidentsRow).toContain("checked");

    // Re-assigning the map moves the subscription; disconnect unsubscribes.
    const nextMap = makeMockMap({ "parcels-fill": {} });
    element.map = nextMap;
    expect(map.listenerCount("styledata")).toBe(0);
    expect(nextMap.listenerCount("styledata")).toBe(1);
    element.disconnectedCallback();
    expect(nextMap.listenerCount("styledata")).toBe(0);
  });

  test("an overlay whose style layers are all missing renders disabled with a not-seeded badge", () => {
    const { element, shadow } = makeElement();
    // Only the incident layer exists; parcels layers are absent.
    element.connect(makeMockMap({ "incident-points": {} }));
    element.overlays = makeOverlays();

    const rows = [...shadow.innerHTML.matchAll(/<label part="row"[\s\S]*?<\/label>/g)].map((m) => m[0]);
    const parcelsRow = rows.find((row) => row.includes('data-overlay-id="parcels"')) ?? "";
    expect(parcelsRow).toContain("disabled");
    expect(parcelsRow).toContain('part="badge"');
    expect(parcelsRow).toContain('<slot name="not-seeded"');
    expect(parcelsRow).toContain("data-not-seeded");
    expect(parcelsRow).not.toContain("checked");

    // The seeded incidents overlay is not disabled and carries no badge.
    const incidentsRow = rows.find((row) => row.includes('data-overlay-id="incidents"')) ?? "";
    expect(incidentsRow).not.toContain("disabled");
    expect(incidentsRow).not.toContain('part="badge"');

    // setVisible on an unseeded overlay is a no-op (no layers to write).
    expect(element.setVisible("parcels", false)).toBe(false);
  });

  test("accepts overlays as a JSON attribute (matching the switcher's JSON intake)", () => {
    const { element, shadow } = makeElement();
    element.connect(makeMockMap({ "parcels-fill": {}, "incident-points": {} }));
    const json = JSON.stringify([
      { id: "parcels", label: "Parcels", layers: ["parcels-fill"] },
      { id: "bogus" }, // missing label/layers: dropped
      { id: "incidents", label: "Incidents", layers: ["incident-points"], attribution: "Ops" },
    ]);
    element.attributeChangedCallback("overlays", null, json);

    expect(element.overlays.map((overlay) => overlay.id)).toEqual(["parcels", "incidents"]);
    expect(element.overlays[1]?.attribution).toBe("Ops");
    expect(shadow.innerHTML).toContain("Parcels");
    expect(shadow.innerHTML).toContain("Incidents");
    expect(shadow.innerHTML).not.toContain("bogus");
  });

  test("rendering without a shadow root is a safe no-op", () => {
    const element = new HonuaLayerListElement();
    Object.assign(element, { getAttribute: () => null });
    element.overlays = makeOverlays();
    expect(() => element.refresh()).not.toThrow();
    expect(element.overlays).toHaveLength(2);
  });
});

// Type-level check: change detail shape is exported and stable.
const _detail: HonuaLayerListChangeDetail = { id: "parcels", visible: true };
void _detail;
