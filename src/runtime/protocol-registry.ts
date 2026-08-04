/**
 * One idempotent MapLibre protocol registry, shared by every scheme the runtime
 * auto-registers.
 *
 * MapLibre's protocol table is process-global, so registration has to be
 * idempotent, deduplicated across concurrently loading maps, and keyed by scheme
 * rather than by whichever protocol happened to register last. This module owns
 * that bookkeeping once; `pmtiles-protocol.ts` and `offline-region-protocol.ts`
 * are thin policies over it that decide *what* handler a scheme gets and *when* a
 * style needs it.
 *
 * The `maplibre-gl` slice stays injectable so every wiring path is unit-testable
 * without the real peer.
 *
 * @module
 */

/** The MapLibre `addProtocol` / `removeProtocol` surface this module drives. */
export interface MaplibreProtocolRegistrar {
  addProtocol(scheme: string, handler: unknown): void;
  removeProtocol?(scheme: string): void;
}

interface Registration {
  readonly registrar: MaplibreProtocolRegistrar;
  readonly handler: unknown;
}

const registrations = new Map<string, Registration>();
const inFlight = new Map<string, Promise<void>>();

/**
 * Resolve the MapLibre `addProtocol` registrar from the lazily-imported module.
 * MapLibre 6 is ESM-only and exposes it as a named export; MapLibre 5 may also
 * surface it off the default namespace depending on how the host bundles the
 * UMD build. Accept either so this works across the `^5 || ^6` peer range.
 */
export async function loadMaplibreRegistrar(): Promise<MaplibreProtocolRegistrar> {
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

/**
 * Register `scheme` once, building its handler only when it is actually needed.
 *
 * Repeated calls — including from several maps loading at the same time — share
 * one registration and one in-flight build per scheme. A failed build is not
 * remembered, so a later call can retry.
 */
export async function ensureMaplibreProtocol(options: {
  readonly scheme: string;
  /** Built at most once per scheme, and only when the scheme is not registered. */
  readonly createHandler: () => unknown | Promise<unknown>;
  readonly maplibre?: MaplibreProtocolRegistrar;
}): Promise<void> {
  const scheme = options.scheme;
  if (typeof scheme !== "string" || scheme.length === 0) throw new TypeError("A protocol scheme is required.");
  if (registrations.has(scheme)) return;
  const pending = inFlight.get(scheme);
  if (pending) return pending;

  const run = (async () => {
    const registrar = options.maplibre ?? (await loadMaplibreRegistrar());
    const handler = await options.createHandler();
    registrar.addProtocol(scheme, handler);
    registrations.set(scheme, { registrar, handler });
  })();
  inFlight.set(scheme, run);
  try {
    await run;
  } finally {
    inFlight.delete(scheme);
  }
}

/** Whether `scheme` is currently registered through this registry. */
export function isMaplibreProtocolRegistered(scheme: string): boolean {
  return registrations.has(scheme);
}

/**
 * Tear down a prior registration. Primarily a test seam so a module-global
 * registration does not leak between cases; also useful if a host wants to fully
 * release a protocol. Best-effort — a registrar without `removeProtocol` just
 * clears the local record.
 */
export function resetMaplibreProtocol(scheme: string): void {
  const registration = registrations.get(scheme);
  if (registration) {
    registration.registrar.removeProtocol?.(scheme);
    registrations.delete(scheme);
  }
  inFlight.delete(scheme);
}

/** Whether a composed MapLibre style references at least one `<scheme>://` source. */
export function styleUsesProtocolScheme(
  style: { sources?: Record<string, unknown> } | null | undefined,
  scheme: string,
): boolean {
  const sources = style?.sources;
  if (!sources) return false;
  const prefix = `${scheme}://`;
  for (const source of Object.values(sources)) {
    if (sourceReferencesScheme(source, prefix)) return true;
  }
  return false;
}

function sourceReferencesScheme(source: unknown, prefix: string): boolean {
  if (!source || typeof source !== "object") return false;
  const url = (source as { url?: unknown }).url;
  if (typeof url === "string" && url.startsWith(prefix)) return true;
  const tiles = (source as { tiles?: unknown }).tiles;
  return Array.isArray(tiles) && tiles.some((tile) => typeof tile === "string" && tile.startsWith(prefix));
}
