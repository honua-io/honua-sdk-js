/**
 * External-map interop for `@honua/react` (REQ-001 of the react depth pass).
 *
 * Every map-attached hook/component in this package resolves its MapLibre map
 * through {@link useHonuaMap}: an explicit prop/argument wins, then the nearest
 * {@link HonuaMapProvider} (or enclosing `HonuaMap`, which publishes the same
 * context). The map is duck-typed as the data-to-map bridge's
 * {@link DataToMapLibreMap} — any real `maplibre-gl` `Map` instance satisfies
 * it, including the instance exposed by `@vis.gl/react-maplibre`'s `useMap()`
 * (`mapRef.getMap()`). `@vis.gl/react-maplibre` is **not** a dependency; the
 * interop is purely structural.
 *
 * SSR-safe: no `window` / `document` access at module scope.
 *
 * @module
 */

import { type ReactNode, createContext, useContext } from "react";

import type { DataToMapLibreMap } from "../map/data-to-map-bridge.js";

/**
 * Context carrying the active, externally-visible MapLibre map instance.
 * Populated by {@link HonuaMapProvider} and by `HonuaMap` (for its own map),
 * so `useHonuaMap` always resolves the nearest enclosing map.
 *
 * @experimental
 */
export const HonuaExternalMapContext = createContext<DataToMapLibreMap | null>(null);
HonuaExternalMapContext.displayName = "HonuaExternalMapContext";

/** Props for {@link HonuaMapProvider}. @experimental */
export interface HonuaMapProviderProps {
  /**
   * The externally-owned MapLibre map (duck-typed). Pass `null`/`undefined`
   * while the map is still being created — descendants simply wait.
   */
  map: DataToMapLibreMap | null | undefined;
  children?: ReactNode;
}

/**
 * Publish an externally-owned MapLibre map to the Honua map-attached hooks and
 * components below it ({@link HonuaSourceLayer}, {@link useMountedSource},
 * selection bindings). Use this when another library owns the map — e.g.
 * `@vis.gl/react-maplibre`'s `<Map>` — and Honua should only mount data onto
 * it. The provider never mutates or removes the map.
 *
 * @example
 * ```tsx
 * function Overlay() {
 *   const { current } = useMap(); // @vis.gl/react-maplibre
 *   return (
 *     <HonuaMapProvider map={current?.getMap() ?? null}>
 *       <HonuaSourceLayer source={source} hover />
 *     </HonuaMapProvider>
 *   );
 * }
 * ```
 *
 * @experimental
 */
export function HonuaMapProvider({ map, children }: HonuaMapProviderProps): ReactNode {
  return <HonuaExternalMapContext.Provider value={map ?? null}>{children}</HonuaExternalMapContext.Provider>;
}

/**
 * Resolve the MapLibre map a map-attached hook/component should target: the
 * explicit `map` argument when given, otherwise the nearest enclosing
 * {@link HonuaMapProvider} or `HonuaMap`. Returns `null` while no map is
 * available (SSR, or before the map finished creating).
 *
 * @experimental
 */
export function useHonuaMap(map?: DataToMapLibreMap | null): DataToMapLibreMap | null {
  const contextMap = useContext(HonuaExternalMapContext);
  return map ?? contextMap;
}
