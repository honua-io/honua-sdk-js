# Honua MapLibre Quickstart App

Committed runnable browser quickstart for the SDK’s `checkCompatibility() + queryFeatures() + MapLibre render`
path.

What it exercises:

- `HonuaClient.checkCompatibility()`
- one read-only `queryFeatures()` call against a configured FeatureServer layer
- Esri JSON to GeoJSON conversion inside the example
- MapLibre rendering and popup-backed feature inspection
- `ExplorationContext` plus interaction bindings for map, result list, filters, query projection, and details

## Fast Local Run

This repo ships a deterministic same-origin review lane for the quickstart app.

```bash
npm install
npm run demo:quickstart:mock
```

The script:

1. builds the example app
2. serves the built app locally
3. serves fixture responses for `GET /api/v1/admin/capabilities`
4. serves a fixture response for `GET /rest/services/{serviceId}/FeatureServer/{layerId}/query`
5. overrides the basemap style to `/__honua-quickstart__/basemap-style.json` so the local lane stays self-contained

The local URL is printed as `quickstartMockUrl=http://127.0.0.1:PORT`.

## Live Honua Run

Point the same app at a prepared Honua environment:

```bash
cp examples/maplibre-quickstart/.env.example examples/maplibre-quickstart/.env
npm run demo:quickstart
```

Supported env vars:

- `VITE_HONUA_QUICKSTART_BASE_URL`: Honua base URL. Leave empty only for the same-origin fixture lane.
- `VITE_HONUA_QUICKSTART_SERVICE_ID`: FeatureServer service id. Default: `natural-earth`.
- `VITE_HONUA_QUICKSTART_LAYER_ID`: FeatureServer layer id. Default: `0`. Must parse as an integer.
- `VITE_HONUA_QUICKSTART_WHERE`: read-only filter. Default: `1=1`.
- `VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT`: bounded query size. Default: `25`. Must be greater than `0`.
- `VITE_HONUA_QUICKSTART_BASEMAP_STYLE`: MapLibre style URL. Default: `https://demotiles.maplibre.org/style.json`.
- `VITE_HONUA_QUICKSTART_API_KEY`: optional API key forwarded as `X-API-Key`.
- `VITE_HONUA_QUICKSTART_BEARER_TOKEN`: browser bearer-token forwarding is disabled unless
  `VITE_HONUA_ALLOW_BROWSER_BEARER_TOKEN=true` is also set. Prefer short-lived API keys or backend-issued sessions for
  browser demos.

The app trims trailing slashes from `VITE_HONUA_QUICKSTART_BASE_URL` before instantiating `HonuaClient`.
Layer-id and result-count overrides are validated during startup before the app makes any Honua API requests.

## Network And Runtime Contract

The browser runtime makes one compatibility request before it queries the layer:

- `GET /api/v1/admin/capabilities` through `HonuaClient.checkCompatibility()`

The SDK reads the compatibility contract from `data.compatibility` inside that JSON response. The parsed object must
include `serverVersion`, `releaseChannel`, `controlPlaneApi.major`/`basePath`/`deprecated`, `metadataSchemas[]`
entries with `version` and `deprecated`, and the boolean `features` map.

The app continues only when the server satisfies the SDK compatibility baseline already enforced by the client:

- server version `>= 1.0.0`
- control-plane API major integer `1` with base path `/api/v1/admin`
- control-plane API deprecation flag `false`
- release channel `preview` or newer

After compatibility passes, the app performs one bounded feature query:

- `GET /rest/services/{serviceId}/FeatureServer/{layerId}/query`

Query shape:

- `where`: configured by env, default `1=1`
- `returnGeometry: true`
- `outFields: ["*"]`
- `outSr: 4326`
- `resultRecordCount`: bounded by env, default `25`

MapLibre then fetches the configured basemap style and any dependent assets separately from the Honua API calls above.
After the initial bounded query, the browser app wires the returned features into a linked exploration context:

- map `moveend` events update the shared extent and spatial filter
- attribute filter controls update the shared filter slice
- map clicks and result-list buttons update one shared source-qualified selection
- the result list and diagnostics panel render from `LinkedViewQueryProjection`
- MapLibre layer filters are translated from the same projection used by the result list

Response handling:

- the app expects `queryResponse.features` to contain at least one record
- non-renderable records are dropped during Esri JSON to GeoJSON conversion
- `featureCount` tracks the raw query response while `renderableFeatureCount` tracks the post-conversion dataset used for rendering
- startup fails with a visible error if no record converts into the rendered point, line, or polygon buckets
- feature titles prefer `NAME`, `TITLE`, `name`, `title`, `LABEL`, then `label`, else `Feature N`
- subtitles prefer `STATUS`, `CATEGORY`, `status`, `category`, `TYPE`, then `type`, else a geometry summary

The app renders only the geometry layers needed by the returned data:

- `fill` plus outline for polygons
- `line` for polylines
- `circle` for points

## Observability And Error Surfaces

For browser smoke tests and troubleshooting, the quickstart exposes:

- `window.__HONUA_QUICKSTART_EVENTS__`
- `window.__HONUA_QUICKSTART_RUNTIME__`
- `CustomEvent("honua:quickstart")`

Expected event types:

- `init`
- `compatibility-ok`
- `query-started`
- `query-finished`
- `map-ready`
- `feature-selected`
- `linked-filter-changed`
- `linked-query-updated`
- `error`

Runtime state includes:

- resolved `baseUrl`, `serviceId`, and `layerId`
- compatibility `serverVersion` and `releaseChannel`
- `featureCount`, `renderableFeatureCount`, and `geometryTypes`
- `queryDurationMs`
- `layerIds`, `mapReady`, `selectedFeatureId`, `popupOpen`, and `lastError`
- `linkedVisibleFeatureCount`, `linkedFilterCount`, and `linkedExtent`

Startup failures are surfaced in the overlay and the inline status panel. For common fixes, use the troubleshooting
guide at [`docs/quickstart-troubleshooting.md`](../../docs/quickstart-troubleshooting.md).

## Verification

```bash
npm run demo:quickstart:typecheck
npx vitest run test/quickstart-config.test.ts test/quickstart-data.test.ts test/quickstart-linked-exploration.test.ts
npm run test:playwright:quickstart
```

Live staging validation is wired separately:

```bash
npm run test:quickstart:staging
```

The staging suite expects the `HONUA_STAGING_*` environment described in
[`docs/quickstart-troubleshooting.md`](../../docs/quickstart-troubleshooting.md#staging-ci-config-drift) and can
write a JSON summary to `HONUA_QUICKSTART_STAGING_SUMMARY_FILE` for CI step reporting. It reuses
`loadQuickstartDataset()` and validates the compatibility plus single-query contract only, so it does not start the
browser app or fetch the basemap style.

GitHub Actions coverage for this committed app is split across two workflows:

- `.github/workflows/ci.yml`: runs the quickstart typecheck, build, and Playwright smoke lane on `trunk` and
  `release/**` pushes and pull requests
- `.github/workflows/quickstart-staging.yml`: runs the live staging integration on `trunk` and `release/**` pushes,
  plus `workflow_dispatch`

## External Follow-on

Bounded child ticket outside this repo, intentionally not implemented here:

- `honua-server`: expose and document a stable staging quickstart dataset for JS SDK CI, including the canonical
  `serviceId`, `layerId`, auth policy, and non-empty geometry-bearing data contract.
