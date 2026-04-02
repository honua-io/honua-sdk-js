export interface ExampleConfig {
  mode: "fixture" | "live";
  baseUrl: string;
  serviceId: string;
  layerId: number;
  /** Live-mode post-query selector for multi-feature route responses; matching normalizes strings and numeric ids. */
  routeId: string;
  /** Optional live attribute name treated as authoritative for route-id matching and preferred normalized output. */
  routeIdField: string;
  where: string;
  objectIds: string;
  /** Defaults to 1; raise this when routeId must choose among multiple live features. */
  resultRecordCount: number;
  fixtureUrl: string;
  /** Fixture-only manifest URL. Live mode derives a synthetic manifest instead. */
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
  /** Fixture manifest in fixture mode, or a synthetic manifest derived from live params. */
  manifest: Record<string, unknown> | null;
  queryRequest: unknown;
  queryResponse: Record<string, unknown>;
  /** Live-mode compatibility result from checkCompatibility(); null in fixture mode. */
  compatibility?: {
    supported?: boolean;
    reasons?: string[];
  } | null;
  /** Live-mode query duration captured from the temporary interceptor; null in fixture mode. */
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
  /** Selected route id, preferring manifest.fieldMapping.routeId before alias fallbacks and normalizing numeric ids to strings. */
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

/** Browser-facing success summary exposed on window.__cesiumRoutePlaybackResult. */
export interface RoutePlaybackResultSummary {
  sourceMode: "fixture" | "live";
  routeName: string;
  routeId: string;
  featureCount: number;
  vertexCount: number;
  hasZ: boolean;
  terrainEnabled: boolean;
  terrainMode: string;
  heightMode: string;
  /** checkCompatibility().supported in live mode, otherwise null for fixture mode. */
  compatibilitySupported: boolean | null;
  /** Live query duration in milliseconds, otherwise null for fixture mode. */
  requestDurationMs: number | null;
  /** Fixture manifest query in fixture mode, or the bounded live query request in live mode. */
  queryRequest: unknown;
  warnings: string[];
  preprocessingSteps: string[];
  entityCount: number;
}

export interface RoutePlaybackRequestInterceptor {
  after?: (context: { durationMs: number }) => void;
  error?: (context: { durationMs?: number }) => void;
}

export interface RoutePlaybackLiveClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  interceptors?: RoutePlaybackRequestInterceptor[];
}

export interface RoutePlaybackLiveClient {
  checkCompatibility(): Promise<{
    supported?: boolean;
    reasons?: string[];
  }>;
  queryFeatures(request: LiveQueryRequest): Promise<Record<string, unknown>>;
}

export interface RoutePlaybackLiveClientConstructor {
  new (options: RoutePlaybackLiveClientOptions): RoutePlaybackLiveClient;
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
    HonuaClient?: RoutePlaybackLiveClientConstructor;
  },
): Promise<RoutePlaybackSource>;
export function normalizeRoutePlaybackSource(
  source: RoutePlaybackSource,
  config?: Partial<ExampleConfig>,
): NormalizedRoutePlayback;
