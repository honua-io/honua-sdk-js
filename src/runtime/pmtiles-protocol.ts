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
 * The `maplibre-gl` / `pmtiles` slices are injectable so the wiring is
 * unit-testable without either real package.
 *
 * @module
 */

/** The MapLibre `addProtocol` / `removeProtocol` surface this module drives. */
export interface MaplibreProtocolRegistrar {
  addProtocol(scheme: string, handler: unknown): void;
  removeProtocol?(scheme: string): void;
}

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

interface Registration {
  readonly scheme: string;
  readonly registrar: MaplibreProtocolRegistrar;
  readonly protocol: PmtilesProtocolLike;
}

let registration: Registration | undefined;
let inFlight: Promise<void> | undefined;

/**
 * Resolve the MapLibre `addProtocol` registrar from the lazily-imported module.
 * MapLibre 6 is ESM-only and exposes it as a named export; MapLibre 5 may also
 * surface it off the default namespace depending on how the host bundles the
 * UMD build. Accept either so this works across the `^5 || ^6` peer range.
 */
async function loadMaplibreRegistrar(): Promise<MaplibreProtocolRegistrar> {
  const mod = (await import("maplibre-gl")) as unknown as {
    addProtocol?: MaplibreProtocolRegistrar["addProtocol"];
    removeProtocol?: MaplibreProtocolRegistrar["removeProtocol"];
    default?: MaplibreProtocolRegistrar;
  };
  if (typeof mod.addProtocol === "function") {
    return { addProtocol: mod.addProtocol, removeProtocol: mod.removeProtocol };
  }
  if (mod.default && typeof mod.default.addProtocol === "function") {
    return mod.default;
  }
  throw new Error(
    "maplibre-gl does not expose addProtocol(); install maplibre-gl 5.x or 6.x (the SDK peer range is ^5.0.0 || ^6.0.0).",
  );
}

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
  if (registration && registration.scheme === scheme) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const registrar = deps.maplibre ?? (await loadMaplibreRegistrar());
    const pmtilesModule = deps.pmtilesModule ?? (await loadPmtilesModule());
    // `metadata: true` lets MapLibre auto-populate source attribution and the
    // inspect surface from the archive header without a second wiring step.
    const protocol = new pmtilesModule.Protocol({ metadata: true });
    registrar.addProtocol(scheme, protocol.tile);
    registration = { scheme, registrar, protocol };
  })();

  try {
    await inFlight;
  } finally {
    inFlight = undefined;
  }
}

/** Whether the `pmtiles://` protocol (or `scheme`) is currently registered. */
export function isPmtilesProtocolRegistered(scheme: string = PMTILES_PROTOCOL_SCHEME): boolean {
  return registration?.scheme === scheme;
}

/**
 * Tear down a prior {@link ensurePmtilesProtocol} registration. Primarily a test
 * seam so the module-global registration does not leak between cases; also
 * useful if a host wants to fully release the protocol. Best-effort — a
 * registrar without `removeProtocol` just clears the local record.
 */
export function resetPmtilesProtocol(): void {
  if (registration) {
    registration.registrar.removeProtocol?.(registration.scheme);
    registration = undefined;
  }
  inFlight = undefined;
}

function sourceReferencesPmtiles(source: unknown, scheme: string): boolean {
  if (!source || typeof source !== "object") return false;
  const prefix = `${scheme}://`;
  const url = (source as { url?: unknown }).url;
  if (typeof url === "string" && url.startsWith(prefix)) return true;
  const tiles = (source as { tiles?: unknown }).tiles;
  if (Array.isArray(tiles) && tiles.some((tile) => typeof tile === "string" && tile.startsWith(prefix))) {
    return true;
  }
  return false;
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
  const sources = style?.sources;
  if (!sources) return false;
  for (const source of Object.values(sources)) {
    if (sourceReferencesPmtiles(source, scheme)) return true;
  }
  return false;
}
