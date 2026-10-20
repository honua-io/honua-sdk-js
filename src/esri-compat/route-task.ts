import { esriConfig } from "./esri-config.js";
import { CompatEventBus, safeInvokeCompatListener } from "./event-bus.js";
import { identityManager } from "./identity-manager.js";
import { coordinateToLonLat } from "./map-view-mount.js";
import {
  RouteLayerCompat,
  type RouteLayerCompatOptions,
  type RouteSolveResultCompat,
  type RouteStopCompat,
  routeStopFromUnknown,
} from "./route-layer.js";

export interface RouteTaskCompatOptions {
  url?: string;
  apiKey?: string;
  requestOptions?: Record<string, unknown>;
  eventBus?: CompatEventBus;
  routeProvider?: RouteLayerCompatOptions["routeProvider"];
}

export interface RouteTaskStopFeatureCompat {
  geometry?: {
    x?: number;
    y?: number;
    longitude?: number;
    latitude?: number;
  };
  attributes?: Record<string, unknown>;
}

export interface RouteTaskStopsFeatureSetCompat {
  features?: readonly RouteTaskStopFeatureCompat[];
}

export interface RouteTaskSolveParametersCompat {
  stops?: readonly RouteStopCompat[] | RouteTaskStopsFeatureSetCompat;
  returnDirections?: boolean;
  /** ArcGIS travel mode name or the mode object returned by retrieveTravelModes. */
  travelMode?: unknown;
}

export interface RouteTaskDirectionsFeatureCompat {
  attributes: {
    text: string;
    length: number;
    time: number;
  };
  geometry: {
    paths: [number, number][][];
    spatialReference: {
      wkid: number;
    };
  };
}

export interface RouteTaskDirectionsSummaryCompat {
  totalLength: number;
  totalTime: number;
  features: readonly RouteTaskDirectionsFeatureCompat[];
}

export interface RouteTaskResultGraphicCompat {
  geometry: {
    paths: [number, number][][];
    spatialReference: {
      wkid: number;
    };
  };
  attributes: {
    Total_Kilometers: number;
    Total_Miles: number;
    Total_TravelTime: number;
    Total_Length: number;
  };
}

export interface RouteTaskRouteResultCompat {
  route: RouteTaskResultGraphicCompat;
  directions?: RouteTaskDirectionsSummaryCompat;
  stops: readonly RouteStopCompat[];
}

export interface RouteTaskSolveResultCompat {
  routeResults: readonly RouteTaskRouteResultCompat[];
}

export type RouteTaskLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface RouteTaskHandleCompat {
  remove(): void;
}

export class RouteTaskCompat {
  public readonly url: string | undefined;
  public readonly apiKey: string | undefined;
  public readonly requestOptions: Readonly<Record<string, unknown>> | undefined;
  public readonly eventBus: CompatEventBus;
  public loaded: boolean;
  public loadStatus: RouteTaskLoadStatusCompat;
  public lastSolveResult: RouteTaskSolveResultCompat | undefined;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;

  private readonly routeProvider: RouteLayerCompatOptions["routeProvider"] | undefined;

  public constructor(options: RouteTaskCompatOptions | string = {}) {
    if (typeof options === "string") {
      this.url = options;
      this.apiKey = undefined;
      this.requestOptions = undefined;
      this.eventBus = new CompatEventBus();
      this.loaded = false;
      this.loadStatus = "not-loaded";
      this.lastSolveResult = undefined;
      this.watchListeners = new Map();
      this.routeProvider = undefined;
      return;
    }

    this.url = options.url;
    this.apiKey = options.apiKey;
    this.requestOptions = options.requestOptions ? { ...options.requestOptions } : undefined;
    this.eventBus = options.eventBus ?? new CompatEventBus();
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.lastSolveResult = undefined;
    this.watchListeners = new Map();
    this.routeProvider = options.routeProvider;
  }

  public async load(): Promise<RouteTaskCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("route-task.loading", undefined, this);
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.eventBus.emit("route-task.loaded", undefined, this);
    return this;
  }

  public async when(callback?: (task: RouteTaskCompat) => void): Promise<RouteTaskCompat> {
    const task = await this.load();
    if (callback) {
      callback(task);
    }
    return task;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): RouteTaskHandleCompat {
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

  public async solve(params: RouteTaskSolveParametersCompat = {}): Promise<RouteTaskSolveResultCompat> {
    const stops = normalizeStops(params.stops);
    if (stops.length < 2) {
      const error = new Error("RouteTask requires at least two stops.");
      this.eventBus.emit("route-task.solve-error", { error }, this);
      throw error;
    }

    this.eventBus.emit("route-task.solve-started", { stopCount: stops.length }, this);
    try {
      const layer = new RouteLayerCompat({
        stops,
        routeProvider:
          this.routeProvider ??
          (this.url && hasRouteService(this.url)
            ? arcGisRouteServiceProvider(this.url, this.apiKey, params.travelMode)
            : undefined),
        eventBus: this.eventBus,
      });
      const route = await layer.solve();
      if (!route) {
        throw new Error("RouteTask solve produced no route result.");
      }

      const result = buildSolveResult(route, stops, params.returnDirections ?? true);
      this.lastSolveResult = result;
      this.notifyWatchers("lastSolveResult", this.lastSolveResult);
      this.eventBus.emit("route-task.solve-completed", { routeResults: result.routeResults }, this);
      return result;
    } catch (error) {
      this.lastSolveResult = undefined;
      this.notifyWatchers("lastSolveResult", this.lastSolveResult);
      this.eventBus.emit("route-task.solve-error", { error }, this);
      throw error;
    }
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

function hasRouteService(url: string): boolean {
  try {
    // `example.test` is the reserved placeholder host used by migrated fixture
    // apps. It has no service to call, so retain the local route fallback.
    return new URL(url).hostname.toLowerCase() !== "example.test";
  } catch {
    return true;
  }
}

function normalizeStops(rawStops: RouteTaskSolveParametersCompat["stops"]): readonly RouteStopCompat[] {
  if (!rawStops) {
    return [];
  }
  if (Array.isArray(rawStops)) {
    return rawStops.map((stop) => routeStopFromUnknown(stop));
  }

  const featureSet = rawStops as RouteTaskStopsFeatureSetCompat;
  const features = featureSet.features ?? [];
  const stops: RouteStopCompat[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) {
      continue;
    }
    const x = geometry.x ?? geometry.longitude;
    const y = geometry.y ?? geometry.latitude;
    if (typeof x !== "number" || typeof y !== "number") {
      continue;
    }
    const name = typeof feature.attributes?.Name === "string" ? feature.attributes.Name : undefined;
    stops.push({
      name,
      location: [x, y],
    });
  }
  return stops;
}

export function buildRouteTaskSolveResult(
  route: RouteSolveResultCompat,
  stops: readonly RouteStopCompat[],
  includeDirections: boolean,
): RouteTaskSolveResultCompat {
  return buildSolveResult(route, stops, includeDirections);
}

export function arcGisRouteServiceProvider(
  url: string,
  apiKey: string | undefined,
  travelMode?: unknown,
): NonNullable<RouteLayerCompatOptions["routeProvider"]> {
  return async (stops) => {
    const solveUrl = new URL(`${url.replace(/\/$/, "")}/solve`);
    solveUrl.searchParams.set("f", "json");
    solveUrl.searchParams.set("outSR", "4326");
    solveUrl.searchParams.set("returnDirections", "true");
    solveUrl.searchParams.set("directionsLengthUnits", "esriNAUKilometers");
    solveUrl.searchParams.set(
      "stops",
      JSON.stringify({
        features: stops.map((stop) => ({
          geometry: stopGeometry(stop),
          attributes: { Name: stop.name ?? "" },
        })),
      }),
    );
    if (travelMode !== undefined && travelMode !== null) {
      solveUrl.searchParams.set("travelMode", typeof travelMode === "string" ? travelMode : JSON.stringify(travelMode));
    }
    const token = apiKey ?? esriConfig.apiKey ?? identityManager.findCredential(url)?.token;
    if (token) {
      solveUrl.searchParams.set("token", token);
    }
    const response = await fetch(solveUrl);
    const json = (await response.json()) as {
      error?: { message?: string };
      routes?: {
        features?: Array<{
          geometry?: { paths?: number[][][]; spatialReference?: { wkid?: number } };
          attributes?: Record<string, unknown>;
        }>;
      };
      directions?: Array<{
        features?: Array<{ attributes?: { text?: unknown; length?: unknown; time?: unknown } }>;
      }>;
    };
    if (!response.ok || json.error) {
      throw new Error(json.error?.message ?? `Route solve failed (${response.status}).`);
    }
    const feature = json.routes?.features?.[0];
    const pathWkid = feature?.geometry?.spatialReference?.wkid;
    const path = (feature?.geometry?.paths ?? []).flatMap((ring) =>
      ring
        .filter((point) => point.length >= 2)
        .map((point) => coordinateToLonLat([point[0] ?? 0, point[1] ?? 0], pathWkid))
        .filter((point): point is [number, number] => point !== undefined),
    );
    const kilometers = numberAttribute(feature?.attributes, "Total_Kilometers");
    const minutes = numberAttribute(feature?.attributes, "Total_TravelTime");
    const metersFromPath = pathLengthMeters(path);
    const directionFeatures = (json.directions?.[0]?.features ?? [])
      .map((step) => {
        const text = step.attributes?.text;
        if (typeof text !== "string" || text.length === 0) {
          return undefined;
        }
        const length = step.attributes?.length;
        const time = step.attributes?.time;
        return {
          text,
          lengthKilometers: typeof length === "number" && Number.isFinite(length) ? length : 0,
          timeMinutes: typeof time === "number" && Number.isFinite(time) ? time : 0,
        };
      })
      .filter((step): step is NonNullable<typeof step> => step !== undefined);
    return {
      path: path.length > 0 ? path : stops.map((stop) => [stop.location[0], stop.location[1]]),
      totalLengthMeters: kilometers !== undefined ? kilometers * 1000 : metersFromPath,
      totalTimeSeconds: minutes !== undefined ? minutes * 60 : metersFromPath / 13.4112,
      ...(directionFeatures.length > 0 ? { directionFeatures } : {}),
    };
  };
}

function stopGeometry(stop: RouteStopCompat): { x: number; y: number; spatialReference: { wkid: number } } {
  const [x, y] = stop.location;
  const webMercator = Math.abs(x) > 180 || Math.abs(y) > 90;
  return { x, y, spatialReference: { wkid: webMercator ? 102100 : 4326 } };
}

function numberAttribute(attributes: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = attributes?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathLengthMeters(path: readonly [number, number][]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    if (!previous || !current) {
      continue;
    }
    const dLon = ((current[0] - previous[0]) * Math.PI) / 180;
    const dLat = ((current[1] - previous[1]) * Math.PI) / 180;
    const lat1 = (previous[1] * Math.PI) / 180;
    const lat2 = (current[1] * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    total += 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

function buildSolveResult(
  route: RouteSolveResultCompat,
  stops: readonly RouteStopCompat[],
  includeDirections: boolean,
): RouteTaskSolveResultCompat {
  const kilometers = route.totalLengthMeters / 1000;
  const miles = route.totalLengthMeters * 0.000621371;
  const totalMinutes = route.totalTimeSeconds / 60;
  const directionsFeatures = includeDirections ? buildDirectionFeatures(route) : [];

  return {
    routeResults: [
      {
        route: {
          geometry: {
            paths: [route.path.map((point) => [point[0], point[1]])],
            spatialReference: { wkid: 4326 },
          },
          attributes: {
            Total_Kilometers: kilometers,
            Total_Miles: miles,
            Total_TravelTime: totalMinutes,
            Total_Length: kilometers,
          },
        },
        directions: includeDirections
          ? {
              totalLength: kilometers,
              totalTime: totalMinutes,
              features: directionsFeatures,
            }
          : undefined,
        stops: stops.map((stop) => ({ name: stop.name, location: [stop.location[0], stop.location[1]] })),
      },
    ],
  };
}

function buildDirectionFeatures(route: RouteSolveResultCompat): readonly RouteTaskDirectionsFeatureCompat[] {
  if (route.directionFeatures && route.directionFeatures.length > 0) {
    const path = route.path.map((point) => [point[0], point[1]] as [number, number]);
    return route.directionFeatures.map((step) => ({
      attributes: {
        text: step.text,
        length: step.lengthKilometers,
        time: step.timeMinutes,
      },
      geometry: {
        paths: [path],
        spatialReference: { wkid: 4326 },
      },
    }));
  }
  if (route.path.length < 2 || route.totalLengthMeters <= 0) {
    return [];
  }

  const features: RouteTaskDirectionsFeatureCompat[] = [];
  for (let i = 1; i < route.path.length; i += 1) {
    const start = route.path[i - 1];
    const end = route.path[i];
    const segmentMeters = haversineDistanceMeters(start, end);
    if (segmentMeters <= 0) {
      continue;
    }
    const ratio = segmentMeters / route.totalLengthMeters;
    const segmentTimeMinutes = (route.totalTimeSeconds * ratio) / 60;
    features.push({
      attributes: {
        text: `Segment ${i}`,
        length: segmentMeters / 1000,
        time: segmentTimeMinutes,
      },
      geometry: {
        paths: [
          [
            [start[0], start[1]],
            [end[0], end[1]],
          ],
        ],
        spatialReference: { wkid: 4326 },
      },
    });
  }

  return features;
}

function haversineDistanceMeters(a: [number, number], b: [number, number]): number {
  const [lonA, latA] = a;
  const [lonB, latB] = b;
  const dLat = toRadians(latB - latA);
  const dLon = toRadians(lonB - lonA);
  const latARad = toRadians(latA);
  const latBRad = toRadians(latB);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(latARad) * Math.cos(latBRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return 6371008.8 * c;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
