# Honua STAC → COG → MapLibre Quickstart

This runnable sample makes direct raster behavior inspectable instead of hiding it behind a tile service. Its primary
fixture-safe workflow uses only published SDK surfaces:

1. `connect()` discovers a static STAC Item.
2. STAC media-type evidence classifies candidate assets as COGs; filename suffixes are not trusted.
3. `openStacCogAsset()` lazily loads a caller-injected decoder, inspects metadata, and performs a bounded read.
4. `mountStacCogAssetToMapLibre()` reads only the visible window and owns map/source/session cleanup.
5. The UI discloses every requested range, fetched byte count, provenance, render state, and typed refusal.

The same screen retains WMS `GetMap`, ImageServer tiles, and `exportImage` as published-service comparisons.

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
npm test -- test/imagery-cog-quickstart.test.ts test/cog-live-evidence.test.ts
npm run demo:imagery-cog:build
npm run test:playwright:imagery-cog
```
