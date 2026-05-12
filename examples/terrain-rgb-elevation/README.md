# Honua Terrain-RGB Elevation Demo

MapLibre sample that proves the terrain and elevation audit surface:

- Terrain-RGB DEM tiles rendered as a `raster-dem` source with hillshade and terrain exaggeration.
- Point elevation lookup for a clicked coordinate.
- Elevation profile query for a drawn line, with fixture fallback when the profile endpoint is unavailable.
- Capability audit rows that map UI behavior to endpoints, SDK surfaces, and cache treatment.

## Run

Fixture-safe lane:

```bash
npm run demo:terrain-elevation:mock
```

Live Honua lane:

```bash
npm run demo:terrain-elevation
```

Set `VITE_HONUA_TERRAIN_BASE_URL` to the Honua deployment. Optional `VITE_HONUA_TERRAIN_SERVICE_ID` defaults to
`OahuTerrain`. Optional `VITE_HONUA_TERRAIN_API_KEY` is passed to SDK API calls and MapLibre Terrain-RGB tile
requests. Browser bearer-token forwarding through `VITE_HONUA_TERRAIN_BEARER_TOKEN` is disabled unless
`VITE_HONUA_ALLOW_BROWSER_BEARER_TOKEN=true` is also set; prefer short-lived API keys or backend-issued sessions for
browser demos.

## Honua Surfaces

| UI feature | SDK surface | Honua endpoint | Audit capability | Cache behavior |
| --- | --- | --- | --- | --- |
| Terrain-RGB map rendering | `new HonuaImageService(...).tileUrl()` | `/rest/services/OahuTerrain/ImageServer/tile/{z}/{y}/{x}` | Terrain-RGB tiles | Tile pyramid and ImageServer metadata are cacheable by source/config version. |
| Metadata status | `new HonuaImageService(...).metadata()` | `/rest/services/OahuTerrain/ImageServer` | Terrain-RGB tiles / metadata | Metadata is cacheable and safe to reuse until the source/config version changes. |
| Zoom Extent | MapLibre `fitBounds()` over the configured terrain extent | No additional endpoint after metadata/dataset load | Terrain-RGB tiles / metadata | Client-side viewport state. |
| Clicked point elevation | Demo-local helper over `HonuaClient.pipelineRequestJson()` | `/api/v1/terrain/OahuTerrain/elevation/value` | Elevation value API | Uncached ad hoc request because the clicked coordinate changes per interaction. |
| Start Line / Clear | Demo-local line geometry state | No server request until `Run Profile` | Elevation profile API preparation | Client-side geometry state. |
| Fixture Line | Demo-local fixture geometry followed by the profile helper | `/api/v1/terrain/OahuTerrain/elevation/profile` | Elevation profile API | Uncached deterministic fixture request for browser smoke coverage. |
| Drawn line profile | Demo-local helper over `HonuaClient.pipelineRequestJson()` | `/api/v1/terrain/OahuTerrain/elevation/profile` | Elevation profile API | Uncached ad hoc request because the user-drawn line changes per interaction. |
| Audit Mapping panel | Demo-local audit rows generated from the terrain dataset | Lists every endpoint above | Terrain-RGB tiles, Elevation value API, Elevation profile API | Static per dataset/config version. |

## SDK Gap

This sample intentionally does not add a public Terrain API to the SDK. The typed SDK surface currently covers
ImageServer tiles through `HonuaImageService.tileUrl()`, but elevation value/profile calls do not have first-class
request/response types. The demo keeps those helpers local and labels them in the audit mapping.

## Validation

```bash
npm run demo:terrain-elevation:typecheck
npm test -- test/terrain-rgb-elevation.test.ts
npm run demo:terrain-elevation:build
npm run test:playwright:terrain-elevation
```
