# Honua Imagery and Terrain Journey

This MapLibre-first sample is the fixture-backed default and configured-live
implementation of the Imagery and Terrain golden-journey candidate. It uses
public SDK surfaces for one continuous workflow:

1. Search a STAC collection by Oʻahu extent, acquisition dates, and cloud
   threshold through `HonuaClient.stac().search()`.
2. Classify the selected STAC asset, open it through the opt-in `/cog` SDK
   surface, disclose every bounded range request, and mount the decoded window
   in MapLibre.
3. Inspect asset identity, footprint, CRS, bands, resolution, nodata policy,
   checksum, attribution, license, acquisition/version, cache identity, and an
   independent bounded `bytes=0-63` TIFF-header receipt.
4. Compare the direct COG mount with supported WMS and ImageServer imagery.
   The comparison slider controls direct COG opacity over the published path.
5. Query a point elevation and sample a deterministic route profile through
   the public elevation helpers.
6. Enable MapLibre Terrain-RGB, hillshade, pitch, and bearing as an honest 2.5D
   context view.

The sample is responsive, keyboard operable, Axe-clean, and designed to make
degraded states visible. Switching assets cancels obsolete inspection and
decode work, releases the previous direct COG mount, and releases the retained
published preview. Disposal aborts pending work, releases both raster
lifecycles, removes listeners, and tears down MapLibre.

## Fidelity boundary

The offline browser lane uses the real `/cog` session and MapLibre mount with a
lazy deterministic decoder. It proves classification, bounded range
accounting, decoded-window rendering, comparison, cancellation, and cleanup;
the committed bytes and decoder are fixtures, not a claim that the asset is a
production GeoTIFF. The scheduled public lane separately uses the pinned
GeoTIFF.js adapter to inspect a real Earth Search COG and decode a bounded
window. A configured browser deployment loads that same adapter lazily for a
same-origin STAC item; unsupported CRS or transport semantics fail visibly.
The adapter and pinned GeoTIFF.js development dependency are sample-owned, so
the SDK root and `/honua` entrypoints retain no decoder dependency.
The pinned public asset is UTM, so the evidence does not claim browser-side
reprojection or a georeferenced MapLibre mount. Scientific resampling/analysis
and Cesium production support are also outside this journey's claim.

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
credentials into its browser bundle. A separate scheduled, anonymous live lane
checks one immutable STAC item, its pinned prefix and validators, semantic COG
inspection, exact partial responses, and a bounded decoded window without
changing the browser-safe default:

```bash
HONUA_COG_LIVE_ENABLED=true npm run evidence:cog:live
```

## Public SDK and service surfaces

| Workflow | SDK surface | Endpoint |
| --- | --- | --- |
| STAC discovery | `HonuaClient.stac().search()` | `/stac/search` |
| Direct COG render | `connect()` + `openStacCogAsset()` + `mountStacCogAssetToMapLibre()` | Fixture `/fixtures/cog/item.json` or configured `/stac/collections/{collection}/items/{item}`, then exact partial requests to the selected asset |
| Bounded COG receipt | `HonuaClient.pipelineFetch()` | Selected same-origin STAC asset with `Range: bytes=0-63` |
| Published WMS pixels | `buildWmsRasterSourceSpec()` with MapLibre's exact `{bbox-epsg-3857}` and literal tile dimensions | `/rest/services/OahuImagery/MapServer/WMS` |
| Published ImageServer pixels | `HonuaImageService.tileUrl()` | `/rest/services/OahuCog/ImageServer/tile/{z}/{y}/{x}` |
| Terrain-RGB | `HonuaImageService.tileUrl()` | `/rest/services/OahuTerrain/ImageServer/tile/{z}/{y}/{x}` |
| Point/profile elevation | `HonuaClient.pipelineRequestJson()` + `sampleElevationProfile()` | `/api/v1/terrain/OahuTerrain/elevation/value` |

The browser receipt calls a normally observed ETag `observed`, not
`revalidated`. Elevation is labeled `revalidated` only when its service response
explicitly reports that cache outcome. All search, range, elevation, and profile
requests are owned by the journey and aborted during disposal.

The WMS path exercises the public runtime helper directly. The helper rejects
credential-bearing endpoints and invalid tile sizes, preserves safe endpoint
parameters, and emits the exact MapLibre bbox placeholder with concrete
`WIDTH`/`HEIGHT` values.

## Validation

```bash
npm run demo:imagery-cog:typecheck
npm test -- test/imagery-cog-quickstart.test.ts test/imagery-terrain-journey.test.ts
npm run samples:run -- build --sample imagery-cog-quickstart --sdk-mode source
npm run samples:run -- build --sample imagery-cog-quickstart --sdk-mode packed
npm run test:playwright:imagery-cog
HONUA_COG_LIVE_ENABLED=true npm run evidence:cog:live
npm run samples:verify
```

The Playwright journey covers the supported and degraded asset paths, asset
switch cancellation, comparison and terrain controls, elevation/profile output,
desktop/mobile layout, keyboard navigation, Axe, console cleanliness, teardown,
source/packed SDK resolution, and bounded bundle/memory observations.

The scheduled live lane is anonymous and pinned. Its artifact is supporting
evidence, not a committed golden receipt: gallery qualification remains planned
until reviewed receipts satisfy every required gate. Older WMS, Terrain-RGB,
and 2.5D publication routes converge here; the small STAC browser remains a
focused credential-free recipe.

## Public standalone COG fixture

The default build is deployable without Honua demo infrastructure. It ships a deterministic CC0-1.0 tiled EPSG:4326 GeoTIFF as SHA-256-pinned 64 KiB chunks. The bundle-local adapter accepts bounded `Range` requests, verifies every fetched chunk, returns `206`, and rejects complete-object downloads. The rendered natural-color overview, transfer ledger, legend, and sampled RGB value provide visible rendering and pixel-inspection evidence. Unsupported CRS, non-COG formats, absent range support, and unsupported statistics remain fail closed.

```ts doc-test=compile
import {
  mountStacCogAssetToMapLibre,
  openStacCogAsset,
  type CogDecoderFactory,
  type StacCogAssetToMapLibreMap,
} from "@honua/sdk-js/cog";

declare const candidate: Parameters<typeof openStacCogAsset>[0];
declare const decoderFactory: CogDecoderFactory;
declare const map: StacCogAssetToMapLibreMap;

const session = openStacCogAsset(candidate, { decoderFactory });
const inspection = await session.inspect();
const pixels = await session.readWindow({
  x: 8, y: 8, width: 16, height: 16, bands: [1, 2, 3],
  sampling: { width: 8, height: 8, overviewDecimation: 4, resampling: "nearest" },
});
const mounted = mountStacCogAssetToMapLibre(map, session, { sourceId: "direct-cog" });
await mounted.ready;
```

[Open the complete project](./)
