import { esriConfig } from "./esri-config.js";
import { CompatEventBus, resolveCompatEventBus, safeInvokeCompatListener } from "./event-bus.js";
import { identityManager } from "./identity-manager.js";
import {
  RouteLayerCompat,
  type RouteLayerCompatOptions,
  type RouteSolveResultCompat,
  type RouteStopCompat,
  routeStopFromUnknown,
} from "./route-layer.js";
import { RouteTaskCompat, type RouteTaskSolveResultCompat, arcGisRouteServiceProvider } from "./route-task.js";

/** Default `routeServiceUrl` on Esri `DirectionsViewModel` for the 4.x widget apps. */
const DEFAULT_ROUTE_SERVICE_URL = "https://route.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World";

export interface DirectionsCompatOptions {
  view?: unknown;
  container?: unknown;
  layer?: RouteLayerCompat;
  eventBus?: CompatEventBus;
  routeProvider?: RouteLayerCompatOptions["routeProvider"];
  routeServiceUrl?: string;
  apiKey?: string;
  stops?: readonly RouteStopCompat[];
  useDefaultRouteLayer?: boolean;
  showSaveAsButton?: boolean;
}

export interface DirectionsSolveSummaryCompat {
  stopCount: number;
  distanceMeters: number;
  durationSeconds: number;
}

export type DirectionsLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface DirectionsHandleCompat {
  remove(): void;
}

export class DirectionsCompat {
  public readonly view: unknown;
  public readonly container: unknown;
  public readonly eventBus: CompatEventBus;
  public loaded: boolean;
  public loadStatus: DirectionsLoadStatusCompat;
  public readonly useDefaultRouteLayer: boolean;
  public readonly showSaveAsButton: boolean;
  public readonly layer: RouteLayerCompat;
  public route: RouteSolveResultCompat | undefined;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;

  public constructor(options: DirectionsCompatOptions = {}) {
    this.view = options.view;
    this.container = options.container;
    this.eventBus = options.eventBus ?? resolveCompatEventBus(options.view, options.layer) ?? new CompatEventBus();
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.useDefaultRouteLayer = options.useDefaultRouteLayer ?? true;
    this.showSaveAsButton = options.showSaveAsButton ?? false;
    const routeServiceUrl = options.routeServiceUrl ?? DEFAULT_ROUTE_SERVICE_URL;
    this.layer =
      options.layer ??
      new RouteLayerCompat({
        url: routeServiceUrl,
        stops: options.stops,
        routeProvider: options.routeProvider ?? arcGisRouteServiceProvider(routeServiceUrl, options.apiKey),
        eventBus: this.eventBus,
      });
    mountDirectionsPanel(this.container);
    this.route = undefined;
    this.watchListeners = new Map();
  }

  public async load(): Promise<DirectionsCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("directions.loading", undefined, this);
    await this.layer.load();
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("directions.loaded", undefined, this);
    return this;
  }

  public async when(callback?: (widget: DirectionsCompat) => void): Promise<DirectionsCompat> {
    const widget = await this.load();
    if (callback) {
      callback(widget);
    }
    return widget;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): DirectionsHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);

    return {
      remove: () => {
        listeners?.delete(listener);
      },
    };
  }

  public setStops(stops: readonly RouteStopCompat[]): void {
    this.layer.clearStops();
    this.layer.addStops(stops);
    this.notifyWatchers("stops", this.layer.stops);
    this.eventBus.emit("directions.stops-updated", { stopCount: this.layer.stops.length }, this);
  }

  public addStop(stop: RouteStopCompat): void {
    this.layer.addStop(stop);
    this.notifyWatchers("stops", this.layer.stops);
    this.eventBus.emit("directions.stops-updated", { stopCount: this.layer.stops.length }, this);
  }

  public clearStops(): void {
    this.layer.clearStops();
    this.notifyWatchers("stops", this.layer.stops);
    this.route = undefined;
    this.notifyWatchers("route", this.route);
    this.eventBus.emit("directions.stops-cleared", undefined, this);
  }

  public async solve(): Promise<RouteSolveResultCompat | undefined> {
    this.eventBus.emit("directions.solve-started", { stopCount: this.layer.stops.length }, this);
    try {
      const route = await this.layer.solve();
      this.route = route;
      this.notifyWatchers("route", this.route);
      this.eventBus.emit("directions.solve-completed", { route }, this);
      return route;
    } catch (error) {
      this.route = undefined;
      this.notifyWatchers("route", this.route);
      this.eventBus.emit("directions.solve-error", { error }, this);
      throw error;
    }
  }

  public getSummary(): DirectionsSolveSummaryCompat | undefined {
    if (!this.route) {
      return undefined;
    }
    return {
      stopCount: this.layer.stops.length,
      distanceMeters: this.route.totalLengthMeters,
      durationSeconds: this.route.totalTimeSeconds,
    };
  }

  public destroy(): void {
    this.watchListeners.clear();
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}

/**
 * The Esri `DirectionsViewModel` shape used by webpack 4.x apps: a view, a stop
 * collection, `load`, `getDirections`, and `reset`. With no custom route
 * provider, `load` reads travel modes and `getDirections` solves
 * `routeServiceUrl` (the Esri world route service by default).
 */
export class DirectionsViewModelCompat {
  public view: unknown;
  public loaded: boolean;
  public selectedTravelMode: unknown;
  public readonly routeServiceUrl: string;
  /** Filled from the route service during `load`. `find` returns undefined until then. */
  public readonly travelModes: Array<{ name?: string }>;
  public readonly layer: RouteLayerCompat;
  public readonly stops: {
    removeAll(): void;
    addMany(stops: readonly unknown[]): void;
  };

  private readonly apiKey: string | undefined;
  private readonly routeProvider: RouteLayerCompatOptions["routeProvider"] | undefined;

  public constructor(
    options: {
      view?: unknown;
      routeServiceUrl?: string;
      apiKey?: string;
      routeProvider?: RouteLayerCompatOptions["routeProvider"];
    } = {},
  ) {
    this.view = options.view;
    this.loaded = false;
    this.selectedTravelMode = undefined;
    this.routeServiceUrl = options.routeServiceUrl ?? DEFAULT_ROUTE_SERVICE_URL;
    this.apiKey = options.apiKey;
    this.routeProvider = options.routeProvider;
    this.travelModes = [];
    this.layer = new RouteLayerCompat({ url: this.routeServiceUrl, routeProvider: options.routeProvider });
    this.stops = {
      removeAll: () => {
        this.layer.clearStops();
      },
      addMany: (stops) => {
        this.layer.addStops(stops.map((stop) => routeStopFromUnknown(stop)));
      },
    };
  }

  public async load(): Promise<this> {
    await this.layer.load();
    if (!this.routeProvider) {
      try {
        const modes = await readTravelModes(
          this.routeServiceUrl,
          tokenForRouteService(this.routeServiceUrl, this.apiKey),
        );
        this.travelModes.splice(0, this.travelModes.length, ...modes);
      } catch {
        // A missing mode catalog still leaves getDirections able to solve.
      }
    }
    this.loaded = true;
    return this;
  }

  public async getDirections(): Promise<RouteTaskSolveResultCompat | undefined> {
    if (this.layer.stops.length < 2) {
      return undefined;
    }
    const task = new RouteTaskCompat({
      url: this.routeProvider ? undefined : this.routeServiceUrl,
      apiKey: tokenForRouteService(this.routeServiceUrl, this.apiKey),
      routeProvider: this.routeProvider,
    });
    return task.solve({
      stops: [...this.layer.stops],
      returnDirections: true,
      travelMode: this.selectedTravelMode,
    });
  }

  public reset(): void {
    this.layer.clearStops();
    this.selectedTravelMode = undefined;
  }
}

async function readTravelModes(url: string, token: string | undefined): Promise<Array<{ name?: string }>> {
  const endpoint = new URL(`${url.replace(/\/$/, "")}/retrieveTravelModes`);
  endpoint.searchParams.set("f", "json");
  if (token) {
    endpoint.searchParams.set("token", token);
  }
  const response = await fetch(endpoint);
  const json = (await response.json()) as {
    error?: { message?: string };
    supportedTravelModes?: Array<{ name?: string }>;
  };
  if (!response.ok || json.error) {
    throw new Error(json.error?.message ?? `Travel modes failed (${response.status}).`);
  }
  return (json.supportedTravelModes ?? []).filter((mode) => mode && typeof mode === "object");
}

function mountDirectionsPanel(container: unknown): void {
  const element = resolveWidgetElement(container);
  if (!element || typeof document === "undefined") {
    return;
  }
  const panel = document.createElement("div");
  panel.className = "honua-directions";
  panel.textContent = "Directions";
  element.append(panel);
}

function resolveWidgetElement(container: unknown): HTMLElement | undefined {
  if (typeof HTMLElement !== "undefined" && container instanceof HTMLElement) {
    return container;
  }
  if (typeof container === "string" && typeof document !== "undefined") {
    const element = document.getElementById(container);
    return typeof HTMLElement !== "undefined" && element instanceof HTMLElement ? element : undefined;
  }
  return undefined;
}

function tokenForRouteService(url: string, apiKey: string | undefined): string | undefined {
  if (apiKey) {
    return apiKey;
  }
  if (esriConfig.apiKey) {
    return esriConfig.apiKey;
  }
  const direct = identityManager.findCredential(url);
  if (direct?.token) {
    return direct.token;
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host !== "arcgis.com" && !host.endsWith(".arcgis.com")) {
    return undefined;
  }
  for (let index = identityManager.credentials.length - 1; index >= 0; index -= 1) {
    const credential = identityManager.credentials[index];
    if (!credential) {
      continue;
    }
    if (typeof credential.expires === "number" && credential.expires <= Date.now()) {
      continue;
    }
    try {
      const credentialHost = new URL(credential.server).hostname;
      if (credentialHost === "arcgis.com" || credentialHost.endsWith(".arcgis.com")) {
        return credential.token;
      }
    } catch {}
  }
  return undefined;
}
