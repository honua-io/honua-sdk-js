# Endpoint to Map

The headline of the standalone data-to-map bridge (`mountSource`, issue #496):
a **public Esri Living Atlas FeatureServer** becomes a styled, interactive
MapLibre map with **no MapPackage, no Honua server, no API key, and no
account**.

## The headline code

The entire application workflow is **4 statements — 9 lines as printed
below** (13 physical lines in the committed `src/main.ts`, where the repo's
120-column formatter wraps the `connect()` call). It is counted between the
`headline start` / `headline end` markers; imports and the demo shell
(status panel, filter dropdown) are not part of the workflow:

```ts doc-test=skip reason="excerpt of src/main.ts; the runnable app is typechecked by demo:endpoint-to-map:typecheck"
const map = new maplibregl.Map({ container: "map", style: config.basemapStyle, center: [-98, 39], zoom: 3 });
await map.once("load");
const data = await connect({ endpoint: config.featureLayerUrl, protocol: "auto", authorizationScopeFingerprint: "public" });
const mounted = await mountSource(map, data.source(), {
  maxGeoJsonFeatures: config.maxFeatures,
  popup: { factory: () => new maplibregl.Popup({ closeButton: true }), fields: [...config.popupFields] },
  hover: true,
  fitBounds: true,
});
```

What the bridge did for those four statements:

1. **Strategy selection** — chose bounded GeoJSON materialization vs the
   dynamic query-tile path from declared capabilities plus a result-size
   heuristic, and reported the decision on `mounted.diagnostics` (rendered in
   the demo's "Why this strategy" panel).
2. **Default styling** — geometry-appropriate layers (circle / line /
   fill + outline) with sane paint defaults.
3. **Interactions** — click popups from a field list and hover feature-state.
4. **One owned handle** — `mounted.setFilter(query)` diff-updates in place
   (the demo's filter dropdown), and `mounted.dispose()` /
   `await using` removes every source, layer, and listener the bridge added.

The demo shell also runs a focused proof of the higher-level application-kernel
path added in #534. It mounts the same connection through
`connection.mount(map, { renderer: maplibreRenderer(maplibregl) })`, waits for
the first usable frame, disposes the connection-owned resources, and verifies
that the borrowed map and the bridge's original source/layers survive. The
status panel and Playwright smoke expose that lifecycle evidence; it is not
counted in the four-statement bridge headline above.

See [`docs/data-to-map-bridge.md`](../../docs/data-to-map-bridge.md) for the
full cookbook.

## Run it

```bash
npm install

# Live lane — hits the pinned public Esri Living Atlas FeatureServer.
npm run demo:endpoint-to-map

# Deterministic lane — replays recorded fixtures on same-origin paths (CI's lane).
npm run demo:endpoint-to-map:mock   # prints endpointToMapMockUrl=http://127.0.0.1:PORT
```

## Configuration

All vars are optional; defaults target Esri's public census-apportionment
FeatureServer.

- `VITE_ENDPOINT_TO_MAP_URL` — any public GeoServices FeatureServer *layer*
  URL (`…/FeatureServer/{layerId}`). A same-origin relative path switches the
  demo into fixture mode.
- `VITE_ENDPOINT_TO_MAP_BASEMAP_STYLE` — MapLibre basemap style URL (default
  MapLibre demotiles).
- `VITE_ENDPOINT_TO_MAP_MAX_FEATURES` — GeoJSON materialization bound
  (default 5000); truncation is reported through the overflow diagnostics.

## Fixtures & CI

The mock lane reuses the recorded GeoServices JSON in
[`test/fixtures/standalone-quickstart-demo/`](../../test/fixtures/standalone-quickstart-demo/)
(shared with the standalone quickstart, refreshed by
`npm run demo:standalone:refresh-fixtures`). `mock-server.mjs` rebuilds the
app with the FeatureServer URL pointed at a same-origin relative path and
replays those recordings, so CI never touches a third-party service.

## Public endpoints & licensing

- **Esri Living Atlas — 2020 Census State Apportionment FeatureServer**
  (`services.arcgis.com/P3ePLMYs2RVChkJx/…`): publicly shared Esri Living
  Atlas content over US Census (public-domain) data; anonymous read-only.
