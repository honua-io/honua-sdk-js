# Direct COG inspection, bounded reads, and MapLibre rendering

`@honua/sdk-js/cog` is an experimental, browser-safe boundary from static STAC
asset discovery to direct Cloud Optimized GeoTIFF inspection, pixel-window
reads, and an opt-in MapLibre image-source renderer. It is intentionally a
separate subpath: the stable root, `/honua`, and browser barrels do not import a
GeoTIFF or MapLibre implementation.

## Trust boundary

Start with the asset candidates produced by an explicit static-STAC
`connect()` call. `openStacCogAsset()` accepts only a candidate whose state is
`classified`, whose kind is `cog`, whose URL is credential-free HTTP(S), and
whose COG classification is supported by declared or probed media-type
evidence. A `.tif` suffix, a STAC extension URI, or an ambiguous plain
`image/tiff` declaration cannot cross the boundary.

The caller injects a decoder implementing two methods, `inspect()` and
`readWindow()`. The decoder receives a bounded `readRange()` callback for each
operation; it never receives an unbounded Fetch function. This keeps a
preferred GeoTIFF package lazy and application-owned while Honua enforces the
network and lifecycle policy.

```ts
import { connect } from "@honua/sdk-js";
import { openStacCogAsset, type CogDecoderFactory } from "@honua/sdk-js/cog";

declare const decoderFactory: CogDecoderFactory; // adapt the optional decoder chosen by the app

const connection = await connect({
  endpoint: "https://data.example/catalog.json",
  protocol: "stac",
  authorizationScopeFingerprint: "anonymous",
});
const candidate = connection.inspection.stacStatic?.assetCandidates.find(
  (asset) => asset.state === "classified" && asset.kind === "cog",
);
if (!candidate) throw new Error("No evidence-classified COG asset was discovered.");

const asset = openStacCogAsset(candidate, { decoderFactory });
try {
  const metadata = await asset.inspect();
  const window = await asset.readWindow({
    x: 0,
    y: 0,
    width: Math.min(256, metadata.width),
    height: Math.min(256, metadata.height),
    bands: [metadata.bands[0].index],
  });
  console.log(metadata.crs, metadata.resolution, window.transfer);
} finally {
  await asset.dispose();
}
```

## Bounded transport

Every asset request is a partial `GET` with an exact `Range` header. Redirects
and credentials are disabled. A readable `206` response must expose the exact
`Content-Range`; `200`, `416`, opaque CORS responses, compressed ranges,
dishonest lengths, changed validators, stream overflow, and a range covering
the complete resource fail with a typed `HonuaCogError`. Response bodies are
cancelled on rejection instead of falling back to whole-file materialization.

Default metadata, window, per-range, total-transfer, pixel, and decoded-byte
ceilings are available as `DEFAULT_COG_TRANSFER_LIMITS`. Callers may lower or
raise them only within hard SDK ceilings. `inspection.transfer`,
`window.transfer`, and `asset.transfer()` expose a deterministic request-order
ledger with byte counts and outcomes; it contains no wall-clock fields.

## Metadata and lifecycle

Inspection normalizes dimensions, CRS, bands, nodata, resolution, footprint,
overview decimations, STAC evidence, document provenance, and a stable asset
validator. A decoder reporting a non-COG format, unsupported CRS, malformed
footprint, or unbounded metadata is rejected.

Window reads use pixel coordinates and one-based inspected band indices. A new
window read aborts the preceding one and the preceding promise rejects with
`obsolete-read`. Caller aborts reject with `aborted`; disposal rejects pending
work with `disposed` and closes even a decoder factory that settles late.

An optional `sampling` descriptor asks the decoder for a bounded output size,
`nearest` or `bilinear` resampling, and one exact overview decimation advertised
by inspection. The session validates output dimensions, decoded pixels, and
decoded bytes. Existing requests without `sampling` remain native-resolution
reads.

## Viewport-driven MapLibre image source

`mountStacCogAssetToMapLibre()` accepts only the S1 session and a structurally
typed caller-owned MapLibre map. It imports neither `maplibre-gl` nor a raster
decoder. The mount inspects the asset, intersects the current `getBounds()`
viewport, chooses an advertised overview from the canvas/zoom target, reads a
bounded window, alpha-masks numeric nodata, encodes a bounded PNG with browser
Canvas 2D, and adds or updates one native MapLibre `image` source.

```ts
import {
  mountStacCogAssetToMapLibre,
  openStacCogAsset,
  type CogDecoderFactory,
  type StacCogAssetToMapLibreMap,
} from "@honua/sdk-js/cog";

declare const candidate: Parameters<typeof openStacCogAsset>[0];
declare const decoderFactory: CogDecoderFactory;
declare const map: StacCogAssetToMapLibreMap; // a maplibregl.Map satisfies this shape

const session = openStacCogAsset(candidate, { decoderFactory });
const mounted = mountStacCogAssetToMapLibre(map, session, {
  sourceId: "observed-imagery",
  beforeId: "labels",
  paint: { "raster-opacity": 0.85 },
});

try {
  const readiness = await mounted.ready;
  console.log(readiness.state, readiness.lastRender?.window, readiness.diagnostics);
} finally {
  await mounted.dispose(); // removes listeners/layer/source and disposes the session
}
```

`moveend` (including zoom) and `resize` start a new refresh. The newest
generation wins; stale reads and even a completed stale encode are checked
again immediately before renderer mutation. `ready` and `refresh()` settle on
supersession or disposal instead of leaving pending promises. Readiness means
the image-source mutation was accepted; consumers that need a visually painted
frame should separately wait for the caller-owned map's render/idle event.

The direct renderer deliberately supports only north-up, single-polygon grids
whose dimensions, resolution, and extent agree; EPSG:4326, OGC:CRS84, or
EPSG:3857; and uint8 identity-scaled grayscale or exact/explicit RGB(A) bands.
Rotated/multipart grids, other CRSs, string or partial nodata, non-uint8 data,
wrapped viewports, canvas/PNG failures, and source identity drift fail visibly
without projection, stretching, or analytic fallback. A viewport outside the
asset and an overview/output/encoded-size overflow return deterministic
`outside-extent` or `refused` readiness without a window read or map mutation.

`DEFAULT_COG_MAPLIBRE_RENDER_LIMITS` publishes the default output-pixel,
overview-source-pixel, encoded-byte, canvas-dimension, and diagnostic-history
ceilings. Callers may tighten them or raise them only within hard SDK limits.
This S2 bridge does not select assets in UI, cache decoded pixels, perform
raster analytics, or supply a GeoTIFF implementation.
