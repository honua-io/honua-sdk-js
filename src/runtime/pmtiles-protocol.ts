/**
 * Auto-registration of the MapLibre `pmtiles://` protocol.
 *
 * MapLibre GL JS resolves a source `url` of `pmtiles://https://…` by calling a
 * protocol handler registered through `maplibregl.addProtocol("pmtiles", …)`.
 * The `pmtiles` package supplies that handler via its `Protocol` class. This
 * module wires the two together **lazily and idempotently**: the `pmtiles` and
 * `maplibre-gl` packages are only pulled in (`await import(...)`) the first time
 * a PMTiles-backed map is loaded, and registration happens exactly once no
 * matter how many maps attach (MapLibre's protocol registry is process-global,
 * and the `pmtiles.Protocol` instance caches every archive it opens).
 *
 * `loadMapPackage` calls {@link ensurePmtilesProtocol} before `map.setStyle`
 * whenever the composed style references a `pmtiles://` source, so consumers get
 * PMTiles rendering out-of-the-box with no manual `addProtocol` wiring. Adding a
 * PMTiles source to a live map through `runtime.addSource` is synchronous — call
 * {@link ensurePmtilesProtocol} yourself beforehand in that case.
 *
 * The registration bookkeeping itself lives in `protocol-registry.ts`, shared
 * with every other scheme the runtime registers; this module owns only the
 * PMTiles policy. The `maplibre-gl` / `pmtiles` slices are injectable so the
 * wiring is unit-testable without either real package.
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

export type { MaplibreProtocolRegistrar };

/** The `pmtiles.Protocol` surface this module drives. */
export interface PmtilesProtocolLike {
  readonly tile: unknown;
}

/** The minimal slice of `typeof import("pmtiles")` registration needs. */
export interface PmtilesProtocolModuleLike {
  Protocol: new (options?: { metadata?: boolean; errorOnMissingTile?: boolean }) => PmtilesProtocolLike;
}

/** Injectable dependencies for {@link ensurePmtilesProtocol} (test seams). */
export interface EnsurePmtilesProtocolDeps {
  /** Override the lazily-imported MapLibre `addProtocol` registrar. */
  readonly maplibre?: MaplibreProtocolRegistrar;
  /** Override the lazily-imported `pmtiles` module. */
  readonly pmtilesModule?: PmtilesProtocolModuleLike;
  /** Protocol scheme to register. Defaults to `"pmtiles"`. */
  readonly scheme?: string;
}

/** The default MapLibre protocol scheme PMTiles archives are addressed under. */
export const PMTILES_PROTOCOL_SCHEME = "pmtiles";

async function loadPmtilesModule(): Promise<PmtilesProtocolModuleLike> {
  return (await import("pmtiles")) as unknown as PmtilesProtocolModuleLike;
}

/**
 * Register the `pmtiles://` protocol on MapLibre if it has not been registered
 * already. Idempotent: repeated calls (including from multiple maps loading
 * concurrently) share a single registration and a single in-flight import.
 *
 * Returns once the protocol is registered so callers can `await` it before
 * handing a `pmtiles://`-referencing style to `map.setStyle`.
 */
export async function ensurePmtilesProtocol(deps: EnsurePmtilesProtocolDeps = {}): Promise<void> {
  const scheme = deps.scheme ?? PMTILES_PROTOCOL_SCHEME;
  await ensureMaplibreProtocol({
    scheme,
    ...(deps.maplibre ? { maplibre: deps.maplibre } : {}),
    createHandler: async () => {
      const pmtilesModule = deps.pmtilesModule ?? (await loadPmtilesModule());
      // `metadata: true` lets MapLibre auto-populate source attribution and the
      // inspect surface from the archive header without a second wiring step.
      return new pmtilesModule.Protocol({ metadata: true }).tile;
    },
  });
}

/** Whether the `pmtiles://` protocol (or `scheme`) is currently registered. */
export function isPmtilesProtocolRegistered(scheme: string = PMTILES_PROTOCOL_SCHEME): boolean {
  return isMaplibreProtocolRegistered(scheme);
}

/**
 * Tear down a prior {@link ensurePmtilesProtocol} registration. Primarily a test
 * seam so the module-global registration does not leak between cases; also
 * useful if a host wants to fully release the protocol. Best-effort — a
 * registrar without `removeProtocol` just clears the local record.
 */
export function resetPmtilesProtocol(scheme: string = PMTILES_PROTOCOL_SCHEME): void {
  resetMaplibreProtocol(scheme);
}

/**
 * Whether a composed MapLibre style references at least one `pmtiles://` source.
 * Used by `loadMapPackage` to decide whether the protocol must be registered
 * before `map.setStyle`.
 */
export function styleUsesPmtiles(
  style: { sources?: Record<string, unknown> } | null | undefined,
  scheme: string = PMTILES_PROTOCOL_SCHEME,
): boolean {
  return styleUsesProtocolScheme(style, scheme);
}
