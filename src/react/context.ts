/**
 * React contexts for `@honua/react`. Kept in a value-only module (no JSX, no
 * `window` access) so it is safe to import during server-side rendering.
 *
 * @module
 */

import { createContext } from "react";

import type { HonuaClient } from "../core/client.js";
import type { HonuaMapRuntime, MaplibreMap } from "../runtime/index.js";
import type { HonuaQueryCache } from "./query-cache.js";

/** Value carried by {@link HonuaContext}: the active client and its query cache. */
export interface HonuaContextValue {
  readonly client: HonuaClient;
  readonly cache: HonuaQueryCache;
}

/**
 * Root context populated by {@link HonuaProvider}. `null` when a hook is used
 * outside a provider — hooks throw a descriptive error in that case.
 */
export const HonuaContext = createContext<HonuaContextValue | null>(null);
HonuaContext.displayName = "HonuaContext";

/** Value carried by {@link HonuaMapContext}: the runtime owned by a `HonuaMap`. */
export interface HonuaMapContextValue {
  /** `null` until `HonuaMap` has finished loading its `MapPackage`. */
  readonly runtime: HonuaMapRuntime | null;
  /** The underlying MapLibre map instance, or `null` before it exists. */
  readonly map: MaplibreMap | null;
}

/**
 * Context provided by {@link HonuaMap} to its `HonuaLayer` / `HonuaPopup`
 * children (and consumers of {@link useMapRuntime}).
 */
export const HonuaMapContext = createContext<HonuaMapContextValue | null>(null);
HonuaMapContext.displayName = "HonuaMapContext";
