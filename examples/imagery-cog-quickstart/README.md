# Honua Imagery and Terrain Journey

This MapLibre-first sample is the fixture-backed S2 implementation of the
Imagery and Terrain golden-journey candidate. It uses public SDK surfaces for
one continuous workflow:

1. Search a STAC collection by Oʻahu extent, acquisition dates, and cloud
   threshold through `HonuaClient.stac().search()`.
2. Inspect asset identity, footprint, CRS, bands, resolution, nodata policy,
   checksum, attribution, license, acquisition/version, cache identity, and a
   bounded `bytes=0-63` TIFF range receipt.
3. Compare supported WMS and ImageServer imagery in MapLibre. The comparison
   slider controls the published ImageServer layer over the WMS base.
4. Query a point elevation and sample a deterministic route profile through
   the public elevation helpers.
5. Enable MapLibre Terrain-RGB, hillshade, pitch, and bearing as an honest 2.5D
   context view.

The sample is responsive, keyboard operable, Axe-clean, and designed to make
degraded states visible. Switching assets cancels obsolete work and releases
the previously retained raster preview. Disposal aborts pending work, releases
the retained selection, removes listeners, and tears down MapLibre.

## Fidelity boundary

This sample does **not** implement a second raster stack. The committed range
fixture proves HTTP range semantics and the TIFF signature, but is not a
renderable GeoTIFF. Direct STAC-to-COG decoding/rendering remains open in
[#537](https://github.com/honua-io/honua-sdk-js/issues/537), so displayed pixels
use supported WMS and ImageServer paths. Cesium production support is also out
of scope; the fidelity report labels it as a lab.

Every compatibility failure keeps the selected STAC identity visible:

| Outcome | Fixture behavior | Visible action |
| --- | --- | --- |
| `credentials` | Asset URL contains signed query values or URL userinfo | Redact the receipt, refuse the fetch, and require a credential-free same-origin proxy path. |
| `cors` | Asset points at another origin | Explain that a configured same-origin Honua proxy is required; retain WMS. |
| `range` | Server ignores `Range`, returns `200`, or lies with an oversized/chunked `206` | Cancel at the hard byte ceiling; refuse the full download; retain WMS. |
| `crs` | Asset requires unsupported reprojection | Explain the CRS boundary; retain WMS. |
| `format` | Asset is not a supported GeoTIFF | Disable inspection; retain WMS. |
| `nodata` | Raster metadata or elevation has no finite value | Return an explicit unsupported state; never substitute zero. |

## Run

Fixture-safe development:

```bash
npm run demo:imagery-cog:mock
```

The shared sample kit can exercise the repository source or a packed published
SDK artifact:

```bash
npm run samples:run -- dev --sample imagery-cog-quickstart --sdk-mode source
npm run samples:run -- build --sample imagery-cog-quickstart --sdk-mode source
npm run samples:run -- build --sample imagery-cog-quickstart --sdk-mode packed
npm run samples:run -- test --sample imagery-cog-quickstart --sdk-mode source
npm run samples:run -- test --sample imagery-cog-quickstart --sdk-mode packed
```

For a configured Honua deployment:

```bash
npm run demo:imagery-cog
```

Set `VITE_HONUA_IMAGERY_BASE_URL` to a path on the browser origin (for example,
`/honua`). Authentication belongs in that reverse proxy or an HttpOnly session;
the sample does not read API keys, bearer tokens, signed asset URLs, or other
credentials into its browser bundle. Pinned live STAC/COG qualification remains
S3 work.

## Public SDK and service surfaces

| Workflow | SDK surface | Endpoint |
| --- | --- | --- |
| STAC discovery | `HonuaClient.stac().search()` | `/stac/search` |
| Bounded COG receipt | `HonuaClient.pipelineFetch()` | Selected same-origin STAC asset with `Range: bytes=0-63` |
| Published WMS pixels | `buildWmsRasterSourceSpec()` plus an explicit legacy-token normalization to MapLibre's `{bbox-epsg-3857}` | `/rest/services/OahuImagery/MapServer/WMS` |
| Published ImageServer pixels | `HonuaImageService.tileUrl()` | `/rest/services/OahuCog/ImageServer/tile/{z}/{y}/{x}` |
| Terrain-RGB | `HonuaImageService.tileUrl()` | `/rest/services/OahuTerrain/ImageServer/tile/{z}/{y}/{x}` |
| Point/profile elevation | `HonuaClient.pipelineRequestJson()` + `sampleElevationProfile()` | `/api/v1/terrain/OahuTerrain/elevation/value` |

The browser receipt calls a normally observed ETag `observed`, not
`revalidated`. Elevation is labeled `revalidated` only when its service response
explicitly reports that cache outcome. All search, range, elevation, and profile
requests are owned by the journey and aborted during disposal.

The WMS adapter is deliberately visible: the current SDK helper emits a legacy
`{bbox-epsg3857}` placeholder and dynamic width/height placeholders that
MapLibre does not expand. This sample normalizes the bbox token and fixes the
dimensions to `tileSize`; the runtime helper should absorb that correction in a
follow-up SDK-wide change tracked by [#620](https://github.com/honua-io/honua-sdk-js/issues/620).

## Validation

```bash
npm run demo:imagery-cog:typecheck
npm test -- test/imagery-cog-quickstart.test.ts test/imagery-terrain-journey.test.ts
npm run samples:run -- build --sample imagery-cog-quickstart --sdk-mode source
npm run samples:run -- build --sample imagery-cog-quickstart --sdk-mode packed
npm run test:playwright:imagery-cog
npm run samples:verify
```

The Playwright journey covers the supported and degraded asset paths, asset
switch cancellation, comparison and terrain controls, elevation/profile output,
desktop/mobile layout, keyboard navigation, Axe, console cleanliness, teardown,
source/packed SDK resolution, and bounded bundle/memory observations.

S3 still owns pinned authenticated live evidence and convergence redirects from
the older focused STAC, Terrain-RGB, and 2.5D recipes. This sample must remain a
recipe until those gates are satisfied.
