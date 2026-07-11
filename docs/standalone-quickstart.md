# Standalone Quickstart: The SDK Against Any Public Endpoint

`@honua/sdk-js` is a typed geospatial service client first and a Honua client
second. Its protocol clients speak raw **Esri GeoServices**, so they work against
*any* ArcGIS Server / ArcGIS Online endpoint with **no Honua server, no API key,
and no account**. This is the maintained, MapLibre-targeting successor to
`esri-leaflet`.

Start here. A [Honua Server](https://github.com/honua-io/honua-server) is the
*upgrade path* (authored MapPackages, realtime, collaboration, MCP) — not the
entry fee. The [capability matrix](./standalone-capability-matrix.md) draws the
honest line between what is backend-agnostic and what needs a Honua Server.

## The first code block runs with zero Honua infrastructure

Point the SDK at a public FeatureServer and get typed query results:

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

// A public Esri Living Atlas FeatureServer — no key, no account, no Honua server.
const url =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";
const client = new HonuaClient({ baseUrl: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis" });

const { features } = await client.queryFeatures({
  serviceId: "2020_Census_State_Apportionment",
  layerId: 0,
  where: "1=1",
  outFields: ["NAME", "Total_Pop_2020", "Seats_2020"],
  returnGeometry: false,
  resultRecordCount: 5,
});

console.log(`Loaded ${features?.length ?? 0} states`);
```

`HonuaClient` builds the standard GeoServices request path
(`/rest/services/{serviceId}/FeatureServer/{layerId}/query`) and joins it to
whatever origin you pass as `baseUrl`, so `services.arcgis.com`,
`sampleserver6.arcgisonline.com`, or your own ArcGIS Server all work unchanged.

### Render it on MapLibre in one call

`@honua/sdk-js/map` turns a public FeatureServer URL straight into a MapLibre
`geojson` source:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { HonuaClient } from "@honua/sdk-js/honua";
import { loadHonuaFeatureServiceGeoJson } from "@honua/sdk-js/map";
import maplibregl from "maplibre-gl";

const client = new HonuaClient({ baseUrl: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis" });
const source = await loadHonuaFeatureServiceGeoJson(client, url, { outFields: ["NAME"] });

const map = new maplibregl.Map({ container: "map", style: "https://demotiles.maplibre.org/style.json" });
map.on("load", () => {
  map.addSource("states", source);
  map.addLayer({ id: "states-fill", source: "states", type: "fill", paint: { "fill-color": "#0f766e" } });
});
```

### The esri-leaflet migration path works standalone too

Pointing `FeatureLayerCompat` (and the rest of `@honua/sdk-js/esri-compat`) at a
`services.arcgis.com`-style URL Just Works — it parses the URL, derives the
origin, and constructs its own client. Existing ArcGIS-shaped code migrates
file-by-file without standing up any Honua infrastructure:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { FeatureLayerCompat } from "@honua/sdk-js/esri-compat";

// Same familiar shape as esri-leaflet / arcgis-rest — no server required.
const layer = new FeatureLayerCompat({ url });
const { features } = await layer.queryFeatures({ where: "Seats_2020 > 10", outFields: ["NAME"] });
```

## Run the committed example

The [`examples/standalone-quickstart/`](../examples/standalone-quickstart/README.md)
app does exactly the above — public GeoServices query → MapLibre render → the
`FeatureLayerCompat` drop-in proof — and ships two lanes:

```bash
npm install

# Live lane: hits the pinned public Esri endpoint.
npm run demo:standalone

# Deterministic lane: replays recorded fixtures on same-origin paths (what CI runs).
npm run demo:standalone:mock   # prints standaloneMockUrl=http://127.0.0.1:PORT
```

CI only ever runs the fixture lane, so it never depends on a third party. Refresh
the recordings from the live endpoints on demand with
`npm run demo:standalone:refresh-fixtures`. A scheduled, non-blocking workflow
(`.github/workflows/standalone-live-smoke.yml`) probes the live endpoints weekly
and never gates a PR.

## Documented public endpoints

These are the pinned, stable public services the docs and example use. All are
anonymous, read-only, and permitted for demonstration use.

| Endpoint | Protocol | Provider / license note |
| --- | --- | --- |
| `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0` | GeoServices FeatureServer | Esri Living Atlas; US Census apportionment (public-domain data), publicly shared by Esri. |
| `https://sampleserver6.arcgisonline.com/arcgis/rest/services/SampleWorldCities/MapServer/0` | GeoServices MapServer | Esri's public sample server, hosted expressly for samples/demos. |
| `https://demo.pygeoapi.io/master/collections` | OGC API Features | pygeoapi's official public demo (MIT project); Natural Earth (public-domain) data. |

> **OGC endpoints and the typed surface.** The GeoServices client is the fully
> backend-agnostic lane today: it targets raw ArcGIS request paths. The SDK's
> *typed* OGC API / WFS / STAC surfaces currently address the Honua server's OGC
> facade paths — see the [capability matrix](./standalone-capability-matrix.md)
> for the honest, per-capability breakdown and roadmap.

## Add a Honua Server (the upgrade path)

When you want more than reads against open services, a
[Honua Server](https://github.com/honua-io/honua-server) unlocks:

- **Authored `MapPackage`s** — `loadMapPackage()` + `HonuaMapRuntime` render a
  server-authored map with styles, layer order, and metadata baked in.
- **Realtime** — subscription-backed feature updates (`@honua/sdk-js/realtime`).
- **Collaboration** — shared/saved maps and multi-user sessions.
- **MCP + AI** — the `@honua/mcp-server` and agent tools surface.

Spin one up locally and point the same code at it:

```bash
# From a honua-server checkout:
docker compose up
# then set baseUrl to your local server, e.g. http://127.0.0.1:8080
```

See the [maplibre-quickstart](../examples/maplibre-quickstart/README.md) for the
server-connected lane, [`docs/maplibre-runtime.md`](./maplibre-runtime.md) for
the `MapPackage` runtime, and [`docs/realtime-subscriptions.md`](./realtime-subscriptions.md)
for realtime.
