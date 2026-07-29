import { afterEach, describe, expect, test, vi } from "vitest";

import { defineHonuaControls } from "../../src/controls/basemap-switcher.js";
import { HonuaLegendDeriveError, deriveLegendEntries } from "../../src/controls/legend-derive.js";
import { HonuaLegendElement, defineHonuaLegend } from "../../src/controls/legend.js";
import type { HonuaLegendEntry, HonuaLegendSection } from "../../src/controls/types.js";

interface MockLayerSpec {
  type: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
}

interface MockMap {
  layers: Record<string, MockLayerSpec>;
  getLayer(id: string): unknown;
  getPaintProperty(layerId: string, name: string): unknown;
  getLayoutProperty(layerId: string, name: string): unknown;
  on(type: string, listener: () => void): void;
  off(type: string, listener: () => void): void;
  emit(type: string): void;
  listenerCount(type: string): number;
}

/**
 * Duck-typed MapLibre map stub following the mock pattern of
 * test/controls/basemap-switcher.test.ts, with paint/layout lookups and a
 * tiny event emitter for `styledata`.
 */
function makeMockMap(layers: Record<string, MockLayerSpec>): MockMap {
  const listeners = new Map<string, Set<() => void>>();
  return {
    layers,
    getLayer(id) {
      return layers[id];
    },
    getPaintProperty(layerId, name) {
      return layers[layerId]?.paint?.[name];
    },
    getLayoutProperty(layerId, name) {
      return layers[layerId]?.layout?.[name];
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

/** The demo's categorical zoning paint: match on a string district attribute. */
function zoningMatchExpression(): unknown[] {
  return [
    "match",
    ["get", "district"],
    "Residential",
    "#facc15",
    "Agricultural",
    "#84cc16",
    "Business",
    "#ef4444",
    "#cbd5e1",
  ];
}

function makeZoningMap(paintOverrides: Record<string, unknown> = {}): MockMap {
  return makeMockMap({
    "zoning-districts": {
      type: "fill",
      paint: { "fill-color": zoningMatchExpression(), "fill-outline-color": "#475569", ...paintOverrides },
    },
  });
}

function makeElement(): {
  element: HonuaLegendElement;
  attributes: Map<string, string>;
  shadow: { innerHTML: string };
} {
  const element = new HonuaLegendElement();
  const attributes = new Map<string, string>();
  const shadow = { innerHTML: "" };
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
  });
  return { element, attributes, shadow };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveLegendEntries", () => {
  test("parses a match expression on a string attribute, including the fallback color", () => {
    const entries = deriveLegendEntries(makeZoningMap(), "zoning-districts");
    expect(entries).toEqual([
      { label: "Residential", color: { fill: "#facc15", outline: "#475569" }, shape: "fill" },
      { label: "Agricultural", color: { fill: "#84cc16", outline: "#475569" }, shape: "fill" },
      { label: "Business", color: { fill: "#ef4444", outline: "#475569" }, shape: "fill" },
      { label: "Other", color: { fill: "#cbd5e1", outline: "#475569" }, shape: "fill" },
    ]);
  });

  test("labels array branch inputs with the values joined by a comma", () => {
    const map = makeMockMap({
      zones: {
        type: "fill",
        paint: {
          "fill-color": ["match", ["get", "code"], ["R-3.5", "R-5", "R-7.5"], "#facc15", 7, "#84cc16", "#cbd5e1"],
        },
      },
    });
    const entries = deriveLegendEntries(map, "zones");
    expect(entries.map((entry) => entry.label)).toEqual(["R-3.5, R-5, R-7.5", "7", "Other"]);
    // No literal fill-outline-color: plain string colors, no outline.
    expect(entries[0]?.color).toBe("#facc15");
  });

  test("line and circle layers derive their shape from the layer type", () => {
    const map = makeMockMap({
      routes: { type: "line", paint: { "line-color": ["match", ["get", "kind"], "primary", "#1d4ed8", "#94a3b8"] } },
      stops: { type: "circle", paint: { "circle-color": "#dc2626" } },
    });
    expect(deriveLegendEntries(map, "routes").map((entry) => entry.shape)).toEqual(["line", "line"]);
    // A literal color yields a single entry labeled with the layer id.
    expect(deriveLegendEntries(map, "stops")).toEqual([{ label: "stops", color: "#dc2626", shape: "circle" }]);
  });

  test("parses simple-equality case expressions", () => {
    const map = makeMockMap({
      zones: {
        type: "fill",
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "district"], "Hotel"],
            "#fb923c",
            ["==", ["get", "district"], "Industrial"],
            "#a855f7",
            "#cbd5e1",
          ],
        },
      },
    });
    expect(deriveLegendEntries(map, "zones").map((entry) => entry.label)).toEqual(["Hotel", "Industrial", "Other"]);
  });

  test("parses step expressions on a feature attribute into range labels", () => {
    const map = makeMockMap({
      parcels: {
        type: "fill",
        paint: { "fill-color": ["step", ["get", "units"], "#dbeafe", 10, "#60a5fa", 50, "#1d4ed8"] },
      },
    });
    const entries = deriveLegendEntries(map, "parcels");
    expect(entries.map((entry) => entry.label)).toEqual(["< 10", "10–50", "≥ 50"]);
    expect(entries.map((entry) => entry.color)).toEqual(["#dbeafe", "#60a5fa", "#1d4ed8"]);
  });

  test("falls back to the layer's paint object when the map has no getPaintProperty", () => {
    const layer = { type: "fill", paint: { "fill-color": zoningMatchExpression() } };
    const entries = deriveLegendEntries({ getLayer: () => layer }, "zoning-districts");
    expect(entries).toHaveLength(4);
    expect(entries[0]?.label).toBe("Residential");
  });

  test("rejects non-literal expression outputs gracefully", () => {
    const nested = makeZoningMap({
      "fill-color": ["match", ["get", "district"], "Residential", ["rgba", 250, 204, 21, 1], "#cbd5e1"],
    });
    expect(() => deriveLegendEntries(nested, "zoning-districts")).toThrowError(HonuaLegendDeriveError);
    expect(() => deriveLegendEntries(nested, "zoning-districts")).toThrowError(/literal color strings/);

    const numeric = makeZoningMap({ "fill-color": ["match", ["get", "district"], "Residential", 7, "#cbd5e1"] });
    expect(() => deriveLegendEntries(numeric, "zoning-districts")).toThrowError(HonuaLegendDeriveError);

    try {
      deriveLegendEntries(nested, "zoning-districts");
      expect.unreachable();
    } catch (error) {
      expect((error as HonuaLegendDeriveError).code).toBe("unsupported-expression");
    }
  });

  test("rejects unsupported expression shapes with clear messages", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      // match input must be ["get", <attr>], not e.g. feature-state or zoom.
      [{ "fill-color": ["match", ["feature-state", "hover"], true, "#fff", "#000"] }, /\["get", <attribute>\]/],
      // interpolate is not categorical.
      [{ "fill-color": ["interpolate", ["linear"], ["zoom"], 0, "#fff", 10, "#000"] }, /unsupported color expression/],
      // case conditions beyond simple equality.
      [{ "fill-color": ["case", [">", ["get", "units"], 10], "#fff", "#000"] }, /simple equalities/],
      // step driven by zoom.
      [{ "fill-color": ["step", ["zoom"], "#fff", 10, "#000"] }, /\["get", <attribute>\]/],
      // match without a fallback.
      [{ "fill-color": ["match", ["get", "district"], "Residential", "#facc15"] }, /fallback/],
    ];
    for (const [paint, message] of cases) {
      const map = makeZoningMap(paint);
      expect(() => deriveLegendEntries(map, "zoning-districts")).toThrowError(HonuaLegendDeriveError);
      expect(() => deriveLegendEntries(map, "zoning-districts")).toThrowError(message);
    }
  });

  test("rejects missing layers, unsupported layer types, and missing paint", () => {
    const map = makeMockMap({
      labels: { type: "symbol", paint: {} },
      bare: { type: "fill" },
    });
    try {
      deriveLegendEntries(map, "nope");
      expect.unreachable();
    } catch (error) {
      expect((error as HonuaLegendDeriveError).code).toBe("layer-not-found");
    }
    try {
      deriveLegendEntries(map, "labels");
      expect.unreachable();
    } catch (error) {
      expect((error as HonuaLegendDeriveError).code).toBe("unsupported-layer-type");
    }
    try {
      deriveLegendEntries(map, "bare");
      expect.unreachable();
    } catch (error) {
      expect((error as HonuaLegendDeriveError).code).toBe("missing-paint");
    }
  });
});

describe("HonuaLegendElement", () => {
  test("is NOT auto-registered by the blanket defineHonuaControls (contested tag, issue #679)", () => {
    const defined: Record<string, CustomElementConstructor> = {};
    const registry = {
      get: (name: string) => defined[name],
      define: (name: string, ctor: CustomElementConstructor) => {
        defined[name] = ctor;
      },
    } as unknown as CustomElementRegistry;
    // honua-legend also has a canonical (default) implementation in the
    // web-components kit; the blanket controls registration must not claim
    // it, so the winner never depends on import order.
    defineHonuaControls(registry);
    expect(defined["honua-legend"]).toBeUndefined();
  });

  test("is registered via the opt-in defineHonuaLegend", () => {
    const defined: Record<string, CustomElementConstructor> = {};
    const registry = {
      get: (name: string) => defined[name],
      define: (name: string, ctor: CustomElementConstructor) => {
        defined[name] = ctor;
      },
    } as unknown as CustomElementRegistry;
    defineHonuaLegend(registry);
    expect(defined["honua-legend"]).toBe(HonuaLegendElement);
    // Idempotent: re-defining must not throw.
    defineHonuaLegend(registry);
    expect(defined["honua-legend"]).toBe(HonuaLegendElement);
  });

  test("a flat entries array renders as one untitled section with list semantics and aria-hidden swatches", () => {
    const { element, shadow } = makeElement();
    element.entries = [
      { label: "High priority", color: "#dc2626", shape: "circle" },
      { label: "Route", color: "#1d4ed8", shape: "line" },
    ];

    expect(element.entries).toEqual([
      {
        entries: [
          { label: "High priority", color: "#dc2626", shape: "circle" },
          { label: "Route", color: "#1d4ed8", shape: "line" },
        ],
      },
    ]);
    expect(shadow.innerHTML).toContain('part="root"');
    expect(shadow.innerHTML).toContain('part="section"');
    expect(shadow.innerHTML).toContain("<ul");
    expect(shadow.innerHTML).toContain('<li part="row"');
    expect(shadow.innerHTML).toContain('aria-hidden="true"');
    expect(shadow.innerHTML).toContain("swatch-circle");
    expect(shadow.innerHTML).toContain("swatch-line");
    expect(shadow.innerHTML).toContain("--legend-fill:#dc2626");
    expect(shadow.innerHTML).toContain("High priority");
  });

  test("sections keep their titles, invalid items are dropped, and labels are escaped", () => {
    const { element, attributes, shadow } = makeElement();
    attributes.set("heading", "Legend");
    element.entries = [
      { title: "Zoning", entries: [{ label: "<Residential & Co>", color: { fill: "#facc15", outline: "#475569" } }] },
      { label: "Loose entry", color: "#16a34a" },
      { bogus: true } as unknown as HonuaLegendEntry,
      { label: 7, color: "#fff" } as unknown as HonuaLegendEntry,
    ];

    expect(element.entries.map((section) => section.title)).toEqual(["Zoning", undefined]);
    expect(element.entries[1]?.entries).toHaveLength(1);
    expect(shadow.innerHTML).toContain('part="heading"');
    expect(shadow.innerHTML).toContain("Legend");
    expect(shadow.innerHTML).toContain('part="section-title"');
    expect(shadow.innerHTML).toContain("&lt;Residential &amp; Co&gt;");
    expect(shadow.innerHTML).toContain("--legend-outline:#475569");
    expect(shadow.innerHTML).not.toContain("<Residential");
  });

  test("emits forced-colors and prefers-contrast styles for distinct swatches and labels", () => {
    const { element, shadow } = makeElement();
    element.entries = [{ label: "Route", color: { fill: "#1d4ed8", outline: "#0f172a" }, shape: "line" }];

    expect(shadow.innerHTML).toContain("@media (forced-colors: active), (prefers-contrast: more)");
    expect(shadow.innerHTML).toContain(".row { color: CanvasText; }");
    expect(shadow.innerHTML).toContain("background: CanvasText;");
    expect(shadow.innerHTML).toContain("border: 1px solid CanvasText;");
    expect(shadow.innerHTML).toContain("forced-color-adjust: none;");
    expect(shadow.innerHTML).toContain(".swatch-line { background: CanvasText; border: none; }");
  });

  test("emits bounded, wrapping rows for narrow containers", () => {
    const { element, shadow } = makeElement();
    element.entries = [{ label: "A-very-long-unbroken-legend-label", color: "#1d4ed8" }];

    expect(shadow.innerHTML).toContain("min-width: 0;");
    expect(shadow.innerHTML).toContain("max-width: 100%;");
    expect(shadow.innerHTML).toContain("overflow-wrap: anywhere;");
    expect(shadow.innerHTML).not.toContain("overflow: hidden");
  });

  test("derive mode appends a section parsed from the layer's match expression", () => {
    const { element, attributes, shadow } = makeElement();
    attributes.set("layer", "zoning-districts");
    attributes.set("layer-title", "Zoning districts");
    element.entries = [{ title: "Incidents", entries: [{ label: "High priority", color: "#dc2626" }] }];
    element.connect(makeZoningMap());

    const sections = element.sections;
    expect(sections).toHaveLength(2);
    expect(sections[1]?.title).toBe("Zoning districts");
    expect(sections[1]?.layer).toBe("zoning-districts");
    expect(sections[1]?.entries.map((entry) => entry.label)).toEqual([
      "Residential",
      "Agricultural",
      "Business",
      "Other",
    ]);
    expect(element.deriveError).toBeUndefined();
    expect(shadow.innerHTML).toContain("Residential");
    expect(shadow.innerHTML).toContain('data-layer="zoning-districts"');
    // Explicit entries render before the derived section.
    expect(shadow.innerHTML.indexOf("High priority")).toBeLessThan(shadow.innerHTML.indexOf("Residential"));
  });

  test("renders a caller-supplied German fallback label in derive mode", () => {
    const { element, attributes, shadow } = makeElement();
    element.layer = "zoning-districts";
    element.fallbackLabel = "Sonstige";
    element.connect(makeZoningMap());

    expect(element.fallbackLabel).toBe("Sonstige");
    expect(attributes.get("fallback-label")).toBe("Sonstige");
    expect(element.sections[0]?.entries.map((entry) => entry.label)).toContain("Sonstige");
    expect(shadow.innerHTML).toContain("Sonstige");
    expect(shadow.innerHTML).not.toContain(">Other<");
  });

  test("derive failures degrade gracefully: explicit sections keep rendering and deriveError is exposed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { element, attributes, shadow } = makeElement();
    attributes.set("layer", "zoning-districts");
    element.entries = [{ label: "High priority", color: "#dc2626" }];
    const map = makeZoningMap({
      "fill-color": ["interpolate", ["linear"], ["get", "units"], 0, "#fff", 10, "#000"],
    });
    element.connect(map);

    expect(element.deriveError).toMatch(/unsupported color expression/);
    expect(element.sections).toHaveLength(1);
    expect(shadow.innerHTML).toContain("High priority");
    expect(warn).toHaveBeenCalledTimes(1);

    // Repeated refreshes with the same failure do not spam the console.
    element.refresh();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a missing layer is treated as transient: no console warning, derive retried on refresh", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { element, attributes } = makeElement();
    attributes.set("layer", "zoning-districts");
    const map = makeMockMap({});
    element.connect(map);

    expect(element.deriveError).toMatch(/does not exist/);
    expect(element.sections).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();

    map.layers["zoning-districts"] = { type: "fill", paint: { "fill-color": zoningMatchExpression() } };
    element.refresh();
    expect(element.deriveError).toBeUndefined();
    expect(element.sections[0]?.entries.map((entry) => entry.label)).toContain("Residential");
  });

  test("refresh() picks up paint expression changes so map and legend cannot drift", () => {
    const { element, attributes } = makeElement();
    attributes.set("layer", "zoning-districts");
    const map = makeZoningMap();
    element.connect(map);
    expect(element.sections[0]?.entries).toHaveLength(4);

    map.layers["zoning-districts"].paint = {
      "fill-color": ["match", ["get", "district"], "Hotel", "#fb923c", "#cbd5e1"],
    };
    element.refresh();
    expect(element.sections[0]?.entries.map((entry) => entry.label)).toEqual(["Hotel", "Other"]);
  });

  test("auto-refresh subscribes to styledata while connected and unsubscribes on disconnect", () => {
    const { element, attributes } = makeElement();
    attributes.set("layer", "zoning-districts");
    attributes.set("auto-refresh", "");
    const map = makeZoningMap();
    element.connect(map);
    expect(map.listenerCount("styledata")).toBe(0);

    element.connectedCallback();
    expect(map.listenerCount("styledata")).toBe(1);

    map.layers["zoning-districts"].paint = {
      "fill-color": ["match", ["get", "district"], "Hotel", "#fb923c", "#cbd5e1"],
    };
    map.emit("styledata");
    expect(element.sections[0]?.entries.map((entry) => entry.label)).toEqual(["Hotel", "Other"]);

    // Re-assigning the map moves the subscription.
    const nextMap = makeZoningMap();
    element.map = nextMap;
    expect(map.listenerCount("styledata")).toBe(0);
    expect(nextMap.listenerCount("styledata")).toBe(1);

    element.disconnectedCallback();
    expect(nextMap.listenerCount("styledata")).toBe(0);
  });

  test("without auto-refresh no styledata subscription is made", () => {
    const { element, attributes } = makeElement();
    attributes.set("layer", "zoning-districts");
    const map = makeZoningMap();
    element.connect(map);
    element.connectedCallback();
    expect(map.listenerCount("styledata")).toBe(0);
    element.disconnectedCallback();
  });

  test("follow-layer-visibility hides sections whose source layer is hidden", () => {
    const { element, attributes, shadow } = makeElement();
    attributes.set("layer", "zoning-districts");
    attributes.set("follow-layer-visibility", "");
    const map = makeZoningMap();
    element.entries = [
      { title: "Incidents", layer: "incident-points", entries: [{ label: "High", color: "#dc2626" }] },
    ];
    map.layers["incident-points"] = { type: "circle", paint: { "circle-color": "#dc2626" } };
    element.connect(map);

    // Both layers visible: no section carries the hidden attribute (the
    // leading space distinguishes it from the swatches' aria-hidden).
    expect(shadow.innerHTML).not.toContain(" hidden");

    map.layers["zoning-districts"].layout = { visibility: "none" };
    element.refresh();
    const sectionsHtml = shadow.innerHTML.split("<section");
    const zoning = sectionsHtml.find((chunk) => chunk.includes("zoning-districts"));
    const incidents = sectionsHtml.find((chunk) => chunk.includes("incident-points"));
    expect(zoning).toContain(" hidden");
    expect(incidents).not.toContain(" hidden");

    // Without the attribute the section renders normally again.
    attributes.delete("follow-layer-visibility");
    element.refresh();
    expect(shadow.innerHTML).not.toContain(" hidden");
  });

  test("attributeChangedCallback re-derives on layer changes and re-subscribes on auto-refresh changes", () => {
    const { element, attributes } = makeElement();
    const map = makeMockMap({
      a: { type: "fill", paint: { "fill-color": ["match", ["get", "kind"], "x", "#fff", "#000"] } },
      b: { type: "circle", paint: { "circle-color": "#dc2626" } },
    });
    element.connect(map);

    attributes.set("layer", "a");
    element.attributeChangedCallback("layer", null, "a");
    expect(element.sections[0]?.entries.map((entry) => entry.label)).toEqual(["x", "Other"]);

    attributes.set("layer", "b");
    element.attributeChangedCallback("layer", "a", "b");
    expect(element.sections[0]?.entries).toEqual([{ label: "b", color: "#dc2626", shape: "circle" }]);

    element.connectedCallback();
    expect(map.listenerCount("styledata")).toBe(0);
    attributes.set("auto-refresh", "");
    element.attributeChangedCallback("auto-refresh", null, "");
    expect(map.listenerCount("styledata")).toBe(1);
    attributes.delete("auto-refresh");
    element.attributeChangedCallback("auto-refresh", "", null);
    expect(map.listenerCount("styledata")).toBe(0);
    element.disconnectedCallback();
  });

  test("boolean and layer properties reflect to attributes", () => {
    const { element, attributes } = makeElement();
    element.followLayerVisibility = true;
    expect(attributes.has("follow-layer-visibility")).toBe(true);
    element.followLayerVisibility = false;
    expect(attributes.has("follow-layer-visibility")).toBe(false);

    element.autoRefresh = true;
    expect(element.autoRefresh).toBe(true);

    element.layer = "zoning-districts";
    expect(attributes.get("layer")).toBe("zoning-districts");
    expect(element.layer).toBe("zoning-districts");
    element.layer = undefined;
    expect(attributes.has("layer")).toBe(false);
  });

  test("rendering without a shadow root is a safe no-op", () => {
    const element = new HonuaLegendElement();
    Object.assign(element, {
      getAttribute: () => null,
    });
    element.entries = [{ label: "High", color: "#dc2626" }];
    expect(() => element.refresh()).not.toThrow();
    expect(element.sections).toHaveLength(1);
  });
});

// Type-level checks: sections accept both flat entries and titled groups.
const _sections: HonuaLegendSection[] = [
  { entries: [{ label: "a", color: "#fff" }] },
  { title: "t", layer: "l", entries: [{ label: "b", color: { fill: "#fff", outline: "#000" }, shape: "line" }] },
];
void _sections;
