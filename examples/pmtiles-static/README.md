# PMTiles Static Quickstart

A complete basemap backend with **no Honua server** — just one immutable
`.pmtiles` archive on static hosting. The Honua runtime auto-registers the
MapLibre `pmtiles://` protocol on map attach, so the archive renders with no
manual `addProtocol` wiring, and the archive metadata (bounds, min/max zoom,
vector layer names) is inspected through the contract's `describe()` surface.

This demonstrates:

- **REQ-002** — `loadMapPackage` auto-registers `pmtiles://` (lazy, idempotent)
  and projects a `pmtiles` MapPackage source binding onto a MapLibre source.
- **REQ-003** — `describePmtilesArchive()` returns archive metadata; the PMTiles
  `Source` is tiles-only (the query family throws
  `HonuaCapabilityNotSupportedError`).
- **NFR-001** — the `pmtiles` package is an optional peer, imported lazily; a
  bundle that never loads a PMTiles map pays no cost.

## Run it

```bash
# Dev server (Vite):
npm run demo:pmtiles-static

# Production build + static preview:
npm run demo:pmtiles-static:build
npm run demo:pmtiles-static:preview

# Typecheck:
npm run demo:pmtiles-static:typecheck
```

The sample archive lives in `public/basemap.pmtiles` (a tiny fixture; a real
deployment points at any archive on object storage — S3 / R2 / GCS). Static
hosts must honour HTTP `Range` requests, which PMTiles relies on; the bundled
`mock-server.mjs` (used by the Playwright smoke) does.

Managed publication is intentionally separate from this direct-archive example.
See the server-side contract-only [managed lifecycle Walkthrough](../../docs/examples/pmtiles-managed-lifecycle/README.md).

## CDN recipe (build-less)

PMTiles works from a plain HTML page with no bundler:

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

With the Honua SDK bundled instead, `loadMapPackage` does the `addProtocol`
step for you — see `src/main.ts`.
