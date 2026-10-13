import type { Map as MapLibreMap } from "maplibre-gl";

/** The explicitly named source mounted by this starter, never a basemap source. */
export const STARTER_SOURCE_ID = "honua-starter-data";

/** Observe rendered SDK data without changing the map, query, camera, or style. */
export function observeRenderedFeatures(map: MapLibreMap): () => void {
  const container = map.getContainer();
  const update = () => {
    if (!map.isStyleLoaded()) return;
    const layers = (map.getStyle().layers ?? [])
      .filter((layer) => "source" in layer && layer.source === STARTER_SOURCE_ID)
      .map((layer) => layer.id);
    const count = layers.length === 0 ? 0 : map.queryRenderedFeatures(undefined, { layers }).length;
    container.dataset["honuaRenderedFeatures"] = String(count);
  };
  container.dataset["honuaMapState"] = "mounted";
  container.dataset["honuaRenderedFeatures"] = "0";
  map.on("render", update);
  map.on("idle", update);
  update();
  return () => {
    map.off("render", update);
    map.off("idle", update);
    delete container.dataset["honuaMapState"];
    delete container.dataset["honuaRenderedFeatures"];
  };
}
