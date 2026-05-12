# Honua Imagery and COG Quickstart

MapLibre sample that proves Honua raster rendering paths for migration demos:

- WMS `GetMap` rendered through `buildWmsRasterSourceSpec()`.
- Published COG rendered through `HonuaImageService.tileUrl()`.
- ImageServer `exportImage` preview for static COG inspection.
- Metadata and legend reads through the same `HonuaClient` base URL.

## Run

Fixture-safe lane:

```bash
npm run demo:imagery-cog:mock
```

Live Honua lane:

```bash
cp examples/imagery-cog-quickstart/.env.example examples/imagery-cog-quickstart/.env
npm run demo:imagery-cog
```

Set `VITE_HONUA_IMAGERY_BASE_URL` to the cloud Honua deployment. Optional `VITE_HONUA_IMAGERY_API_KEY` is passed to
both SDK API calls and MapLibre raster tile requests. Browser bearer-token forwarding through
`VITE_HONUA_IMAGERY_BEARER_TOKEN` is disabled unless `VITE_HONUA_ALLOW_BROWSER_BEARER_TOKEN=true` is also set; prefer
short-lived API keys or backend-issued sessions for browser demos.

## Honua Surfaces

| UI path | SDK surface | Honua endpoint | Cache behavior |
| --- | --- | --- | --- |
| Tiled imagery service | `client.wms().capabilities()` + `buildWmsRasterSourceSpec()` | `/rest/services/OahuImagery/MapServer/WMS` | Metadata cacheable; map tiles are viewport-specific. |
| Published COG through ImageServer | `new HonuaImageService(...).tileUrl()` | `/rest/services/OahuCog/ImageServer/tile/{z}/{y}/{x}` | Metadata and legend cacheable; map tiles are viewport-specific. |
| COG export preview | `HonuaImageService.exportImage()` | `/rest/services/OahuCog/ImageServer/exportImage` | Ad hoc export is not cached by the app. |

## Validation

```bash
npm run demo:imagery-cog:typecheck
npm test -- test/imagery-cog-quickstart.test.ts
npm run demo:imagery-cog:build
npm run test:playwright:imagery-cog
```
