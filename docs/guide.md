# `@honua/sdk-js` reference guide

This long-form guide collects the runnable demos, server compatibility contract,
subpath entrypoints, protocol-specific cookbooks, MapLibre runtime, request/auth
bridge, migration CLI, and other reference material that used to live in the
project README. Skim the [README](../README.md) for the 60-second tour and the
[`docs/`](.) directory for topic-specific docs.

## Contents

### Getting set up
- [Demo apps in depth](#demo-apps-in-depth)
- [Install](#install)
- [Local development](#local-development)
- [Verify](#verify)
- [Server compatibility baseline](#server-compatibility-baseline)
- [Entrypoints](#entrypoints)
- [Split package artifacts](#split-package-artifacts)

### Core surfaces
- [Shared client contract and exploration](#shared-client-contract-and-exploration)
- [MapLibre GL JS runtime for `MapPackage`](#maplibre-gl-js-runtime-for-mappackage)
- [Generated app preview runtime](#generated-app-preview-runtime)
- [Request/auth bridge](#requestauth-bridge)
- [Streaming pagination](#streaming-pagination)
- [Event lifecycle (`.on`)](#event-lifecycle-on)

### Protocol cookbooks
- [OGC API Features (Honua-first)](#ogc-api-features-honua-first)
- [OGC API Tiles, Maps, Processes, STAC](#ogc-api-tiles-maps-processes-stac)
- [WFS 2.0](#wfs-20)
- [OData v4](#odata-v4)
- [Mixed Esri + OGC in one app](#mixed-esri--ogc-in-one-app)
- [MapServer query helpers](#mapserver-query-helpers)
- [TimeSlider integration](#timeslider-integration)

### Migration tooling
- [Migration CLI](#migration-cli)
- [Migration admin scanner](#migration-admin-scanner)
- [Esri sample corpus (#206)](#esri-sample-corpus-206)
- [FeatureTable demo lane (#327)](#featuretable-demo-lane-327)

## Demo apps in depth

> The committed quickstart app uses the same `queryFeatures()` request shape shown in
> the [README quickstart](../README.md#60-second-quickstart) and fails fast when
> compatibility is
> unsupported, the query returns no features, or none of the returned records survive
> conversion into the rendered point, line, or polygon geometry buckets.

- [`examples/maplibre-quickstart/`](./examples/maplibre-quickstart/README.md): committed MapLibre quickstart app with a deterministic fixture-backed mock lane, one compatibility check, one read-only feature query, popup inspection, browser telemetry, and a matching staging integration suite that reuses the same compatibility-plus-query data-loading path.
- [`examples/react-quickstart/`](./examples/react-quickstart/README.md): `@honua/react` quickstart — `HonuaProvider` + `useDataset`/`useQuery`/`useCapabilities` hooks and a `HonuaMap`/`HonuaLayer`/`HonuaPopup` composition over the same deterministic fixture lane, booted under React StrictMode with Playwright smoke coverage.
- [`examples/storytelling-25d-map/`](./examples/storytelling-25d-map/README.md): pitched `2.5D` MapLibre demo with Honua compatibility gating, same-origin fixture mocking, OGC collection overlays, polygon extrusions, and route replay.
- [`examples/kepler-analytics/`](./examples/kepler-analytics/README.md): fixture-first kepler.gl analytics demo for an `operations replay` workflow with committed GeoJSON plus metadata, KPI cards, walkthrough copy, and focused browser smoke coverage.
- [`examples/imagery-cog-quickstart/`](./examples/imagery-cog-quickstart/README.md): MapLibre imagery proof for WMS `GetMap`, COG-backed ImageServer tiles, `exportImage` previews, legends, and metadata cache state through one Honua client configuration.
- [`examples/spatial-analytics-workbench/`](./examples/spatial-analytics-workbench/README.md): Honua Cloud analytics workbench for AOI jobs, materialized outputs, linked map/table/chart state, and fixture-backed indexed aggregation cells plus category/histogram/range widgets.
- [`examples/edit-workflow-demo/`](./examples/edit-workflow-demo/README.md): Honua Cloud editing workflow for metadata-backed forms, optimistic create/update/delete, rollback diagnostics, conflicts, relationships, and attachment lifecycle checks over shared map/table/form context.
- [`examples/geocoding-quickstart/`](./examples/geocoding-quickstart/README.md): MapLibre geocoding sample for forward geocoding, reverse lookup from a clicked point, typeahead suggestions, and GeocodeServer audit mapping through `HonuaGeocodingClient`.
- [`examples/terrain-rgb-elevation/`](./examples/terrain-rgb-elevation/README.md): MapLibre Terrain-RGB elevation proof with fixture-safe DEM tiles, clicked point elevation lookup, drawn line profile queries, and explicit SDK gap notes for untyped terrain value/profile endpoints.
- [`examples/unified-ops-workspace/`](./examples/unified-ops-workspace/README.md): fixture-backed operational workspace shell that composes incident command and analysis review modules over one shared app workspace, linked-view context, realtime state, review drafts, and saved snapshot diagnostics.
- [`docs/examples/cesium-route-playback/README.md`](./docs/examples/cesium-route-playback/README.md): exploratory Cesium route-playback spike that consumes one bounded Honua `FeatureServer/query` response, keeps the preprocessing steps explicit, and stays outside the SDK's `SceneViewCompat` and WebMap 3D support contract.

Each example README documents its own env surface, network contract, browser telemetry hooks, run lanes, accepted data
contracts, live-query narrowing rules, preprocessing rules, and browser diagnostics.
The shared seeded Honua Cloud demo contract lives in
[`docs/honua-cloud-demo-services.md`](./docs/honua-cloud-demo-services.md), with the machine-readable manifest at
[`examples/cloud-demo-services.json`](./examples/cloud-demo-services.json) and env template at
[`examples/cloud-demo.env.example`](./examples/cloud-demo.env.example). Use `npm run test:cloud-demo:config` to
validate the config/docs shape without live credentials, and `npm run test:cloud-demo:staging` for the credential-gated
cloud smoke scaffold.
For the Cesium spike specifically, `window.__cesiumRoutePlaybackDone` is the completion signal on both success and
failure, `window.__cesiumRoutePlaybackError` is failure-only, and `window.__cesiumRoutePlaybackResult` is populated
only on success.
Its `queryRequest` summary echoes `fixtures/source-manifest.json#query` in fixture mode and the bounded live
`queryFeatures()` request in live mode; both describe the same `outFields=["*"]`, `outSr=4326`,
`returnGeometry=true`, and `extraParams={ outSr: 4326, returnZ: true }` query shape, while `routeId` and
`routeIdField` remain post-query selectors instead of extra server filters, `routeIdField` is authoritative when
configured, matching normalizes numeric route ids to strings, the success summary leaves `routeId` as `null` when the
selected feature has no route-id attribute, and fixture mode keeps `compatibilitySupported` plus `requestDurationMs`
as `null`.

The kepler example README documents the fixture metadata manifest, required dataset IDs and fields, the default incident status and replay-window filters, browser readiness/error plus replay-harness hooks, refresh stdout JSON, and the runtime style override env vars used by the demo.

Deterministic local review flows from this repo:

```bash
# Node.js 20.19.0+ at the repo root
npm install

# Run either mock server in its own terminal/session.
npm run demo:quickstart:mock
# or
npm run demo:25d:mock
# or
npm run demo:geocoding:mock
```

The quickstart command prints `quickstartMockUrl=http://127.0.0.1:PORT`, the 2.5D command prints
`story25dMockUrl=http://127.0.0.1:PORT`, and the geocoding command prints
`geocodingMockUrl=http://127.0.0.1:PORT`.

Live Honua flow for the `2.5D` demo:

```bash
cp examples/storytelling-25d-map/.env.example examples/storytelling-25d-map/.env
npm run demo:25d
```

Use the linked example READMEs for the `2.5D` collection contract, the Cesium live-query URL parameters, custom `routeIdField` matching and multi-route selection rules, terrain fallback behavior, and smoke-test globals.

## Server Compatibility Baseline

Use the server compatibility contract before enabling admin/control-plane flows:

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://your-honua-server.com" });

const status = await client.checkCompatibility();
if (!status.supported) {
  throw new Error(
    `Server ${status.compatibility?.serverVersion ?? "unknown"} is unsupported. ` +
      `Minimum: ${HonuaClient.minimumSupportedServerVersion}. ` +
      `Reasons: ${status.reasons.join("; ")}`,
  );
}

if (await client.supportsFeature("manifestApply")) {
  console.log("Manifest apply workflows are available on this server.");
}

const compatibilityContract = await client.getCompatibility();
console.log(compatibilityContract.metadataSchemas);
```

`checkCompatibility()` reports support status, `supportsFeature()` gates coarse capabilities from
`data.compatibility.features`, and `getCompatibility()` returns the parsed `data.compatibility` object from
`GET /api/v1/admin/capabilities`.

The capabilities endpoint still needs to return a JSON object with `success` plus `data.compatibility`. The parsed
compatibility object must include `serverVersion`, `releaseChannel`, `controlPlaneApi.major`/`basePath`/`deprecated`,
`metadataSchemas[]` entries with `version` and `deprecated`, and the boolean `features` map. Top-level extras such as
`metadataApiVersions` and `resourceKinds` may be present on the endpoint response, but they are not returned by
`getCompatibility()`.

This SDK baseline currently expects:
- server version `>= 1.0.0`
- control-plane API major integer `1` with base path `/api/v1/admin`
- control-plane API deprecation flag `false`
- server release channel `preview` or newer

---

Initial JavaScript SDK scaffold for the JS-first migration phase (`#324`).

This package currently provides:

- core HTTP client (`HonuaClient`) for FeatureServer, MapServer export/query/related-record operations, and catalog operations, plus fluent layer wrappers (`client.featureLayer(...)`, `client.mapLayer(...)`, `service.featureLayer(...)`, `service.featureLayers()`, `service.mapLayer(...)`, `service.mapLayers()`, `service.mapService().layer(...)`),
- first-class OGC API clients/wrappers for Features (`client.ogcFeatures()`), Tiles (`client.ogcTiles()`), Maps (`client.ogcMaps()`), Processes (`client.ogcProcesses()`), and STAC (`client.stac()`), including landing/conformance discovery, feature items, tile and map bytes, async `IJobRun` process execution, and STAC search,
- first-party OGC web-map clients/wrappers for WMS 1.3.0 (`client.wms(serviceId)` → `HonuaWms` / `HonuaWmsLayer`) and WMTS 1.0.0 (`client.wmts(serviceId)` → `HonuaWmts` / `HonuaWmtsLayer` / `HonuaWmtsTileset`) covering Capabilities, `GetMap` (with `TIME` / `ELEVATION` dimension handling and CRS axis-order swap per WMS 1.3 §6.7.3.2), `GetFeatureInfo`, `GetLegendGraphic` (when the server advertises it; otherwise `HonuaCapabilityNotSupportedError`), RESTful + KVP tile fetch, plus MapLibre source helpers `buildWmsRasterSourceSpec(descriptor)` / `buildWmtsRasterSourceSpec(descriptor)` from `@honua/sdk-js/runtime`,
- dynamic query tile descriptors and MapLibre helpers (`defineQueryTileSource`, `buildMapLibreQueryTileSourceSpec`, `QueryTileRequestController`) for query-backed vector tiles with cache key normalization, viewport request aborts, feature identity mapping, selected-feature detail lookup, and unsupported-protocol/fallback diagnostics,
- Esri-style compatibility wrappers (`FeatureLayerCompat`, `MapImageLayerCompat`, `TileLayerCompat`, `RouteLayerCompat`, `MapCompat`, `MapViewCompat`, `SceneViewCompat`, `WebMapCompat`) for migration-critical patterns,
  including basic `when()` lifecycle support, `FeatureLayer.refresh()/createQuery()/queryFeaturesAll()/queryObjectIds()/queryFeatureCount()/queryExtent()/queryRelatedFeatures()/addAttachment()/updateAttachment()/listFields()/getField()`, `MapImageLayer.when()/refresh()/createQuery()/exportImage()/getLegend()/find()/identify()/queryFeatures()/queryFeaturesAll()/queryFeatureCount()/queryObjectIds()/queryExtent()/queryRelatedFeatures()/findSublayerById()/sublayer(...).query*()` where writable `layer.sublayers` and sublayer lookups return query-capable `MapImageSublayerCompat` wrappers (and auto-hydrate from metadata when not explicitly configured) with nested `sublayer.sublayers/allSublayers`, `sublayer.visible`, and `sublayer.definitionExpression` bridging to query defaults, `FeatureTableCompat` row/query helpers with runtime `layer` switching (`table.layer = nextLayer` / `table.setLayer(nextLayer)`), `Map` layer collection helpers, `GraphicsLayerCompat`/`GroupLayerCompat`, and `MapView` watch/event handles with popup/layer-view bridges plus `toMap`/`toScreen`/`hitTest`/`takeScreenshot()` and `view.ui.add/remove/move/getComponents` compatibility,
- identify controller (`IdentifyCompat`) for cross-layer MapServer identify workflows with optional popup auto-open,
- compat widgets/components (`LayerListCompat`, `LegendCompat`, `PopupCompat`, `SearchCompat`, `BasemapGalleryCompat`, `BookmarksCompat`, `ExpandCompat`, `SketchCompat`, `EditorCompat`, `TrackCompat`, `MeasurementCompat`, `TimeSliderCompat`, `DirectionsCompat`) backed by a shared `CompatEventBus` so widgets/components can subscribe to layer/view changes, including popup feature-selection navigation and search source/result state helpers (default search sources support both ArcGIS `queryFeatures` layers and OGC collection-style `items()` layers),
- common map controls (`HomeCompat`, `BasemapToggleCompat`, `LocateCompat`, `ScaleBarCompat`, `CompassCompat`, `FullscreenCompat`, `ZoomCompat`, `AttributionCompat`) wired to the same event bus for shared view state updates,
- request/auth migration bridge helpers (`createEsriRequestInterceptors`, `createArcGisTokenInterceptor`) plus core `HonuaClient` interceptor hooks (`before`/`after`/`error`),
- URL parsing helpers for ArcGIS FeatureLayer endpoint detection,
- ArcGIS usage scanner (`scanArcGisUsage`) for migration inventory and risk flags,
- safe codemod runner (`runEsriCompatCodemod`) for migration-safe constructors across layers, views, widgets, and controls,
- migration report builder with explicit manual TODOs and rewrite metric,
- JS parity matrix artifacts (`getJsParityMatrix` / `summarizeJsParityMatrix` and `getJsRuntimeParityMatrix` / `summarizeJsRuntimeParity`) for constructor-level and runtime-capability `native/compat/assisted/unsupported` tracking across Honua compat and esri-leaflet targets,
- service reconciliation helper (`runLayerReconciliation`) for feature-count, geometry-validity, and attribute-key checks,
- unit tests for request mapping and URL parsing,
- WebMap JSON conversion utilities (`parseWebMap`, renderer/symbol/popup converters) with a golden fixture suite and compatibility contract documented in [`docs/webmap-json-compatibility.md`](./docs/webmap-json-compatibility.md).

## Entrypoints

Prefer subpath entrypoints to keep Honua-first and migration layers separate:

- Honua-first core: `@honua/sdk-js/honua`
- Esri compat bridge: `@honua/sdk-js/esri-compat`
- Migration tooling: `@honua/sdk-js/migration`
- Canonical shared client contract: `@honua/sdk-js/contract`
- Exploration state + linked-view presets: `@honua/sdk-js/exploration`
- MapLibre GL JS runtime for `MapPackage`: `@honua/sdk-js/runtime`
- React bindings (provider, hooks, map components): `@honua/sdk-js/react` — see [`docs/react.md`](./react.md)
- Client-side geometry ops + reprojection (curated turf/proj4): `@honua/sdk-js/geometry` — see [`docs/geometry.md`](./geometry.md)
- Provider-pluggable geocoding (Nominatim/Photon/Pelias/Honua) + routing (OSRM/Valhalla/Honua): `@honua/sdk-js/geocoding`, `@honua/sdk-js/routing` — see [`docs/geocoding-routing-providers.md`](./geocoding-routing-providers.md)
- Generated operations-dashboard manifest projection and preview runtime: `@honua/sdk-js/generated-app`
- Studio package-family projections, validation/preview envelopes, capability manifest, and publish/share/embed contracts (MCP/QGIS-safe): `@honua/sdk-js/studio` — see [`docs/studio-package-contracts.md`](./studio-package-contracts.md)

The root entrypoint (`@honua/sdk-js`) remains available as an aggregate export for compatibility. Surfaces documented
as subpath-only, including `@honua/sdk-js/generated-app`, should be imported from their named subpath.

## Shared Client Contract And Exploration

`HonuaFeatureLayer`, `HonuaMapService`, and `HonuaOgcFeatureCollection` continue to be the runtime classes. For
cross-protocol code — exploration views, visual builders, and server packaging — the SDK also exposes a
protocol-neutral contract and exploration state module that wrap (not replace) those classes.

- `@honua/sdk-js/contract` — canonical `Dataset`, `Source`, `SourceDescriptor`, `Capabilities`, `Query`, `Result`,
  `IJobRun`, and `MapBinding` types, plus `createDataset(...)` and built-in adapters for the five GeoServices
  service types (`geoservices-feature-service`, `geoservices-map-service`, `geoservices-image-service`,
  `geoservices-geometry-service`, `geoservices-gp-service`), the four OGC API + STAC adapters (`ogc-features`,
  `ogc-tiles`, `ogc-maps`, `stac`), the OGC web-map adapters (`wms`, `wmts`), `wfs` (WFS 2.0), and `odata`
  (OData v4). Image / Geometry / GP services expose their protocol-specific surface (raster `exportImage` /
  `identify`, geometry `project` / `buffer` / `simplify` / `intersect` / `union` / `clip` / `difference`, GP
  `submitJob` / `jobStatus` / `cancelJob` / `jobResult`) through the typed `Source.protocol()` escape hatch —
  the canonical query family throws `HonuaCapabilityNotSupportedError` for utility-only services so
  mixed-source apps surface the limitation explicitly. The ImageServer adapter rejects `Query.spatialFilter` /
  `orderBy` / `outFields` rather than silently widening the catalog result. WMS surfaces `query` through
  point-only `GetFeatureInfo`; WMTS is render-only (`Source.query()` throws). The WFS adapter compiles
  `Query.where` / `Query.spatialFilter` to FES 2.0, prefers GeoJSON over GML via `OperationsMetadata`
  negotiation, builds `<wfs:Transaction>` bodies for `applyEdits`, and reaches raw GML / `LockFeature` /
  `GetPropertyValue` / stored queries through `Source.protocol("wfs")`. The OData adapter exposes
  `query` / `queryObjectIds` / `stream` / `applyEdits` first-party
  (PATCH-with-full-body in place of PUT, per the parity matrix) and surfaces `$batch` / `$apply` /
  `$search` / `$deltatoken` through `Source.protocol("odata")` on a `HonuaOdataEntitySet`; it is also
  the first adapter to lazily fetch service `$metadata` and intersect the declared capability set with
  the server's `Capabilities.*` annotations. Capability negotiation is `strict` by default; `degraded`
  opts into client-side fallbacks that surface `Result.degraded[]`. Full contract reference:
  [`docs/shared-client-contract.md`](./docs/shared-client-contract.md).
- `@honua/sdk-js/exploration` — `createExplorationContext(...)` returning an observable, microtask-coalesced
  reducer over filters, spatial filter, extent, selection, sort, pagination, visible fields, grouping, and
  aggregation. View bindings (`map`, `grid`, `chart`, `form`, `custom`) propagate through five linked-view
  presets (`globalLinked`, `mapDriven`, `gridDriven`, `chartDriven`, `decoupled`). Full state model and
  worked example: [`docs/exploration-context.md`](./docs/exploration-context.md).
- Capability coverage per protocol: [`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md).
- Cross-SDK semantic alignment for JS/Python/.NET language bindings:
  [`docs/sdk-surface-alignment.md`](./docs/sdk-surface-alignment.md).
- Round-trip mapping to the server `SourceBinding` / `MapPackage` document:
  [`docs/source-binding-alignment.md`](./docs/source-binding-alignment.md).
- Live SDK ↔ Honua Server protocol integration lane:
  [`docs/integration-tests.md`](./docs/integration-tests.md).

```ts doc-test=compile
import { createDataset } from "@honua/sdk-js/contract";
import { createExplorationContext } from "@honua/sdk-js/exploration";
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });

const dataset = createDataset({
  id: "parcels",
  client,
  sources: [
    {
      id: "parcels-fs",
      protocol: "geoservices-feature-service",
      locator: { url: "https://your-honua-server.example", serviceId: "parcels", layerId: 0 },
      capabilities: new Set(["query", "queryExtent", "queryObjectIds"]),
    },
  ],
});

const parcels = dataset.source("parcels-fs")!;
const result = await parcels.query({ where: "STATUS = 'ACTIVE'", pagination: { limit: 100 } });
const { extent } = await parcels.queryExtent({ where: "STATUS = 'ACTIVE'" });

const ctx = createExplorationContext({
  datasetId: dataset.id,
  sourceIds: dataset.sourceIds(),
  preset: "mapDriven",
});
ctx.bind({ id: "map", role: "map" });
if (extent) ctx.dispatch({ kind: "set-extent", extent, viewId: "map" });
console.log(`Loaded ${result.features.length} features`);
```

Capability misses throw `HonuaCapabilityNotSupportedError` (under `strict` policy). Exploration misuses throw
`HonuaExplorationContextError`. Both are in the `HonuaError` union and pass `isHonuaError(e)`.

## MapLibre GL JS Runtime For `MapPackage`

`@honua/sdk-js/runtime` binds a server-produced `MapPackage` (from `honua-io/honua-server#731`) to a
caller-provided `maplibre-gl.Map`. It composes the style from `mapSpec` + `styleRefs[]` + `theme` tokens,
projects `sourceBindings[]` through the `@honua/sdk-js/contract` adapters, and exposes an operational API
that `honua-io/honua-sdk-js#22` and `#29` build on. The runtime never instantiates the map (`maplibre-gl`
stays a peer dependency) and never issues edit writes.

```ts doc-test=skip reason="partial excerpt requires application host context"
import maplibregl from "maplibre-gl";
import { HonuaClient } from "@honua/sdk-js/honua";
import { loadMapPackage } from "@honua/sdk-js/runtime";

const map = new maplibregl.Map({ container: "map", style: { version: 8, sources: {}, layers: [] } });
const runtime = await loadMapPackage(pkg, map, {
  client: new HonuaClient({ baseUrl: "https://your-honua-server.example" }),
  popupFactory: () => new maplibregl.Popup(),
});

runtime.setLayerVisibility("parcels-fill", true);
runtime.bindPopup("parcels-fill");
await runtime.updatePackage(nextPkg);  // diffs by stable ids, falls back to setStyle on structural change
runtime.dispose();
```

- Full runtime reference: [`docs/maplibre-runtime.md`](./docs/maplibre-runtime.md).
- Protocol routing (server `SourceBinding` → MapLibre / contract adapter):
  [`docs/source-binding-alignment.md`](./docs/source-binding-alignment.md#runtime-consumer-honuasdk-jsruntime).
- `MapPackage` format tag: `honua_map_package.v1`. The loader throws
  `HonuaMapPackageError { stage: "load" }` on any other value, and `updatePackage` rejects format
  mismatches without mutating the map.

Binding failures throw `HonuaMapPackageError` with a `stage` of
`"load" | "update" | "style-compose" | "source-bind" | "view" | "popup" | "dispose"` under the opt-in
`sourceErrorPolicy: "fail-fast"`. Under the default `"tolerant"` policy a single per-source binding
failure does not abort the load — the failed source is dropped from the composed style along with any
layer that referenced it, the runtime emits a `source-error` event for the failed source, and a
`source-bind` telemetry error span fires. Remaining sources keep rendering. Query-time adapter errors
(`HonuaCapabilityNotSupportedError`, `HonuaHttpError`, adapter-specific classes) are not wrapped — they
surface on the per-`Source` promises from `runtime.dataset` and through the shared `HonuaClient`
interceptor chain; consumers fanning a query across the dataset can broadcast a per-source rejection
through `runtime.reportSourceError(sourceId, error)` to fold it into the same `source-error` channel.

For mixed-protocol compositions (parcels FeatureServer + WMS basemap + STAC overlay + OData operational
layer in one map), use `intersectCapabilities` from `@honua/sdk-js/contract` to compute the **weakest**
capability set across participating sources before fanning a call out, and rely on `Result.degraded[]`
entries (now carrying optional `sourceId`) for per-source attribution. Full composition guide:
[`docs/composition.md`](./docs/composition.md).

## Generated App Preview Runtime

`@honua/sdk-js/generated-app` is the browser-safe proof slice for generated operations dashboards. It projects
canonical `BuildSpec`, `AppPackage.manifest_artifact`, and `MapPackage` inputs into a versioned
`honua_generated_app_manifest.v1` manifest with the `operations-dashboard.v1` profile, then binds the generated
map/table or list/count/chart/filter widgets through `@honua/sdk-js/runtime` and the shared `ExplorationContext`.

```ts doc-test=skip reason="partial excerpt requires application host context"
import { previewGeneratedApp } from "@honua/sdk-js/generated-app";

const preview = await previewGeneratedApp(
  { appPackage, mapPackage },
  {
    mapFactory: () => ({ map }),
    mapLoadOptions: { client },
  },
);

if (preview.status === "ready") {
  renderDashboard(preview.model);
} else {
  renderPreviewErrors(preview.errors);
}
```

The preview response is a discriminated union: ready responses include the resolved manifest, runtime handle,
render model, and `errors: []`; error responses include serializable `HonuaGeneratedAppDiagnostic` objects and never
throw from `previewGeneratedApp`. Call `loadGeneratedAppRuntime` directly when the host wants exceptions. Full
contract reference: [`docs/generated-app-runtime.md`](./docs/generated-app-runtime.md). For map-backed manifests,
the host must provide a `MapPackage`, `mapFactory`, and `mapLoadOptions`; when `manifest.mapPackageId` is present,
the supplied `MapPackage.mapPackageId` must match before map construction. Map filter bindings use the widget
`layerId` with `manifest.bindings.layerId` as fallback, and failed initial feature loads dispose partially loaded map
resources before returning an error result.

## Install

```bash
npm install @honua/sdk-js
```

## Local development

Repo-root installs for local development and the checked-in browser demos currently require Node.js 20.19.0 or newer because the current demo/dev toolchain dependencies set that patch-level floor. The published `@honua/sdk-js` package itself remains on the documented Node 20+ runtime contract.

```bash
npm install
```

Storytelling demo loops:

```bash
npm run demo:quickstart:mock
# or, with examples/maplibre-quickstart/.env configured:
npm run demo:quickstart

# advanced storytelling demo:
npm run demo:25d:mock
# or, with examples/storytelling-25d-map/.env configured:
npm run demo:25d
```

Advanced analytics demo loop:

```bash
npm run demo:kepler:install
npm run demo:kepler:dev
```

Open `http://127.0.0.1:4175` to view the fixture-first `operations replay` story. The committed fixture lives under `examples/kepler-analytics/public/data`, and maintainers can refresh it from a live Honua environment with:

```bash
npm run demo:kepler:refresh-fixture
```

The repo-root refresh wrapper builds the SDK before delegating to the example-local script. Set `HONUA_DEMO_BASE_URL` and any optional auth or service override env vars described in the example README before running it.

Imagery and COG demo loop:

```bash
npm run demo:imagery-cog:mock
# or, with examples/imagery-cog-quickstart/.env configured:
npm run demo:imagery-cog
```

Node backend quickstart loop:

```bash
npm run demo:node-backend:mock
# in another terminal:
npm run demo:node-backend
```

## Verify

```bash
npm run typecheck
npm run build
npm run demo:quickstart:typecheck
npm run demo:25d:typecheck
npm run demo:node-backend:typecheck
npm run demo:unified-ops:typecheck
npx vitest run test/quickstart-config.test.ts test/quickstart-data.test.ts
npx vitest run test/node-backend-quickstart.test.ts
npx vitest run test/unified-ops-workspace.test.ts
npx vitest run test/cesium-route-playback.test.ts
npx vitest run test/storytelling-25d-config.test.ts test/storytelling-25d-data.test.ts
npm test
npm run test:playwright:quickstart
npm run test:playwright:unified-ops
npx playwright test test/playwright/cesium-route-playback.spec.mjs
npm run test:playwright:25d
npm run test:playwright
npm run demo:kepler:smoke
npm run test:quickstart:staging # requires HONUA_STAGING_* env
npm run test:integration # connect-only; requires HONUA_INTEGRATION_BASE_URL — see docs/integration-tests.md
npm run scan:arcgis -- ../../path/to/arcgis-app
npm run migrate:arcgis -- ../../path/to/arcgis-app --write --report migration-report.json
npm run report:migration:real-samples
npm run gate:migration:real-samples
npm run gate:migration:demo-target
npm run matrix:runtime
npm run build:split-packages
```

`npm run test:playwright` and `npm run demo:kepler:smoke` now bootstrap the isolated `examples/kepler-analytics` dependencies automatically when that package has not been installed yet.

## Split Package Artifacts

Generate publish-ready split packages under `dist/packages/`:

- `@honua/sdk` -> `dist/packages/honua-sdk`
- `@honua/sdk-esri-compat` -> `dist/packages/honua-sdk-esri-compat`
- `@honua/honua-migrate` -> `dist/packages/honua-migrate`

```bash
npm run build:split-packages
npm run verify:split-packages
```

Create local tarballs for all split packages:

```bash
npm run pack:split-packages
```

CI publish workflow:
- manual dry-run or publish via `Publish JS SDK Packages` workflow
- tag-triggered publish uses Release Please tags in form `js-sdk-<version>`; the workflow also accepts `js-sdk-v<version>` and enforces tag/version match
- Release Please dispatches the JS SDK and MCP publish workflows after creating releases; package publishes skip versions that already exist on npm.

## Request/Auth Bridge

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js";
import { createArcGisTokenInterceptor, createEsriRequestInterceptors } from "@honua/sdk-js/esri-compat";

const client = new HonuaClient({
  baseUrl: "https://example.test",
  interceptors: [
    ...createEsriRequestInterceptors([
      {
        urls: "/rest/services/default",
        before: (params) => {
          params.requestOptions.headers = {
            ...(params.requestOptions.headers ?? {}),
            "X-Migrated-By": "honua",
          };
        },
      },
    ]),
    createArcGisTokenInterceptor({
      applyTo: "/rest/services/default",
      mode: "query",
      getToken: async () => "arcgis-token-value",
    }),
  ],
});
```

For first-party Honua auth, prefer an auth provider over storing long-lived
secrets in SDK configuration. The provider owns secure storage, refresh, and
revocation; the SDK keeps only an in-memory cache and refreshes before
`expiresAt` enters the configured skew window.

```ts doc-test=skip reason="partial excerpt requires application host context"
const client = new HonuaClient({
  baseUrl: "https://example.test",
  authRefreshSkewMs: 60_000,
  auth: {
    async getCredentials({ reason }) {
      const session = await authStore.getFreshSession({ force: reason !== "initial" });
      return {
        bearerToken: session.accessToken,
        expiresAt: session.expiresAt,
      };
    },
    async revokeCredentials(credentials) {
      if (credentials.bearerToken) {
        await authStore.revoke(credentials.bearerToken);
      }
    },
  },
});

await client.refreshAuthCredentials(); // force a key/token rotation probe
await client.revokeAuthCredentials(); // revoke cached credentials and clear SDK memory
```

Do not persist bearer tokens, API keys, or refresh tokens inside the SDK
instance. Store them in the platform credential store or your server-side
session layer, return short-lived credentials from `auth.getCredentials`, and
use `clearAuthCredentials()` on logout or account switch. If a request fails
with `401`/`403`, call `refreshAuthCredentials("unauthorized")` after your app
has handled any sign-in prompt, then retry the failed operation explicitly.
Network, timeout, and retry behavior still flows through the same
`timeoutMs`, `retry`, and interceptor pipeline.

## OGC API Features (Honua-first)

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://example.test" });
const ogc = client.ogcFeatures();

const collections = await ogc.collections();
const parcels = ogc.collection("0");
const items = await parcels.items({ limit: 100, filter: "status = 'active'" });
const allItems = await parcels.itemsAll({ pageSize: 500, maxPages: 20 });
const feature = await parcels.item({ featureId: "123" });
```

## OGC API Tiles, Maps, Processes, STAC

The first-party OGC client covers the OGC conformance areas that
operator apps need. Everything is exposed through canonical Honua types
— OGC conformance class identifiers stay internal.

```ts doc-test=skip reason="partial excerpt requires application host context"
import { HonuaClient } from "@honua/sdk-js/honua";
import type { IJobRun } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://example.test" });

// OGC API Tiles — vector or raster over the canonical collection-tile route
const tile = await client.ogcTiles()
  .tileset("parcels", "WebMercatorQuad")
  .tile({ tileMatrix: 5, tileRow: 9, tileCol: 12 });

// OGC API Maps — server-rendered map images
const map = await client.ogcMaps().map({
  width: 1024, height: 1024,
  bbox: [-122, 37, -120, 38],
  collections: ["parcels", "roads"],
});

// OGC API Processes — async job execution mapped onto canonical IJobRun
const job: IJobRun = await client.ogcProcesses().execute({
  processId: "buffer",
  inputs: { feature: someGeoJson, distance: 500 },
  mode: "async",
});
const { outputs } = await job.results();

// STAC API — cross-collection search, also available through Source.query()
const search = await client.stac().search({
  bbox: [-122, 37, -120, 38],
  collections: ["sentinel-2"],
  filter: "cloud_cover < 10",
  filterLang: "cql2-text",
});
```

### STAC in the browser bundle

`HonuaStacSearch` is part of the browser-safe `/honua` surface — import it (or call
`client.stac()`) instead of hand-writing `fetch` against STAC endpoints. It is
exported from the `@honua/sdk-js/honua` subpath, so it bundles with
esbuild/Vite/Rollup like the rest of the client:

```ts doc-test=compile
// Browser app (esbuild / Vite / Rollup). No Node-only imports.
import { HonuaClient, HonuaStacSearch } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://example.test" });

// Either construct it directly…
const stac = new HonuaStacSearch({ client });
// …or get the same instance from the client:
const sameStac = client.stac();

const landing = await stac.landing();
const items = await stac.search({
  bbox: [-122, 37, -120, 38],
  collections: ["sentinel-2"],
  datetime: "2026-01-01/2026-06-01",
});

// `searchAll` paginates for you (bounded by `maxPages`):
for await (const item of stac.searchStream({ collections: ["sentinel-2"] })) {
  // …
}
```

See [`docs/ogc-api.md`](./docs/ogc-api.md) for the full developer
reference, [`docs/shared-client-contract.md`](./docs/shared-client-contract.md)
for the canonical `Source` / `IJobRun` model, and
[`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md)
for capability coverage.

## WFS 2.0

```ts doc-test=compile
import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://server.honua.io" });
const dataset = createDataset({
  id: "parcels",
  client,
  sources: [
    {
      id: "parcels-wfs",
      protocol: "wfs",
      locator: {
        url: "https://server.honua.io/wfs",
        typeName: "parcels:lot",
        // Required for applyEdits when typeName is namespace-qualified;
        // bound on <wfs:Transaction xmlns:parcels="…"> so the server can
        // resolve the schema element. Falls back to a synthetic URN
        // when omitted.
        featureNamespace: "http://parcels.example.com/ns",
      },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
    },
  ],
});

const wfs = dataset.source("parcels-wfs")!;
const result = await wfs.query({ where: "STATE = 'CA' AND ACRES > 10" });
const ids = await wfs.queryObjectIds({ where: "STATUS = 'ACTIVE'" });

// Stored-query discovery + execution stays under the typed escape hatch.
const root = wfs.protocol("wfs")!.root;
const storedQueries = await root.storedQueries();
```

`Query.where` compiles to FES 2.0 (comparison, `IN`, `BETWEEN`,
`LIKE`, `IS NULL`, boolean combinators); `Query.spatialFilter`
becomes a KVP `bbox=` for envelope-only requests or a `<fes:Filter>`
otherwise. Filters that exceed the GET budget switch to POST
GetFeature with the `<fes:Filter>` body. `applyEdits` builds a single
`<wfs:Transaction>` (`<wfs:Insert>` / `<wfs:Update>` / `<wfs:Delete>`)
and surfaces per-handle `<fes:ResourceId>` IDs onto `EditOutcome.id`.
GeoJSON is preferred over GML through `OperationsMetadata`
negotiation; if the server only advertises GML the canonical surface
throws `HonuaCapabilityNotSupportedError` and points callers at
`Source.protocol("wfs")` for the raw payload. Full reference:
[`docs/wfs.md`](./docs/wfs.md).

## OData v4

```ts doc-test=compile
import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://server.honua.io" });
const dataset = createDataset({
  id: "parcels",
  client,
  sources: [
    {
      id: "parcels-odata",
      protocol: "odata",
      // Pass `entitySet` directly — or pass `layerId` and let the
      // adapter derive `Layers(<layerId>)/Features` for layer-scoped
      // server bindings.
      locator: { url: "https://server.honua.io/odata", entitySet: "Parcels" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
    },
  ],
});

const parcels = dataset.source("parcels-odata")!;
const result = await parcels.query({ where: "STATE = 'CA' AND ACRES > 10" });
const ids = await parcels.queryObjectIds({ where: "STATUS = 'ACTIVE'" });

// Dialect-specific operations stay behind the typed escape hatch.
const odata = parcels.protocol("odata")!;
const meta = await odata.metadata();
// `apply` accepts a literal OData v4 `$apply` transformation string
// per OData v4 §5.1.4 — `groupby((<dim>),aggregate(<expr>))` is the
// canonical form for SQL-style group-by + sum.
const aggregated = await odata.apply(
  "groupby((STATE),aggregate(ACRES with sum as SumAcres))",
);
```

`Query.where` accepts SQL-92 / OData `$filter` text; the adapter rewrites
the documented intersection (`IS NULL` → `eq null`, `<>` → `ne`, `=` →
`eq`, plus the SQL comparison operators `>=` / `<=` / `>` / `<` → `ge` /
`le` / `gt` / `lt`) and rejects operators the parity matrix marks
unsupported (`has`, `in`, `any`, `all`, `cast`, `isof`). `Query.outFields`
splits onto `$select` for plain field names and `$expand` for navigation
paths — `["Owner.name"]` lowers to `$expand=Owner($select=name)` so
related properties round-trip through the canonical request envelope.
`Query.spatialFilter` translates to `geo.intersects` / `geo.distance`
against the geometry column resolved from `SourceDescriptor.schema.fields`
(typed `esriFieldTypeGeometry`) first, then the lazy `$metadata` probe.
`applyEdits` routes adds → `POST`, updates → `PATCH /<entitySet>(<key>)`
with the full canonical body (PUT is unsupported per the parity matrix),
deletes → `DELETE /<entitySet>(<key>)`. When `EditEnvelope.rollbackOnFailure: true`
and `$metadata` advertises `Capabilities.BatchSupported`, all operations
collapse into one `$batch` request with a shared `atomicityGroup`. OData
is the **first adapter** to lazily fetch service `$metadata` and
intersect declared capabilities against the server's `Capabilities.*`
annotations — see
[`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md)
for the rule and
[`docs/decisions/odata-library-selection.md`](./docs/decisions/odata-library-selection.md)
for the runtime-library posture.

## Mixed Esri + OGC in one app

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://example.test" });

const parcelsLayer = client.service("transport").featureLayer(0);
const parcelsOgc = client.ogcFeatures().collection("parcels");

const [features, items] = await Promise.all([
  parcelsLayer.queryFeatures({ where: "status = 'active'", outFields: ["OBJECTID"] }),
  parcelsOgc.items({ limit: 50 }),
]);
```

## MapServer query helpers

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({
  baseUrl: "https://example.test",
  timeoutMs: 15000,
  retry: { maxRetries: 2, retryStatuses: [429, 503] },
});

const mapLayer = client.mapLayer("basemap", 4);
const allMapLayerFeatures = await mapLayer.queryFeaturesAll({ pageSize: 2000, maxPages: 25 });

const mapService = client.mapService("basemap");
const allServiceLayerFeatures = await mapService.queryLayerFeaturesAll({
  layerId: 4,
  pageSize: 2000,
  maxPages: 25,
});

const related = await mapService.queryLayerRelatedRecords({
  layerId: 4,
  relationshipId: 1,
  objectIds: [1001, 1002],
});

const mapLayerRelated = await mapLayer.queryRelatedFeatures({
  relationshipId: 1,
  objectIds: [1001],
});
```

## Streaming Pagination

```ts doc-test=compile
import { FeatureLayerCompat, CompatEventBus } from "@honua/sdk-js/esri-compat";

const layer = new FeatureLayerCompat({
  url: "https://example.test/rest/services/transport/FeatureServer/0",
});

// Collect all pages in one call
const allFeatures = await layer.queryFeaturesAll({ pageSize: 500, maxPages: 50 });

// Stream pages one at a time with an async generator
for await (const page of layer.queryFeaturesStream({ pageSize: 500 })) {
  console.log(`Received ${page.length} features`);
}
```

## Event Lifecycle (.on)

```ts doc-test=compile
import { FeatureLayerCompat, CompatEventBus } from "@honua/sdk-js/esri-compat";

const eventBus = new CompatEventBus();
const layer = new FeatureLayerCompat({
  url: "https://example.test/rest/services/transport/FeatureServer/0",
  eventBus,
});

// Listen for edit completions
const handle = layer.on("edits", (result) => {
  console.log("Edits applied:", result);
});

await layer.applyEdits({ adds: [{ attributes: { name: "New" } }] });

// Clean up when done
handle.remove();
```

## TimeSlider Integration

```ts doc-test=compile
import { FeatureLayerCompat, TimeSliderCompat, CompatEventBus } from "@honua/sdk-js/esri-compat";

const eventBus = new CompatEventBus();

const layer = new FeatureLayerCompat({
  url: "https://example.test/rest/services/events/FeatureServer/0",
  eventBus,
});

const slider = new TimeSliderCompat({
  eventBus,
  timeExtent: { start: new Date("2024-01-01"), end: new Date("2024-06-01") },
  stops: { interval: { value: 1, unit: "days" } },
});

// Connect slider to layer — time extent changes auto-filter queries
const connection = slider.connectLayer(layer);

// Queries now include the time parameter automatically
const features = await layer.queryFeatures({ where: "1=1" });

// Disconnect when done
connection.remove();
```

## Migration CLI

```bash
# Scan only
node dist/src/migration/cli.js scan ./src --report scan-report.json

# Safe codemod (dry run)
node dist/src/migration/cli.js codemod ./src --report migration-report.json

# Safe codemod (write changes)
node dist/src/migration/cli.js codemod ./src --write --report migration-report.json

# Safe codemod (explicit honua target alias)
node dist/src/migration/cli.js codemod ./src --target honua --write --report migration-report.json

# Safe codemod (write changes targeting esri-leaflet for supported subset)
node dist/src/migration/cli.js codemod ./src --target esri-leaflet --write --report migration-report.json

# Safe codemod (write + inline TODO annotations for manual sites)
node dist/src/migration/cli.js codemod ./src --write --annotate-todos --report migration-report.json

# Emit parity matrix JSON (for docs/CI dashboards)
node dist/src/migration/cli.js matrix --report parity-matrix.json

# Emit runtime parity matrix JSON (for JS API capability tracking)
node dist/src/migration/cli.js runtime-matrix --report runtime-parity-matrix.json

# Generate readiness metrics for bundled complex real-sample fixtures
node dist/src/migration/cli.js fixtures --report reports/real-sample-metrics.json

# Inspect the fixture-only Esri sample migration corpus helpers from tests/docs
# See docs/esri-sample-corpus.md and test/fixtures/esri-sample-corpus/manifest.json

# Enforce strict readiness gates for bundled real-sample fixtures
node dist/src/migration/cli.js fixtures --fail-on-manual --fail-on-unhandled --fail-on-blocked --max-manual-ratio 0 --max-manual-intervention-ratio 0 --report reports/real-sample-metrics.json

# Enforce strict readiness gates for the demo target fixture only
node dist/src/migration/cli.js fixtures --target honua --fixtures esri-demo-feature-table-relates-app --fail-on-manual --fail-on-unhandled --fail-on-blocked --max-manual-ratio 0 --max-manual-intervention-ratio 0 --report reports/demo-featuretable-primary-metrics.json

# Limit fixture metrics to a subset and esri-leaflet target mode
node dist/src/migration/cli.js fixtures --target esri-leaflet --fixtures esri-demo-feature-table-popup-interaction-app --report reports/demo-featuretable-fallback-esri-leaflet-metrics.json

# Gate in CI (non-zero exit if migration constraints fail)
node dist/src/migration/cli.js codemod ./src --fail-on-manual --fail-on-unhandled --fail-on-blocked --max-manual-ratio 0.2 --max-manual-intervention-ratio 0.3

# Compare source vs target service fidelity for one layer
node dist/src/migration/cli.js reconcile --source-base-url https://source.example --source-service-id parcels --target-base-url https://target.example --target-service-id parcels --layer-id 0 --sample-size 200 --report reconcile-report.json

# Content inventory scan from ArcGIS Online/Portal
node dist/src/migration/cli.js content scan --portal https://org.maps.arcgis.com --report ./content/scan.json

# Content export (WebMaps + hosted layers)
node dist/src/migration/cli.js content export --portal https://org.maps.arcgis.com --output-dir ./export --report ./content/export.json

# Content import into Honua admin endpoint
node dist/src/migration/cli.js content import --source ./export --target https://honua.example.com --admin-api-key $HONUA_ADMIN_API_KEY --report ./content/import.json

# Content reconcile using export + import reports
node dist/src/migration/cli.js content reconcile --source ./export --report ./content/reconcile.json

# Convert a WebMap JSON export into Honua style config and rewrite portal URLs
node dist/src/migration/cli.js content-webmap --input ./export/webmap.json --output ./export/webmap.honua.json --source-url-prefix https://org.maps.arcgis.com --target-url-prefix https://honua.example.com --report ./export/webmap.report.json
```

## Migration Admin Scanner

`HonuaClient.scanMigrationSource()` wraps the stable admin scan endpoint for
source-system migration planning:

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";
import type { MigrationSourceInventoryArtifact } from "@honua/sdk-js/honua";

const client = new HonuaClient({
  baseUrl: "https://honua.example.com",
  apiKey: process.env.HONUA_ADMIN_API_KEY,
});

const inventory: MigrationSourceInventoryArtifact = await client.scanMigrationSource({
  sourceKind: "geoservices",
  sourceUrl: "https://source.example.com/arcgis/rest/services/Parcels/FeatureServer",
  timeoutSeconds: 30,
});

if (inventory.scanCompleteness.status === "failed") {
  // HTTP 200 means Honua produced an artifact; completeness is the planning gate.
}
```

Set `exportJson: true` to request
`POST /api/v1/admin/import/scan?export=json`; the SDK still parses the JSON
artifact. The SDK also exports public artifact constants and TypeScript shapes
for source inventory, migration manifest, parity evidence pack, cutover
readiness, and readiness attestations. Manifest, parity, and readiness artifacts
are modeled for client-side review workflows only; the SDK does not assume
server routes for those artifacts.

## Esri Sample Corpus (#206)

The first paired sample-app/service corpus slice is fixture-only and documented
in [`docs/esri-sample-corpus.md`](./docs/esri-sample-corpus.md). The curated
manifest at `test/fixtures/esri-sample-corpus/manifest.json` records Esri sample
source URLs as metadata only, license/terms notes, skip reasons, and expected
service/Portal references. PR CI uses Honua-owned snippets and must not contact
live Esri services, vendor Esri sample code, or commit Esri service data.

## FeatureTable Demo Lane (#327)

Primary target:
- fixture: `esri-demo-feature-table-relates-app`
- sample: `FeatureTable with related records`
- source: `https://developers.arcgis.com/javascript/latest/sample-code/widgets-featuretable-relates/`

Fallback target:
- fixture: `esri-demo-feature-table-popup-interaction-app`
- sample: `Feature table with popup interaction`
- source: `https://developers.arcgis.com/javascript/latest/sample-code/widgets-featuretable-popup-interaction/`

Pinned attribution metadata is tracked in `test/fixtures/DEMO_TARGETS.md` and fixture-local `ATTRIBUTION.md` files.

Runbook (codemod-only CI reproducible path):

```bash
# 1) Run primary demo lane migration (honua target)
npm run demo:migration:featuretable

# 2) Validate primary lane readiness gates and report metrics
npm run gate:migration:demo-target

# 3) Validate fallback lane deterministic esri-leaflet mapping
npm run gate:migration:esri-leaflet-target
```

Report metrics to capture:
- elapsed time: `reports/demo-featuretable-codemod-report.json -> elapsedMs`
- manual rewrite ratio: `migration.manualRewriteMetric.ratio`
- manual intervention count: `migration.manualInterventionMetric.numerator`
- manual rewrite count: `migration.manualRewriteMetric.numerator`

Quick metric extract:

```bash
node -e 'const r=require("./reports/demo-featuretable-codemod-report.json"); console.log({elapsedMs:r.elapsedMs, manualRewriteRatio:r.migration.manualRewriteMetric.ratio, manualInterventionCount:r.migration.manualInterventionMetric.numerator, manualRewriteCount:r.migration.manualRewriteMetric.numerator});'
```

The codemod is intentionally conservative:
- default target (`--target honua` alias of `honua-compat`) rewrites safe constructors:
  - `new FeatureLayer({ url: ... })` -> `new FeatureLayerCompat({ url: ... })` (supports `id`, `title`, `outFields`, `definitionExpression`, `renderer`, `popupTemplate`, `labelingInfo`, `labelsVisible`, `opacity`, `visible`, `minScale`, `maxScale`, `legendEnabled`, and `listMode`; `url` may be absolute or relative, including path-prefixed deployments)
  - `new Polyline(...)` -> `new PolylineCompat(...)`
  - `new Polygon(...)` -> `new PolygonCompat(...)`
  - `new Extent(...)` -> `new ExtentCompat(...)`
  - `new SpatialReference(...)` -> `new SpatialReferenceCompat(...)`
  - `new Color(...)` -> `new ColorCompat(...)`
  - `new PictureMarkerSymbol(...)` -> `new PictureMarkerSymbolCompat(...)`
  - `new TextSymbol(...)` -> `new TextSymbolCompat(...)`
  - `new LabelClass(...)` -> `new LabelClassCompat(...)`
  - `new SimpleFillSymbol(...)` -> `new SimpleFillSymbolCompat(...)`
  - `new ClassBreaksRenderer(...)` -> `new ClassBreaksRendererCompat(...)`
  - `new SimpleRenderer(...)` -> `new SimpleRendererCompat(...)`
  - `new UniqueValueRenderer(...)` -> `new UniqueValueRendererCompat(...)`
  - `new GraphicsLayer(...)` -> `new GraphicsLayerCompat(...)`
  - `new GroupLayer(...)` -> `new GroupLayerCompat(...)`
  - `new MapImageLayer({ url: ... })` -> `new MapImageLayerCompat({ url: ... })` (supports `id`, `title`, `sublayers`, `opacity`, `visible`, `minScale`, `maxScale`, `listMode`, and `legendEnabled`; runtime helpers include `exportImage/getLegend/find/identify/queryFeatures/queryFeaturesAll/queryFeatureCount/queryObjectIds/queryExtent/queryRelatedFeatures` plus `sublayer(...).query*()`, `sublayer(...).queryFeaturesAll()`, `sublayer(...).queryRelatedFeatures()`, and `sublayer.visible/definitionExpression`; `url` may be absolute or relative, including path-prefixed deployments)
  - `new TileLayer({ url: ... })` -> `new TileLayerCompat({ url: ... })` (supports `id`, `title`, `opacity`, `visible`, `minScale`, `maxScale`, and `listMode`; `url` may be absolute or relative, including path-prefixed deployments)
  - `new RouteLayer(...)` -> `new RouteLayerCompat(...)`
  - `new Map(...)` -> `new MapCompat(...)` (supports `basemap`, `layers`, `ground`, `tables`, `portalItem`, and `spatialReference`)
  - `new MapView(...)` -> `new MapViewCompat(...)` (supports `map`, `container`, `center`, `zoom`, `scale`, `rotation`, `extent`, `constraints`, `padding`, `highlightOptions`, `spatialReference`, and `popup`)
  - `new SceneView(...)` -> `new SceneViewCompat(...)` (supports core `MapView` options plus `viewingMode`, `qualityProfile`, and `camera`)
  - `new WebMap(...)` -> `new WebMapCompat(...)` (supports `portalItem`, `basemap`, `layers`, `ground`, `tables`, and `spatialReference`)
  - `new FeatureTable(...)` -> `new FeatureTableCompat(...)` (supports common table options including `highlightIds` and `multiSortEnabled`)
  - `new FeatureForm(...)` -> `new FeatureFormCompat(...)` (supports `feature`, `fieldConfig`, `groupDisplay`, `headingLevel`, and `visibleElements`)
  - `new FeatureTemplates(...)` -> `new FeatureTemplatesCompat(...)` (supports `layerInfos`, `container`, `filterFunction`, and `groupBy`)
  - `new LayerList(...)` -> `new LayerListCompat(...)` (supports `view`, `map`, `container`, `includeHidden`, `autoRefresh`, and `listItemCreatedFunction`)
  - `new Legend(...)` -> `new LegendCompat(...)` (supports `view`, `map`, `layers`, `container`, `includeHidden`, and `autoRefresh`)
  - `new Popup(...)` -> `new PopupCompat(...)`
  - `new Home(...)` -> `new HomeCompat(...)` (supports `view`, `container`, and `viewpoint`)
  - `new BasemapToggle(...)` -> `new BasemapToggleCompat(...)`
  - `new Locate(...)` -> `new LocateCompat(...)` (supports `view`, `container`, `zoom`, and `locateProvider`)
  - `new ScaleBar(...)` -> `new ScaleBarCompat(...)`
  - `new Search(...)` -> `new SearchCompat(...)` (supports `sources`, `includeDefaultSources`, `autoNavigate`, and `autoRefreshSources`)
  - `new BasemapGallery(...)` -> `new BasemapGalleryCompat(...)`
  - `new Bookmarks(...)` -> `new BookmarksCompat(...)`
  - `new Expand(...)` -> `new ExpandCompat(...)`
  - `new Compass(...)` -> `new CompassCompat(...)`
  - `new Fullscreen(...)` -> `new FullscreenCompat(...)`
  - `new Zoom(...)` -> `new ZoomCompat(...)`
  - `new Attribution(...)` -> `new AttributionCompat(...)`
  - `new Sketch(...)` -> `new SketchCompat(...)`
  - `new Editor(...)` -> `new EditorCompat(...)`
  - `new Track(...)` -> `new TrackCompat(...)` (supports `tracking`, `goToLocationEnabled`, `useHeadingEnabled`, `rotationEnabled`, `scale`, and `trackProvider`)
  - `new Measurement(...)` -> `new MeasurementCompat(...)`
  - `new TimeSlider(...)` -> `new TimeSliderCompat(...)`
  - `new Directions(...)` -> `new DirectionsCompat(...)`
- alternate target (`--target esri-leaflet`) rewrites deterministic subset plus broad compat fallbacks:
  - `new FeatureLayer({ ... })` -> `HonuaEsriLeaflet.featureLayer({ ... })`
  - `new MapImageLayer({ ... })` -> `HonuaEsriLeaflet.dynamicMapLayer({ ... })`
  - `new TileLayer({ ... })` -> `HonuaEsriLeaflet.tiledMapLayer({ ... })`
  - `new Map({ ... })` -> `new MapCompat({ ... })`
  - `new MapView({ ... })` -> `new MapViewCompat({ ... })`
  - `new SceneView({ ... })` -> `new SceneViewCompat({ ... })`
  - `new LayerList({ ... })` -> `new LayerListCompat({ ... })`
  - `new Legend({ ... })` -> `new LegendCompat({ ... })`
  - `new Popup({ ... })` -> `new PopupCompat({ ... })`
  - `new Search({ ... })` -> `new SearchCompat({ ... })`
  - `new Home/BasemapToggle/Locate/ScaleBar/BasemapGallery/Expand/Compass/Bookmarks/Fullscreen/Zoom/Attribution(...)` -> corresponding `*Compat` constructor
  - dynamic imports for those modules -> `Promise.resolve({ default: HonuaEsriLeaflet.* })`
  - dynamic imports for compat fallback modules -> `import("@honua/sdk-esri-compat").then((m) => ({ default: m.*Compat }))`
  - advanced 3D-only modules (for example `Slice` and external-renderer style APIs) are emitted as manual TODO/report entries
- `--target esri-leaflet` is for ArcGIS JS (`@arcgis/core`) inputs; existing Esri Leaflet apps generally do not need codemod migration
- it rewrites supported dynamic imports to compat bridge expressions when safe (for example SceneView dynamic import),
- it skips complex constructors and records manual TODO entries in the report,
- it keeps CommonJS `require(...)` constructor sites as manual TODOs (for example `.cjs` or `.js` files exporting via `module.exports`/`exports.*`),
- optionally it can inject inline `// TODO(honua-migrate)...` comments for manual sites (`--annotate-todos`),
- it computes `manualRewrite = numerator / denominator` for codemod-scoped call sites,
- it computes `manualIntervention = numerator / denominator` across codemod-scoped call sites plus unhandled ArcGIS usage hits,
- migration report JSON includes `codemodTarget` so CI artifacts clearly indicate target mode (`honua-compat` or `esri-leaflet`),
- it supports CI gating flags:
  - `--fail-on-manual`
  - `--fail-on-unhandled`
  - `--fail-on-blocked`
  - `--max-manual-ratio <0..1>`
  - `--max-manual-intervention-ratio <0..1>`
- CLI summary includes:
  - per-type migration counts as `byKind=feature-layer:auto/manual/total,graphic:auto/manual/total,point-geometry:auto/manual/total,polyline-geometry:auto/manual/total,polygon-geometry:auto/manual/total,extent-geometry:auto/manual/total,spatial-reference:auto/manual/total,color:auto/manual/total,simple-line-symbol:auto/manual/total,simple-marker-symbol:auto/manual/total,picture-marker-symbol:auto/manual/total,text-symbol:auto/manual/total,label-class:auto/manual/total,simple-fill-symbol:auto/manual/total,class-breaks-renderer:auto/manual/total,simple-renderer:auto/manual/total,unique-value-renderer:auto/manual/total,...,route-layer:auto/manual/total,layer-list:auto/manual/total,legend-widget:auto/manual/total,popup-widget:auto/manual/total,home-widget:auto/manual/total,basemap-toggle-widget:auto/manual/total,locate-widget:auto/manual/total,scale-bar-widget:auto/manual/total,search-widget:auto/manual/total,basemap-gallery-widget:auto/manual/total,bookmarks-widget:auto/manual/total,expand-widget:auto/manual/total,compass-widget:auto/manual/total,fullscreen-widget:auto/manual/total,zoom-widget:auto/manual/total,attribution-widget:auto/manual/total,sketch-widget:auto/manual/total,editor-widget:auto/manual/total,track-widget:auto/manual/total,measurement-widget:auto/manual/total,time-slider-widget:auto/manual/total,directions-widget:auto/manual/total,query:auto/manual/total,feature-set:auto/manual/total,oauth-info:auto/manual/total,identity-manager:auto/manual/total,esri-request:auto/manual/total,esri-config:auto/manual/total,reactive-utils:auto/manual/total`,
  - grouped manual reasons,
  - unhandled ArcGIS module inventory (with `static-import` / `dynamic-import` / `require` usage style),
  - scanner flags include module-shape and risk hints (for example `commonjs-detected`, `scene-3d-detected`, `dynamic-import-detected`),
  - readiness classification (`ready`, `assisted`, `blocked`) with explicit gate results.
