import { afterEach, describe, expect, test, vi } from "vitest";

import { defineHonuaControls } from "../../src/controls/basemap-switcher.js";
import { HONUA_COMPONENT_CATALOG, getComponentCatalogEntriesForTag } from "../../src/controls/catalog.js";
import {
  HonuaComponentCatalogError,
  createComponentRegistry,
  registerAllComponents,
  registerComponent,
  registerComponents,
} from "../../src/controls/registry.js";
import {
  HonuaLayerListElement,
  HonuaLegendElement,
  defineHonuaWebComponents,
} from "../../src/web-components/elements.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRegistry(): { get: (name: string) => CustomElementConstructor | undefined } & CustomElementRegistry {
  const defined = new Map<string, CustomElementConstructor>();
  return {
    get: (name: string) => defined.get(name),
    define: (name: string, ctor: CustomElementConstructor) => {
      if (defined.has(name)) return;
      defined.set(name, ctor);
    },
  } as unknown as { get: (name: string) => CustomElementConstructor | undefined } & CustomElementRegistry;
}

/**
 * Regresses the exact scenario issue #679 reports: both kits' blanket
 * auto-registration entry points, called in either order against a shared
 * registry, must land on the same tag → constructor assignment every time —
 * "importing any supported combination of component entrypoints cannot
 * register two constructors for one tag."
 */
describe("defineHonuaControls + defineHonuaWebComponents: import-order independence", () => {
  test("controls first, then web-components", () => {
    const registry = makeRegistry();
    defineHonuaControls(registry);
    defineHonuaWebComponents(registry);
    // Both kits name their `honua-legend` / `honua-layer-list` classes
    // identically, so assert by reference against the web-components
    // (canonical) exports rather than by `.name`.
    expect(registry.get("honua-legend")).toBe(HonuaLegendElement);
    expect(registry.get("honua-layer-list")).toBe(HonuaLayerListElement);
    const canonicalLegend = getComponentCatalogEntriesForTag("honua-legend").find((entry) => entry.canonical);
    expect(canonicalLegend?.source).toBe("web-components");
  });

  test("web-components first, then controls — same outcome as the reverse order", () => {
    const registryA = makeRegistry();
    defineHonuaControls(registryA);
    defineHonuaWebComponents(registryA);

    const registryB = makeRegistry();
    defineHonuaWebComponents(registryB);
    defineHonuaControls(registryB);

    const tags = new Set(HONUA_COMPONENT_CATALOG.map((entry) => entry.tag));
    for (const tag of tags) {
      // Only tags both entry points can reach (i.e. not the opt-in-only
      // controls.legend / controls.layer-list, which neither blanket call
      // claims) are expected to resolve identically here.
      const aCtor = registryA.get(tag);
      const bCtor = registryB.get(tag);
      expect(aCtor?.name).toBe(bCtor?.name);
    }
  });
});

/**
 * Registry contract tests (issue #679, REQ-002/REQ-003/NFR-001): the
 * catalog-driven register-all/subset/individual APIs must never let two
 * constructors claim one tag, must be idempotent, and must work against an
 * isolated (non-global) registry — the "cannot register two constructors for
 * one tag" / "scoped custom-element registries" acceptance criteria.
 */
describe("createComponentRegistry", () => {
  test("returns an isolated registry independent of the global one", () => {
    const registry = createComponentRegistry();
    expect(registry.get("honua-basemap-switcher")).toBeUndefined();
    expect(typeof registry.define).toBe("function");
    expect(typeof registry.get).toBe("function");
  });

  test("define-if-missing: a second define for the same tag is a no-op, not a throw", () => {
    const registry = createComponentRegistry();
    class A {}
    class B {}
    registry.define("honua-test-tag", A as unknown as CustomElementConstructor);
    expect(() => registry.define("honua-test-tag", B as unknown as CustomElementConstructor)).not.toThrow();
    expect(registry.get("honua-test-tag")).toBe(A);
  });
});

describe("registerAllComponents", () => {
  test("registers exactly one constructor per distinct tag, with no duplicates", async () => {
    const registry = createComponentRegistry();
    await registerAllComponents({ registry });
    const tags = new Set(HONUA_COMPONENT_CATALOG.map((entry) => entry.tag));
    for (const tag of tags) {
      expect(registry.get(tag), `expected "${tag}" to be registered`).toBeDefined();
    }
  });

  test("only claims each contested tag's canonical (web-components) implementation", async () => {
    const registry = createComponentRegistry();
    await registerAllComponents({ registry });
    const { HonuaLayerListElement: WcLayerList, HonuaLegendElement: WcLegend } = await import(
      "../../src/web-components/elements.js"
    );
    const { HonuaLayerListElement: ControlsLayerList, HonuaLegendElement: ControlsLegend } = await import(
      "../../src/controls/index.js"
    );
    // Both kits happen to name their classes identically, so disambiguate by
    // reference rather than by `.name`.
    expect(registry.get("honua-legend")).toBe(WcLegend);
    expect(registry.get("honua-legend")).not.toBe(ControlsLegend);
    expect(registry.get("honua-layer-list")).toBe(WcLayerList);
    expect(registry.get("honua-layer-list")).not.toBe(ControlsLayerList);
  });

  test("is idempotent: calling it twice against the same registry does not throw or change ownership", async () => {
    const registry = createComponentRegistry();
    await registerAllComponents({ registry });
    const before = new Map(
      [...new Set(HONUA_COMPONENT_CATALOG.map((entry) => entry.tag))].map((tag) => [tag, registry.get(tag)]),
    );
    await expect(registerAllComponents({ registry })).resolves.toBeUndefined();
    for (const [tag, ctor] of before) {
      expect(registry.get(tag)).toBe(ctor);
    }
  });

  test("no-ops without throwing when no registry is available", async () => {
    await expect(registerAllComponents({ registry: undefined })).resolves.toBeUndefined();
  });
});

describe("registerComponent / registerComponents", () => {
  test("registers a single controls-sourced id without touching other tags", async () => {
    const registry = createComponentRegistry();
    await registerComponent("controls.basemap-switcher", { registry });
    expect(registry.get("honua-basemap-switcher")).toBeDefined();
    expect(registry.get("honua-swipe-control")).toBeUndefined();
  });

  test("registers a single web-components-sourced id via the lazy import path without touching other tags", async () => {
    const registry = createComponentRegistry();
    await registerComponent("web-components.chart", { registry });
    expect(registry.get("honua-chart")).toBeDefined();
    // Every other tag the web-components kit owns — the lazy `elements.js`
    // import must not have run the kit's blanket auto-registration as a side
    // effect of registering just this one (issue #679 PR review: `elements.js`
    // must stay side-effect-free on import so this stays true).
    const otherTags = [...new Set(HONUA_COMPONENT_CATALOG.map((entry) => entry.tag))].filter(
      (tag) => tag !== "honua-chart",
    );
    for (const tag of otherTags) {
      expect(registry.get(tag), `expected "${tag}" to remain unregistered`).toBeUndefined();
    }
  });

  test("registering a single web-components id does not claim either contested tag", async () => {
    const registry = createComponentRegistry();
    await registerComponent("web-components.feature-table", { registry });
    expect(registry.get("honua-legend")).toBeUndefined();
    expect(registry.get("honua-layer-list")).toBeUndefined();
  });

  test("importing the web-components element module directly registers nothing (side-effect-free)", async () => {
    const elements = await import("../../src/web-components/elements.js");
    const registry = createComponentRegistry();
    // Merely importing the module (already happened, above, and by every
    // other test file in this process) must never have populated the global
    // registry or any fresh isolated registry on its own; only calling
    // `defineHonuaWebComponents` / `defineHonuaWebComponent` does.
    for (const tag of new Set(
      HONUA_COMPONENT_CATALOG.filter((entry) => entry.source === "web-components").map((entry) => entry.tag),
    )) {
      expect(registry.get(tag)).toBeUndefined();
    }
    expect(typeof elements.defineHonuaWebComponents).toBe("function");
    expect(typeof elements.defineHonuaWebComponent).toBe("function");
  });

  test("registers the non-canonical (opt-in) controls implementation of a contested tag when named explicitly", async () => {
    const registry = createComponentRegistry();
    await registerComponent("controls.legend", { registry });
    const entry = getComponentCatalogEntriesForTag("honua-legend").find(
      (candidate) => candidate.id === "controls.legend",
    );
    expect(registry.get("honua-legend")?.name).toBe(entry?.className);
  });

  test("registerComponents registers a named subset and nothing else", async () => {
    const registry = createComponentRegistry();
    await registerComponents(["controls.basemap-switcher", "web-components.search"], { registry });
    expect(registry.get("honua-basemap-switcher")).toBeDefined();
    expect(registry.get("honua-search")).toBeDefined();
    expect(registry.get("honua-swipe-control")).toBeUndefined();
    expect(registry.get("honua-map")).toBeUndefined();
  });

  test("rejects an unknown catalog id", async () => {
    const registry = createComponentRegistry();
    await expect(registerComponent("not-a-real-id", { registry })).rejects.toBeInstanceOf(HonuaComponentCatalogError);
  });

  test("first explicit registrant of a contested tag wins; a later explicit call for the same tag is a deterministic no-op", async () => {
    const registry = createComponentRegistry();
    await registerComponent("controls.legend", { registry });
    const claimedBy = registry.get("honua-legend");
    await registerComponent("web-components.legend", { registry });
    expect(registry.get("honua-legend")).toBe(claimedBy);
  });
});
