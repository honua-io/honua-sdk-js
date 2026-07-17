# Honua STAC → COG → MapLibre Quickstart

Candidate for the **Imagery and Terrain** golden journey. Its existing MapLibre
view proves Honua raster rendering paths for migration demos:

1. `connect()` discovers a static STAC Item.
2. STAC media-type evidence classifies candidate assets as COGs; filename suffixes are not trusted.
3. `openStacCogAsset()` lazily loads a caller-injected decoder, inspects metadata, and performs a bounded read.
4. `mountStacCogAssetToMapLibre()` reads only the visible window and owns map/source/session cleanup.
5. The UI discloses every requested range, fetched byte count, provenance, render state, and typed refusal.

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

## Run the deterministic demo

```bash
npm run demo:imagery-cog:mock
```

Choose the successful A/B assets or the deliberate failure cases in **Asset and failure scenario**. The fixture covers:

- successful discovery, inspection, bounded read, and MapLibre render;
- a server that ignores `Range`, browser-style CORS failure, unsupported CRS, and regular GeoTIFF refusal;
- slow-asset cancellation, latest-selection-wins behavior, and decoder/session/map resource release;
- keyboard focus, 44 px touch controls, live status announcements, and a one-column mobile layout.

The deterministic decoder is dynamically imported after selection. It is an injection-boundary fixture, not an SDK
dependency. [`scripts/lib/geotiff-cog-decoder.mjs`](../../scripts/lib/geotiff-cog-decoder.mjs) is the corresponding
lazy GeoTIFF.js adapter used by the public evidence lane. `geotiff` remains a dev-only sample dependency and is absent
from the SDK root, `/honua`, `/cog`, and prebuilt browser static graphs.

## Core application pattern

```ts doc-test=skip reason="partial excerpt requires application host context"
import { connect } from "@honua/sdk-js";
import { mountStacCogAssetToMapLibre, openStacCogAsset } from "@honua/sdk-js/cog";

const connection = await connect({
  endpoint: stacItemUrl,
  protocol: "stac",
  authorizationScopeFingerprint: "anonymous",
});
const candidate = connection.inspection.stacStatic?.assetCandidates.find(
  (asset) => asset.state === "classified" && asset.kind === "cog",
);
if (!candidate) throw new Error("No evidence-classified COG asset");

const session = openStacCogAsset(candidate, { decoderFactory, fetchFn: fetch });
const inspection = await session.inspect({ signal });
const preview = await session.readWindow(
  {
    x: 0,
    y: 0,
    width: 256,
    height: 256,
    bands: [1, 2, 3],
    sampling: { width: 128, height: 128, overviewDecimation: 2, resampling: "bilinear" },
  },
  { signal },
);
console.table(preview.transfer.ranges);

const mounted = mountStacCogAssetToMapLibre(map, session, {
  bands: { mode: "rgb", red: 1, green: 2, blue: 3 },
  disposeSession: true,
});
await mounted.ready;
// On asset switch or page teardown:
await mounted.dispose();
```

An application should abort and dispose the previous selection before opening the next, and gate every asynchronous
completion by a monotonically increasing selection generation. [`src/main.ts`](./src/main.ts) contains the complete
latest-wins implementation.

## Pinned public semantic evidence

The scheduled/manual lane pins Earth Search item `S2B_21WWV_20260706_0_L2A` and its `visual` COG. The contract records
the STAC identity, acquisition time, asset URL, ETag, byte length, 64-byte prefix digest, CRS/bands/resolution, and
overview ladder in
[`public-earth-search-sentinel-2.json`](../../test/fixtures/cog/public-earth-search-sentinel-2.json).

It is intentionally separate from ordinary CI:

```bash
HONUA_COG_LIVE_ENABLED=true npm run evidence:cog:live
```

Without that gate the producer performs no network calls and returns a truthful `skipped` envelope. The weekly
[`cog-live-evidence.yml`](../../.github/workflows/cog-live-evidence.yml) workflow runs the gated command and publishes
the resulting evidence artifact. Acquisition time and probe time are separate fields, and each live observation is
valid for eight days. The pinned Sentinel-2 asset is UTM (`EPSG:32621`), so this lane proves classification,
inspection, and bounded decoding; the offline WGS84 fixture proves MapLibre rendering and the UI demonstrates that an
unsupported render CRS is refused rather than silently warped.

## Published Honua comparisons

For a configured Honua deployment, copy `.env.example` to `.env`, set `VITE_HONUA_IMAGERY_BASE_URL`, and run:

```bash
npm run demo:imagery-cog
```

Optional API-key/bearer variables affect only the legacy published-service comparison. Browser bearer forwarding is
disabled unless `VITE_HONUA_ALLOW_BROWSER_BEARER_TOKEN=true`; prefer backend-issued sessions.

| UI path | SDK surface | Cache behavior |
| --- | --- | --- |
| Direct STAC COG | `connect` + `openStacCogAsset` + `mountStacCogAssetToMapLibre` | STAC metadata may be cached; visible-window asset ranges are bounded and evidenced. |
| WMS imagery | `client.wms().capabilities()` + `buildWmsRasterSourceSpec()` | Metadata cacheable; map images are viewport-specific. |
| Published COG tiles | `HonuaImageService.tileUrl()` | Metadata/legend cacheable; tiles are viewport-specific. |
| Export preview | `HonuaImageService.exportImage()` | Ad hoc export is not cached by the app. |

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
