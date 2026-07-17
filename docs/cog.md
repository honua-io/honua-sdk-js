# Direct COG inspection and bounded reads

`@honua/sdk-js/cog` is an experimental, browser-safe boundary from static STAC
asset discovery to direct Cloud Optimized GeoTIFF inspection and pixel-window
reads. It is intentionally a separate subpath: the stable root, `/honua`, and
browser barrels do not import a GeoTIFF implementation.

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

This S1 boundary does not render MapLibre layers, choose assets in UI, cache
decoded pixels, or perform raster analysis. Those consumers should build on
the inspection/read contract without weakening its range and provenance rules.
