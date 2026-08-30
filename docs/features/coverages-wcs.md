# Read multidimensional coverages with OGC API Coverages and WCS

> **Maturity: experimental.** The standalone fixture is release-gated in a real browser, but there is no reviewed anonymous live OGC API Coverages or WCS canary. The canonical raster source registry therefore keeps both adapters experimental.

Use `@honua/sdk-js/coverages` when the output is a raster value grid rather than vector features or a pre-rendered map. The client keeps protocol details explicit and uses the same `HonuaClient` request pipeline as the rest of the SDK.

## Run the qualified standalone example

[`examples/coverages-wcs-basic`](../../examples/coverages-wcs-basic/README.md) executes both real clients against a strict committed transport, renders their PNG results through the same MapLibre image-source helper, and exposes cancellation and structured WCS degradation without a live fallback.

```bash
npm run demo:coverages-wcs
npm run test:playwright:coverages-wcs
```

The example's `fixtureFetch` rejects every unexpected origin. Its browser test separately blocks and records any escaped HTTP request, so the fixture qualification cannot silently become a network-dependent demo. This proves the bundle and developer workflow; it does not claim real-server interoperability.

## Choose the right raster path

| Need | Start with | Why |
| --- | --- | --- |
| Discover axes/range fields and request a subset | OGC API Coverages | JSON discovery and straightforward HTTP resources |
| Integrate an established scientific/enterprise coverage service | WCS 2.0.1 | Broad compatibility and explicit KVP coverage operations |
| Read windows directly from an object-store file | COG | Range requests without a coverage service |
| Use ImageServer rendering, statistics, or Esri-compatible clients | ImageServer | GeoServices raster operations and ecosystem compatibility |

## 1. Create one authenticated request pipeline

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";
import { createCoverageClient } from "@honua/sdk-js/coverages";

const client = new HonuaClient({
  baseUrl: "https://data.example.com",
  apiKey: process.env.HONUA_API_KEY,
  timeoutMs: 15_000,
  // Existing HonuaClient interceptors, retries, and auth-provider refresh also apply.
});
const coverages = createCoverageClient(client);
```

Coverage endpoints must share the client's origin. This prevents a caller from accidentally forwarding credentials to a discovered cross-origin link.

## 2. Discover before downloading

```ts doc-test=skip reason="continuation requires prior walkthrough state"
const service = await coverages.discover();
const source = coverages.source(service.collections[0]!.id);
const [domain, range] = await Promise.all([source.domainSet(), source.rangeType()]);

console.table(domain.axes);
console.table(range.fields);
```

`domainSet()` normalizes CRS, extent, grid, and named axes. `rangeType()` normalizes bands/fields, data types, and no-data values while preserving raw server metadata.

## 3. Request a bounded subset

```ts doc-test=skip reason="continuation requires prior walkthrough state"
const controller = new AbortController();
const result = await source.coverage({
  bbox: [-158.1, 21.3, -157.9, 21.5],
  subsets: [{ axis: "phenomenonTime", low: "2025-01-01T00:00:00Z" }],
  properties: ["elevation"],
  scaleSize: { width: 512, height: 512 },
  format: "image/png",
  maxResponseBytes: 8 * 1024 * 1024,
  signal: controller.signal,
});
```

The SDK rejects a request without a bbox, axis subset, or scaling constraint unless `allowFullCoverage: true` is explicit. It rejects oversized declared bodies before reading and enforces the same limit while streaming when `Content-Length` is missing or dishonest.

## WCS compatibility

```ts doc-test=skip reason="continuation requires prior walkthrough state"
import { createWcsClient } from "@honua/sdk-js/coverages";

const wcs = createWcsClient(client, { basePath: "/ogc/services/7/wcs" });
const capabilities = await wcs.capabilities();
const [description] = await wcs.describeCoverage(["7"]);
const geotiff = await wcs.getCoverage("7", {
  // Axis order is preserved exactly as supplied.
  subsets: [
    { axis: description!.axisLabels[0]!, low: 21.3, high: 21.5 },
    { axis: description!.axisLabels[1]!, low: -158.1, high: -157.9 },
  ],
  rangeSubset: ["elevation"],
  scaleSize: { Lat: 512, Long: 512 },
  format: "image/tiff",
});
```

The WCS client supports GetCapabilities, DescribeCoverage, GetCoverage, repeated `SUBSET`, `BBOX`, CRS selection, range subset, scaling, interpolation, temporal selection, and TIFF/PNG/JPEG negotiation. OWS exception reports become `HonuaWcsExceptionError` with stable `exceptionCode`, `locator`, and `statusCode` fields.

## Display a browser image

`coverageToMapLibreImage()` converts a PNG/JPEG response and bbox into a MapLibre image source plus raster layer descriptor. The qualified example passes both the OGC `properties=elevation` response and WCS `RANGESUBSET=elevation` response through this helper, then switches the mounted source without changing presentation code. Dispose each object URL when the map or layer is removed. GeoTIFF remains a data result; render it with the COG/raster pipeline or request PNG from the service.

## Discovery integration status

This package subpath is usable directly. Discovery and session capability selection project from `config/raster-source-registry.v1.json`; adapters consume advertised endpoints and never derive them from labels or URL shapes.
