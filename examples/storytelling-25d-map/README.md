# Honua 2.5D Storytelling Demo

Portfolio-grade browser demo for a pitched `2.5D` corridor walkthrough.

What it shows:

- Honua compatibility gating through `HonuaClient.checkCompatibility()`
- OGC API Features collections loaded through `client.ogcFeatures().collection(...).items()`
- polygon extrusions on a pitched MapLibre map
- deterministic story steps with camera transitions and an animated route replay

What it does **not** claim:

- full `3D`
- terrain or mesh rendering
- digital-twin parity

## Fast Local Run

This repo ships a deterministic local review lane that mirrors the live browser calls with fixture-backed Honua
endpoint shapes.

```bash
npm install
npm run demo:25d:mock
```

The script:

1. builds the example app
2. serves the built app locally
3. serves fixture responses for `GET /api/v1/admin/capabilities`
4. serves fixture OGC collections for assets, route, and stops on same-origin paths
5. overrides the basemap style to `/__honua-25d__/basemap-style.json` so the review lane stays self-contained

The local URL is printed as `story25dMockUrl=http://127.0.0.1:PORT`.

This lane depends on the demo defaulting `VITE_HONUA_25D_BASE_URL` to an empty string, so every SDK request stays
same-origin against the fixture server. It exercises the same `HonuaClient.checkCompatibility()` and
`client.ogcFeatures().collection(...).items()` codepaths as the live app without depending on a seeded Honua
environment.

## Live Honua Run

Point the same app at a prepared Honua environment with the documented collection names:

```bash
cp examples/storytelling-25d-map/.env.example examples/storytelling-25d-map/.env
npm run demo:25d
```

Supported env vars:

- `VITE_HONUA_25D_BASE_URL`: Honua base URL. Leave empty only for the same-origin mock lane.
- `VITE_HONUA_25D_API_KEY`: optional API key forwarded as the `X-API-Key` header.
- `VITE_HONUA_25D_ASSETS_COLLECTION`: assets collection id. Default: `story-25d-assets`.
- `VITE_HONUA_25D_ROUTE_COLLECTION`: route collection id. Default: `story-25d-route`.
- `VITE_HONUA_25D_STOPS_COLLECTION`: stops collection id. Default: `story-25d-stops`.
- `VITE_HONUA_25D_BASEMAP_STYLE`: MapLibre style URL. Default: `https://demotiles.maplibre.org/style.json`.

The app trims trailing slashes from `VITE_HONUA_25D_BASE_URL` before instantiating `HonuaClient`.

## Network And Compatibility Contract

The browser runtime makes one compatibility request before it loads any story data:

- `GET /api/v1/admin/capabilities` through `HonuaClient.checkCompatibility()`

The demo continues only when the server satisfies the SDK compatibility baseline already enforced by the client:

- server version `>= 1.0.0`
- control-plane API major `v1` on `/api/v1/admin`
- release channel `preview` or newer

After compatibility passes, the demo loads the three collections in parallel through OGC API Features:

- `GET /ogc/features/collections/{assets}/items?limit=250`
- `GET /ogc/features/collections/{route}/items?limit=250`
- `GET /ogc/features/collections/{stops}/items?limit=250`

When `VITE_HONUA_25D_API_KEY` is set, the SDK forwards it on the compatibility request and the OGC collection
requests as `X-API-Key`.

The route replay is client-side after this initial load, so story navigation and animation do not re-fetch data.

## Collection Contract

Required live collection behavior:

- assets collection: at least one `Polygon` or `MultiPolygon`; non-polygon features are ignored
- route collection: at least one `LineString` or `MultiLineString`; the first matching feature becomes the replay path
- stops collection: at least one `Point`; non-point features are ignored and the remaining stops are sorted by sequence
- numeric risk, height, and sequence values may be native numbers or numeric strings

Supported asset fields and defaults:

- stable ids should come from `feature.id`; if omitted, the demo falls back to `story_id`, `asset_id`, `assetId`, `id`, `name`, or `title`
- display title can come from `title`, `name`, `asset_name`, `assetName`, or `label`
- district can come from `district`, `zone`, `area`, or `corridor`
- status can come from `status`, `inspection_status`, or `condition`
- summary can come from `summary`, `description`, `story`, or `note`
- linked stop ids can come from `linked_stop_id`, `linkedStopId`, `stop_id`, or `stopId`
- numeric risk can come from `risk_score`, `riskScore`, `risk`, `severity`, or `priority_score`
- extrusion height can come from `extrusion_height_m`, `height_m`, `height`, `heightMeters`, `elevation_m`, `elevation`, or `floors` where `floors` is converted as `floors * 4`
- missing title, district, status, and summary fields fall back to deterministic copy and missing heights are rejected
- normalized heights are rounded to one decimal place and clamped to a minimum of `8m`
- normalized risk buckets are `stable`, `guarded`, `high`, or `severe`

Supported route and stop fields:

- route ids use the same stable-id fallback chain if `feature.id` is absent
- route title can come from `title`, `name`, or `route_name`; route summary can come from `summary` or `description`
- stop ids use the same stable-id fallback chain if `feature.id` is absent
- stop title can come from `title`, `name`, or `stop_name`; stop summary can come from `summary` or `description`
- stops are ordered by `sequence`, `seq`, or `order`
- stop-to-asset linkage can come from `linked_asset_id`, `linkedAssetId`, `asset_id`, or `assetId`

Default collection ids:

- `story-25d-assets`
- `story-25d-route`
- `story-25d-stops`

Override them in `examples/storytelling-25d-map/.env` if your environment uses different ids.

## Story Steps

The walkthrough is fixed to four step ids:

1. `overview`
2. `triage`
3. `route-replay`
4. `asset-focus`

Behavior notes:

- the triage step highlights assets at `risk_score >= 70`; if none cross the threshold, the demo falls back to the top three assets by risk
- the route replay runs for `4.8s` and advances stop highlighting client-side
- the asset-focus step selects the highest-priority asset and its linked stop when present

## Observability And Error Surfaces

For browser smoke tests and developer inspection, the demo exposes runtime signals on `window`:

- `window.__HONUA_25D_EVENTS__`: ordered telemetry events such as `init`, `compatibility-ok`, `data-loaded`, `story-step-changed`, `route-playback-started`, `route-playback-finished`, and `error`
- `window.__HONUA_25D_RUNTIME__`: runtime state including `datasetSummary`, `currentStepId`, `routeProgress`, `mapReady`, `pitch`, `sourceIds`, `layerIds`, and `selectedAssetId`
- each telemetry event is also dispatched as `CustomEvent("honua:25d-demo")`
- `compatibility-ok` includes `serverVersion`, `releaseChannel`, and resolved `baseUrl`; `data-loaded` includes the dataset summary plus resolved collection ids
- `story-step-changed` includes `stepId`, `stepIndex`, and `totalSteps`; route playback events include stop counts and replay duration

Startup failures are surfaced in the loading overlay and mirrored into `#demo-status`. Unsupported compatibility
reasons are shown directly, and collection fetch failures are wrapped as `Failed to load the {label} collection
"{id}" from OGC API Features: ...`. Basemap style failures are wrapped as `Failed to load the basemap style
"{url}": ...`.

## Verification

```bash
npm run demo:25d:typecheck
npx vitest run test/storytelling-25d-config.test.ts test/storytelling-25d-data.test.ts
npm run test:playwright:25d
```

## Fixtures

Deterministic payloads used by the local mock lane and browser smoke coverage live in
`test/fixtures/honua-25d-demo/`.

## Follow-on Child Ticket

Bounded external follow-on, intentionally not implemented in this repo:

- `honua-server`: add a deterministic `25d-demo` seed/profile that publishes the same polygon, route, and stop
  collections with stable ids and numeric risk/height attributes.
