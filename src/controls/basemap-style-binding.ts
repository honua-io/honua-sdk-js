/**
 * Headless style binding behind `<honua-basemap-switcher>`.
 *
 * `HonuaBasemapStyleBinding` owns the MapLibre style mutations: it lazily
 * adds each base's sources and layers the first time the base is activated,
 * keeps base layers grouped beneath the host's overlay layers, and toggles
 * `visibility` so exactly one base renders at a time. Hosts that do not want
 * a custom element (React wrappers, imperative apps) can drive it directly.
 *
 * @module
 */

import type { HonuaBasemapDefinition, HonuaBasemapLayerSpecification, HonuaBasemapSwitcherMap } from "./types.js";

/**
 * Applies exclusive basemap selection to a MapLibre map.
 *
 * Strategy: sources and layers belonging to a base are added on first
 * activation (so inactive bases never fetch tiles) and toggled with
 * `setLayoutProperty(layerId, "visibility", ...)` afterwards. Layers are
 * inserted before the first style layer not owned by any registered base, so
 * bases always sit beneath the host application's overlay layers regardless
 * of activation order. Bases removed from the definitions list are pruned
 * from the map (layers and exclusively-owned sources are removed).
 */
export class HonuaBasemapStyleBinding {
  #map: HonuaBasemapSwitcherMap | undefined;
  #bases: readonly HonuaBasemapDefinition[] = [];
  #activeId: string | undefined;
  readonly #addedLayerIds = new Set<string>();
  readonly #addedSourceIds = new Set<string>();

  /** The bound map, if any. */
  public get map(): HonuaBasemapSwitcherMap | undefined {
    return this.#map;
  }

  /** The registered base definitions. */
  public get bases(): readonly HonuaBasemapDefinition[] {
    return this.#bases;
  }

  /** Id of the currently active base, if one has been applied. */
  public get activeId(): string | undefined {
    return this.#activeId;
  }

  /**
   * Binds (or unbinds, with `undefined`) the MapLibre map. Unbinding removes
   * every layer and source this binding added to the previous map. Binding a
   * map re-applies the current active base when one is set.
   */
  public setMap(map: HonuaBasemapSwitcherMap | undefined): void {
    if (this.#map === map) return;
    this.#removeAllOwned();
    this.#map = map;
    if (map && this.#activeId !== undefined) this.#apply(this.#activeId);
  }

  /**
   * Replaces the base definitions. Layers and sources added for bases that no
   * longer exist are removed from the map; the active base (when still
   * present) is re-applied so its style objects stay in sync.
   */
  public setBases(bases: readonly HonuaBasemapDefinition[]): void {
    this.#bases = bases;
    this.#pruneOwned();
    if (this.#activeId !== undefined && !this.#findBase(this.#activeId)) {
      this.#activeId = undefined;
      return;
    }
    if (this.#activeId !== undefined) this.#apply(this.#activeId);
  }

  /**
   * Activates the base with the given id: ensures its sources/layers exist on
   * the map, shows them, and hides every other base's layers. Returns `true`
   * when the id matches a registered base (even if the map is not bound yet —
   * the selection is re-applied as soon as a map arrives).
   */
  public activate(baseId: string): boolean {
    if (!this.#findBase(baseId)) return false;
    this.#activeId = baseId;
    this.#apply(baseId);
    return true;
  }

  /** Removes every layer and source this binding added and unbinds the map. */
  public detach(): void {
    this.#removeAllOwned();
    this.#map = undefined;
  }

  #findBase(baseId: string): HonuaBasemapDefinition | undefined {
    return this.#bases.find((base) => base.id === baseId);
  }

  #apply(activeId: string): void {
    const map = this.#map;
    const active = this.#findBase(activeId);
    if (!map || !active) return;

    for (const [sourceId, source] of Object.entries(active.sources)) {
      if (!this.#sourceExists(map, sourceId)) {
        map.addSource(sourceId, source);
        this.#addedSourceIds.add(sourceId);
      }
    }

    const activeLayerIds = new Set(active.layers.map((layer) => layer.id));
    for (const layer of active.layers) {
      if (this.#layerExists(map, layer.id)) {
        map.setLayoutProperty(layer.id, "visibility", "visible");
        continue;
      }
      map.addLayer(withVisibility(layer, "visible"), this.#anchorLayerId(map));
      this.#addedLayerIds.add(layer.id);
    }

    for (const base of this.#bases) {
      if (base.id === activeId) continue;
      for (const layer of base.layers) {
        if (activeLayerIds.has(layer.id)) continue;
        if (this.#layerExists(map, layer.id)) map.setLayoutProperty(layer.id, "visibility", "none");
      }
    }
  }

  /**
   * First style layer not owned by any registered base — base layers are
   * inserted before it so they render beneath the host's overlay layers.
   */
  #anchorLayerId(map: HonuaBasemapSwitcherMap): string | undefined {
    const owned = new Set<string>(this.#addedLayerIds);
    for (const base of this.#bases) {
      for (const layer of base.layers) owned.add(layer.id);
    }
    for (const layerId of styleLayerIds(map)) {
      if (!owned.has(layerId)) return layerId;
    }
    return undefined;
  }

  #pruneOwned(): void {
    const map = this.#map;
    const keepLayers = new Set<string>();
    const keepSources = new Set<string>();
    for (const base of this.#bases) {
      for (const layer of base.layers) keepLayers.add(layer.id);
      for (const sourceId of Object.keys(base.sources)) keepSources.add(sourceId);
    }
    for (const layerId of [...this.#addedLayerIds]) {
      if (keepLayers.has(layerId)) continue;
      this.#addedLayerIds.delete(layerId);
      if (map && this.#layerExists(map, layerId)) map.removeLayer?.(layerId);
    }
    for (const sourceId of [...this.#addedSourceIds]) {
      if (keepSources.has(sourceId)) continue;
      this.#addedSourceIds.delete(sourceId);
      if (map && this.#sourceExists(map, sourceId)) map.removeSource?.(sourceId);
    }
  }

  #removeAllOwned(): void {
    const map = this.#map;
    if (map) {
      for (const layerId of this.#addedLayerIds) {
        if (this.#layerExists(map, layerId)) map.removeLayer?.(layerId);
      }
      for (const sourceId of this.#addedSourceIds) {
        if (this.#sourceExists(map, sourceId)) map.removeSource?.(sourceId);
      }
    }
    this.#addedLayerIds.clear();
    this.#addedSourceIds.clear();
  }

  #layerExists(map: HonuaBasemapSwitcherMap, layerId: string): boolean {
    return typeof map.getLayer === "function" ? Boolean(map.getLayer(layerId)) : this.#addedLayerIds.has(layerId);
  }

  #sourceExists(map: HonuaBasemapSwitcherMap, sourceId: string): boolean {
    return typeof map.getSource === "function" ? Boolean(map.getSource(sourceId)) : this.#addedSourceIds.has(sourceId);
  }
}

function withVisibility(
  layer: HonuaBasemapLayerSpecification,
  visibility: "visible" | "none",
): Record<string, unknown> {
  const layout =
    typeof layer.layout === "object" && layer.layout !== null ? (layer.layout as Record<string, unknown>) : {};
  return { ...layer, layout: { ...layout, visibility } };
}

function styleLayerIds(map: HonuaBasemapSwitcherMap): readonly string[] {
  const style = typeof map.getStyle === "function" ? map.getStyle() : undefined;
  const layers =
    typeof style === "object" && style !== null && "layers" in style
      ? (style as { layers?: unknown }).layers
      : undefined;
  if (!Array.isArray(layers)) return [];
  return layers.flatMap((layer) => {
    const id = typeof layer === "object" && layer !== null ? (layer as { id?: unknown }).id : undefined;
    return typeof id === "string" ? [id] : [];
  });
}
