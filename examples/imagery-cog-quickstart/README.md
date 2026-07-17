# Honua Imagery and COG Quickstart

Candidate for the **Imagery and Terrain** golden journey. Its existing MapLibre
view proves Honua raster rendering paths for migration demos:

- WMS `GetMap` rendered through `buildWmsRasterSourceSpec()`.
- Published COG rendered through `HonuaImageService.tileUrl()`.
- ImageServer `exportImage` preview for static COG inspection.
- Metadata and legend reads through the same `HonuaClient` base URL.

The S1 headless workflow in `src/journey.ts` now consolidates the reusable data
path that the accessible S2 interface will consume:

1. Search an area/date/cloud threshold through `HonuaClient.stac().search()`.
2. Select an asset and inspect its identity, footprint, CRS, bands, resolution,
   nodata policy, checksum, attribution, license, and acquisition/version data.
3. Probe only `bytes=0-63` through `HonuaClient.pipelineFetch()` and require a
   real `206`, `Content-Range`, `Accept-Ranges: bytes`, and TIFF signature.
4. Read point elevation through `HonuaClient.pipelineRequestJson()` and build a
   route profile through the public `sampleElevationProfile()` helper.
5. Cancel obsolete asset work and release renderer-owned resources on every
   switch or disposal.

This is intentionally a transport/metadata receipt, not a second raster stack.
The committed range fixture is a tiny TIFF-header fixture, not a renderable
GeoTIFF. Direct STAC-to-COG decoding and MapLibre rendering remain open in
[#537](https://github.com/honua-io/honua-sdk-js/issues/537); pixels continue to
use the supported WMS/ImageServer comparison paths.

## Deterministic outcomes

The fixture server makes every compatibility boundary observable rather than
silently degrading:

| Outcome | Fixture behavior | Application action |
| --- | --- | --- |
| `cors` | Asset points at another origin | Route it through an explicitly configured same-origin Honua proxy. |
| `range` | Server ignores `Range` and returns `200` | Keep metadata visible; do not download the full raster. |
| `crs` | Asset requires reprojection outside EPSG:4326/3857 | Use a supported published preview until reprojection support lands. |
| `format` | Asset declares a non-GeoTIFF media type or has no TIFF signature | Keep discovery metadata visible and disable COG inspection. |
| `nodata` | Raster bands omit a finite nodata declaration, or elevation returns no data | Return an explicit unsupported result; never substitute zero. |

Cache receipts combine the STAC collection/item/asset identity with the HTTP
ETag (or declared checksum), and keep `Cache-Control`, acquisition time,
provider attribution, license, source version, and checksum visible.

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
npm test -- test/imagery-cog-quickstart.test.ts test/imagery-terrain-journey.test.ts
npm run demo:imagery-cog:build
npm run test:playwright:imagery-cog
```

S1 covers the deterministic data workflow and focused tests. The accessible
MapLibre journey, responsive/visual/performance gates, pinned live STAC/COG
evidence, and old-route redirects are S2/S3 work; the focused STAC, Terrain-RGB,
and 2.5D recipes remain available as small modules until that promotion.
