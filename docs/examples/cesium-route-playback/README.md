# Cesium Route Playback Spike

This example is an exploratory 3D consumer workflow for `honua-sdk-js`. It does
not change the public SDK runtime surface. The goal is narrower: prove that a
current Honua `FeatureServer/query` response can drive one believable Cesium
workflow end to end, while documenting the manual conversion steps and the gaps
that still block a stronger platform-level 3D claim.

## Scenario

The spike uses `route playback with elevation context`.

Why this scenario:

- it fits the SDK's existing `HonuaClient.queryFeatures()` surface
- it only needs one bounded polyline query plus optional terrain
- it demonstrates the difference between "Cesium can consume Honua-served data"
  and "Honua already exposes a first-class 3D scene contract"

## What The Example Includes

- `index.html`: a plain browser page that loads local Cesium assets
- `app.mjs`: viewer wiring, diagnostics, playback controls, and optional terrain
- `data-path.mjs`: explicit query and normalization helpers
- `fixtures/route-query-response.json`: deterministic Honua query fixture for CI
- `fixtures/source-manifest.json`: query shape, field mapping, and preprocessing notes

## Run It

From the repo root:

```bash
npm install
npm run build
python3 -m http.server 8080
```

Open:

```text
http://127.0.0.1:8080/docs/examples/cesium-route-playback/
```

Fixture mode is the default. It renders the checked-in Honua query payload and
keeps local review and CI deterministic.

## Runtime Defaults And URL Parameters

The browser page reads its configuration from the query string.

- `mode`: `fixture` by default. Use `live` to query a Honua server from the browser.
- `baseUrl`: required in live mode. Trailing slashes are trimmed before `HonuaClient` is created.
- `serviceId`: defaults to `route-playback-demo`.
- `layerId`: defaults to `0`.
- `where`: defaults to `1=1`.
- `objectIds`: optional live-mode filter passed through to the query request.
- `resultRecordCount`: defaults to `1` so the live query stays intentionally bounded.
- `speed`: playback speed in meters per second. Default: `18`.
- `fixtureUrl`: fixture payload URL. Default: `./fixtures/route-query-response.json`.
- `manifestUrl`: manifest URL. Default: `./fixtures/source-manifest.json`.
- `terrainUrl`: optional Cesium terrain endpoint. Tried before `ionToken`.
- `ionToken`: optional Cesium ion token used only when `terrainUrl` is absent or fails.

## Live Mode

Live mode uses the same example, but switches the source from the checked-in
fixture to a user-supplied Honua server and feature layer:

```text
http://127.0.0.1:8080/docs/examples/cesium-route-playback/?mode=live&baseUrl=https%3A%2F%2Fyour-honua-server.example&serviceId=transport&layerId=0&where=route_id%20%3D%20'route-playback-demo'
```

Optional terrain:

- `terrainUrl=https://terrain.example/tiles`
- or `ionToken=<token>` to use Cesium World Terrain

Notes:

- live mode calls `checkCompatibility()` before querying features
- the query is intentionally bounded and always uses `outFields=["*"]`,
  `outSr=4326`, `returnGeometry=true`, and `extraParams.returnZ=true`
- the request duration shown in diagnostics comes from a temporary `HonuaClient`
  interceptor attached by the example
- CORS still has to allow the browser request when `baseUrl` is cross-origin

## Response Contract And Normalization

The example keeps the conversion path explicit:

1. `HonuaClient.checkCompatibility()` gates live mode through the existing SDK
   compatibility contract.
2. `HonuaClient.queryFeatures()` reads one bounded polyline route with
   `returnGeometry=true`, `outSr=4326`, and `returnZ=true`.
3. The query response must expose `features[]` entries with polyline
   `geometry.paths`. Non-polyline features are ignored.
4. `data-path.mjs` selects the feature that matches
   `manifest.query.routeIdValue` plus `fieldMapping.routeId` when available;
   otherwise it falls back to the polyline feature with the most vertices.
5. Multipart polylines are reduced to the longest path with at least two valid
   vertices, then normalized into Cesium-friendly WGS84 coordinates.
6. Route labels fall back through `route_name`, `routeName`, `name`, and `Name`.
   Route ids fall back through `route_id`, `routeId`, `ROUTE_ID`, and `Name`.
7. If source Z values exist, the example preserves them for display when terrain
   is disabled.
8. If terrain is configured, the example samples external terrain and uses that
   as the display height while keeping source Z for diagnostics only.
9. Playback timestamps are derived from cumulative segment distance at the
   configured speed. The example does not currently consume route time fields.
10. Playback starts from `manifest.playback.startTimestamp` when the manifest
   provides one, otherwise it falls back to `2026-01-01T00:00:00Z`.
11. Cesium entities render the route line, start/end markers, and a moving asset
   driven by `SampledPositionProperty`.

## Required Preprocessing Today

Nothing is hidden behind SDK internals. The example still needs consumer-side
preprocessing:

- query in WGS84 degrees because Cesium expects longitude/latitude input
- normalize Esri polyline paths into one playback track
- decide how to treat source Z values when their units are not confirmed
- derive timestamps client-side instead of consuming route time attributes
- supply an external terrain source if topographic context matters

## Terrain And Height Handling

Height handling is ordered:

1. `terrainUrl`
2. `ionToken`
3. ellipsoid fallback

When terrain is disabled:

- source Z values produce `heightMode=source-z-unverified`
- missing Z values produce `heightMode=ellipsoid-zero`

When terrain sampling succeeds:

- display heights come from sampled terrain
- source Z values are kept for diagnostics only

When terrain sampling fails:

- the example falls back to the non-terrain height mode
- the failure is surfaced in the warnings list and result summary

## Gap Analysis

What worked directly:

- current `HonuaClient` query and compatibility surfaces were enough for a small
  browser prototype
- Cesium can render a believable moving-route workflow from a Honua-shaped
  polyline response without changing SDK exports
- the repo's existing browser smoke-test lane can validate both fixture and live
  code paths

What is still missing:

- no documented Honua terrain, 3D Tiles, or I3S contract in this repo
- no approved stable public route dataset is referenced here, so fixture mode is
  the canonical reproducible path
- source Z units are not validated by contract, so the example must label them as
  unverified display heights
- Cesium setup still requires local asset serving and optional terrain
  configuration outside the SDK runtime surface

## Diagnostics And Verification

The example surfaces its runtime state in two places:

- the page diagnostics panel shows source mode, selected query, geometry type,
  feature and vertex counts, request duration, playback distance, and playback duration
- the warnings panel shows terrain fallback and load failures directly

For browser smoke tests and local inspection, the example also exposes:

- `window.__cesiumRoutePlaybackDone`
- `window.__cesiumRoutePlaybackError`
- `window.__cesiumRoutePlaybackResult`

`window.__cesiumRoutePlaybackResult` includes the source mode, route identity,
feature and vertex counts, terrain and height mode, query request details,
warnings, preprocessing steps, and rendered entity count.

Verification commands:

```bash
npm run build
npx vitest run test/cesium-route-playback.test.ts
npx playwright test test/playwright/cesium-route-playback.spec.mjs
```

The Playwright lane validates both the default fixture path and the live-query
path against a local mock Honua server, including the compatibility request and
the `returnZ=true` query contract.

## Recommendation

Keep this example exploratory.

Reasoning:

- it proves a credible consumer-side 3D story for one workflow today
- it does not yet justify claiming first-class 3D parity for Honua itself
- the strongest missing pieces are platform contracts and demo-data governance,
  not SDK syntax

Promotion to a portfolio demo should wait for a stable route dataset and a
documented terrain or 3D scene contract.

## Bounded Follow-On Child Tickets

- `honua-sdk-js`: extract the route-normalization helpers from this example only
  if another maintained sample needs the same conversion path
- `honua-server`: publish one documented, stable, Z-aware demo route layer for
  browser samples
- `honua-server`: define a terrain or 3D scene contract before any portfolio
  claim of near-parity 3D support
