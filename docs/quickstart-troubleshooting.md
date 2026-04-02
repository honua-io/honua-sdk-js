# Quickstart Troubleshooting

Use this guide when the committed quickstart app at
[`examples/maplibre-quickstart/`](../examples/maplibre-quickstart/README.md) does not load as expected.

## Unsupported Compatibility Baseline

Symptoms:

- the app stops before querying data
- the overlay shows an unsupported compatibility message
- `window.__HONUA_QUICKSTART_RUNTIME__.serverVersion` or `releaseChannel` is missing or below the SDK baseline

Checks:

- confirm `GET /api/v1/admin/capabilities` is reachable from the browser
- confirm the server reports version `>= 1.0.0`
- confirm the control-plane API major is `v1` at `/api/v1/admin`
- confirm the release channel is `preview` or newer

The quickstart app intentionally fails before the feature query when this contract is not satisfied.

## Missing Or Invalid Auth

Symptoms:

- `401` or `403` responses on compatibility or feature-query requests
- browser console shows a request error before the map becomes ready

Checks:

- set `VITE_HONUA_QUICKSTART_API_KEY` when the server expects `X-API-Key`
- set `VITE_HONUA_QUICKSTART_BEARER_TOKEN` when the server expects bearer auth
- for staging CI, set `HONUA_STAGING_API_KEY` or `HONUA_STAGING_BEARER_TOKEN` if the environment is protected

The quickstart app forwards auth directly into `HonuaClient`; it does not add custom example-only header behavior.

## CORS Or Browser Network Failures

Symptoms:

- the browser reports `TypeError: Failed to fetch`
- requests work from server-side tools but fail from the browser app

Checks:

- confirm the Honua server allows the browser origin used by Vite or preview
- confirm preflight responses allow the headers your auth mode sends
- use the same-origin fixture lane first:

```bash
npm run demo:quickstart:mock
```

If the fixture lane works but the live lane fails, the problem is likely environment or browser policy rather than the
example code.

## Empty Feature Queries

Symptoms:

- the app reports `The feature query returned no features...`
- staging integration fails with `featureCount` equal to `0`

Checks:

- confirm `VITE_HONUA_QUICKSTART_SERVICE_ID` and `VITE_HONUA_QUICKSTART_LAYER_ID`
- confirm the configured `where` clause matches seeded data
- reduce filter complexity and retry with `1=1`
- keep `resultRecordCount` bounded but non-zero

The quickstart app expects at least one feature because it fits the map and drives an inspection popup from the query
result.

## Unsupported Or Missing Geometry

Symptoms:

- the app reports `none included renderable geometry`
- the feature query succeeds but the map never renders data

Checks:

- confirm the layer returns geometry-bearing features
- confirm the quickstart query keeps `returnGeometry: true`
- confirm the requested layer is a point, polyline, or polygon layer
- keep `outSr: 4326` so MapLibre receives browser-safe coordinates

The app filters out non-renderable records and only creates render layers for returned points, lines, or polygons.

## Basemap Style Load Failures

Symptoms:

- the overlay reports `Failed to load the basemap style "..."`
- Honua requests succeed but the map never initializes

Checks:

- confirm `VITE_HONUA_QUICKSTART_BASEMAP_STYLE` is reachable from the browser
- confirm the style JSON and its dependent assets are public or otherwise accessible
- use the fixture lane to remove basemap-network variability from the initial debug loop

The fixture lane serves `/__honua-quickstart__/basemap-style.json` locally to keep smoke coverage deterministic.

## Staging CI Config Drift

The live staging suite is triggered by `npm run test:quickstart:staging` and `.github/workflows/quickstart-staging.yml`.

Required environment variables:

- `HONUA_STAGING_BASE_URL`
- `HONUA_STAGING_SERVICE_ID`
- `HONUA_STAGING_LAYER_ID`

Optional environment variables:

- `HONUA_STAGING_WHERE`
- `HONUA_STAGING_RESULT_RECORD_COUNT`
- `HONUA_STAGING_API_KEY`
- `HONUA_STAGING_BEARER_TOKEN`
- `HONUA_QUICKSTART_STAGING_SUMMARY_FILE`

If staging CI starts failing after an environment change:

- confirm the configured service and layer still exist
- confirm the environment still exposes non-empty geometry-bearing data
- confirm the auth policy still matches the configured secret or public access path
- review the workflow step summary for `serverVersion`, `releaseChannel`, `featureCount`, and `queryDurationMs`

## Inspecting Runtime State

For browser debugging and Playwright smoke assertions, inspect:

- `window.__HONUA_QUICKSTART_EVENTS__`
- `window.__HONUA_QUICKSTART_RUNTIME__`

Useful fields:

- `baseUrl`, `serviceId`, `layerId`
- `serverVersion`, `releaseChannel`
- `featureCount`, `renderableFeatureCount`, `geometryTypes`
- `queryDurationMs`
- `mapReady`, `selectedFeatureId`, `popupOpen`, `lastError`

Every telemetry event is also dispatched as `CustomEvent("honua:quickstart")`.

## External Follow-on

This repo still depends on one bounded external child ticket for long-term staging stability:

- `honua-server`: expose and document a stable staging quickstart dataset for JS SDK CI, including the canonical
  service, layer, auth policy, and non-empty geometry contract.
