/**
 * `@honua/react` — idiomatic React bindings for the Honua SDK: a provider,
 * data hooks, and declarative map components over the framework-neutral
 * `@honua/sdk-js` core.
 *
 * The core SDK stays React-free; this entry point is the only place React is
 * imported. It is SSR-safe (no `window`/`document` access at import time) and
 * StrictMode-safe under React 18 and 19.
 *
 * @example
 * ```tsx
 * import { HonuaClient } from "@honua/sdk-js/honua";
 * import { HonuaProvider, useDataset, useQuery } from "@honua/react";
 *
 * const client = new HonuaClient({ baseUrl: "https://honua.example.com" });
 *
 * function App() {
 *   return (
 *     <HonuaProvider client={client}>
 *       <Incidents />
 *     </HonuaProvider>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

export { HonuaProvider } from "./provider.js";
export type { HonuaProviderProps } from "./provider.js";

export {
  useHonuaClient,
  useHonuaQueryCache,
  useDataset,
  useQuery,
  useCapabilities,
  useMapRuntime,
  useRealtime,
} from "./hooks.js";
export type {
  UseDatasetOptions,
  UseQueryOptions,
  UseQueryResult,
  UseCapabilitiesOptions,
  UseCapabilitiesResult,
  RealtimeCleanup,
} from "./hooks.js";

export { HonuaMap } from "./honua-map.js";
export type { HonuaMapProps, MapLibreGlModule, MapLibreMapOptions } from "./honua-map.js";
export { HonuaLayer } from "./honua-layer.js";
export type { HonuaLayerProps, HonuaLayerSource } from "./honua-layer.js";
export { HonuaPopup } from "./honua-popup.js";
export type { HonuaPopupProps } from "./honua-popup.js";

export { HonuaContext, HonuaMapContext } from "./context.js";
export type { HonuaContextValue, HonuaMapContextValue } from "./context.js";

export { HonuaQueryCache, stableQueryHash, idleSnapshot } from "./query-cache.js";
export type { QueryStatus, QuerySnapshot, QueryFetcher } from "./query-cache.js";

// ── React depth pass (issue #498) — all @experimental ─────────────

export { HonuaExternalMapContext, HonuaMapProvider, useHonuaMap } from "./external-map.js";
export type { HonuaMapProviderProps } from "./external-map.js";

export { useMountedSource } from "./use-mounted-source.js";
export type { UseMountedSourceOptions, UseMountedSourceResult } from "./use-mounted-source.js";

export { HonuaSourceLayer } from "./honua-source-layer.js";
export type { HonuaSourceLayerProps, HonuaSourceRenderer } from "./honua-source-layer.js";

export {
  HonuaSelectionContext,
  HonuaSelectionProvider,
  HonuaSelectionStore,
  useHover,
  useMapHoverBinding,
  useMapSelectionBinding,
  useSelection,
} from "./selection.js";
export type {
  HonuaSelectionProviderProps,
  HonuaSelectionSnapshot,
  MapHoverBindingOptions,
  MapSelectionBindingOptions,
  UseHoverResult,
  UseSelectionResult,
} from "./selection.js";
