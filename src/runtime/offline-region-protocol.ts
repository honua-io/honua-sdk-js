/**
 * Auto-registration of the MapLibre `offline-region://` protocol.
 *
 * A style whose tile sources address a persisted offline region renders through
 * a protocol handler built by `@honua/sdk-js/offline`
 * (`createOfflineRegionTileProtocol`). This module registers that handler on
 * MapLibre once, through the same shared registry `pmtiles://` uses.
 *
 * The runtime deliberately does **not** import `@honua/sdk-js/offline` and does
 * not build the handler itself. A handler is bound to one region manifest, one
 * store, and one authorization scope, none of which the runtime can invent —
 * so the caller supplies the handler and the runtime decides only *when* it must
 * be registered. That also keeps the offline module graph out of every map that
 * never reads from a region.
 *
 * Registration is triggered by evidence, never by import: `loadMapPackage`
 * registers when the composed style actually references the scheme, and fails
 * closed when it does but no handler was supplied — because a missing handler
 * renders blank tiles rather than an error.
 *
 * @module
 */

import {
  type MaplibreProtocolRegistrar,
  ensureMaplibreProtocol,
  isMaplibreProtocolRegistered,
  resetMaplibreProtocol,
  styleUsesProtocolScheme,
} from "./protocol-registry.js";

/** The MapLibre protocol scheme persisted offline regions are addressed under. */
export const OFFLINE_REGION_PROTOCOL_SCHEME = "offline-region";

/**
 * The handler shape `createOfflineRegionTileProtocol()` returns.
 *
 * Declared structurally so the runtime never imports the offline entrypoint; it
 * is the same shape MapLibre itself expects from `addProtocol`.
 */
export type OfflineRegionTileHandler = (
  request: { readonly url: string },
  abortController?: AbortController,
) => Promise<{ readonly data: ArrayBuffer; readonly cacheControl?: string; readonly expires?: string }>;

/** Injectable dependencies for {@link ensureOfflineRegionProtocol}. */
export interface EnsureOfflineRegionProtocolDeps {
  /** Handler from `@honua/sdk-js/offline`'s `createOfflineRegionTileProtocol()`. */
  readonly tileHandler: OfflineRegionTileHandler;
  /** Override the lazily-imported MapLibre `addProtocol` registrar. */
  readonly maplibre?: MaplibreProtocolRegistrar;
  /** Protocol scheme to register. Defaults to `"offline-region"`. */
  readonly scheme?: string;
}

/**
 * Register the `offline-region://` protocol on MapLibre if it is not registered
 * already. Idempotent per scheme, exactly like the PMTiles registration: several
 * maps loading the same region concurrently share one registration.
 *
 * Because MapLibre's protocol table is process-global, the *first* handler wins
 * for a given scheme. A host that needs to serve a different region on the same
 * scheme must {@link resetOfflineRegionProtocol} first, or register the second
 * region under its own scheme.
 */
export async function ensureOfflineRegionProtocol(deps: EnsureOfflineRegionProtocolDeps): Promise<void> {
  if (typeof deps?.tileHandler !== "function") {
    throw new TypeError(
      "An offline-region tile handler is required; build one with createOfflineRegionTileProtocol() from @honua/sdk-js/offline.",
    );
  }
  await ensureMaplibreProtocol({
    scheme: deps.scheme ?? OFFLINE_REGION_PROTOCOL_SCHEME,
    ...(deps.maplibre ? { maplibre: deps.maplibre } : {}),
    createHandler: () => deps.tileHandler,
  });
}

/** Whether the `offline-region://` protocol (or `scheme`) is currently registered. */
export function isOfflineRegionProtocolRegistered(scheme: string = OFFLINE_REGION_PROTOCOL_SCHEME): boolean {
  return isMaplibreProtocolRegistered(scheme);
}

/**
 * Release a prior {@link ensureOfflineRegionProtocol} registration, so a later
 * call can bind a different region's handler to the same scheme.
 */
export function resetOfflineRegionProtocol(scheme: string = OFFLINE_REGION_PROTOCOL_SCHEME): void {
  resetMaplibreProtocol(scheme);
}

/**
 * Whether a composed MapLibre style references at least one `offline-region://`
 * source. This is the evidence `loadMapPackage` registers on.
 */
export function styleUsesOfflineRegion(
  style: { sources?: Record<string, unknown> } | null | undefined,
  scheme: string = OFFLINE_REGION_PROTOCOL_SCHEME,
): boolean {
  return styleUsesProtocolScheme(style, scheme);
}
