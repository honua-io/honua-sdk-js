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
- `routeId`: optional explicit route identifier used only for client-side feature selection when a live query can still return multiple polylines. It does not narrow the server request by itself, so prefer pairing it with a tighter `where` or `objectIds` filter when possible. If you rely on `routeId` to select among multiple returned routes, widen `resultRecordCount` beyond the default `1` so the target feature can actually be returned. The matcher compares normalized string values across the configured route-id field when one is known, otherwise it falls back to the example's common route-id aliases. If no returned polyline matches, the example throws instead of falling back to another feature. The normalized result summary also prefers that configured field when reporting `routeId`.
- `routeIdField`: optional live-mode route-id attribute name. Set this when the live layer stores route ids outside the example's built-in aliases like `route_id` or `routeId`. When provided, live route matching treats that configured field as authoritative instead of falling back to alias fields.
- `where`: defaults to `1=1`.
- `objectIds`: optional live-mode filter passed through to the query request.
- `resultRecordCount`: defaults to `1` so the live query stays intentionally bounded.
- `speed`: playback speed in meters per second. Default: `18`.
- `fixtureUrl`: fixture payload URL. Default: `./fixtures/route-query-response.json`.
- `manifestUrl`: fixture-mode manifest URL. Default: `./fixtures/source-manifest.json`. Live mode ignores this and synthesizes a minimal manifest from the live query parameters instead.
- `terrainUrl`: optional Cesium terrain endpoint. Tried before `ionToken`.
- `ionToken`: optional Cesium ion token used only when `terrainUrl` is absent or fails.

## Live Mode

Live mode uses the same example, but switches the source from the checked-in
fixture to a user-supplied Honua server and feature layer:

```text
http://127.0.0.1:8080/docs/examples/cesium-route-playback/?mode=live&baseUrl=https%3A%2F%2Fyour-honua-server.example&serviceId=transport&layerId=0&routeId=route-playback-demo&where=route_id%20%3D%20'route-playback-demo'
```

Optional terrain:

- `terrainUrl=https://terrain.example/tiles`
- or `ionToken=<token>` to use Cesium World Terrain

Notes:

- live mode calls `checkCompatibility()` before querying features
- the query is intentionally bounded and always uses `outFields=["*"]`,
  `outSr=4326`, `returnGeometry=true`, and `extraParams.returnZ=true`
- if the live layer can still return multiple polyline features, pass
  `routeId`, widen `resultRecordCount` enough to return that feature, set
  `routeIdField` when the identifier lives in a custom attribute, or narrow
  `where`/`objectIds`; the example errors instead of choosing one heuristically
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
4. In live mode, `data-path.mjs` synthesizes a minimal manifest from the bounded
   query request and URL parameters. It copies `routeId` into
   `manifest.query.routeIdValue` and uses it only for post-query client-side
   feature selection. It selects the polyline feature whose configured route id
   matches after string normalization, including numeric route ids that need to
   be coerced to strings. In live mode, `routeIdField` seeds
   `fieldMapping.routeId` when the layer uses a nonstandard attribute name, and
   matching treats that configured field as authoritative; without
   `routeIdField`, the selector falls back through the example's route-id
   aliases. If no returned polyline matches the configured route id, or if
   multiple polyline features remain without a configured route id, the example
   throws instead of guessing.
5. Multipart polylines are reduced to the physically longest path by measured
   segment distance, then normalized into Cesium-friendly WGS84 coordinates.
6. Route labels fall back through `route_name`, `routeName`, `name`, and `Name`.
   Route ids first honor `manifest.fieldMapping.routeId` when it is set, then
   fall back through `route_id`, `routeId`, `ROUTE_ID`, and `Name`.
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
- provide `routeId` or another query bound whenever a live route query can
  still return multiple polyline features, and raise `resultRecordCount` when
  the target route might not be the first returned feature
- provide `routeIdField` when the live route identifier is not exposed through
  the example's built-in route-id aliases
- normalize Esri polyline paths into one playback track by selecting the
  physically longest path
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
  feature and vertex counts, source-Z presence, height mode, terrain mode,
  request duration, playback distance, and playback duration
- the warnings panel shows terrain fallback and load failures directly

For browser smoke tests and local inspection, the example also exposes:

- `window.__cesiumRoutePlaybackDone`
- `window.__cesiumRoutePlaybackError`
- `window.__cesiumRoutePlaybackResult`

`window.__cesiumRoutePlaybackDone` flips to `true` on both success and failure
so smoke tests can wait on completion before inspecting the error or result.

`window.__cesiumRoutePlaybackResult` includes:

- `sourceMode`, `routeName`, `routeId`, `featureCount`, `vertexCount`, and `hasZ`
- `terrainEnabled`, `terrainMode`, and `heightMode`
- `compatibilitySupported` and `requestDurationMs`, both `null` in fixture mode
- `queryRequest`, `warnings`, `preprocessingSteps`, and `entityCount`

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
