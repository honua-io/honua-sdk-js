# Standalone Quickstart

The server-optional front door: this app points `@honua/sdk-js` at a **public
Esri GeoServices endpoint** and renders it on MapLibre with **no Honua server, no
API key, and no account**. It is the runnable proof that the SDK is a
maintained, MapLibre-targeting successor to `esri-leaflet`.

What it exercises, all against a public endpoint:

1. `loadHonuaFeatureServiceGeoJson()` (`@honua/sdk-js/map`) — one call turns a
   public FeatureServer URL into a MapLibre `geojson` source.
2. `HonuaClient.getLayerMetadata()` — typed layer name / geometry type.
3. `FeatureLayerCompat` (`@honua/sdk-js/esri-compat`) — the `esri-leaflet`
   migration drop-in, run against the *same* `services.arcgis.com`-style URL to
   prove it works standalone.
4. MapLibre rendering of the queried features.

See [`docs/standalone-quickstart.md`](../../docs/standalone-quickstart.md) and the
[backend-agnostic capability matrix](../../docs/standalone-capability-matrix.md).

## Run it

```bash
npm install

# Live lane — hits the pinned public Esri Living Atlas FeatureServer.
npm run demo:standalone

# Deterministic lane — replays recorded fixtures on same-origin paths (CI's lane).
npm run demo:standalone:mock   # prints standaloneMockUrl=http://127.0.0.1:PORT
```

## Configuration

Copy `.env.example` to `.env` to override the defaults. All vars are optional;
the defaults target Esri's public census FeatureServer.

- `VITE_STANDALONE_FEATURE_LAYER_URL` — any public GeoServices FeatureServer
  *layer* URL (`.../FeatureServer/{layerId}`).
- `VITE_STANDALONE_WHERE` — server-side WHERE clause (default `1=1`).
- `VITE_STANDALONE_OUT_FIELDS` — comma-separated fields (default all).
- `VITE_STANDALONE_MAX_PAGES` — max pages the paginated query drains (default 4).
- `VITE_STANDALONE_BASEMAP_STYLE` — MapLibre basemap (default MapLibre demotiles).

## Fixtures & CI

Recorded GeoServices JSON lives in
[`test/fixtures/standalone-quickstart-demo/`](../../test/fixtures/standalone-quickstart-demo/).
`mock-server.mjs` rebuilds the app with the FeatureServer URL pointed at a
same-origin relative path, then replays those recordings — so CI and the
Playwright smoke (`test/playwright/standalone-quickstart.spec.mjs`) never touch a
third-party service.

Refresh the recordings from the live endpoints on demand:

```bash
npm run demo:standalone:refresh-fixtures
```

A scheduled, non-blocking workflow
([`.github/workflows/standalone-live-smoke.yml`](../../.github/workflows/standalone-live-smoke.yml))
probes the live endpoints weekly and link-checks the documented list. It never
runs on a PR, so it can never block one.

## Public endpoints & licensing

- **Esri Living Atlas — 2020 Census State Apportionment FeatureServer**
  (`services.arcgis.com/P3ePLMYs2RVChkJx/...`): publicly shared Esri Living Atlas
  content over US Census (public-domain) data; anonymous read-only.
- **Esri SampleWorldCities MapServer** (`sampleserver6.arcgisonline.com`): Esri's
  public sample server, hosted expressly for samples and demos.
- **pygeoapi demo** (`demo.pygeoapi.io`): the pygeoapi project's official public
  OGC API demo (MIT project) over Natural Earth (public-domain) data.

All are used read-only for demonstration. See
[`docs/standalone-capability-matrix.md`](../../docs/standalone-capability-matrix.md)
for why GeoServices is the fully backend-agnostic lane today.

## Add a Honua Server

A [Honua Server](https://github.com/honua-io/honua-server) is the upgrade path
(authored MapPackages, realtime, collaboration, MCP), not the entry fee. Point
the same SDK code at a local server (`docker compose up` in a honua-server
checkout) — see [`examples/maplibre-quickstart/`](../maplibre-quickstart/README.md)
for the server-connected lane.
