/**
 * {@link HonuaProvider} — the root of every `@honua/react` tree. Publishes an
 * active {@link HonuaClient} plus a per-provider {@link HonuaQueryCache} to the
 * hooks and map components below it.
 *
 * @module
 */

import { type ReactNode, useMemo, useRef } from "react";

import type { HonuaClient } from "../core/client.js";
import { HonuaContext, type HonuaContextValue } from "./context.js";
import { HonuaQueryCache } from "./query-cache.js";

/** Props for {@link HonuaProvider}. */
export interface HonuaProviderProps {
  /** The client every descendant hook/component queries through. */
  client: HonuaClient;
  /**
   * Optional externally-owned query cache. Supply one to share cached results
   * across providers or to pre-seed a cache in tests; omit to let the provider
   * own a fresh, session-scoped cache.
   */
  cache?: HonuaQueryCache;
  children?: ReactNode;
}

/**
 * Wrap an application (or subtree) to make a `HonuaClient` available to the
 * `@honua/react` hooks and map components.
 *
 * @example
 * ```tsx
 * const client = new HonuaClient({ baseUrl: "https://honua.example.com" });
 * <HonuaProvider client={client}>
 *   <App />
 * </HonuaProvider>
 * ```
 */
export function HonuaProvider({ client, cache, children }: HonuaProviderProps): ReactNode {
  // Own a stable cache for the provider's lifetime unless the caller supplies
  // one. `useRef` keeps the same instance across re-renders and StrictMode's
  // double-invoke of render.
  const ownedCacheRef = useRef<HonuaQueryCache | null>(null);
  if (ownedCacheRef.current === null) {
    ownedCacheRef.current = new HonuaQueryCache();
  }
  const activeCache = cache ?? ownedCacheRef.current;

  const value = useMemo<HonuaContextValue>(
    () => ({ client, cache: activeCache }),
    [client, activeCache],
  );

  return <HonuaContext.Provider value={value}>{children}</HonuaContext.Provider>;
}
