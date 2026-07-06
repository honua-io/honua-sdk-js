# 5-Minute Quickstart: Query Features and Render on a Map

> **Start server-optional.** You do **not** need a Honua server to use this SDK.
> The fastest path with zero infrastructure — a public GeoServices endpoint in,
> a MapLibre map out — is the
> [standalone quickstart](./standalone-quickstart.md) and its committed app
> [`examples/standalone-quickstart/`](../examples/standalone-quickstart/README.md).
> This page covers the **server-connected** lane (compatibility gate, Honua
> fixtures/live env); see the
> [backend-agnostic capability matrix](./standalone-capability-matrix.md) for
> which features need a server.

The canonical runnable browser quickstart for the **server-connected** lane is the committed
example app at [`examples/maplibre-quickstart/`](../examples/maplibre-quickstart/README.md).

## Fastest Local Path

Run the fixture-backed app from this repo:

```bash
npm install
npm run demo:quickstart:mock
```

The command builds the example, serves deterministic Honua fixture responses on same-origin paths, and prints
`quickstartMockUrl=http://127.0.0.1:PORT`.

What this committed app exercises:

1. `HonuaClient.checkCompatibility()`
2. one read-only `queryFeatures()` call
3. Esri JSON to GeoJSON conversion in the example
4. MapLibre rendering
5. popup-backed feature inspection

Use the example README for the full local and live lanes:

- [`examples/maplibre-quickstart/README.md`](../examples/maplibre-quickstart/README.md)
- [`docs/quickstart-troubleshooting.md`](./quickstart-troubleshooting.md)

For the more advanced demo lanes, use the dedicated guides instead of expanding this quickstart:

- [`examples/storytelling-25d-map/README.md`](../examples/storytelling-25d-map/README.md)
- [`examples/kepler-analytics/README.md`](../examples/kepler-analytics/README.md)
- [`docs/examples/cesium-route-playback/README.md`](./examples/cesium-route-playback/README.md)

## Live Honua Path

Point the same app at a prepared Honua environment:

```bash
cp examples/maplibre-quickstart/.env.example examples/maplibre-quickstart/.env
npm run demo:quickstart
```

The live app accepts:

- `VITE_HONUA_QUICKSTART_BASE_URL` for live runs. Leave it empty only for the same-origin fixture lane.
- optional `VITE_HONUA_QUICKSTART_SERVICE_ID`. Default: `natural-earth`.
- optional `VITE_HONUA_QUICKSTART_LAYER_ID`. Default: `0`. Must parse as an integer.
- optional `VITE_HONUA_QUICKSTART_WHERE`. Default: `1=1`.
- optional `VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT`. Default: `25`. Must be greater than `0`.
- optional `VITE_HONUA_QUICKSTART_BASEMAP_STYLE`. Default: `https://demotiles.maplibre.org/style.json`.
- optional `VITE_HONUA_QUICKSTART_API_KEY`
- optional `VITE_HONUA_QUICKSTART_BEARER_TOKEN`, ignored in browser demos unless
  `VITE_HONUA_ALLOW_BROWSER_BEARER_TOKEN=true` is also set. Prefer short-lived API keys or backend-issued sessions for
  browser demos.

Invalid layer-id or result-count overrides fail startup before the app makes any Honua API requests.

## Minimal SDK Snippet

Use the same SDK flow directly in your own app:

```ts
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });
const compatibility = await client.checkCompatibility();

if (!compatibility.supported) {
  throw new Error(
    `Unsupported Honua server. Minimum supported version: ${HonuaClient.minimumSupportedServerVersion}. ` +
      `Reasons: ${compatibility.reasons.join("; ")}`,
  );
}

const result = await client.queryFeatures({
  serviceId: "natural-earth",
  layerId: 0,
  where: "1=1",
  returnGeometry: true,
  outFields: ["*"],
  outSr: 4326,
  resultRecordCount: 25,
});

const featureCount = result.features?.length ?? 0;
console.log(`Found ${featureCount} feature(s)`);
```

The committed example adds the browser pieces around this SDK path: GeoJSON conversion, bounds fitting, render
layers, popup inspection, and browser telemetry for smoke coverage.

## Runtime And Response Contract

The committed app performs exactly two Honua API requests on a healthy startup before MapLibre loads the configured
basemap style and any dependent assets:

1. `GET /api/v1/admin/capabilities` through `HonuaClient.checkCompatibility()`
2. `GET /rest/services/{serviceId}/FeatureServer/{layerId}/query` through `client.queryFeatures(...)`

The compatibility request must resolve to a JSON object whose SDK-relevant payload lives at `data.compatibility`.
That object is parsed strictly and must include:

- `serverVersion` and `releaseChannel`
- `controlPlaneApi.major` as integer `1`, `controlPlaneApi.basePath`, and `controlPlaneApi.deprecated`
- `metadataSchemas[]` entries with `version` and `deprecated`
- `features.metadataResources`, `features.manifestExport`, `features.manifestApply`, `features.manifestDryRun`, and `features.manifestPrune`

The quickstart only proceeds when that compatibility contract reports:

- server version `>= 1.0.0`
- control-plane API major integer `1` with base path `/api/v1/admin`
- control-plane API deprecation flag `false`
- release channel `preview` or newer

The quickstart query is fixed to:

- `where`: configured filter, default `1=1`
- `returnGeometry: true`
- `outFields: ["*"]`
- `outSr: 4326`
- `resultRecordCount`: bounded by config, default `25`

MapLibre then fetches `VITE_HONUA_QUICKSTART_BASEMAP_STYLE` and any referenced sprites, glyphs, or tiles separately
from the Honua API contract above.

The app then expects the response to include:

- a `features` array with at least one record
- at least one record whose geometry converts into the rendered point, line, or polygon buckets
- raw query records without renderable geometry may still be present, but they are dropped before the app builds the rendered GeoJSON dataset

If the query returns zero features, or only features without renderable geometry, startup stops with a visible error
instead of rendering an empty map.

The staging integration reuses the same `loadQuickstartDataset(...)` helper and validates only the compatibility plus
single-query portion of this contract. It does not boot MapLibre or fetch the basemap style.

## Optional Next Steps

Keep these as follow-ons, not part of the first committed quickstart app:

- geocoding search through `@honua/sdk-js/geocoding`
- `HonuaMap` source and layer management
- direct OGC API Features flows
- richer browser demos through the storytelling, kepler, or Cesium example lanes

For problems with compatibility, auth, empty queries, geometry, basemap loading, or staging CI config, use
[`docs/quickstart-troubleshooting.md`](./quickstart-troubleshooting.md).
