# PMTiles

[PMTiles](https://github.com/protomaps/PMTiles) is a single-file archive format
for an entire pyramid of map tiles (raster or vector). One `.pmtiles` file on
static hosting — S3, R2, GCS, or any HTTP server that honours `Range` requests —
is a complete basemap or overlay backend. No tile server, no Honua server.

MapLibre GL JS renders PMTiles through a registered protocol handler
(`maplibregl.addProtocol("pmtiles", …)`). The Honua SDK wires that up for you:
the runtime auto-registers the `pmtiles://` protocol on map attach, and the
`pmtiles` package is an **optional peer dependency** imported lazily, so a build
that never touches PMTiles pays no bundle cost.

- `pmtiles` is an optional `peerDependency` (see `package.json`). Install it
  alongside `maplibre-gl` when you use PMTiles: `npm i pmtiles`.
- Reference an archive as a MapLibre source `url` with the `pmtiles://` scheme:
  `pmtiles://https://example.com/basemap.pmtiles`.

## Rendering a PMTiles source (runtime)

`loadMapPackage` auto-registers the `pmtiles://` protocol before it applies the
composed style, so a `pmtiles` source binding renders with no manual
`addProtocol` call. The registration is lazy (the `pmtiles` and `maplibre-gl`
packages are imported only when a PMTiles-backed map loads) and idempotent
across every map you attach.

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";
import { HONUA_MAP_PACKAGE_FORMAT_V1, loadMapPackage } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";

const map = new maplibregl.Map({ container: "map", style: { version: 8, sources: {}, layers: [] } });
await new Promise((resolve) => map.on("load", resolve));

await loadMapPackage(
  {
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    mapPackageId: "pmtiles-basemap",
    sourceBindings: [
      {
        sourceId: "basemap",
        protocol: "pmtiles",
        // `sourceType` picks the MapLibre source kind: "vector" (default) or "raster".
        locator: { url: "pmtiles://https://example.com/basemap.pmtiles", sourceType: "vector" },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [
        { id: "water", type: "fill", source: "basemap", "source-layer": "water", paint: { "fill-color": "#9cf" } },
      ],
    },
  },
  map,
  // No protocol-backed sources → no Honua server needed. `HonuaClient` is
  // required by the contract but never called here.
  { client: new HonuaClient({ baseUrl: location.origin }), skipCompatibilityCheck: true },
);
```

A `pmtiles` source binding projects onto a MapLibre-native source
(`{ type: "vector" | "raster", url: "pmtiles://…" }`) via `projectSourceBindings`.
The `locator.sourceType` hint selects the MapLibre source kind and defaults to
`vector` (the common PMTiles basemap case).

### Registering the protocol yourself

If you add a PMTiles source to a live map imperatively (`runtime.addSource`,
which is synchronous) or drive MapLibre directly, register the protocol first:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { ensurePmtilesProtocol } from "@honua/sdk-js/runtime";

await ensurePmtilesProtocol(); // lazy, idempotent — safe to call repeatedly
map.addSource("basemap", { type: "vector", url: "pmtiles://https://example.com/basemap.pmtiles" });
```

## Inspecting archive metadata (contract)

PMTiles participates in the protocol-neutral `Dataset` / `Source` model as a
**tiles-only** protocol. Its default capability set is `{ tiles }`, so the
canonical query family throws `HonuaCapabilityNotSupportedError` — an archive has
no feature-query surface. Archive metadata is inspected through the typed escape
hatch or the standalone helper:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createDataset, describePmtilesArchive } from "@honua/sdk-js/contract";

// Standalone: inspect any archive URL.
const info = await describePmtilesArchive("https://example.com/basemap.pmtiles");
console.log(info.tileKind); // "mvt" | "png" | "jpeg" | "webp" | "avif" | "unknown"
console.log(info.bounds); // [west, south, east, north] in degrees
console.log(info.minZoom, info.maxZoom);
console.log(info.vectorLayers.map((layer) => layer.id)); // source-layer names

// Through a Dataset: `describe()` on the typed adapter handle.
const dataset = createDataset({
  id: "basemaps",
  client,
  skipCompatibilityCheck: true,
  sources: [
    {
      id: "basemap",
      protocol: "pmtiles",
      locator: { url: "pmtiles://https://example.com/basemap.pmtiles" },
      capabilities: new Set(["tiles"]),
    },
  ],
});
const archive = dataset.source("basemap")!.protocol("pmtiles");
const meta = await archive!.describe();
```

`PmtilesArchiveDescription` carries `url`, `tileKind`, `bounds`, `minZoom`,
`maxZoom`, `center`, `vectorLayers`, an optional `attribution`, and the raw
`metadata` JSON.

## Build-less CDN recipe

PMTiles works from a plain HTML page with no bundler — load `maplibre-gl` and
`pmtiles` from a CDN and register the protocol:

```html
<script src="https://unpkg.com/pmtiles@4/dist/pmtiles.js"></script>
<link href="https://unpkg.com/maplibre-gl@6/dist/maplibre-gl.css" rel="stylesheet" />
<div id="map" style="position:absolute;inset:0"></div>
<script type="module">
  import * as maplibregl from "https://unpkg.com/maplibre-gl@6/dist/maplibre-gl.mjs";

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: { basemap: { type: "raster", url: "pmtiles://https://example.com/basemap.pmtiles" } },
      layers: [{ id: "basemap", type: "raster", source: "basemap" }],
    },
  });
</script>
```

## Notes

- **Immutable + HTTP caching.** PMTiles archives are immutable; the reader fetches
  byte ranges and relies on HTTP caching. There is no realtime path.
- **Range requests required.** Static hosts must honour the `Range` header (S3 /
  R2 / GCS do). The `examples/pmtiles-static` mock server does too.
- **Runnable example.** See [`examples/pmtiles-static`](../examples/pmtiles-static)
  and `npm run demo:pmtiles-static`.
