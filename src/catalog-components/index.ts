import { HonuaCatalogCardElement, HonuaCatalogSearchElement } from "./elements.js";
import { HonuaAppsUsingElement, HonuaServiceEndpointsElement } from "./relations.js";

export { HonuaCatalogCardElement, HonuaCatalogSearchElement, HonuaServiceEndpointsElement, HonuaAppsUsingElement };
export type {
  CatalogAppsUsingProjection,
  CatalogEndpointProjection,
  CatalogRelationQuery,
  CatalogCardProjection,
  CatalogComponentClient,
  CatalogSearchProjection,
  CatalogSearchQuery,
  CatalogStructuredData,
} from "./presentation.js";

const components: Readonly<Record<string, CustomElementConstructor>> = {
  "honua-catalog-search": HonuaCatalogSearchElement,
  "honua-service-endpoints": HonuaServiceEndpointsElement,
  "honua-apps-using": HonuaAppsUsingElement,
  "honua-dataset-card": class extends HonuaCatalogCardElement {},
  "honua-layer-card": class extends HonuaCatalogCardElement {},
  "honua-service-card": class extends HonuaCatalogCardElement {},
  "honua-map-card": class extends HonuaCatalogCardElement {},
  "honua-app-card": class extends HonuaCatalogCardElement {},
};

/** Registers the experimental fixture slice only when explicitly enabled. */
export function defineCatalogComponents(
  options: {
    readonly enabled?: boolean;
    readonly registry?: Pick<CustomElementRegistry, "get" | "define">;
  } = {},
): void {
  if (options.enabled !== true) return;
  const registry = options.registry ?? globalThis.customElements;
  if (!registry) return;
  for (const [tag, elementClass] of Object.entries(components)) {
    const registered = registry.get(tag);
    if (registered && registered !== elementClass) throw new Error(`Conflicting catalog element: ${tag}`);
    if (!registered) registry.define(tag, elementClass);
  }
}
