const DEFAULT_FIXTURE_URL = "./fixtures/route-query-response.json";
const DEFAULT_MANIFEST_URL = "./fixtures/source-manifest.json";
const DEFAULT_RESULT_RECORD_COUNT = 1;
const DEFAULT_PLAYBACK_START_ISO = "2026-01-01T00:00:00Z";
const ROUTE_NAME_FIELDS = ["route_name", "routeName", "name", "Name"];
const ROUTE_ID_FIELDS = ["route_id", "routeId", "ROUTE_ID", "Name"];
const EARTH_RADIUS_METERS = 6_371_008.8;

export const DEFAULT_PLAYBACK_SPEED_METERS_PER_SECOND = 18;

export function createExampleConfig(search = "") {
  const params = new URLSearchParams(search);

  return {
    mode: params.get("mode") === "live" ? "live" : "fixture",
    baseUrl: trimTrailingSlash(params.get("baseUrl") ?? ""),
    serviceId: params.get("serviceId") ?? "route-playback-demo",
    layerId: parseInteger(params.get("layerId"), 0),
    where: params.get("where") ?? "1=1",
    objectIds: params.get("objectIds") ?? "",
    resultRecordCount: parseInteger(params.get("resultRecordCount"), DEFAULT_RESULT_RECORD_COUNT),
    fixtureUrl: params.get("fixtureUrl") ?? DEFAULT_FIXTURE_URL,
    manifestUrl: params.get("manifestUrl") ?? DEFAULT_MANIFEST_URL,
    terrainUrl: params.get("terrainUrl") ?? "",
    ionToken: params.get("ionToken") ?? "",
    speedMetersPerSecond: parsePositiveNumber(params.get("speed"), DEFAULT_PLAYBACK_SPEED_METERS_PER_SECOND),
  };
}

export function createLiveQueryRequest(config) {
  const request = {
    serviceId: config.serviceId,
    layerId: config.layerId,
    where: config.where,
    outFields: ["*"],
    outSr: 4326,
    returnGeometry: true,
    resultRecordCount: config.resultRecordCount,
    extraParams: {
      outSr: 4326,
      returnZ: true,
    },
  };

  if (config.objectIds) {
    request.objectIds = config.objectIds;
  }

  return request;
}

export async function loadRouteSource(config, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;

  if (config.mode === "fixture") {
    const [manifest, queryResponse] = await Promise.all([
      fetchJson(config.manifestUrl, fetchFn),
      fetchJson(config.fixtureUrl, fetchFn),
    ]);

    return {
      sourceMode: "fixture",
      manifest,
      queryRequest: manifest.query ?? null,
      queryResponse,
      compatibility: null,
      requestDurationMs: null,
    };
  }

  if (typeof options.HonuaClient !== "function") {
    throw new Error("Live mode requires a HonuaClient constructor.");
  }
  if (!config.baseUrl) {
    throw new Error("Live mode requires a baseUrl query parameter.");
  }

  let requestDurationMs = null;
  const clientFetchFn =
    options.fetchFn ??
    (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : undefined);
  const client = new options.HonuaClient({
    baseUrl: config.baseUrl,
    fetchFn: clientFetchFn,
    interceptors: [
      {
        after(context) {
          requestDurationMs = context.durationMs;
        },
        error(context) {
          if (typeof context.durationMs === "number") {
            requestDurationMs = context.durationMs;
          }
        },
      },
    ],
  });

  const compatibility = await client.checkCompatibility();
  if (!compatibility.supported) {
    throw new Error(`Server compatibility check failed: ${compatibility.reasons.join("; ")}`);
  }

  const queryRequest = createLiveQueryRequest(config);
  const queryResponse = await client.queryFeatures(queryRequest);

  return {
    sourceMode: "live",
    manifest: createLiveManifest(config, queryRequest),
    queryRequest,
    queryResponse,
    compatibility,
    requestDurationMs,
  };
}

export function normalizeRoutePlaybackSource(source, config = {}) {
  const queryResponse = asRecord(source.queryResponse, "Honua route query response");
  const features = Array.isArray(queryResponse.features) ? queryResponse.features : [];
  const featureCount = features.length;
  const polylineFeatures = features.filter((feature) => isPolylineFeature(feature?.geometry));

  if (polylineFeatures.length === 0) {
    throw new Error("No polyline geometry was found in the Honua query response.");
  }

  const selectedFeature =
    findFeatureByManifestRouteId(polylineFeatures, source.manifest) ?? selectFeatureWithMostVertices(polylineFeatures);
  const geometry = selectedFeature.geometry;
  const paths = geometry.paths.filter((path) => Array.isArray(path) && path.length >= 2);

  if (paths.length === 0) {
    throw new Error("The selected route geometry did not contain a path with at least two vertices.");
  }

  const longestPath = selectLongestPath(paths);
  const positions = longestPath.map((coordinate) => normalizeCoordinate(coordinate)).filter(Boolean);

  if (positions.length < 2) {
    throw new Error("The selected route geometry did not contain enough valid coordinates for playback.");
  }

  const speedMetersPerSecond = Number.isFinite(config.speedMetersPerSecond)
    ? Math.max(1, config.speedMetersPerSecond)
    : DEFAULT_PLAYBACK_SPEED_METERS_PER_SECOND;
  const startTimestampMs = readPlaybackStartTimestamp(source.manifest);
  const playbackSamples = buildPlaybackSamples(positions, speedMetersPerSecond, startTimestampMs);
  const hasZ = positions.some((position) => Number.isFinite(position.sourceZ));
  const totalDistanceMeters =
    playbackSamples.length > 0 ? playbackSamples[playbackSamples.length - 1].distanceMeters : 0;
  const preprocessingSteps = [
    source.sourceMode === "live"
      ? "Queried a live Honua FeatureServer layer with outSr=4326, returnGeometry=true, and returnZ=true."
      : "Loaded a checked-in Honua FeatureServer/query fixture for deterministic playback.",
    paths.length > 1
      ? "Selected the longest path from a multi-part polyline before playback."
      : "Read the single route polyline path directly from the Honua query response.",
    hasZ
      ? "Preserved source Z values as display heights when terrain sampling is disabled."
      : "Applied an ellipsoid height fallback of 0 meters because the source route had no Z values.",
    `Derived playback timestamps from cumulative distance at ${speedMetersPerSecond} meters/second.`,
  ];

  return {
    sourceMode: source.sourceMode,
    queryRequest: source.queryRequest,
    queryResponse,
    featureCount,
    routeName: readRouteName(selectedFeature.attributes),
    routeId: readRouteId(selectedFeature.attributes),
    attributes: selectedFeature.attributes ?? {},
    geometryType: queryResponse.geometryType ?? "esriGeometryPolyline",
    pathCount: paths.length,
    vertexCount: positions.length,
    hasZ,
    speedMetersPerSecond,
    playbackDurationSeconds:
      playbackSamples.length > 0 ? playbackSamples[playbackSamples.length - 1].secondsFromStart : 0,
    totalDistanceMeters,
    positions,
    playbackSamples,
    preprocessingSteps,
    warnings: [],
  };
}

function createLiveManifest(config, queryRequest) {
  return {
    scenario: "Route playback with elevation context",
    sourceContract: "FeatureServer/query",
    query: {
      ...queryRequest,
      baseUrl: config.baseUrl,
    },
    fieldMapping: {
      routeId: "route_id",
      routeName: "route_name",
      startTimestamp: null,
    },
  };
}

async function fetchJson(url, fetchFn) {
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function isPolylineFeature(geometry) {
  return Boolean(geometry && Array.isArray(geometry.paths));
}

function findFeatureByManifestRouteId(features, manifest) {
  const routeIdField = manifest?.fieldMapping?.routeId;
  const routeIdValue = manifest?.query?.routeIdValue;

  if (!routeIdField || routeIdValue === undefined || routeIdValue === null) {
    return null;
  }

  return features.find((feature) => feature?.attributes?.[routeIdField] === routeIdValue) ?? null;
}

function selectFeatureWithMostVertices(features) {
  return features.reduce((selected, candidate) => {
    return countFeatureVertices(candidate) > countFeatureVertices(selected) ? candidate : selected;
  });
}

function countFeatureVertices(feature) {
  if (!feature?.geometry?.paths) {
    return 0;
  }

  return feature.geometry.paths.reduce((total, path) => total + (Array.isArray(path) ? path.length : 0), 0);
}

function selectLongestPath(paths) {
  return paths.reduce((selected, candidate) => {
    return candidate.length > selected.length ? candidate : selected;
  });
}

function normalizeCoordinate(coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return null;
  }

  const longitude = Number(coordinate[0]);
  const latitude = Number(coordinate[1]);
  const sourceZ = coordinate.length >= 3 ? Number(coordinate[2]) : null;

  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return null;
  }

  return {
    longitude,
    latitude,
    sourceZ: Number.isFinite(sourceZ) ? sourceZ : null,
  };
}

function buildPlaybackSamples(positions, speedMetersPerSecond, startTimestampMs) {
  let distanceMeters = 0;

  return positions.map((position, index) => {
    if (index > 0) {
      distanceMeters += haversineDistanceMeters(positions[index - 1], position);
    }

    const secondsFromStart = distanceMeters / speedMetersPerSecond;
    return {
      ...position,
      distanceMeters,
      secondsFromStart,
      timestampMs: startTimestampMs + secondsFromStart * 1_000,
      heightMeters: position.sourceZ ?? 0,
    };
  });
}

function readPlaybackStartTimestamp(manifest) {
  const value = manifest?.playback?.startTimestamp ?? DEFAULT_PLAYBACK_START_ISO;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.parse(DEFAULT_PLAYBACK_START_ISO);
}

function readRouteName(attributes = {}) {
  return readAttributeValue(attributes, ROUTE_NAME_FIELDS) ?? "Route playback demo";
}

function readRouteId(attributes = {}) {
  return readAttributeValue(attributes, ROUTE_ID_FIELDS) ?? "route-playback-demo";
}

function readAttributeValue(attributes, candidates) {
  for (const key of candidates) {
    const value = attributes[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function haversineDistanceMeters(from, to) {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseInteger(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function asRecord(value, label) {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} was not an object.`);
  }
  return value;
}
