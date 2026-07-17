# First Map troubleshooting

Use this guide with the canonical [`maplibre-quickstart`](../examples/maplibre-quickstart/README.md). Begin with the
closed, credential-free fixture so endpoint and browser-policy failures stay separate from application failures:

```bash
npm run demo:quickstart:mock
```

## Invalid endpoint or configuration

First Map accepts an absolute HTTP(S) GeoServices `FeatureServer/{layerId}` URL or an OGC API Features landing page.
Endpoint URLs cannot contain user info, non-format query parameters, or fragments. Basemap style URLs are also
credential-free and cannot carry query or fragment data.

The reviewed browser settings are:

- `VITE_HONUA_FIRST_MAP_URL`
- `VITE_HONUA_FIRST_MAP_MODE` (`fixture` or `public-live`)
- `VITE_HONUA_FIRST_MAP_PROTOCOL` (`auto`, `geoservices-feature-service`, or `ogc-features`)
- `VITE_HONUA_FIRST_MAP_SOURCE_ID`
- `VITE_HONUA_FIRST_MAP_MAX_FEATURES` (an integer from 1 through 10,000)
- `VITE_HONUA_FIRST_MAP_FILTER`
- `VITE_HONUA_FIRST_MAP_BASEMAP_STYLE`

There is no browser API-key or bearer-token setting. Vite publishes `VITE_*` values in client JavaScript, so protected
traffic belongs behind an application session or server-side proxy.

## Source selection is required

When discovery advertises more than one source, the SDK does not pick the first one. Select the advertised source in the
source picker and submit again. For an OGC landing page, use the explicit `ogc-features` hint when auto-discovery cannot
identify the protocol from the URL alone.

## Unsupported capability, overflow, or query failure

First Map keeps these states distinct:

- unsupported capability means the selected source cannot satisfy a geometry-bearing bounded query;
- overflow means the source reports more features than the approved `maxFeatures` bound;
- an unsafe or rejected source-native filter remains a query error, not an empty map;
- zero returned records is shown as an empty result, while missing renderable geometry is reported separately.

Inspect the strategy reasons, advertised capabilities, diagnostics, count, geometry kinds, and overflow row beside the
map. Do not raise the bound just to hide an overflow; narrow the filter or choose a source designed for map delivery.

## Authentication, CORS, and network failures

HTTP `401` or `403` means the endpoint is not anonymous. Use a public endpoint or an application backend. If a request
works in a server-side tool but fails in the browser, confirm that the source and basemap permit the Vite/preview origin
through CORS. The fixture lane should make no non-loopback request; its passing while public mode fails usually points to
endpoint or browser policy.

## Basemap failures

The public basemap style and all dependent assets must be anonymously browser-readable. The fixture lane serves its
style locally to remove that variable. A basemap error does not convert a successful source query into a false ready
state.

## Anonymous staging lane

`npm run test:quickstart:staging` executes the same public First Map semantic path without opening a browser. It requires:

- `HONUA_STAGING_BASE_URL`
- `HONUA_STAGING_SERVICE_ID`
- `HONUA_STAGING_LAYER_ID`

`HONUA_STAGING_RESULT_RECORD_COUNT` and `HONUA_QUICKSTART_STAGING_SUMMARY_FILE` are optional. The target must allow
anonymous metadata and bounded feature reads. The workflow summary reports endpoint origin, protocol, source, metadata
cache state, strategy, feature count, and geometry count; it never contains endpoint credentials or feature payloads.

## Runtime inspection and cleanup

The browser smoke and local diagnostics use:

- `window.__HONUA_QUICKSTART_EVENTS__`
- `window.__HONUA_QUICKSTART_RUNTIME__`
- `window.__HONUA_QUICKSTART_DISPOSE__()`
- `CustomEvent("honua:quickstart")`

Useful runtime fields include mode, endpoint origin, source identity, feature and geometry counts, plan strategy, first-map
duration, budget outcome, layer IDs, popup state, last error, journey completion, and disposal state. The disposer is
idempotent and removes in-flight work, listeners, popups, bridge layers, MapLibre, the kernel, and sample presentation.
