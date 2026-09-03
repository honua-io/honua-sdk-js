# Bounded coverage quickstart

This browser example runs both real coverage clients against a committed, version-pinned transport:

- OGC API Coverages: `collections()` -> `collection()` -> `domainSet()` -> `rangeType()` -> `getCoverage()` with `properties=elevation`.
- WCS 2.0.1: `GetCapabilities` -> `DescribeCoverage` -> `GetCoverage` with `RANGESUBSET=elevation`.
- Presentation: both PNG results pass through `coverageToMapLibreImage()` and mount as a real MapLibre image source and raster layer.
- Resilience: each protocol independently aborts a superseded request and surfaces a structured unknown-band error without removing the active map.

```bash
npm run demo:coverages-wcs
npm run demo:coverages-wcs:typecheck
npm run demo:coverages-wcs:build
npm run test:playwright:coverages-wcs
```

The default issues zero external requests. `HonuaClient` is configured with the strict in-memory fixture transport, which validates the exact method, origin, paths, identifiers, bbox/subsets, named band, dimensions, CRS, format, and response ceiling before it returns a digest-pinned 320 x 220 PNG. MapLibre uses an inline style and the coverage object URL, with no basemap, glyph, sprite, or telemetry URL.

The 320 x 220 output size, South Oahu bbox, selected `elevation` field, and 1 MiB streaming response ceiling are deliberate fixture inputs, not portable server defaults. For a real deployment, configure or discover the endpoint and auth policy, collection/coverage identifiers, axis labels and order, supported bbox and CRS values, range field name, output dimensions, format, and safe response ceiling from that service's advertised metadata. The coverage clients continue to inherit auth refresh, retry, timeout, cancellation, and request-interceptor policy from the shared pipeline.

## Maturity

The standalone fixture bundle is browser-qualified, but OGC API Coverages and WCS support remain **experimental**. Anonymous live evidence and a scheduled interoperability lane are planned but missing. The canonical raster source registry records that ceiling; do not substitute an invented `demo.honua.io` endpoint.
