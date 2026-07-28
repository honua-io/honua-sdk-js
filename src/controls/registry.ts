/**
 * Catalog-driven registration APIs spanning both custom-element kits.
 * Controls are registered synchronously; web-components are loaded lazily so
 * controls-only consumers do not pull the core/runtime closure into bundles.
 */

import { defineHonuaBasemapSwitcher } from "./basemap-switcher.js";
import { HONUA_COMPONENT_CATALOG, type HonuaComponentCatalogEntry, getComponentCatalogEntry } from "./catalog.js";
import { globalDom } from "./element-utils.js";
import { defineHonuaLayerList } from "./layer-list.js";
import { defineHonuaLegend } from "./legend.js";
import { defineHonuaSwipeControl } from "./swipe-control.js";

export type HonuaComponentCatalogId = HonuaComponentCatalogEntry["id"];

export type HonuaComponentRegistry = Pick<CustomElementRegistry, "get" | "define">;

export interface HonuaComponentRegistrationOptions {
  readonly registry?: HonuaComponentRegistry;
}

export class HonuaComponentCatalogError extends Error {
  public constructor(id: string) {
    super(`Unknown Honua component catalog id "${id}".`);
    this.name = "HonuaComponentCatalogError";
  }
}

type ControlsRegistrar = (registry?: CustomElementRegistry) => void;

const CONTROLS_REGISTRARS: Readonly<Record<string, ControlsRegistrar>> = {
  "controls.basemap-switcher": defineHonuaBasemapSwitcher,
  "controls.swipe-control": defineHonuaSwipeControl,
  "controls.legend": defineHonuaLegend,
  "controls.layer-list": defineHonuaLayerList,
};

async function registerWebComponentsEntry(
  entry: HonuaComponentCatalogEntry,
  registry: HonuaComponentRegistry | undefined,
): Promise<void> {
  const webComponents = await import("../web-components/elements.js");
  webComponents.defineHonuaWebComponent(entry.tag, registry as CustomElementRegistry | undefined);
}

export async function registerComponent(
  id: HonuaComponentCatalogId,
  options: HonuaComponentRegistrationOptions = {},
): Promise<void> {
  const entry = getComponentCatalogEntry(id);
  if (!entry) throw new HonuaComponentCatalogError(id);
  const registry = options.registry ?? (globalDom.customElements as HonuaComponentRegistry | undefined);
  if (!registry) return;
  if (entry.source === "controls") {
    CONTROLS_REGISTRARS[entry.id]?.(registry as CustomElementRegistry);
    return;
  }
  await registerWebComponentsEntry(entry, registry);
}

export async function registerComponents(
  ids: readonly HonuaComponentCatalogId[],
  options: HonuaComponentRegistrationOptions = {},
): Promise<void> {
  for (const id of ids) await registerComponent(id, options);
}

export async function registerAllComponents(options: HonuaComponentRegistrationOptions = {}): Promise<void> {
  const canonicalIds = HONUA_COMPONENT_CATALOG.filter((entry) => entry.canonical).map((entry) => entry.id);
  await registerComponents(canonicalIds, options);
}

export function createComponentRegistry(): HonuaComponentRegistry {
  const registryCtor = (globalThis as { CustomElementRegistry?: new () => CustomElementRegistry })
    .CustomElementRegistry;
  if (typeof registryCtor === "function") {
    try {
      return new registryCtor();
    } catch {
      // Fall through to the portable in-memory registry.
    }
  }
  const defined = new Map<string, CustomElementConstructor>();
  return {
    get: (tagName: string) => defined.get(tagName),
    define: (tagName: string, ctor: CustomElementConstructor) => {
      if (!defined.has(tagName)) defined.set(tagName, ctor);
    },
  };
}
