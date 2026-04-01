# 5-Minute Quickstart: Query Features and Render on a Map

Build a web page that queries geospatial features from a Honua server and
renders them on an interactive MapLibre GL JS map.

If you want the richer portfolio demo path with the deterministic same-origin mock
lane, a pitched `2.5D` map, polygon extrusions, scripted route replay, and the
exact compatibility, OGC collection, and telemetry contract used by the demo, see
[`examples/storytelling-25d-map/README.md`](../examples/storytelling-25d-map/README.md).

For an exploratory browser-side 3D workflow that keeps the SDK runtime surface
unchanged, see
[`docs/examples/cesium-route-playback/README.md`](./examples/cesium-route-playback/README.md).
That example stays fixture-first by default, switches to a bounded live
`FeatureServer/query` request only when `?mode=live&baseUrl=...` is supplied, and
does not expand the SDK's WebMap or scene-contract support.

## What You'll Build

A single-page app that:

1. Connects to a Honua server using the SDK
2. Queries a feature layer for geospatial data
3. Renders the results on an interactive MapLibre map

If you want the portfolio-ready analytics sample instead of the minimal map walkthrough, use the isolated kepler.gl demo in [`examples/kepler-analytics`](../examples/kepler-analytics/README.md). That path runs from a committed Honua export fixture and does not require a separate server bring-up flow:

```bash
npm install
npm run demo:kepler:install
npm run demo:kepler:dev
```

Open `http://127.0.0.1:4175`. The demo loads `/data/fixture-metadata.json` first, then reads the committed GeoJSON datasets declared there, so the default local story stays deterministic without a live Honua environment.

The shipped kepler config also applies an initial `status` filter on `incidents` (`active`, `contained`, `monitoring`) and a shared `replay_at` time range across `incidents` and `unit-tracks`, so first-load visible counts are intentionally narrower than the raw `recordCount` values recorded in the manifest.

## Prerequisites

- Node.js 20.19+
- A running Honua server (or use the demo endpoint at `https://demo.honua.io`)

## Step 1: Create project and install (30 seconds)

```bash
mkdir honua-map-demo && cd honua-map-demo
npm init -y
npm install @honua/sdk maplibre-gl
```

## Step 2: Query features (60 seconds)

Create `index.mjs`:

```javascript
import { HonuaClient } from "@honua/sdk";

const client = new HonuaClient({
  baseUrl: "https://demo.honua.io",
});

const compatibility = await client.checkCompatibility();
if (!compatibility.supported) {
  throw new Error(
    `Unsupported Honua server. Minimum supported version: ${HonuaClient.minimumSupportedServerVersion}. ` +
      `Reasons: ${compatibility.reasons.join("; ")}`,
  );
}

if (await client.supportsFeature("manifestApply")) {
  console.log("Manifest workflows are available on this server.");
}

// Query the first 100 active features with geometry
const result = await client.queryFeatures({
  serviceId: "natural-earth",
  layerId: 0,
  where: "1=1",
  returnGeometry: true,
  outFields: ["*"],
  resultRecordCount: 100,
});

console.log(`Found ${result.features?.length ?? 0} features`);
console.log("First feature:", JSON.stringify(result.features?.[0], null, 2));
```

Run it:

```bash
node index.mjs
```

You should see feature objects with `attributes` and `geometry` properties
logged to the console.

The compatibility check uses `GET /api/v1/admin/capabilities` once, reports whether the
server is inside the SDK baseline (`>= 1.0.0`, control-plane `v1`, release channel
`preview` or newer), and lets you branch on coarse features without probing multiple
endpoints.

## Step 3: Add MapLibre map (90 seconds)

Create `index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Honua + MapLibre Quickstart</title>
  <link
    rel="stylesheet"
    href="https://unpkg.com/maplibre-gl/dist/maplibre-gl.css"
  />
  <script src="https://unpkg.com/maplibre-gl/dist/maplibre-gl.js"></script>
  <style>
    body { margin: 0; }
    #map { width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <div id="map"></div>

  <script type="module">
    import { HonuaClient } from "@honua/sdk";

    // 1. Create the Honua client
    const client = new HonuaClient({
      baseUrl: "https://demo.honua.io",
    });

    // 2. Query features
    const result = await client.queryFeatures({
      serviceId: "natural-earth",
      layerId: 0,
      where: "1=1",
      returnGeometry: true,
      outFields: ["*"],
      outSr: 4326,
      resultRecordCount: 200,
    });

    // 3. Convert Esri JSON features to GeoJSON
    function toGeoJson(features) {
      return {
        type: "FeatureCollection",
        features: (features ?? []).map((f) => ({
          type: "Feature",
          properties: f.attributes,
          geometry: esriGeometryToGeoJson(f.geometry),
        })),
      };
    }

    function esriGeometryToGeoJson(geom) {
      if (!geom) return null;
      if (geom.rings) {
        return { type: "Polygon", coordinates: geom.rings };
      }
      if (geom.paths) {
        return {
          type: geom.paths.length > 1 ? "MultiLineString" : "LineString",
          coordinates: geom.paths.length > 1 ? geom.paths : geom.paths[0],
        };
      }
      if (geom.x !== undefined && geom.y !== undefined) {
        return { type: "Point", coordinates: [geom.x, geom.y] };
      }
      if (geom.points) {
        return { type: "MultiPoint", coordinates: geom.points };
      }
      return geom;
    }

    const geojson = toGeoJson(result.features);

    // 4. Create the MapLibre map
    const map = new maplibregl.Map({
      container: "map",
      style: "https://demotiles.maplibre.org/style.json",
      center: [0, 20],
      zoom: 2,
    });

    map.on("load", () => {
      // 5. Add the GeoJSON source
      map.addSource("honua-features", {
        type: "geojson",
        data: geojson,
      });

      // 6. Render as fill (polygons), line, and circle (points) layers
      map.addLayer({
        id: "honua-fill",
        source: "honua-features",
        type: "fill",
        filter: ["==", "$type", "Polygon"],
        paint: {
          "fill-color": "#088",
          "fill-opacity": 0.5,
        },
      });

      map.addLayer({
        id: "honua-line",
        source: "honua-features",
        type: "line",
        filter: ["==", "$type", "LineString"],
        paint: {
          "line-color": "#e55e5e",
          "line-width": 2,
        },
      });

      map.addLayer({
        id: "honua-points",
        source: "honua-features",
        type: "circle",
        filter: ["==", "$type", "Point"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#e55e5e",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1,
        },
      });

      // 7. Show a popup on click
      map.on("click", "honua-fill", (e) => {
        const props = e.features[0].properties;
        const html = Object.entries(props)
          .slice(0, 5)
          .map(([k, v]) => `<strong>${k}:</strong> ${v}`)
          .join("<br>");
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
      });

      map.on("click", "honua-points", (e) => {
        const props = e.features[0].properties;
        const html = Object.entries(props)
          .slice(0, 5)
          .map(([k, v]) => `<strong>${k}:</strong> ${v}`)
          .join("<br>");
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
      });

      console.log(`Rendered ${geojson.features.length} features on the map`);
    });
  </script>
</body>
</html>
```

## Step 4: Serve and view (30 seconds)

```bash
npx serve .
```

Open `http://localhost:3000` in your browser. You should see features rendered
on the map. Click a feature to see its attributes in a popup.

## Step 5: Add geocoding search (60 seconds)

Add address search to your map using `HonuaGeocodingClient`. Update the
`<script type="module">` block in `index.html` to include a search box:

```html
<!-- Add this above the <div id="map"> element -->
<div id="search" style="position:absolute;top:10px;left:10px;z-index:1;">
  <input
    id="search-input"
    type="text"
    placeholder="Search address..."
    style="padding:8px 12px;width:280px;font-size:14px;border:1px solid #ccc;border-radius:4px;"
  />
  <div
    id="search-results"
    style="background:#fff;border:1px solid #ccc;border-top:none;border-radius:0 0 4px 4px;display:none;max-height:200px;overflow-y:auto;"
  ></div>
</div>
```

Then add this to the end of your `<script type="module">` block:

```javascript
import { HonuaGeocodingClient } from "@honua/sdk";

const geocoder = new HonuaGeocodingClient({
  baseUrl: "https://demo.honua.io",
});

const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
let debounceTimer;

searchInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const text = searchInput.value.trim();

  if (text.length < 3) {
    searchResults.style.display = "none";
    return;
  }

  debounceTimer = setTimeout(async () => {
    const suggestions = await geocoder.suggest(text, { maxSuggestions: 5 });
    searchResults.innerHTML = "";
    searchResults.style.display = suggestions.length ? "block" : "none";

    for (const s of suggestions) {
      const div = document.createElement("div");
      div.textContent = s.text;
      div.style.cssText = "padding:8px 12px;cursor:pointer;";
      div.addEventListener("mouseenter", () => (div.style.background = "#f0f0f0"));
      div.addEventListener("mouseleave", () => (div.style.background = "#fff"));
      div.addEventListener("click", async () => {
        const results = await geocoder.forwardGeocode(s.text, { maxResults: 1 });
        if (results.length > 0) {
          map.flyTo({
            center: [results[0].longitude, results[0].latitude],
            zoom: 14,
          });
          new maplibregl.Popup()
            .setLngLat([results[0].longitude, results[0].latitude])
            .setHTML(`<strong>${results[0].address}</strong>`)
            .addTo(map);
        }
        searchResults.style.display = "none";
        searchInput.value = s.text;
      });
      searchResults.appendChild(div);
    }
  }, 300);
});
```

Reload the page. Type an address in the search box, select a suggestion,
and the map flies to that location.

## Alternative: Use HonuaMap for source/layer management

For apps with multiple data sources, the SDK provides `HonuaMap` -- a
protocol-aware source/layer manager that produces MapLibre-compatible styles:

```javascript
import { HonuaClient, HonuaMap } from "@honua/sdk";

const client = new HonuaClient({ baseUrl: "https://demo.honua.io" });

const honuaMap = new HonuaMap({ client });

// Register a Feature Service source
honuaMap.addSource("parcels", {
  type: "honua-feature-service",
  url: "https://demo.honua.io/rest/services/parcels/FeatureServer/0",
  definitionExpression: "status = 'active'",
});

// Add rendering layers that reference the source
honuaMap.addLayer({
  id: "parcel-fill",
  source: "parcels",
  type: "fill",
  paint: { "fill-color": "#088", "fill-opacity": 0.4 },
});

honuaMap.addLayer({
  id: "parcel-labels",
  source: "parcels",
  type: "symbol",
  layout: { "text-field": ["get", "parcel_id"], "text-size": 12 },
});

// Access the underlying SDK surface for queries
const parcels = honuaMap.getSource("parcels"); // HonuaFeatureLayer
```

## Alternative: Use OGC API Features

If your server exposes OGC API Features endpoints, you can query GeoJSON
natively without conversion:

```javascript
import { HonuaClient } from "@honua/sdk";

const client = new HonuaClient({ baseUrl: "https://demo.honua.io" });
const ogc = client.ogcFeatures();

// List available collections
const collections = await ogc.collections();
console.log(collections.collections.map((c) => c.id));

// Query items from a collection (returns GeoJSON directly)
const items = await ogc.collection("admin-boundaries").items({
  limit: 100,
  filter: "status = 'active'",
});

// items is a GeoJSON FeatureCollection -- pass directly to MapLibre
map.addSource("boundaries", { type: "geojson", data: items });
```

## What's Next

- **[INSTALL.md](../INSTALL.md)** -- Advanced install options, split
  packages, and Esri migration tooling
- **[README.md](../README.md)** -- Full API reference covering
  FeatureServer, MapServer, OGC API Features, streaming pagination,
  interceptors, and more
- **[Migration CLI](../README.md#migration-cli)** -- Migrate existing Esri
  ArcGIS JS apps to Honua with the automated codemod tool
