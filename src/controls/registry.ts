/**
 * Catalog-driven registration APIs spanning both the `controls` and
 * `web-components` custom-element kits (issue #679; see `./catalog.js` for
 * the metadata these operate over).
 *
 * `controls`-sourced catalog entries are registered synchronously against
 * this module's local sibling files (`./basemap-switcher.js`, `./legend.js`,
 * `./layer-list.js`, `./swipe-control.js`) — none of them import `src/core`
 * or `src/runtime`, so statically importing them here costs nothing beyond
 * what `@honua/sdk-js/controls` already bundles.
 *
 * `web-components`-sourced entries are registered through a **dynamic**
 * `import("../web-components/elements.js")`, so merely importing this module
 * (or `@honua/sdk-js/controls`, which re-exports it) never pulls the
 * `web-components` kit's `src/core` / `src/runtime` dependency into a
 * `controls`-only bundle. That dependency is only paid the first time a
 * caller actually registers a `web-components`-sourced tag.
 *
 * Critically, `web-components/elements.js` is itself side-effect-free on
 * import — it defines the element classes, the tag→constructor lookup, and
 * `defineHonuaWebComponent(tag)` / `defineHonuaWebComponents()`, but does not
 * call either. (The blanket auto-registration existing
 * `@honua/sdk-js/web-components` consumers rely on lives in
 * `web-components/index.js`, which calls `defineHonuaWebComponents()`
 * explicitly.) Without that separation, this module's dynamic import would
 * evaluate `elements.js` and its auto-run would claim every tag the kit
 * owns — including contested tags — as a side effect of registering just
 * one, which a Rollup/Vite production build can also reorder *earlier* than
 * intended when the dynamic import target is merged into the same chunk as a
 * sibling static import of `@honua/sdk-js/web-components` (issue #679 PR
 * review; this combination was the root cause of a real ordering bug in the
 * `web-components-basic` sample before this module existed).
 *
 * Because both the synchronous and dynamic paths funnel through the exact
 * same catalog + `defineIfMissing`-style guards the two kits already use,
 * calling these functions is deterministic and idempotent regardless of how
 * many times, in what order, or from which subpath a caller invokes them —
 * the fix for the import-order-dependent tag ownership issue #679 tracks.
 *
 * @module
 */

import { defineHonuaBasemapSwitcher } from "./basemap-switcher.js";
import { HONUA_COMPONENT_CATALOG, type HonuaComponentCatalogEntry, getComponentCatalogEntry } from "./catalog.js";
import { globalDom } from "./element-utils.js";
import { defineHonuaLayerList } from "./layer-list.js";
import { defineHonuaLegend } from "./legend.js";
import { defineHonuaSwipeControl } from "./swipe-control.js";

/** The catalog id union; kept as `string` at the type level (see `./catalog.js`) but documented here for discoverability. */
export type HonuaComponentCatalogId = HonuaComponentCatalogEntry["id"];

/**
 * The minimal `CustomElementRegistry` surface every registration function in
 * this module (and both kits' existing `define*` functions) needs. A real
 * `CustomElementRegistry`, the object `createComponentRegistry()` returns, or
 * a hand-rolled `{ get, define }` test double all satisfy this.
 */
export type HonuaComponentRegistry = Pick<CustomElementRegistry, "get" | "define">;

export interface HonuaComponentRegistrationOptions {
  /** Registry to define tags on. Defaults to the global `customElements`. */
  readonly registry?: HonuaComponentRegistry;
}

/** Thrown by `registerComponent(s)` for an id that is not in `HONUA_COMPONENT_CATALOG`. */
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
  // `elements.js` is side-effect-free (see the module doc above); this only
  // ever defines `entry.tag`, never the other 15 tags the kit owns.
  const webComponents = await import("../web-components/elements.js");
  webComponents.defineHonuaWebComponent(entry.tag, registry as CustomElementRegistry | undefined);
}

/**
 * Registers a single catalog entry by id, e.g. `"web-components.map"` or
 * `"controls.basemap-switcher"`. Always returns a `Promise` — `controls`
 * entries resolve synchronously in practice, but a uniform async contract
 * keeps this one typed shape usable for both kits (including the lazy
 * `web-components` path) without callers branching on the id's source.
 *
 * Throws {@link HonuaComponentCatalogError} for an id not in the catalog.
 * No-ops (resolves immediately) when no registry is available (Node/SSR
 * without an explicit `registry` option) — matches every existing `define*`
 * function's DOM-optional contract (NFR-001).
 */
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

/** Registers a named subset of catalog entries. See {@link registerComponent}. */
export async function registerComponents(
  ids: readonly HonuaComponentCatalogId[],
  options: HonuaComponentRegistrationOptions = {},
): Promise<void> {
  for (const id of ids) {
    await registerComponent(id, options);
  }
}

/**
 * Registers every canonical catalog entry — i.e. everything
 * `@honua/sdk-js/controls` + `@honua/sdk-js/web-components` would
 * auto-register between them, from one call. Equivalent to importing both
 * kits, without needing to import either as a side effect (useful for
 * lazy-loading the whole component set, or for scoped-registry setups where
 * side-effect module import cannot target a specific registry).
 *
 * Non-canonical entries (the `controls` implementations of `honua-legend` /
 * `honua-layer-list`) are intentionally excluded — use
 * {@link registerComponent} / {@link registerComponents} to opt into them
 * explicitly.
 */
export async function registerAllComponents(options: HonuaComponentRegistrationOptions = {}): Promise<void> {
  const canonicalIds = HONUA_COMPONENT_CATALOG.filter((entry) => entry.canonical).map((entry) => entry.id);
  await registerComponents(canonicalIds, options);
}

/**
 * Creates a fresh, isolated component registry: a real `CustomElementRegistry`
 * where the runtime supports constructing one (the Scoped Custom Element
 * Registries proposal — not yet universal), otherwise an in-memory
 * `{ get, define }` object with the same define-once-per-tag idempotency as
 * every `define*` function in this kit.
 *
 * The fallback object satisfies {@link HonuaComponentRegistry} and every
 * kit's `define*(registry)` parameter, so it is usable anywhere a caller
 * wants an isolated registration target (tests, multiple independent
 * catalogs in one process) — but, unlike a real `CustomElementRegistry`, it
 * cannot be passed to `shadowRoot`-scoped APIs like `attachShadow` on
 * runtimes that lack native scoped-registry support.
 */
export function createComponentRegistry(): HonuaComponentRegistry {
  const registryCtor = (globalThis as { CustomElementRegistry?: new () => CustomElementRegistry })
    .CustomElementRegistry;
  if (typeof registryCtor === "function") {
    try {
      return new registryCtor();
    } catch {
      // Some runtimes expose the constructor without allowing construction
      // (e.g. spec-gated behind a flag); fall through to the in-memory registry.
    }
  }
  const defined = new Map<string, CustomElementConstructor>();
  return {
    get: (tagName: string) => defined.get(tagName),
    define: (tagName: string, ctor: CustomElementConstructor) => {
      if (defined.has(tagName)) return;
      defined.set(tagName, ctor);
    },
  };
}
