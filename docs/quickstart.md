# 5-Minute Quickstart: Query Features and Render on a Map

The canonical runnable browser quickstart for this repo is the committed example app at
[`examples/maplibre-quickstart/`](../examples/maplibre-quickstart/README.md).

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

The live app expects:

- `VITE_HONUA_QUICKSTART_BASE_URL`
- `VITE_HONUA_QUICKSTART_SERVICE_ID`
- `VITE_HONUA_QUICKSTART_LAYER_ID`
- optional `VITE_HONUA_QUICKSTART_WHERE`
- optional `VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT`
- optional `VITE_HONUA_QUICKSTART_API_KEY`
- optional `VITE_HONUA_QUICKSTART_BEARER_TOKEN`

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
```

The committed example adds the browser pieces around this SDK path: GeoJSON conversion, bounds fitting, render
layers, popup inspection, and browser telemetry for smoke coverage.

## Optional Next Steps

Keep these as follow-ons, not part of the first committed quickstart app:

- geocoding search through `@honua/sdk-js/geocoding`
- `HonuaMap` source and layer management
- direct OGC API Features flows
- richer browser demos through the storytelling, kepler, or Cesium example lanes

For problems with compatibility, auth, empty queries, geometry, basemap loading, or staging CI config, use
[`docs/quickstart-troubleshooting.md`](./quickstart-troubleshooting.md).
