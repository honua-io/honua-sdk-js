import { HonuaAbortError } from "../core/errors.js";
import type {
  RendererAdapter,
  RendererMountRequest,
  RendererOwnership,
  RendererSession,
  RendererTarget,
} from "../kernel/renderer.js";
import {
  type AutomaticMapLibreDiagnostic,
  type ExplainAutomaticMapLibreOptions,
  HonuaAutomaticMapLibreStrategyError,
  type SourceToMapLibreMap,
  explainAutomaticSourceToMapLibre,
  mountAutomaticSourceToMapLibre,
} from "../map/index.js";
import type { PmtilesProtocolModuleLike } from "./pmtiles-protocol.js";
import { ensurePmtilesProtocol } from "./pmtiles-protocol.js";

/** MapLibre module slice consumed from the caller-injected optional peer. */
export interface MapLibreRendererPeer {
  readonly Map?: new (options: Readonly<Record<string, unknown>>) => unknown;
  readonly addProtocol?: (scheme: string, handler: unknown) => void;
  readonly removeProtocol?: (scheme: string) => void;
  readonly default?: MapLibreRendererPeer;
}

/** Host slice added to the existing source-mutation contract for lifecycle readiness. */
export interface MapLibreRendererMap extends SourceToMapLibreMap {
  loaded?(): boolean;
  isStyleLoaded?(): boolean;
  once?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
  triggerRepaint?(): void;
  remove?(): void;
}

export interface MapLibreRendererFactoryOptions {
  /** Inject PMTiles only when PMTiles sources are expected; no package is loaded implicitly. */
  readonly pmtiles?: PmtilesProtocolModuleLike;
}

/** Adapter-specific construction and automatic-strategy controls. */
export interface MapLibreRendererOptions extends Omit<ExplainAutomaticMapLibreOptions, "queryPlan"> {
  readonly mapOptions?: Readonly<Record<string, unknown>>;
  /** Defaults to `render`, the first frame that can contain the mounted layer. */
  readonly firstFrameEvent?: "render" | "idle";
}

const EMPTY_STYLE = Object.freeze({
  version: 8 as const,
  sources: Object.freeze({}),
  layers: Object.freeze([]),
});

/**
 * Create an executable MapLibre adapter without importing `maplibre-gl`.
 * The supplied module is retained only on this adapter instance.
 */
export function maplibreRenderer(
  peer: MapLibreRendererPeer,
  options: MapLibreRendererFactoryOptions = {},
): RendererAdapter<"maplibre", MapLibreRendererMap, MapLibreRendererOptions> {
  const maplibre = maplibrePeer(peer);
  const pmtiles = options.pmtiles;
  return Object.freeze({
    kind: "maplibre" as const,
    environments: Object.freeze(["browser" as const]),
    peer,
    defaultOwnership(target: RendererTarget): RendererOwnership {
      return isMapHost(target) ? "borrowed" : "owned";
    },
    async mount<T>(
      target: RendererTarget,
      request: RendererMountRequest<T, MapLibreRendererOptions>,
    ): Promise<RendererSession<MapLibreRendererMap>> {
      const rendererOptions = request.rendererOptions ?? {};
      const host = resolveMapHost(maplibre, target, request, rendererOptions);
      const map = host.map;
      try {
        await waitUntilStyleReady(map, request.signal);
        let queryPlan = request.queryPlan;
        let plan = explainAutomaticSourceToMapLibre(request.source, {
          ...automaticOptions(rendererOptions),
          ...(queryPlan === undefined ? {} : { queryPlan }),
        });
        const queryCandidate = plan.candidates.find((candidate) => candidate.strategy === "geojson-query");
        if (queryPlan !== undefined && queryCandidate?.reason === "plan-context-mismatch") {
          throw new HonuaAutomaticMapLibreStrategyError(
            "stale-plan",
            "The accepted query plan no longer matches the mounted source.",
          );
        }
        if (plan.selected === undefined && queryCandidate?.reason === "missing-query-plan") {
          queryPlan = await request.planQuery();
          plan = explainAutomaticSourceToMapLibre(request.source, {
            ...automaticOptions(rendererOptions),
            queryPlan,
          });
        }
        if (plan.selected?.strategy.startsWith("pmtiles")) {
          if (pmtiles === undefined || typeof maplibre.addProtocol !== "function") {
            throw new HonuaAutomaticMapLibreStrategyError(
              "no-eligible-strategy",
              "PMTiles mounting requires caller-injected MapLibre and PMTiles protocol peers.",
            );
          }
          const registrar = {
            addProtocol: (scheme: string, handler: unknown) => maplibre.addProtocol!(scheme, handler),
            ...(typeof maplibre.removeProtocol === "function"
              ? { removeProtocol: (scheme: string) => maplibre.removeProtocol!(scheme) }
              : {}),
          };
          await ensurePmtilesProtocol({ maplibre: registrar, pmtilesModule: pmtiles });
        }
        const mounted = await mountAutomaticSourceToMapLibre(map, request.source, plan, {
          ...automaticOptions(rendererOptions),
          ...(queryPlan === undefined ? {} : { queryPlan }),
          ...request.execution,
          signal: request.signal,
        });
        let disposePromise: Promise<void> | undefined;
        const dispose = (): Promise<void> => {
          if (disposePromise !== undefined) return disposePromise;
          disposePromise = disposeMapLibreSession(mounted.dispose, host);
          return disposePromise;
        };
        const ready = firstUsableFrame(map, rendererOptions.firstFrameEvent ?? "render", request.signal).catch(
          async (error: unknown) => {
            try {
              await dispose();
            } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], "MapLibre readiness and rollback failed");
            }
            throw error;
          },
        );
        return {
          raw: map,
          diagnostics: mounted.diagnostics as readonly AutomaticMapLibreDiagnostic[],
          ready,
          async refresh(refreshOptions = {}) {
            const signal = combineSignals(request.signal, refreshOptions.signal);
            throwIfAborted(signal);
            await mounted.refresh({ ...request.execution, signal });
            await firstUsableFrame(map, rendererOptions.firstFrameEvent ?? "render", signal);
          },
          dispose,
        };
      } catch (error) {
        if (host.owned) {
          try {
            host.map.remove?.();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "MapLibre mount and owned-host rollback failed");
          }
        }
        throw error;
      }
    },
  });
}

function automaticOptions(options: MapLibreRendererOptions): ExplainAutomaticMapLibreOptions {
  const { mapOptions: _mapOptions, firstFrameEvent: _firstFrameEvent, ...automatic } = options;
  return automatic;
}

function maplibrePeer(value: MapLibreRendererPeer): MapLibreRendererPeer {
  if (typeof value !== "object" || value === null) throw new TypeError("maplibreRenderer() requires an injected peer.");
  return value.default && typeof value.default === "object" ? value.default : value;
}

function resolveMapHost<T>(
  peer: MapLibreRendererPeer,
  target: RendererTarget,
  request: RendererMountRequest<T, MapLibreRendererOptions>,
  options: MapLibreRendererOptions,
): { readonly map: MapLibreRendererMap; readonly owned: boolean } {
  if (isMapHost(target)) {
    assertReadinessHost(target);
    if (request.ownership === "owned") assertOwnedHost(target);
    return { map: target, owned: request.ownership === "owned" };
  }
  if (request.ownership === "borrowed") {
    throw new TypeError("A selector or element target cannot be borrowed without an existing MapLibre map.");
  }
  const MapConstructor = peer.Map;
  if (typeof MapConstructor !== "function") {
    throw new TypeError("The injected MapLibre peer does not expose a Map constructor.");
  }
  const style = request.style === undefined || request.style === "auto" ? EMPTY_STYLE : request.style;
  const map = new MapConstructor({ ...options.mapOptions, container: target, style });
  if (!isMapHost(map)) {
    removeHostCandidate(map);
    throw new TypeError("The injected MapLibre Map constructor returned an incompatible host.");
  }
  try {
    assertReadinessHost(map);
    assertOwnedHost(map);
  } catch (error) {
    removeHostCandidate(map);
    throw error;
  }
  return { map, owned: true };
}

interface ReadinessMapLibreRendererMap extends MapLibreRendererMap {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  triggerRepaint(): void;
}

function assertReadinessHost(map: MapLibreRendererMap): asserts map is ReadinessMapLibreRendererMap {
  if (typeof map.once !== "function" || typeof map.off !== "function" || typeof map.triggerRepaint !== "function") {
    throw new HonuaAutomaticMapLibreStrategyError(
      "map-mutation-failed",
      "The MapLibre host does not expose once(), off(), and triggerRepaint(); first-frame readiness is unavailable.",
    );
  }
}

function assertOwnedHost(map: MapLibreRendererMap): asserts map is MapLibreRendererMap & { remove(): void } {
  if (typeof map.remove !== "function") {
    throw new HonuaAutomaticMapLibreStrategyError(
      "map-mutation-failed",
      "An owned MapLibre host must expose remove() for deterministic disposal.",
    );
  }
}

function removeHostCandidate(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  try {
    const remove = (value as { readonly remove?: unknown }).remove;
    if (typeof remove === "function") Reflect.apply(remove, value, []);
  } catch {
    // The incompatible host error remains the primary construction failure.
  }
}

function isMapHost(value: unknown): value is MapLibreRendererMap {
  if (typeof value !== "object" || value === null) return false;
  try {
    const map = value as Partial<SourceToMapLibreMap>;
    return (
      typeof map.getSource === "function" &&
      typeof map.addSource === "function" &&
      typeof map.removeSource === "function" &&
      typeof map.getLayer === "function" &&
      typeof map.addLayer === "function" &&
      typeof map.removeLayer === "function"
    );
  } catch {
    return false;
  }
}

async function waitUntilStyleReady(map: MapLibreRendererMap, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  assertReadinessHost(map);
  if (map.loaded?.() === true || map.isStyleLoaded?.() === true) return;
  await waitForEvent(map, "load", signal);
}

async function firstUsableFrame(
  map: MapLibreRendererMap,
  event: "render" | "idle",
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  assertReadinessHost(map);
  const frame = waitForEvent(map, event, signal);
  map.triggerRepaint();
  await frame;
}

function waitForEvent(map: ReadinessMapLibreRendererMap, event: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
      map.off(event, completed);
    };
    const completed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const aborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HonuaAbortError());
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    try {
      map.once(event, completed);
      if (signal.aborted) {
        if (settled) map.off(event, completed);
        else aborted();
      }
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

function disposeMapLibreSession(
  disposeMounted: () => void,
  host: { readonly map: MapLibreRendererMap; readonly owned: boolean },
): Promise<void> {
  return Promise.resolve().then(() => {
    const failures: unknown[] = [];
    try {
      disposeMounted();
    } catch (error) {
      failures.push(error);
    }
    if (host.owned) {
      try {
        host.map.remove?.();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "MapLibre mounted-session cleanup failed");
  });
}

function combineSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  if (secondary === undefined || secondary === primary) return primary;
  return AbortSignal.any([primary, secondary]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new HonuaAbortError();
}
