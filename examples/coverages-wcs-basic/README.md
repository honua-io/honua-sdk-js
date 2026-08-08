# Bounded coverage quickstart

This is the smallest OGC API Coverages workflow: inspect domain and range metadata, request a spatially and dimensionally bounded PNG, then project it to a MapLibre-compatible image source/layer descriptor.

```bash
npm run demo:coverages-wcs
npm run demo:coverages-wcs:typecheck
npm run demo:coverages-wcs:build
```

The default uses an in-memory, version-pinned fixture, so it does not depend on a live service. In an application, keep the `HonuaClient` and replace only its `baseUrl`/auth configuration; the coverage client then inherits its auth refresh, retries, timeout, cancellation, and request interceptors.

The deliberate safety rails are part of the example: `bbox`, `scaleSize`, and `maxResponseBytes` prevent a metadata exploration task from becoming an unbounded raster download.
