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
  /** Runtime-validated so the real MapLibre constructor remains structurally injectable. */
  readonly Map?: unknown;
  readonly addProtocol?: unknown;
  readonly removeProtocol?: unknown;
  readonly default?: unknown;
}

interface ResolvedMapLibreRendererPeer {
  readonly Map?: new (options: Readonly<Record<string, unknown>>) => unknown;
  readonly addProtocol?: (scheme: string, handler: unknown) => void;
  readonly removeProtocol?: (scheme: string) => void;
}

/** Host slice added to the existing source-mutation contract for lifecycle readiness. */
export interface MapLibreRendererMap extends SourceToMapLibreMap {
  loaded?(): boolean;
  /** Mirrors MapLibre v5, which returns void after the style has been destroyed. */
  isStyleLoaded?(): boolean | void;
  getStyle?(): unknown;
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
  /** Map-constructor options for an owned selector/element target; invalid for an existing map host. */
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
 * The supplied module is retained only on this adapter instance. `style` and
 * `rendererOptions.mapOptions` configure owned map construction; an existing
 * map must already carry its caller-owned construction state.
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
        await waitUntilStyleReady(map, request.signal, host.owned);
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
        if (
          request.queryIntent === "explicit" &&
          plan.selected !== undefined &&
          plan.selected.strategy !== "geojson-query"
        ) {
          throw new HonuaAutomaticMapLibreStrategyError(
            "no-eligible-strategy",
            `The selected ${plan.selected.strategy} strategy cannot apply the explicit query. Select the geojson-query override or omit the query.`,
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

function maplibrePeer(value: MapLibreRendererPeer): ResolvedMapLibreRendererPeer {
  if (typeof value !== "object" || value === null) throw new TypeError("maplibreRenderer() requires an injected peer.");
  const fallback =
    value.default !== null && typeof value.default === "object" ? (value.default as MapLibreRendererPeer) : undefined;
  const MapConstructor = fallback?.Map ?? value.Map;
  const addProtocol = value.addProtocol ?? fallback?.addProtocol;
  const removeProtocol = value.removeProtocol ?? fallback?.removeProtocol;
  return Object.freeze({
    ...(typeof MapConstructor === "function" ? { Map: MapConstructor as ResolvedMapLibreRendererPeer["Map"] } : {}),
    ...(typeof addProtocol === "function"
      ? { addProtocol: addProtocol as ResolvedMapLibreRendererPeer["addProtocol"] }
      : {}),
    ...(typeof removeProtocol === "function"
      ? { removeProtocol: removeProtocol as ResolvedMapLibreRendererPeer["removeProtocol"] }
      : {}),
  });
}

function resolveMapHost<T>(
  peer: ResolvedMapLibreRendererPeer,
  target: RendererTarget,
  request: RendererMountRequest<T, MapLibreRendererOptions>,
  options: MapLibreRendererOptions,
): { readonly map: MapLibreRendererMap; readonly owned: boolean } {
  if (isMapHost(target)) {
    if (request.style !== undefined) {
      throw new TypeError(
        "MapLibre style is an owned-host construction option and cannot be applied to an existing map.",
      );
    }
    if (options.mapOptions !== undefined) {
      throw new TypeError(
        "MapLibre mapOptions are owned-host construction options and cannot be applied to an existing map.",
      );
    }
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

async function waitUntilStyleReady(map: MapLibreRendererMap, signal: AbortSignal, owned: boolean): Promise<void> {
  throwIfAborted(signal);
  assertReadinessHost(map);
  const event = owned ? "load" : "style.load";
  if (typeof map.isStyleLoaded === "function") {
    const isReady = (): boolean => map.isStyleLoaded?.() === true;
    while (!isReady()) {
      await (owned
        ? waitForEvent(map, event, signal, isReady)
        : waitForAnyEvent(map, [event, "data"], signal, isReady));
    }
    return;
  }
  if (typeof map.loaded === "function") {
    const isReady = (): boolean => map.loaded?.() === true;
    while (!isReady()) await waitForEvent(map, event, signal, isReady);
    return;
  }
  if (!owned && typeof map.getStyle === "function" && map.getStyle() !== undefined) return;
  await waitForEvent(map, event, signal);
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

function waitForEvent(
  map: ReadinessMapLibreRendererMap,
  event: string,
  signal: AbortSignal,
  isReady?: () => boolean,
): Promise<void> {
  return waitForAnyEvent(map, [event], signal, isReady);
}

function waitForAnyEvent(
  map: ReadinessMapLibreRendererMap,
  events: readonly string[],
  signal: AbortSignal,
  isReady?: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
      for (const event of events) map.off(event, completed);
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
      for (const event of events) {
        if (settled) break;
        map.once(event, completed);
      }
      if (isReady?.()) completed();
      if (signal.aborted) {
        if (settled) for (const event of events) map.off(event, completed);
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
