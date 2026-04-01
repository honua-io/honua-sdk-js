#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.cwd();
const repoRoot = path.resolve(packageRoot, "../..");
const dataRoot = path.join(packageRoot, "public", "data");
const builtSdkEntry = path.join(repoRoot, "dist", "src", "honua.js");

const DATASET_SPECS = [
  {
    id: "incidents",
    label: "Incident escalations",
    path: "/data/incidents.geojson",
    filename: "incidents.geojson",
    description: "Response incidents exported from the Honua incident replay contract.",
    serviceEnv: "HONUA_DEMO_INCIDENTS_SERVICE_ID",
    layerEnv: "HONUA_DEMO_INCIDENTS_LAYER_ID",
    defaultServiceId: "ops-analytics",
    defaultLayerId: 0,
    timeField: "replay_at"
  },
  {
    id: "unit-tracks",
    label: "Unit pings",
    path: "/data/unit-tracks.geojson",
    filename: "unit-tracks.geojson",
    description: "Timestamped unit positions exported from the same Honua replay environment.",
    serviceEnv: "HONUA_DEMO_UNIT_TRACKS_SERVICE_ID",
    layerEnv: "HONUA_DEMO_UNIT_TRACKS_LAYER_ID",
    defaultServiceId: "ops-analytics",
    defaultLayerId: 1,
    timeField: "replay_at"
  },
  {
    id: "coverage-zones",
    label: "Coverage gap zones",
    path: "/data/coverage-zones.geojson",
    filename: "coverage-zones.geojson",
    description: "Zone-level SLA gap summaries emitted by the ETL-to-insight path before the demo is loaded.",
    serviceEnv: "HONUA_DEMO_COVERAGE_ZONES_SERVICE_ID",
    layerEnv: "HONUA_DEMO_COVERAGE_ZONES_LAYER_ID",
    defaultServiceId: "ops-analytics",
    defaultLayerId: 2,
    timeField: null
  }
];

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function envRequired(name) {
  const value = env(name);
  if (value === "") {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

async function ensureBuiltSdk() {
  try {
    await fs.access(builtSdkEntry);
  } catch {
    throw new Error(
      "Built SDK not found. Run `npm run build` from the repo root before refreshing the kepler fixture."
    );
  }
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }
  return sorted[midpoint];
}

function toTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTimeWindowLabel(startIso, endIso) {
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Honolulu",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Honolulu",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  return `${dateFormatter.format(new Date(startIso))} · ${timeFormatter.format(new Date(startIso))}-${timeFormatter.format(new Date(endIso))} HST`;
}

function normalizeFeatureProperties(properties) {
  return properties && typeof properties === "object" ? properties : {};
}

function geometryToGeoJson(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return null;
  }

  if ("x" in geometry && "y" in geometry) {
    return {
      type: "Point",
      coordinates: [geometry.x, geometry.y]
    };
  }

  if ("points" in geometry && Array.isArray(geometry.points)) {
    return {
      type: "MultiPoint",
      coordinates: geometry.points
    };
  }

  if ("paths" in geometry && Array.isArray(geometry.paths)) {
    return geometry.paths.length === 1
      ? {
          type: "LineString",
          coordinates: geometry.paths[0]
        }
      : {
          type: "MultiLineString",
          coordinates: geometry.paths
        };
  }

  if ("rings" in geometry && Array.isArray(geometry.rings)) {
    return {
      type: "Polygon",
      coordinates: geometry.rings
    };
  }

  if ("xmin" in geometry && "ymin" in geometry && "xmax" in geometry && "ymax" in geometry) {
    return {
      type: "Polygon",
      coordinates: [[
        [geometry.xmin, geometry.ymin],
        [geometry.xmax, geometry.ymin],
        [geometry.xmax, geometry.ymax],
        [geometry.xmin, geometry.ymax],
        [geometry.xmin, geometry.ymin]
      ]]
    };
  }

  throw new Error(`Unsupported geometry payload: ${JSON.stringify(geometry)}`);
}

function sortFeatures(features, timeField) {
  if (!timeField) {
    return [...features];
  }

  return [...features].sort((left, right) => {
    const leftValue = toTimestamp(normalizeFeatureProperties(left.properties)[timeField]) ?? 0;
    const rightValue = toTimestamp(normalizeFeatureProperties(right.properties)[timeField]) ?? 0;
    return leftValue - rightValue;
  });
}

function toFeatureCollection(features, timeField) {
  return {
    type: "FeatureCollection",
    features: sortFeatures(features, timeField).map((feature) => ({
      type: "Feature",
      properties: normalizeFeatureProperties(feature.attributes),
      geometry: geometryToGeoJson(feature.geometry)
    }))
  };
}

function collectReplayWindow(featureCollections) {
  const replayTimestamps = [];
  const fallbackTimestamps = [];

  for (const collection of featureCollections) {
    for (const feature of collection.features) {
      const properties = normalizeFeatureProperties(feature.properties);

      const replayTimestamp = toTimestamp(properties.replay_at);
      if (replayTimestamp !== null) {
        replayTimestamps.push(replayTimestamp);
      }

      for (const fieldName of ["opened_at", "observed_at", "window_start", "window_end"]) {
        const fallbackTimestamp = toTimestamp(properties[fieldName]);
        if (fallbackTimestamp !== null) {
          fallbackTimestamps.push(fallbackTimestamp);
        }
      }
    }
  }

  const timestamps = replayTimestamps.length > 0 ? replayTimestamps : fallbackTimestamps;

  if (timestamps.length === 0) {
    const now = new Date().toISOString();
    return {
      start: now,
      end: now,
      label: formatTimeWindowLabel(now, now)
    };
  }

  const start = new Date(Math.min(...timestamps)).toISOString();
  const end = new Date(Math.max(...timestamps)).toISOString();

  return {
    start,
    end,
    label: formatTimeWindowLabel(start, end)
  };
}

function buildKpis({ incidents, unitTracks, coverageZones }) {
  const incidentFeatures = incidents.features;
  const unitFeatures = unitTracks.features;
  const zoneFeatures = coverageZones.features;

  const replayIncidents = incidentFeatures.filter((feature) => {
    const status = String(normalizeFeatureProperties(feature.properties).status ?? "").toLowerCase();
    return status !== "resolved" && status !== "closed";
  });

  const activeIncidents = replayIncidents.length;

  const responseMinutes = replayIncidents
    .map((feature) => Number(normalizeFeatureProperties(feature.properties).response_minutes))
    .filter((value) => Number.isFinite(value));

  const unitIds = new Set(
    unitFeatures.map((feature) => String(normalizeFeatureProperties(feature.properties).unit_id ?? "")).filter(Boolean)
  );

  const zonesAtRisk = zoneFeatures.filter((feature) => {
    const gap = Number(normalizeFeatureProperties(feature.properties).sla_gap_pct);
    return Number.isFinite(gap) && gap >= 12;
  }).length;

  return [
    {
      id: "active-incidents",
      label: "Active incidents",
      value: String(activeIncidents),
      detail: "Incidents still active or in monitoring during the exported replay window."
    },
    {
      id: "median-response",
      label: "Median first unit",
      value: `${Math.round(median(responseMinutes))} min`,
      detail: "Median first-unit response derived from the incident export."
    },
    {
      id: "units-engaged",
      label: "Units engaged",
      value: String(unitIds.size),
      detail: "Named units represented in the unit replay layer."
    },
    {
      id: "zones-at-risk",
      label: "Zones at risk",
      value: String(zonesAtRisk),
      detail: "Coverage zones at or above the SLA-gap threshold."
    }
  ];
}

function createMetadata(datasetResults, replayWindow, environmentLabel) {
  const byId = Object.fromEntries(datasetResults.map((result) => [result.spec.id, result.collection]));
  const environmentSummary = environmentLabel || "Live Honua environment";

  return {
    storyId: "honolulu-operations-replay",
    storyTitle: "Honolulu operations replay",
    storySubtitle:
      "A committed Honua export fixture that replays incident escalations, unit movement, and coverage gaps without requiring a live server.",
    modeLabel: "Fixture mode · no server bring-up required",
    exportedAt: new Date().toISOString(),
    sourceEnvironment: `${environmentSummary} refreshed through HonuaClient`,
    timeWindow: replayWindow,
    datasets: datasetResults.map(({ spec, collection }) => ({
      id: spec.id,
      label: spec.label,
      path: spec.path,
      recordCount: collection.features.length,
      source: {
        serviceId: env(spec.serviceEnv, spec.defaultServiceId),
        layerId: Number.parseInt(env(spec.layerEnv, String(spec.defaultLayerId)), 10),
        endpoint: `/rest/services/${env(spec.serviceEnv, spec.defaultServiceId)}/FeatureServer/${env(spec.layerEnv, String(spec.defaultLayerId))}`,
        description: spec.description,
        envServiceId: spec.serviceEnv,
        envLayerId: spec.layerEnv,
        ...(spec.timeField ? { timeField: spec.timeField } : {})
      }
    })),
    walkthrough: [
      {
        title: "Play the first response wave",
        detail:
          "Use the time slider to replay the response window and watch active incidents stay in view while unit pings converge on the harbor and Waikiki corridors."
      },
      {
        title: "Switch from events to coverage risk",
        detail:
          "Leave the coverage polygons on to show which zones drifted past the SLA threshold even when the raw incident count looked manageable."
      },
      {
        title: "Connect the replay to Honua exports",
        detail:
          "Use the provenance panel to show the exact Honua service and layer IDs that produced the committed fixture and the maintainer refresh command."
      },
      {
        title: "Tell the ETL-to-insight story",
        detail:
          "Use the KPI cards as the punch line: ETL precomputes the gap metrics, the SDK refreshes the fixture, and kepler.gl turns it into a briefing."
      }
    ],
    kpis: buildKpis({
      incidents: byId.incidents,
      unitTracks: byId["unit-tracks"],
      coverageZones: byId["coverage-zones"]
    }),
    provenance: {
      badge: "Honua export fixture",
      summary:
        "The default demo path loads committed GeoJSON exports captured from a Honua replay contract so evaluators can run the story locally without a live environment.",
      derivationNotes: [
        "Coverage polygons already include SLA-gap percentages and median response minutes from the ETL pipeline; the browser does not recompute them on load.",
        "The replay window is anchored to the shared replay_at timestamp field so incidents and unit pings scrub together during playback.",
        "Maintainers can refresh the fixture from a live Honua environment with the documented script when the demo contract changes."
      ],
      refreshCommand: "npm run demo:kepler:refresh-fixture"
    }
  };
}

function formatHonuaError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function main() {
  await ensureBuiltSdk();

  const { HonuaClient, isHonuaError } = await import(pathToFileURL(builtSdkEntry).href);
  const baseUrl = envRequired("HONUA_DEMO_BASE_URL");
  const environmentLabel = env("HONUA_DEMO_ENV_LABEL", "Maintainer environment");

  const telemetry = [];
  const client = new HonuaClient({
    baseUrl,
    ...(env("HONUA_DEMO_API_KEY") ? { apiKey: env("HONUA_DEMO_API_KEY") } : {}),
    ...(env("HONUA_DEMO_BEARER_TOKEN") ? { bearerToken: env("HONUA_DEMO_BEARER_TOKEN") } : {}),
    interceptors: [
      {
        after({ request, response, durationMs }) {
          telemetry.push({
            path: request.path,
            status: response.status,
            durationMs
          });
        },
        error({ request, error, durationMs }) {
          telemetry.push({
            path: request.path,
            status: "error",
            durationMs: durationMs ?? null,
            error: formatHonuaError(error)
          });
        }
      }
    ]
  });

  const compatibility = await client.checkCompatibility();
  if (!compatibility.supported) {
    throw new Error(
      `Honua environment is not compatible with this demo refresh. Reasons: ${compatibility.reasons.join("; ")}`
    );
  }

  const datasetResults = await Promise.all(
    DATASET_SPECS.map(async (spec) => {
      const serviceId = env(spec.serviceEnv, spec.defaultServiceId);
      const layerId = Number.parseInt(env(spec.layerEnv, String(spec.defaultLayerId)), 10);
      const features = await client.featureLayer(serviceId, layerId).queryFeaturesAll({
        where: "1=1",
        outFields: ["*"],
        returnGeometry: true,
        pageSize: 2000,
        maxPages: 25
      });

      return {
        spec,
        collection: toFeatureCollection(features, spec.timeField)
      };
    })
  );

  const replayWindow = collectReplayWindow(datasetResults.map((result) => result.collection));
  const metadata = createMetadata(datasetResults, replayWindow, environmentLabel);

  await fs.mkdir(dataRoot, { recursive: true });

  await Promise.all(
    datasetResults.map(({ spec, collection }) =>
      fs.writeFile(path.join(dataRoot, spec.filename), `${JSON.stringify(collection, null, 2)}\n`, "utf8")
    )
  );
  await fs.writeFile(path.join(dataRoot, "fixture-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify(
      {
        refreshed: true,
        datasetCounts: Object.fromEntries(
          metadata.datasets.map((dataset) => [dataset.id, dataset.recordCount])
        ),
        replayWindow: metadata.timeWindow,
        telemetry
      },
      null,
      2
    )}\n`
  );

  return { isHonuaError };
}

main().catch(async (error) => {
  try {
    await ensureBuiltSdk();
    const { isHonuaError } = await import(pathToFileURL(builtSdkEntry).href);
    const message = isHonuaError(error) ? formatHonuaError(error) : formatHonuaError(error);
    process.stderr.write(`${message}\n`);
  } catch {
    process.stderr.write(`${formatHonuaError(error)}\n`);
  }
  process.exit(1);
});
