/**
 * `@honua/sdk-js/app` — framework-neutral app bootstrap helpers.
 *
 * The app helper composes existing SDK primitives without taking a static
 * dependency on a renderer. Pass a `map`, `mapFactory`, or prebuilt `runtime`
 * when the app should render; otherwise it returns package-aware controller
 * handles that can be bound by the host.
 *
 * @module
 */

import { createHonuaController } from "../app-controller/index.js";
import type { HonuaController, HonuaControllerOptions } from "../app-controller/index.js";
import type { SourceDescriptor } from "../contract/index.js";
import { HonuaClient } from "../core/client.js";
import type { HonuaClientOptions } from "../core/types.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  HonuaMapPackageError,
  fetchMapPackage,
  loadMapPackage,
  watchMapPackage,
} from "../runtime/index.js";
import type {
  FetchMapPackageOptions,
  FetchMapPackageResult,
  HonuaMapPackage,
  HonuaMapPackageProtocol,
  HonuaMapPackageSourceBinding,
  HonuaMapRuntime,
  LoadMapPackageOptions,
  MapPackageFetchCache,
  MapPackageFetchCacheState,
  MapPackageLocator,
  MapPackagePathResolver,
  MapPackageWatchEvent,
  MapPackageWatchHandle,
  MaplibreMap,
  WatchMapPackageOptions,
} from "../runtime/index.js";
import {
  createHonuaWebComponentController,
  createHonuaWebComponentControllerFromRuntime,
} from "../web-components/controller.js";
import type { CreateHonuaWebComponentControllerOptions, HonuaWebComponentController } from "../web-components/types.js";

export type HonuaAppLifecycleStage =
  | "initialize"
  | "auth"
  | "fetch"
  | "validate"
  | "source-bind"
  | "render"
  | "watch"
  | "dispose";

export type HonuaAppStatus = "idle" | "loading" | "ready" | "degraded" | "error" | "disposed";

export type HonuaAppLifecycleEvent<T = Record<string, unknown>> =
  | { readonly type: "status"; readonly status: HonuaAppStatus; readonly stage: HonuaAppLifecycleStage }
  | { readonly type: "client-ready"; readonly client: HonuaClient }
  | { readonly type: "package-loading"; readonly locator: MapPackageLocator }
  | {
      readonly type: "package-ready";
      readonly mapPackage: HonuaMapPackage;
      readonly fetch?: FetchMapPackageResult;
    }
  | { readonly type: "runtime-ready"; readonly runtime: HonuaMapRuntime; readonly map: MaplibreMap }
  | {
      readonly type: "controller-ready";
      readonly controller: HonuaController;
      readonly webComponentController: HonuaWebComponentController<T>;
    }
  | {
      readonly type: "degraded";
      readonly stage: Exclude<HonuaAppLifecycleStage, "dispose">;
      readonly reason: string;
      readonly error?: unknown;
      readonly sourceId?: string;
    }
  | {
      readonly type: "error";
      readonly stage: HonuaAppLifecycleStage;
      readonly error: unknown;
      readonly message: string;
    }
  | { readonly type: "watch"; readonly event: MapPackageWatchEvent }
  | { readonly type: "disposed" };

export type HonuaAppLifecycleListener<T = Record<string, unknown>> = (event: HonuaAppLifecycleEvent<T>) => void;

export interface HonuaAppSourceInput {
  readonly id: string;
  readonly title?: string;
  readonly descriptor: SourceDescriptor;
  readonly layer?:
    | {
        readonly id?: string;
        readonly type?: "circle" | "line" | "fill" | "symbol" | "raster" | "background";
        readonly paint?: Record<string, unknown>;
        readonly layout?: Record<string, unknown>;
      }
    | false;
  readonly initialView?: HonuaMapPackage["initialView"];
}

export interface HonuaAppMapFactoryContext {
  readonly container?: HTMLElement;
  readonly mapPackage: HonuaMapPackage;
}

export type HonuaAppMapFactory = (context: HonuaAppMapFactoryContext) => MaplibreMap | Promise<MaplibreMap>;

export interface HonuaAppWatchOptions
  extends Omit<WatchMapPackageOptions, "client" | "runtime" | "initialPackage" | "onEvent" | "onError" | "onUpdate"> {
  readonly onEvent?: (event: MapPackageWatchEvent) => void | Promise<void>;
}

export interface CreateHonuaAppOptions<T = Record<string, unknown>> {
  readonly client?: HonuaClient;
  readonly clientOptions?: HonuaClientOptions;
  readonly baseUrl?: string;
  readonly mapPackage?: HonuaMapPackage;
  readonly packageId?: string;
  readonly packageUrl?: string;
  readonly src?: string;
  readonly locator?: MapPackageLocator;
  readonly source?: HonuaAppSourceInput;
  readonly map?: MaplibreMap;
  readonly mapFactory?: HonuaAppMapFactory;
  readonly mapContainer?: HTMLElement;
  readonly mapElement?: HTMLElement;
  readonly runtime?: HonuaMapRuntime;
  readonly controller?: HonuaController;
  readonly webComponentController?: HonuaWebComponentController<T>;
  readonly fetch?: Omit<FetchMapPackageOptions, "client">;
  readonly load?: Omit<LoadMapPackageOptions, "client" | "onEvent">;
  readonly controllerOptions?: Omit<HonuaControllerOptions, "runtime">;
  readonly webComponents?: Omit<CreateHonuaWebComponentControllerOptions<T>, "mapPackage">;
  readonly watch?: boolean | HonuaAppWatchOptions;
  readonly onEvent?: HonuaAppLifecycleListener<T>;
}

export interface NormalizedHonuaAppOptions<T = Record<string, unknown>> {
  readonly client: HonuaClient;
  readonly packageSource:
    | { readonly kind: "inline"; readonly mapPackage: HonuaMapPackage }
    | { readonly kind: "locator"; readonly locator: MapPackageLocator }
    | { readonly kind: "source"; readonly source: HonuaAppSourceInput }
    | { readonly kind: "runtime" };
  readonly map?: MaplibreMap;
  readonly mapFactory?: HonuaAppMapFactory;
  readonly mapContainer?: HTMLElement;
  readonly runtime?: HonuaMapRuntime;
  readonly controller?: HonuaController;
  readonly webComponentController?: HonuaWebComponentController<T>;
  readonly fetch: Omit<FetchMapPackageOptions, "client">;
  readonly load: Omit<LoadMapPackageOptions, "client" | "onEvent">;
  readonly controllerOptions: Omit<HonuaControllerOptions, "runtime">;
  readonly webComponents: Omit<CreateHonuaWebComponentControllerOptions<T>, "mapPackage">;
  readonly watch: false | HonuaAppWatchOptions;
}

export interface HonuaAppHandle<T = Record<string, unknown>> {
  readonly client: HonuaClient;
  readonly mapPackage?: HonuaMapPackage;
  readonly fetch?: FetchMapPackageResult;
  readonly cache?: MapPackageFetchCacheState;
  readonly runtime?: HonuaMapRuntime;
  readonly controller: HonuaController;
  readonly webComponentController: HonuaWebComponentController<T>;
  readonly map?: MaplibreMap;
  readonly mapElement?: HTMLElement;
  readonly status: HonuaAppStatus;
  readonly degraded: boolean;
  readonly errors: readonly HonuaAppLifecycleEvent<T>[];
  readonly watcher?: MapPackageWatchHandle;
  on(listener: HonuaAppLifecycleListener<T>): { remove(): void };
  dispose(): void;
}

export async function createHonuaApp<T = Record<string, unknown>>(
  options: CreateHonuaAppOptions<T>,
): Promise<HonuaAppHandle<T>> {
  const normalized = normalizeHonuaAppOptions(options);
  const listeners = new Set<HonuaAppLifecycleListener<T>>();
  const recorded: HonuaAppLifecycleEvent<T>[] = [];
  let status: HonuaAppStatus = "idle";
  let disposed = false;
  let degraded = false;
  let watcher: MapPackageWatchHandle | undefined;

  const emit = (event: HonuaAppLifecycleEvent<T>): void => {
    if (event.type === "status") status = event.status;
    if (event.type === "degraded") degraded = true;
    if (event.type === "error") status = "error";
    recorded.push(event);
    options.onEvent?.(event);
    for (const listener of listeners) listener(event);
  };

  const emitError = (stage: HonuaAppLifecycleStage, error: unknown): void => {
    emit({ type: "error", stage, error, message: messageFromError(error) });
  };

  try {
    emit({ type: "status", status: "loading", stage: "initialize" });
    emit({ type: "client-ready", client: normalized.client });

    const packageResult = await resolvePackage(normalized, emit);
    const mapPackage = packageResult.mapPackage;

    const map =
      normalized.map ??
      (normalized.mapFactory
        ? await normalized.mapFactory({ container: normalized.mapContainer, mapPackage })
        : undefined);
    let runtime = normalized.runtime;
    if (!runtime && map) {
      emit({ type: "status", status: "loading", stage: "render" });
      runtime = await loadMapPackage(mapPackage, map, {
        ...normalized.load,
        client: normalized.client,
        onEvent: (event) => {
          if (event.type === "source-error") {
            emit({
              type: "degraded",
              stage: "source-bind",
              reason: `Source "${event.sourceId}" failed to bind.`,
              sourceId: event.sourceId,
              error: event.error,
            });
          }
        },
      });
      emit({ type: "runtime-ready", runtime, map });
    }

    const controller =
      normalized.controller ??
      createHonuaController({
        ...normalized.controllerOptions,
        ...(runtime ? { runtime } : {}),
      });
    const webComponentController =
      normalized.webComponentController ??
      (runtime
        ? createHonuaWebComponentControllerFromRuntime<T>(runtime, normalized.webComponents)
        : createHonuaWebComponentController<T>({
            ...normalized.webComponents,
            mapPackage,
            status: degraded ? "error" : "ready",
          }));

    emit({ type: "controller-ready", controller, webComponentController });

    const activeWatch = normalized.watch;
    if (activeWatch !== false && runtime && packageResult.locator) {
      watcher = watchMapPackage(packageResult.locator, {
        ...activeWatch,
        client: normalized.client,
        runtime,
        initialPackage: mapPackage,
        onEvent: async (event) => {
          emit({ type: "watch", event });
          await activeWatch.onEvent?.(event);
          if (event.type === "error") {
            emit({
              type: "degraded",
              stage: "watch",
              reason: "MapPackage watch reported an error.",
              error: event.error,
            });
          }
        },
      });
    }

    emit({ type: "status", status: degraded ? "degraded" : "ready", stage: "render" });

    return {
      client: normalized.client,
      mapPackage,
      ...(packageResult.fetch ? { fetch: packageResult.fetch, cache: packageResult.fetch.cache } : {}),
      ...(runtime ? { runtime } : {}),
      controller,
      webComponentController,
      ...(map ? { map } : {}),
      ...(normalized.mapContainer ? { mapElement: normalized.mapContainer } : {}),
      get status() {
        return disposed ? "disposed" : status;
      },
      get degraded() {
        return degraded;
      },
      get errors() {
        return recorded.filter((event) => event.type === "error" || event.type === "degraded");
      },
      ...(watcher ? { watcher } : {}),
      on(listener) {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        watcher?.dispose();
        normalized.webComponentController ? undefined : webComponentController.destroy?.();
        normalized.controller ? undefined : controller.dispose();
        normalized.runtime ? undefined : runtime?.dispose();
        emit({ type: "status", status: "disposed", stage: "dispose" });
        emit({ type: "disposed" });
        listeners.clear();
      },
    };
  } catch (error) {
    const stage = stageFromError(error);
    emitError(stage, error);
    throw error;
  }
}

export function normalizeHonuaAppOptions<T = Record<string, unknown>>(
  options: CreateHonuaAppOptions<T>,
): NormalizedHonuaAppOptions<T> {
  const client = options.client ?? new HonuaClient(normalizeClientOptions(options));
  return {
    client,
    packageSource: normalizePackageSource(options),
    ...(options.map ? { map: options.map } : {}),
    ...(options.mapFactory ? { mapFactory: options.mapFactory } : {}),
    ...((options.mapContainer ?? options.mapElement)
      ? { mapContainer: options.mapContainer ?? options.mapElement }
      : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.controller ? { controller: options.controller } : {}),
    ...(options.webComponentController ? { webComponentController: options.webComponentController } : {}),
    fetch: options.fetch ?? {},
    load: options.load ?? {},
    controllerOptions: options.controllerOptions ?? {},
    webComponents: options.webComponents ?? {},
    watch: normalizeWatchOptions(options.watch),
  };
}

function normalizeClientOptions<T>(options: CreateHonuaAppOptions<T>): HonuaClientOptions {
  const clientOptions = options.clientOptions ?? { baseUrl: options.baseUrl ?? "" };
  if (clientOptions.fetchFn || typeof globalThis.fetch !== "function") return clientOptions;
  return {
    ...clientOptions,
    fetchFn: globalThis.fetch.bind(globalThis),
  };
}

interface PackageResolution {
  readonly mapPackage: HonuaMapPackage;
  readonly fetch?: FetchMapPackageResult;
  readonly locator?: MapPackageLocator;
}

async function resolvePackage<T>(
  options: NormalizedHonuaAppOptions<T>,
  emit: (event: HonuaAppLifecycleEvent<T>) => void,
): Promise<PackageResolution> {
  switch (options.packageSource.kind) {
    case "runtime": {
      if (!options.runtime) {
        throw new HonuaMapPackageError("runtime package source requires a runtime handle", { stage: "load" });
      }
      const mapPackage = options.runtime.mapPackage;
      emit({ type: "package-ready", mapPackage });
      return { mapPackage };
    }
    case "inline":
      emit({ type: "package-ready", mapPackage: options.packageSource.mapPackage });
      return { mapPackage: options.packageSource.mapPackage };
    case "source": {
      const mapPackage = mapPackageFromSource(options.packageSource.source);
      emit({ type: "package-ready", mapPackage });
      return { mapPackage };
    }
    case "locator": {
      emit({ type: "package-loading", locator: options.packageSource.locator });
      const fetch = await fetchMapPackage(options.packageSource.locator, {
        ...options.fetch,
        client: options.client,
      });
      emit({ type: "package-ready", mapPackage: fetch.mapPackage, fetch });
      return { mapPackage: fetch.mapPackage, fetch, locator: options.packageSource.locator };
    }
  }
}

function normalizePackageSource<T>(options: CreateHonuaAppOptions<T>): NormalizedHonuaAppOptions<T>["packageSource"] {
  if (options.runtime) return { kind: "runtime" };
  if (options.mapPackage) return { kind: "inline", mapPackage: options.mapPackage };
  if (options.source) return { kind: "source", source: options.source };
  const locator = options.locator ?? options.packageUrl ?? options.src ?? options.packageId;
  if (locator) return { kind: "locator", locator };
  throw new HonuaMapPackageError(
    "createHonuaApp requires mapPackage, packageId, packageUrl, locator, source, or runtime",
    {
      stage: "load",
    },
  );
}

function normalizeWatchOptions(watch: CreateHonuaAppOptions["watch"]): false | HonuaAppWatchOptions {
  if (watch === undefined || watch === false) return false;
  if (watch === true) return {};
  return watch;
}

function mapPackageFromSource(source: HonuaAppSourceInput): HonuaMapPackage {
  const layer = source.layer === false ? undefined : (source.layer ?? {});
  const layerId = layer?.id ?? `${source.id}-layer`;
  return {
    mapPackageId: source.id,
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [sourceBindingFromDescriptor(source.descriptor)],
    ...(source.initialView ? { initialView: source.initialView } : {}),
    legend: [{ label: source.title ?? source.id }],
    mapSpec: {
      version: 8,
      sources: {},
      layers: layer
        ? [
            {
              id: layerId,
              source: source.descriptor.id,
              type: layer.type ?? "circle",
              metadata: { title: source.title ?? layerId },
              ...(layer.paint ? { paint: layer.paint } : {}),
              ...(layer.layout ? { layout: layer.layout } : {}),
            },
          ]
        : [],
    },
  };
}

function sourceBindingFromDescriptor(descriptor: SourceDescriptor): HonuaMapPackageSourceBinding {
  return {
    sourceId: descriptor.id,
    protocol: mapDescriptorProtocol(descriptor.protocol),
    locator: { ...descriptor.locator },
    ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
  };
}

function mapDescriptorProtocol(protocol: SourceDescriptor["protocol"]): HonuaMapPackageProtocol {
  switch (protocol) {
    case "geoservices-feature-service":
      return "geoservices_feature_service";
    case "geoservices-map-service":
      return "geoservices_map_service";
    case "ogc-features":
      return "ogc_features";
    case "ogc-maps":
      return "ogc_maps";
    case "ogc-tiles":
      return "ogc_tiles";
    case "maplibre-vector":
      return "vector_tile";
    case "maplibre-raster":
      return "raster_tile";
    case "wfs":
    case "wms":
    case "wmts":
    case "odata":
      return protocol;
    case "grpc":
    case "geoservices-image-service":
    case "geoservices-geometry-service":
    case "geoservices-gp-service":
    case "ogc-records":
    case "stac":
    case "maplibre-geojson":
      throw new HonuaMapPackageError(`SourceDescriptor protocol "${protocol}" cannot be projected to a MapPackage`, {
        stage: "source-bind",
      });
  }
}

function stageFromError(error: unknown): HonuaAppLifecycleStage {
  if (error instanceof HonuaMapPackageError) {
    if (error.stage === "fetch") return "fetch";
    if (error.stage === "validate") return "validate";
    if (error.stage === "source-bind") return "source-bind";
    if (error.stage === "view" || error.stage === "load" || error.stage === "style-compose") return "render";
  }
  if (isAuthLikeError(error)) return "auth";
  return "render";
}

function isAuthLikeError(error: unknown): boolean {
  const status =
    typeof error === "object" && error ? (error as { status?: unknown; code?: unknown }).status : undefined;
  const statusCode = typeof error === "object" && error ? (error as { statusCode?: unknown }).statusCode : undefined;
  const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
  return (
    status === 401 ||
    status === 403 ||
    statusCode === 401 ||
    statusCode === 403 ||
    code === "unauthenticated" ||
    code === "permission-denied"
  );
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type {
  HonuaClientOptions,
  MapPackageFetchCache,
  MapPackageLocator,
  MapPackagePathResolver,
  MapPackageWatchEvent,
  MapPackageWatchHandle,
  MaplibreMap,
};
