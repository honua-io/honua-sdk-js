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

export interface RoutePlaybackManifestQuery extends Partial<LiveQueryRequest> {
  baseUrl?: string;
  /** Post-query selector copied from ?routeId=... in live mode; not part of the echoed live queryRequest. */
  routeIdValue?: string | null;
}

export interface RoutePlaybackManifest {
  scenario?: string;
  sourceContract?: string;
  query?: RoutePlaybackManifestQuery | null;
  fieldMapping?: {
    /** Optional authoritative live route-id field copied from ?routeIdField=...; not part of the echoed live queryRequest. */
    routeId?: string | null;
    routeName?: string | null;
    startTimestamp?: string | null;
  } | null;
  playback?: {
    startTimestamp?: string | null;
    speedMetersPerSecond?: number;
  } | null;
}

export interface RoutePlaybackSource {
  sourceMode: "fixture" | "live";
  /** Fixture manifest in fixture mode, or a synthetic manifest derived from live params. */
  manifest: RoutePlaybackManifest | null;
  /** Fixture manifest query in fixture mode, or the exact bounded live query request in live mode; live echoes do not include routeId/routeIdField selectors. */
  queryRequest: RoutePlaybackManifestQuery | LiveQueryRequest | null;
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
  /** Fixture manifest query in fixture mode, or the exact bounded live query request in live mode; live echoes do not include routeId/routeIdField selectors. */
  queryRequest: RoutePlaybackManifestQuery | LiveQueryRequest | null;
  queryResponse: Record<string, unknown>;
  featureCount: number;
  routeName: string;
  /** Selected route id, preferring manifest.fieldMapping.routeId before alias fallbacks and normalizing numeric ids to strings; null when the selected feature has no route-id attribute. */
  routeId: string | null;
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
  /** Mirrors the normalized route id and stays null when the selected feature has no route-id attribute. */
  routeId: string | null;
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
  /** Fixture manifest query in fixture mode, or the exact bounded live query request in live mode; live echoes do not include routeId/routeIdField selectors. */
  queryRequest: RoutePlaybackManifestQuery | LiveQueryRequest | null;
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
