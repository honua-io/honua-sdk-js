/**
 * {@link useMountedSource} — the React lifecycle wrapper around the
 * data-to-map bridge's `mountSource` (REQ-002 of the react depth pass).
 *
 * One bridge mount per effect run: the mount effect creates a fresh
 * `MountedSource` and its cleanup aborts any in-flight mount and disposes the
 * handle (idempotent), so React 18/19 StrictMode's mount → unmount → mount
 * never leaks MapLibre sources, layers, or listeners and never double-adds.
 *
 * Prop changes are diffed instead of torn down:
 * - `query` → `handle.setFilter(query)` (GeoJSON `setData` / tile URL rewrite);
 * - `paint` / `layout` → per-property `map.setPaintProperty` /
 *   `map.setLayoutProperty` on the bridge-owned layers (falling back to a full
 *   remount when the host map does not expose those methods);
 * - structural options (strategy, ids, custom `layers`, geometry, tiles…) →
 *   remount.
 *
 * SSR-safe: no `window` / `document` access at module scope.
 *
 * @module
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Source } from "../contract/types.js";
import type {
  DataToMapLibreMap,
  MountSourceOptions,
  MountSourcePopupContext,
  MountSourcePopupOptions,
  MountedSource,
  MountedSourceDiagnostics,
} from "../map/data-to-map-bridge.js";
import { mountSource } from "../map/data-to-map-bridge.js";
import { type MapLibreGeometryKind, defaultPaint, defaultPolygonOutlinePaint } from "../map/geojson-projection.js";
import { useHonuaMap } from "./external-map.js";
import { stableQueryHash } from "./query-cache.js";

/** Options for {@link useMountedSource}. @experimental */
export interface UseMountedSourceOptions<T = Record<string, unknown>> extends Omit<MountSourceOptions<T>, "signal"> {
  /** When `false`, nothing is mounted (and any existing mount is disposed). Default `true`. */
  enabled?: boolean;
  /** Called with fresh diagnostics after the mount and after every applied update. */
  onDiagnostics?: (diagnostics: MountedSourceDiagnostics) => void;
  /** Called when mounting or a diff update fails (aborted mounts are silent). */
  onError?: (error: unknown) => void;
}

/** Result of {@link useMountedSource}. @experimental */
export interface UseMountedSourceResult<T = Record<string, unknown>> {
  /** The live bridge handle, or `null` while unmounted / mounting / failed. */
  handle: MountedSource<T> | null;
  /** Diagnostics snapshot from the mount and the latest applied update. */
  diagnostics: MountedSourceDiagnostics | null;
  /** Mount or update failure, `undefined` while healthy. */
  error: unknown;
  /** True while the initial mount (or a structural remount) is in flight. */
  isMounting: boolean;
  /** Re-execute the current filter and diff-update the mounted data in place. */
  refresh: () => void;
}

interface MountState<T> {
  handle: MountedSource<T> | null;
  diagnostics: MountedSourceDiagnostics | null;
  error: unknown;
  isMounting: boolean;
}

const IDLE_STATE: MountState<never> = Object.freeze({
  handle: null,
  diagnostics: null,
  error: undefined,
  isMounting: false,
});

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Everything that requires a structural remount when it changes. `query`,
 * `paint`, and `layout` are intentionally absent (diff-updated in place);
 * function-valued options (`popup.factory` / `popup.render`, callbacks) are
 * read through a ref so their identity never forces a remount.
 */
function structuralSignature<T>(options: UseMountedSourceOptions<T>): string {
  return stableQueryHash({
    strategy: options.strategy,
    sourceId: options.sourceId,
    layerId: options.layerId,
    beforeId: options.beforeId,
    geometry: options.geometry,
    layers: options.layers,
    maxGeoJsonFeatures: options.maxGeoJsonFeatures,
    queryTiles: options.queryTiles,
    sourceLayer: options.sourceLayer,
    attribution: options.attribution,
    fitBounds: options.fitBounds,
    hover: options.hover,
    popup: options.popup
      ? {
          fields: options.popup.fields,
          title: options.popup.title,
          // Adding/removing a custom renderer rewires the bridge's popup
          // binding (structural); identity changes of an existing renderer or
          // factory are delivered through the stable wrappers below instead.
          hasRender: options.popup.render !== undefined,
        }
      : undefined,
  });
}

/**
 * Wrap a popup option so its function-valued members (`factory`, `render`)
 * are resolved from the latest props at call time. The bridge captures the
 * popup object once at mount; without this, a renderer or factory that closes
 * over React state would keep using its mount-time closure.
 */
function livePopupOptions<T>(
  snapshot: MountSourcePopupOptions,
  optionsRef: { readonly current: UseMountedSourceOptions<T> },
): MountSourcePopupOptions {
  return {
    ...snapshot,
    factory: () => (optionsRef.current.popup ?? snapshot).factory(),
    ...(snapshot.render !== undefined
      ? {
          render: (context: MountSourcePopupContext) =>
            (optionsRef.current.popup?.render ?? snapshot.render)?.(context),
        }
      : {}),
  };
}

interface RendererCapableMap {
  setPaintProperty?(layerId: string, name: string, value: unknown): void;
  setLayoutProperty?(layerId: string, name: string, value: unknown): void;
}

const KIND_BY_SUFFIX: ReadonlyArray<readonly [string, MapLibreGeometryKind | "polygonOutline"]> = [
  ["-polygon-outline", "polygonOutline"],
  ["-polygon", "polygon"],
  ["-line", "line"],
  ["-point", "point"],
];

function kindForLayerId(layerId: string): MapLibreGeometryKind | "polygonOutline" | undefined {
  for (const [suffix, kind] of KIND_BY_SUFFIX) {
    if (layerId.endsWith(suffix)) return kind;
  }
  return undefined;
}

function defaultPaintFor(kind: MapLibreGeometryKind | "polygonOutline"): Readonly<Record<string, unknown>> {
  return kind === "polygonOutline" ? defaultPolygonOutlinePaint() : defaultPaint(kind);
}

/**
 * Apply a `paint` / `layout` change to the bridge's default layer matrix in
 * place. Returns `false` when the host map lacks the property setters (the
 * caller then falls back to a structural remount). Keys removed from an
 * override are restored to the bridge default (paint) or reset (`undefined`,
 * layout), keyed off the previously applied override.
 */
function applyRendererDiff<T>(
  map: DataToMapLibreMap,
  handle: MountedSource<T>,
  previous: Pick<MountSourceOptions<T>, "paint" | "layout"> | undefined,
  next: Pick<MountSourceOptions<T>, "paint" | "layout">,
): boolean {
  const host = map as RendererCapableMap;
  if (typeof host.setPaintProperty !== "function" || typeof host.setLayoutProperty !== "function") {
    return false;
  }
  for (const layerId of handle.layerIds) {
    const kind = kindForLayerId(layerId);
    if (kind === undefined) return false; // custom layer set: structural
    const defaults = defaultPaintFor(kind);
    const prevPaint = previous?.paint?.[kind] ?? {};
    const nextPaint = next.paint?.[kind] ?? {};
    for (const key of new Set([...Object.keys(prevPaint), ...Object.keys(nextPaint)])) {
      host.setPaintProperty(layerId, key, key in nextPaint ? nextPaint[key] : defaults[key]);
    }
    const prevLayout = previous?.layout?.[kind] ?? {};
    const nextLayout = next.layout?.[kind] ?? {};
    for (const key of new Set([...Object.keys(prevLayout), ...Object.keys(nextLayout)])) {
      host.setLayoutProperty(layerId, key, key in nextLayout ? nextLayout[key] : undefined);
    }
  }
  return true;
}

/**
 * Mount a contract `Source` on a MapLibre map through the data-to-map bridge
 * for the lifetime of the component.
 *
 * Pass the map explicitly, or pass `undefined` to resolve it from the nearest
 * {@link HonuaMapProvider} / `HonuaMap` (external `@vis.gl/react-maplibre`
 * interop works the same way — hand over `mapRef.getMap()`).
 *
 * @example
 * ```tsx
 * const { diagnostics, error } = useMountedSource(map, source, {
 *   query: { where: "STATUS = 'OPEN'" },
 *   hover: true,
 *   onDiagnostics: (d) => console.log(d.strategy, d.featureCount),
 * });
 * ```
 *
 * @experimental
 */
export function useMountedSource<T = Record<string, unknown>>(
  map: DataToMapLibreMap | null | undefined,
  source: Source<T> | null | undefined,
  options: UseMountedSourceOptions<T> = {},
): UseMountedSourceResult<T> {
  const resolvedMap = useHonuaMap(map);
  const enabled = options.enabled ?? true;

  // Latest options snapshot for effects: mount reads it once per run; the
  // diff effects read it when their hash keys change. Callback / factory
  // identity changes therefore never remount or re-run anything.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const structuralKey = structuralSignature(options);
  const queryKey = stableQueryHash(options.query ?? null);
  const rendererKey = stableQueryHash({ paint: options.paint, layout: options.layout });

  const [remountToken, setRemountToken] = useState(0);
  const [state, setState] = useState<MountState<T>>(IDLE_STATE as MountState<T>);

  // Hash keys applied by the *current* mount; diff effects compare against
  // these so a fresh mount (which reads the latest options) is never followed
  // by a redundant setFilter / repaint.
  const appliedRef = useRef<{ query: string; renderer: string } | null>(null);

  // ── Mount / structural remount ─────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: `structuralKey` hashes every structural option; the rest is read via optionsRef.
  useEffect(() => {
    if (!resolvedMap || !source || !enabled) {
      appliedRef.current = null;
      setState(IDLE_STATE as MountState<T>);
      return;
    }
    let cancelled = false;
    let mounted: MountedSource<T> | null = null;
    const controller = new AbortController();
    const snapshot = optionsRef.current;
    const { enabled: _enabled, onDiagnostics: _onDiagnostics, onError: _onError, ...mountOptions } = snapshot;

    appliedRef.current = null;
    setState({ handle: null, diagnostics: null, error: undefined, isMounting: true });

    // Popup callbacks are wrapped so the bridge (which captures the popup
    // object once) always calls the latest `factory` / `render` props.
    const popup = mountOptions.popup ? livePopupOptions(mountOptions.popup, optionsRef) : undefined;

    mountSource<T>(resolvedMap, source, {
      ...mountOptions,
      ...(popup ? { popup } : {}),
      signal: controller.signal,
    }).then(
      (handle) => {
        if (cancelled) {
          // StrictMode / fast unmount: the mount resolved after cleanup ran.
          // Dispose immediately — dispose() is idempotent, so a second call
          // from a racing cleanup is safe.
          handle.dispose();
          return;
        }
        mounted = handle;
        appliedRef.current = {
          query: stableQueryHash(snapshot.query ?? null),
          renderer: stableQueryHash({ paint: snapshot.paint, layout: snapshot.layout }),
        };
        const diagnostics = handle.diagnostics;
        setState({ handle, diagnostics, error: undefined, isMounting: false });
        optionsRef.current.onDiagnostics?.(diagnostics);
      },
      (error) => {
        if (cancelled || controller.signal.aborted || isAbortError(error)) return;
        setState({ handle: null, diagnostics: null, error, isMounting: false });
        optionsRef.current.onError?.(error);
      },
    );

    return () => {
      cancelled = true;
      // Abort first so an in-flight mount never touches the map, then dispose
      // whatever this run mounted. Both are idempotent, so the StrictMode
      // mount → cleanup → mount sequence releases every MapLibre resource.
      controller.abort(new DOMException("useMountedSource unmounted", "AbortError"));
      try {
        mounted?.dispose();
      } catch (error) {
        optionsRef.current.onError?.(error);
      }
    };
  }, [resolvedMap, source, enabled, structuralKey, remountToken]);

  // ── Query prop → setFilter diff update ─────────────────────────
  const handle = state.handle;
  useEffect(() => {
    if (!handle || handle.state === "disposed") return;
    const applied = appliedRef.current;
    if (!applied || applied.query === queryKey) return;
    applied.query = queryKey;
    handle.setFilter(optionsRef.current.query).then(
      (diagnostics) => {
        if (handle.state === "disposed") return;
        setState((current) => (current.handle === handle ? { ...current, diagnostics, error: undefined } : current));
        optionsRef.current.onDiagnostics?.(diagnostics);
      },
      (error) => {
        if (handle.state === "disposed" || isAbortError(error)) return;
        setState((current) => (current.handle === handle ? { ...current, error } : current));
        optionsRef.current.onError?.(error);
      },
    );
  }, [handle, queryKey]);

  // ── paint/layout props → in-place repaint (or structural remount) ──
  const previousRendererRef = useRef<Pick<MountSourceOptions<T>, "paint" | "layout"> | undefined>(undefined);
  useEffect(() => {
    if (!handle || handle.state === "disposed" || !resolvedMap) return;
    const applied = appliedRef.current;
    if (!applied) return;
    if (applied.renderer === rendererKey) {
      previousRendererRef.current = {
        paint: optionsRef.current.paint,
        layout: optionsRef.current.layout,
      };
      return;
    }
    const next = { paint: optionsRef.current.paint, layout: optionsRef.current.layout };
    if (
      optionsRef.current.layers === undefined &&
      applyRendererDiff(resolvedMap, handle, previousRendererRef.current, next)
    ) {
      applied.renderer = rendererKey;
      previousRendererRef.current = next;
      return;
    }
    // Custom layer sets and hosts without property setters cannot be diffed
    // in place: fall back to a full, transactional remount.
    setRemountToken((token) => token + 1);
  }, [handle, resolvedMap, rendererKey]);

  const refresh = useCallback(() => {
    const current = handle;
    if (!current || current.state === "disposed") return;
    current.refresh().then(
      (diagnostics) => {
        if (current.state === "disposed") return;
        setState((existing) =>
          existing.handle === current ? { ...existing, diagnostics, error: undefined } : existing,
        );
        optionsRef.current.onDiagnostics?.(diagnostics);
      },
      (error) => {
        if (current.state === "disposed" || isAbortError(error)) return;
        setState((existing) => (existing.handle === current ? { ...existing, error } : existing));
        optionsRef.current.onError?.(error);
      },
    );
  }, [handle]);

  return useMemo(
    () => ({
      handle: state.handle,
      diagnostics: state.diagnostics,
      error: state.error,
      isMounting: state.isMounting,
      refresh,
    }),
    [state, refresh],
  );
}
