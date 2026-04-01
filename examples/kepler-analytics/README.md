# Honua kepler.gl analytics demo

This example is the advanced analytics sample for `honua-sdk-js`: a fixture-first `operations replay` story that shows how Honua exports flow into a portfolio-ready kepler.gl briefing.

## What the demo shows

- incident escalations as replayable event points
- unit movement as timestamped response pings
- coverage-gap zones with precomputed SLA metrics from the ETL path
- walkthrough copy, KPI cards, and provenance that are visible before anyone opens the source

## Run locally

The default path does not require a live Honua server.

```bash
npm install
npm run demo:kepler:install
npm run demo:kepler:dev
```

Open `http://127.0.0.1:4175`.

The first-run path is:

1. install the root SDK dependencies
2. install the isolated demo package dependencies
3. start the Vite dev server through the root wrapper script

That stays inside the repo, avoids a separate server bring-up path, and is intended to fit inside the ticket's `10` minute target on a normal development machine.

## Demo walkthrough

1. Start with the left rail. It explains that the app is running against a committed Honua export fixture.
2. Use the replay time slider in kepler.gl to scrub the incident and unit layers together.
3. Keep the coverage polygons visible to show that the story is not a point-map sample; the insight layer is the SLA-gap surface.
4. Finish on the provenance panel and refresh command to show how the SDK refreshes the exported fixture from a real Honua environment.

## Data provenance

The committed fixture lives in [`public/data`](./public/data) and is intentionally readable:

- [`incidents.geojson`](./public/data/incidents.geojson)
- [`unit-tracks.geojson`](./public/data/unit-tracks.geojson)
- [`coverage-zones.geojson`](./public/data/coverage-zones.geojson)
- [`fixture-metadata.json`](./public/data/fixture-metadata.json)

The metadata file records:

- the source Honua service and layer IDs
- the export timestamp and replay window
- record counts for each dataset
- derivation notes for the precomputed KPI and coverage metrics

## Fixture contract

The app loads [`fixture-metadata.json`](./public/data/fixture-metadata.json) first, then fetches each dataset listed in `metadata.datasets`.

The side rail renders `metadata.timeWindow.label`, but the shared kepler replay filter recomputes its `start` and `end` bounds from the minimum and maximum `replay_at` values present in the `incidents` and `unit-tracks` GeoJSON payloads when those timestamps exist. Fixture refreshes should keep `metadata.timeWindow` aligned with the exported timestamps so the visible copy and active replay filter stay in sync.

Required metadata fields:

- top-level story copy: `storyId`, `storyTitle`, `storySubtitle`, `modeLabel`, `exportedAt`, `sourceEnvironment`
- replay framing: `timeWindow.start`, `timeWindow.end`, `timeWindow.label`
- visible side-rail content: `walkthrough[]`, `kpis[]`, `provenance.badge`, `provenance.summary`, `provenance.derivationNotes[]`, `provenance.refreshCommand`
- dataset manifest entries: `datasets[].id`, `label`, `path`, `recordCount`, and `source.{serviceId,layerId,endpoint,description,envServiceId,envLayerId,timeField?}`

The saved kepler config references dataset IDs directly. It applies `active-status-filter` to `incidents.status` with the default visible values `active`, `contained`, and `monitoring`, and `replay-window-filter` targets both `incidents` and `unit-tracks` on `replay_at`. The committed manifest and any refreshed bundle must keep these exact IDs:

- `incidents`
- `unit-tracks`
- `coverage-zones`

## Dataset field expectations

The shipped kepler config and tooltip wiring expect these fields to be present:

- `incidents`: `status`, `replay_at`, `severity_score`, `response_minutes`, plus tooltip/story fields such as `incident_id`, `title`, and `severity_band`
- `unit-tracks`: `replay_at`, `unit_id`, `speed_kph`, plus tooltip fields `status`, `observed_at`, and `incident_id`
- `coverage-zones`: polygon geometry with `sla_gap_pct`, `median_response_min`, `zone_name`, `coverage_state`, `window_start`, and `window_end`

The browser derives the playback bundle from GeoJSON only. The refresh script converts supported Honua geometries directly to GeoJSON and does not reproject them, so the fixture needs longitude/latitude-compatible coordinates for the shipped map state and kepler layers.

## Maintainer refresh path

The committed fixture is the default runtime path. Maintainers can refresh it from a live Honua environment with the SDK-backed script below. The documented repo-root wrapper builds `dist/src` first and then delegates to the example-local script.

Required environment:

```bash
export HONUA_DEMO_BASE_URL="https://your-honua-server.example"
```

Optional environment overrides:

```bash
export HONUA_DEMO_API_KEY="demo-admin-key"
export HONUA_DEMO_BEARER_TOKEN="demo-bearer-token"
export HONUA_DEMO_ENV_LABEL="staging replay contract"
export HONUA_DEMO_INCIDENTS_SERVICE_ID="ops-analytics"
export HONUA_DEMO_INCIDENTS_LAYER_ID="0"
export HONUA_DEMO_UNIT_TRACKS_SERVICE_ID="ops-analytics"
export HONUA_DEMO_UNIT_TRACKS_LAYER_ID="1"
export HONUA_DEMO_COVERAGE_ZONES_SERVICE_ID="ops-analytics"
export HONUA_DEMO_COVERAGE_ZONES_LAYER_ID="2"
```

Refresh command:

```bash
npm run demo:kepler:refresh-fixture
```

If you invoke the example-local script directly with `npm --prefix examples/kepler-analytics run refresh-fixture`, run `npm run build` from the repo root first so it can import `dist/src/honua.js`.

The refresh script:

- calls `HonuaClient.checkCompatibility()` once before querying
- uses explicit dataset identifiers rather than service discovery
- records request timings through SDK interceptors
- writes the GeoJSON fixture files and `fixture-metadata.json`
- recomputes the visible KPI cards against the shipped replay semantics, including excluding resolved or closed incidents from the median-response card
- preserves actionable Honua SDK error messages when refresh fails

On success it prints a JSON summary to stdout with this shape:

```json
{
  "refreshed": true,
  "datasetCounts": {
    "incidents": 6,
    "unit-tracks": 12,
    "coverage-zones": 3
  },
  "replayWindow": {
    "start": "2026-05-01T16:00:00.000Z",
    "end": "2026-05-01T17:26:00.000Z",
    "label": "May 1, 2026 · 06:00-07:26 HST"
  },
  "telemetry": [
    {
      "path": "/rest/services/ops-analytics/FeatureServer/0/query",
      "status": 200,
      "durationMs": 123
    }
  ]
}
```

`telemetry[].status` is the HTTP status code for completed requests and `"error"` for interceptor-level failures. `durationMs` can be `null` when the request fails before a response is available.

## Smoke coverage

Run the focused browser smoke for this demo:

```bash
npm run demo:kepler:smoke
```

That build-and-smoke path validates the app shell, kepler mount, dataset labels, shared replay filtering, and browser error surface in fixture mode. The app also exposes `window.__keplerAnalyticsReady`, `window.__keplerAnalyticsError`, and `window.__keplerAnalyticsHarness` so smoke and external harnesses can wait for fixture load, inspect replay-filter state, and drive the shared replay window deterministically.

`window.__keplerAnalyticsHarness` exposes:

- `getReplayState()`, which returns `{ currentTime, dataIds, filteredCounts, layerIds, replayStatus, value }` for the shared replay filter state after kepler mounts
- `setReplayWindow(startIso, endIso)`, which returns `true` once the demo is ready and updates the shared replay filter plus animation time

`filteredCounts` reflects the currently active filters rather than raw manifest totals, so the default first load shows five visible incidents even though `fixture-metadata.json` records six incident features overall.

## Troubleshooting

- If the app fails with missing modules, run `npm run demo:kepler:install` again.
- If you want to keep the no-token path but swap basemaps, set `VITE_KEPLER_STYLE_URL=https://your-style.example/style.json` before running `npm run demo:kepler:dev`.
- If the basemap style does not render in your environment, provide a Mapbox token and opt into kepler's defaults:
  - `VITE_MAPBOX_TOKEN=...`
  - `VITE_KEPLER_USE_MAPBOX_DEFAULTS=true`
- If the example-local `refresh-fixture` script fails before querying, run `npm run build` from the repo root so it can import the built SDK from `dist/src`.
