/**
 * {@link HonuaMap} — a React component that owns a {@link HonuaMapRuntime}
 * lifecycle over a MapLibre GL map. It can create and own the map itself, or
 * attach to an externally-owned map instance (the `@vis.gl/react-maplibre`
 * interop pattern). Children ({@link HonuaLayer} / {@link HonuaPopup}) reach the
 * runtime through context.
 *
 * SSR-safe: `maplibre-gl` is only imported (dynamically) inside a mount effect,
 * never at module load. StrictMode-safe: the mount effect fully disposes the
 * runtime and removes any owned map on cleanup, so a double-invoked mount never
 * leaks a runtime or a WebGL context.
 *
 * @module
 */

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import type { HonuaMapPackage, HonuaMapRuntime, LoadMapPackageOptions, MaplibreMap } from "../runtime/index.js";
import { loadMapPackage } from "../runtime/index.js";
import type { PopupFactory } from "../runtime/index.js";
import { useHonuaClient } from "./hooks.js";
import { HonuaMapContext, type HonuaMapContextValue } from "./context.js";

/** Options accepted by the `maplibre-gl` `Map` constructor that `HonuaMap` uses. */
export interface MapLibreMapOptions {
  container: string | HTMLElement;
  style: unknown;
  center?: [number, number];
  zoom?: number;
  [key: string]: unknown;
}

/**
 * The shape of the `maplibre-gl` module `HonuaMap` needs when it owns the map.
 * Pass your imported `maplibre-gl` namespace as {@link HonuaMapProps.mapLibre},
 * or let `HonuaMap` dynamically `import("maplibre-gl")`.
 */
export interface MapLibreGlModule {
  Map: new (options: MapLibreMapOptions) => MaplibreMap & { remove(): void };
  Popup: new (options?: Record<string, unknown>) => unknown;
}

const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

/** Props for {@link HonuaMap}. */
export interface HonuaMapProps {
  /** The `MapPackage` to compose onto the map. */
  package: HonuaMapPackage;
  /**
   * Attach to an existing, externally-owned map instead of creating one. When
   * set, `HonuaMap` never removes the map on unmount (the owner is responsible)
   * — it only disposes the runtime.
   */
  map?: MaplibreMap;
  /**
   * The `maplibre-gl` module. Provide it to avoid a dynamic import (and to pin
   * the exact version). Ignored when {@link map} is supplied.
   */
  mapLibre?: MapLibreGlModule;
  /**
   * Extra options merged into the `maplibre-gl` `Map` constructor when
   * `HonuaMap` owns the map (`container` and `style` are managed for you).
   */
  mapOptions?: Partial<Omit<MapLibreMapOptions, "container">>;
  /**
   * Extra options forwarded to `loadMapPackage`. `client` is taken from the
   * provider; a `popupFactory` is defaulted from the maplibre module when one
   * is available so {@link HonuaPopup} works out of the box.
   */
  loadOptions?: Omit<LoadMapPackageOptions, "client">;
  /** Called once the runtime is ready. */
  onRuntime?: (runtime: HonuaMapRuntime) => void;
  /** Called if map creation or package loading fails. */
  onError?: (error: unknown) => void;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * Render a Honua-composed MapLibre map.
 *
 * @example
 * ```tsx
 * <HonuaMap package={mapPackage} style={{ height: 480 }}>
 *   <HonuaLayer layer={{ id: "sites", type: "circle", source: "sites", paint: { "circle-radius": 6 } }}
 *               source={{ id: "sites", spec: { type: "geojson", data: sitesGeoJson } }} />
 *   <HonuaPopup layer="sites" binding={{ sourceId: "sites", title: "Site" }} />
 * </HonuaMap>
 * ```
 */
export function HonuaMap(props: HonuaMapProps): ReactNode {
  const {
    package: mapPackage,
    map: externalMap,
    mapLibre,
    mapOptions,
    loadOptions,
    onRuntime,
    onError,
    className,
    style,
    children,
  } = props;

  const client = useHonuaClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [contextValue, setContextValue] = useState<HonuaMapContextValue>({ runtime: null, map: null });
  // The package reference last handed to load/updatePackage — lets us route
  // subsequent package changes through `updatePackage` instead of reloading.
  const appliedPackageRef = useRef<HonuaMapPackage | null>(null);

  useEffect(() => {
    let cancelled = false;
    let runtime: HonuaMapRuntime | null = null;
    let ownedMap: (MaplibreMap & { remove(): void }) | null = null;

    const start = async (): Promise<void> => {
      let map = externalMap ?? null;
      let gl: MapLibreGlModule | undefined = mapLibre;
      if (!map) {
        const container = containerRef.current;
        if (!container) return;
        gl = mapLibre ?? ((await import("maplibre-gl")).default as unknown as MapLibreGlModule);
        if (cancelled) return;
        ownedMap = new gl.Map({
          container,
          style: EMPTY_STYLE,
          ...mapOptions,
        });
        map = ownedMap;
      }

      // Default a popup factory from the maplibre module (when we have it) so
      // HonuaPopup works without extra wiring.
      const glModule = gl;
      const popupFactory: PopupFactory | undefined =
        loadOptions?.popupFactory ?? (glModule ? (() => new glModule.Popup() as never) : undefined);

      const loaded = await loadMapPackage(mapPackage, map, {
        ...loadOptions,
        client,
        popupFactory,
      });
      if (cancelled) {
        loaded.dispose();
        ownedMap?.remove();
        return;
      }
      runtime = loaded;
      appliedPackageRef.current = mapPackage;
      setContextValue({ runtime: loaded, map });
      onRuntime?.(loaded);
    };

    start().catch((error) => {
      if (cancelled) return;
      onError?.(error);
    });

    return () => {
      cancelled = true;
      runtime?.dispose();
      ownedMap?.remove();
      appliedPackageRef.current = null;
      setContextValue({ runtime: null, map: null });
    };
    // Recreate only when the client, external map, or maplibre module changes.
    // Package-content changes are handled by the effect below via updatePackage.
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally excludes mapPackage/options to avoid map re-creation.
  }, [client, externalMap, mapLibre]);

  // Route package changes to updatePackage without tearing down the map.
  useEffect(() => {
    const runtime = contextValue.runtime;
    if (!runtime) return;
    if (appliedPackageRef.current === mapPackage) return;
    appliedPackageRef.current = mapPackage;
    runtime.updatePackage(mapPackage).catch((error) => onError?.(error));
    // biome-ignore lint/correctness/useExhaustiveDependencies: onError is a callback prop; re-running on its identity is undesirable.
  }, [contextValue.runtime, mapPackage]);

  return (
    <HonuaMapContext.Provider value={contextValue}>
      {externalMap ? null : <div ref={containerRef} className={className} style={style} data-honua-map="" />}
      {children}
    </HonuaMapContext.Provider>
  );
}
