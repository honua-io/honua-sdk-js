# From a STAC asset to a bounded COG render

Use this walkthrough when a STAC search has returned an imagery asset and you
need to inspect, subset, style, and display it without downloading the entire
object. The fixture is pinned at
[`test/fixtures/raster/pinned-stac-cog-item.json`](../../test/fixtures/raster/pinned-stac-cog-item.json);
the walkthrough makes no live, unversioned catalog request.

## 1. Keep the STAC evidence

Pass the evidence-classified `StacAssetCandidate` from discovery into the
raster descriptor. Do not reduce the candidate to a `.tif` URL: a suffix is not
proof that the internal TIFF layout is cloud optimized.

```ts
const raster = await openRasterSession(
  { kind: "cog", id: candidate.id, candidate },
  { decoderFactory, decoderExecution: "worker", signal },
);
```

Expected outcome: `openRasterSession` resolves only after bounded decoder
inspection returns `format: "cog"`. An ordinary GeoTIFF fails with
`HonuaCogError.code === "unsupported-format"`.

## 2. Inspect the plan before doing work

```ts
const plan = raster.plan("read-window");
// mode: "worker-decode", bounded: true
```

The plan separates browser byte-range transport from decoder placement. Transfer
limits are enforced regardless of whether decoding occurs on the main thread or
behind a worker-backed factory.

## 3. Read only the required pixels and bands

```ts
const window = await raster.readWindow(
  {
    space: "pixel",
    x: 4096,
    y: 2048,
    width: 512,
    height: 512,
    outputSize: [256, 256],
    overviewDecimation: 2,
    bands: [3, 2, 1],
    resampling: "bilinear",
  },
  { signal },
);
```

Expected outcome: the transfer ledger contains exact HTTP `Range` requests and
never a whole-file response. Byte, range, and decoded-pixel ceilings fail closed
before an oversized operation continues.

## 4. Compare client and server subsets

For a published ImageServer rendition, keep the same task vocabulary but use a
bounded map extent:

```ts
const published = await openRasterSession({
  kind: "image-server",
  id: "oahu-imagery",
  baseUrl: "https://honua.example",
  serviceId: "Imagery/Oahu",
  deployment: "honua",
}, { clientOptions: { auth, interceptors } });

const image = await published.readWindow({
  space: "bbox",
  bbox: [-158.1, 21.2, -157.7, 21.6],
  width: 1024,
  height: 768,
  bands: [3, 2, 1],
  style: { kind: "stretch", method: "percent-clip", minPercent: 2, maxPercent: 2 },
});
```

Expected outcome: the direct path reports range bytes and decoded samples; the
published path returns a bounded image URL through the configured Honua auth,
retry, cancellation, and interceptor pipeline.

## Troubleshooting

- `unsupported-format`: the decoder found a TIFF that is not structurally cloud optimized. Publish a COG; do not bypass the check with a filename.
- `range-unsupported` or `whole-file-disallowed`: configure the host for exact byte ranges and readable CORS range headers.
- `byte-limit-exceeded`: reduce the window, select an overview, or raise a reviewed transfer budget explicitly.
- `core.capability-not-supported` for Coverage/WCS: provide an executor derived from advertised operation links. The SDK deliberately does not guess a service URL.
- Unsupported codec from the decoder: load a decoder build containing the codec, or use the server-rendered subset path.

The complete focused project is [`examples/raster-quickstart`](../../examples/raster-quickstart/README.md).

