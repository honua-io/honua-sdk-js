---
name: build-a-map-app
description: Use when building a browser map app with @honua/sdk-js and MapLibre from zero, such as a Vite + TypeScript page that shows layers from a Honua server or any GeoServices / OGC API endpoint, stacks several layers on one map, renders a layer larger than the server transfer limit at every zoom, adds layer toggles, or shows feature details on click.
release: "2026.1"
stages: []
---

# Build a map app with @honua/sdk-js

One client pattern: `createHonua()` owns every connection, and each connection
mounts onto one MapLibre map that you create. Data flows through the SDK. Do not
hand-write `fetch` calls to the server.

## 1. Project setup

```bash
npm create vite@latest . -- --template vanilla-ts   # or start from an empty package.json
npm install --save-exact @honua/sdk-js               # the published release, pinned exactly
npm install maplibre-gl@^6.4.1                       # the SDK's MapLibre peer is ^6.4.1; 5.x fails to resolve
```

Import only public entry points: `@honua/sdk-js` (createHonua, spatial helpers)
and `@honua/sdk-js/runtime` (maplibreRenderer). Never import from `src/` or
`dist/` paths, `@honua/sdk`, or `@honua/react`.

MapLibre 6 under Vite needs its worker URL set, or every source fails with
"Worker failed to load":

```ts doc-test=skip reason="agent recipe with <placeholder> values; needs a browser map and a live server"
import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
maplibregl.setWorkerUrl(maplibreWorkerUrl);
```

Add a `vite-env.d.ts` next to your entry module with `/// <reference types="vite/client" />` so the
`?worker&url` import typechecks. Top-level `await` needs `build.target: "es2022"`
in `vite.config.ts`.

## 2. One map, many mounted layers

Create the map yourself, wait for `load`, then mount each connection with
`ownership: "borrowed"` so the SDK adds a source and layer to your map instead
of creating its own:

```ts doc-test=skip reason="agent recipe with <placeholder> values; needs a browser map and a live server"
import { createHonua } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";

const honua = createHonua();
const map = new maplibregl.Map({
  container: "map",
  style: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#eef2f3" } }] },
  center: [-156.33, 20.8],
  zoom: 9,
});
await new Promise((resolve) => map.once("load", resolve));
const renderer = maplibreRenderer(maplibregl);

const zoning = await honua.connect("https://demo.honua.io/rest/services/maui-zoning/FeatureServer/2");
const zoningLayer = await zoning.mount(map, {
  renderer,
  ownership: "borrowed",
  rendererOptions: { sourceId: "zoning", layerId: "zoning", geometry: "polygon", paint: { "fill-color": "#f4a261", "fill-opacity": 0.35 } },
});
await zoningLayer.ready;
```

- Always pass `geometry` ("polygon", "line" or "point") when you pass `paint`.
  With the default `"auto"` the renderer creates point, line and fill layers and
  your fill paint fails validation on the first two.
- Mount order is draw order: mount overlays first and the layer that should
  receive clicks last (or pass `beforeId`).
- Connect a GeoServices layer by its layer URL (`.../FeatureServer/<id>`). A
  service root with several layers needs an explicit `sourceId`.

## 3. Large layers: page the query, then add one GeoJSON source

A plain mount runs one bounded query and stops at the server's transfer limit
(10,000 features on Honua), so a 50,000-feature layer silently shows only the
first 10,000. Zoom in somewhere and the layer is empty. Page through the layer
with the SDK and add the features to the map yourself:

```ts doc-test=skip reason="agent recipe with <placeholder> values; needs a browser map and a live server"
type Row = { attributes: Record<string, unknown>; geometry?: { rings?: number[][][] } };
const PAGE = 10_000;
const big = await honua.connect("<server>/rest/services/<service>/FeatureServer/<layer id>");

async function page(offset: number) {
  const result = await big.query({
    where: "1=1",
    outFields: ["<key field>", "<label fields>"],
    returnGeometry: true,
    outSr: 4326,
    orderBy: [{ field: "<object id field>", direction: "asc" }],   // stable order across pages
    pagination: { offset, limit: PAGE },
  });
  const rows = result.features as Row[];
  const features = rows.flatMap((row) => {
    const rings = row.geometry?.rings;
    if (!rings?.length) return [];
    return [{ type: "Feature" as const, properties: { ...row.attributes }, geometry: { type: "Polygon" as const, coordinates: rings } }];
  });
  return { features, fetched: rows.length, more: result.exceededTransferLimit };
}

const features = [];
for (let offset = 0; ; ) {
  const batch = await page(offset);
  features.push(...batch.features);
  offset += batch.fetched;                                        // the server may cap a page below PAGE
  if (batch.fetched === 0 || (!batch.more && batch.fetched < PAGE)) break;   // count fetched rows, not drawable ones
}
map.addSource("big", { type: "geojson", data: { type: "FeatureCollection", features } });
map.addLayer({ id: "big", type: "fill", source: "big", paint: { "fill-color": "#000", "fill-opacity": 0.05, "fill-outline-color": "#333" } });
```

- Esri polygon rings go straight into one GeoJSON `Polygon`; MapLibre sorts
  outer rings and holes by winding.
- Fetch pages in sequence or two at a time. Honua's demo server allows 60
  requests a minute, and 51,000 features take six pages.
- Do not use the server's OGC API Tiles for county scale: Honua answers
  HTTP 413 for dense layers below zoom 13, and the SDK's automatic tile mount
  writes the server root as the tile URL (honua-sdk-js#2391).

## 4. Toggles and click details

Layer toggles: set visibility on every style layer whose `source` is the
mounted `sourceId`. Do not rely on the layer id alone.

```ts doc-test=skip reason="agent recipe with <placeholder> values; needs a browser map and a live server"
function setVisibility(sourceId: string, visibility: "visible" | "none") {
  for (const layer of map.getStyle().layers) {
    if ("source" in layer && layer.source === sourceId) map.setLayoutProperty(layer.id, "visibility", visibility);
  }
}
```

Click details: read the key from the clicked feature, query the feature
service for the full record, then query overlays with the record's geometry:

```ts doc-test=skip reason="agent recipe with <placeholder> values; needs a browser map and a live server"
import { queryFilter, spatialIntersects } from "@honua/sdk-js";

map.on("click", "big", async (event) => {
  const key = event.features?.[0]?.properties?.["<key field>"];
  if (key === undefined) return;
  const record = (await big.query({ filter: queryFilter.eq("<key field>", key), outFields: ["*"], outSr: 4326 })).features[0];
  if (!record?.geometry) return;
  const within = spatialIntersects({ ...record.geometry });
  const overlay = await zoning.query({ spatialFilter: within, outFields: ["<overlay field>"], returnGeometry: false });
  const values = overlay.features.map((f) => f.attributes["<overlay field>"]);
});
```

A feature can intersect more than one overlay polygon. Show every value, not
just the first.

## 5. Verify before you finish

1. `npm run build`, then `npx vite preview` and open the page.
2. In the browser console, `map.queryRenderedFeatures()` should return
   features from every layer both at county zoom (about 10) and at town zoom
   (about 15). Zero features for a large layer at either zoom means it is
   capped or tiled (step 3).
3. Click each toggle and confirm only its own layer disappears.
4. Click a known feature and confirm the details match the server's own
   `/query` response.
5. Honua's demo server rate-limits each client to 60 requests a minute. Mount
   once and avoid per-frame queries.
