export interface ExampleConfig {
  mode: "fixture" | "live";
  baseUrl: string;
  serviceId: string;
  layerId: number;
  routeId: string;
  routeIdField: string;
  where: string;
  objectIds: string;
  resultRecordCount: number;
  fixtureUrl: string;
  manifestUrl: string;
  terrainUrl: string;
  ionToken: string;
  speedMetersPerSecond: number;
}

export interface LiveQueryRequest {
  serviceId: string;
  layerId: number;
  where: string;
  outFields: string[];
  outSr: number;
  returnGeometry: boolean;
  resultRecordCount: number;
  objectIds?: string;
  extraParams: Record<string, string | number | boolean>;
}

export interface RoutePlaybackSource {
  sourceMode: "fixture" | "live";
  manifest: Record<string, unknown> | null;
  queryRequest: unknown;
  queryResponse: Record<string, unknown>;
  compatibility?: {
    supported?: boolean;
    reasons?: string[];
  } | null;
  requestDurationMs?: number | null;
}

export interface RoutePlaybackPosition {
  longitude: number;
  latitude: number;
  sourceZ: number | null;
}

export interface RoutePlaybackSample extends RoutePlaybackPosition {
  distanceMeters: number;
  secondsFromStart: number;
  timestampMs: number;
  heightMeters: number;
}

export interface NormalizedRoutePlayback {
  sourceMode: "fixture" | "live";
  queryRequest: unknown;
  queryResponse: Record<string, unknown>;
  featureCount: number;
  routeName: string;
  routeId: string;
  attributes: Record<string, unknown>;
  geometryType: string;
  pathCount: number;
  vertexCount: number;
  hasZ: boolean;
  speedMetersPerSecond: number;
  playbackDurationSeconds: number;
  totalDistanceMeters: number;
  positions: RoutePlaybackPosition[];
  playbackSamples: RoutePlaybackSample[];
  preprocessingSteps: string[];
  warnings: string[];
}

export const DEFAULT_PLAYBACK_SPEED_METERS_PER_SECOND: number;

export function createExampleConfig(search?: string): ExampleConfig;
export function createLiveQueryRequest(config: Pick<
  ExampleConfig,
  "serviceId" | "layerId" | "where" | "resultRecordCount" | "objectIds"
>): LiveQueryRequest;
export function loadRouteSource(
  config: ExampleConfig,
  options?: {
    fetchFn?: typeof fetch;
    HonuaClient?: new (...args: unknown[]) => unknown;
  },
): Promise<RoutePlaybackSource>;
export function normalizeRoutePlaybackSource(
  source: RoutePlaybackSource,
  config?: Partial<ExampleConfig>,
): NormalizedRoutePlayback;
