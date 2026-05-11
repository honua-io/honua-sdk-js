# MapLibre GL JS Runtime (`@honua/sdk-js/runtime`)

Status: implemented in `src/runtime/` (ticket `honua-sdk-js-21`).
Public entrypoint: `@honua/sdk-js/runtime` (subpath export only; the
root barrel does not re-export the runtime so hosts that do not need a
map can avoid pulling in the MapLibre-aware code).

The runtime binds a server-produced `MapPackage` (from
`honua-io/honua-server#731`) to a caller-provided `maplibre-gl.Map`. It
composes the style, projects `sourceBindings[]` through the shared
`@honua/sdk-js/contract` adapters, applies `StyleRef` overrides and
`ThemeSpec` tokens, wires popups / legend / initial view, and exposes
a stable operational API for `#22` (mixed-protocol composition) and
`#29` (operator components) to build on.

The runtime **does not** instantiate `maplibre-gl.Map`, issue edit
writes, or duplicate query logic — `maplibre-gl` stays a peer
dependency, edits flow through the existing adapters, and queries go
through the contract's `Source` handles.

## Module layout

```
src/runtime/
├── index.ts           # barrel — public surface
├── map-package.ts     # HonuaMapPackage type (mirrors honua-server#731)
├── map-package-fetch.ts # hosted fetch + load-from-id helpers
├── map-package-validation.ts # typed validation diagnostics
├── map-package-watch.ts # disposable polling watcher
├── load-package.ts    # loadMapPackage(pkg, map, opts) → HonuaMapRuntime
├── runtime.ts         # HonuaMapRuntime class + event/telemetry types
├── source-bridge.ts   # SourceBinding[] → SourceDescriptor[] + native sources
├── query-tiles.ts     # dynamic query tile MapLibre helpers + request lifecycle
├── style-compose.ts   # applyStyleRefs + applyTheme
├── diff.ts            # MapPackageDiff primitives for updatePackage
├── popups.ts          # bindPopup + default unstyled DOM renderer
├── legend.ts          # buildLegend + swatch backfill
└── errors.ts          # HonuaMapPackageError (stages)
```

## Public surface

```ts
import maplibregl from "maplibre-gl";
import { HonuaClient } from "@honua/sdk-js";
import { loadMapPackage } from "@honua/sdk-js/runtime";

const map = new maplibregl.Map({ container: "map" });
const runtime = await loadMapPackage(pkg, map, {
  client: new HonuaClient({ baseUrl: "https://honua.example.com" }),
  popupFactory: () => new maplibregl.Popup(),
});

runtime.setLayerVisibility("parcels-fill", false);
const legend = runtime.getLegend();
await runtime.updatePackage(nextPkg);
runtime.dispose();
```

| Export | Shape | Notes |
| --- | --- | --- |
| `loadMapPackage(pkg, map, opts)` | `Promise<HonuaMapRuntime>` | Inline-package load entry point. Throws `HonuaMapPackageError` for binding failures under `sourceErrorPolicy: "fail-fast"`; under the default `"tolerant"` policy a single per-source binding failure does not abort the load — see *Tolerant binding* below. Query-time adapter failures surface on the per-`Source` promises from `runtime.dataset` and through the shared `HonuaClient` interceptor chain; consumers can broadcast them through `runtime.reportSourceError(sourceId, error)` to convert query-time rejections into the canonical `source-error` event. |
| `fetchMapPackage(idOrLocator, opts)` | `Promise<FetchMapPackageResult>` | Fetches a hosted package through `HonuaClient.pipelineFetch`, validates it, resolves style refs when a resolver is supplied, and uses ETag / Last-Modified validators from the server when available. |
| `loadMapPackageFromId(idOrLocator, map, opts)` | `Promise<LoadMapPackageFromIdResult>` | Builder-style helper: fetches a hosted package, then delegates to `loadMapPackage`. The result includes the runtime plus fetch diagnostics/cache state. |
| `watchMapPackage(idOrLocator, opts)` | `MapPackageWatchHandle` | Opt-in polling watcher with `dispose()` and `refresh()`. It reuses `fetchMapPackage`, reports structural updates that require full style reload, and can apply updates to an existing `HonuaMapRuntime`. |
| `validateMapPackage(pkg, opts)` | `ValidateMapPackageResult` | Returns typed diagnostics for format/version, missing sources, unsupported protocols, stale/expired packages, and style-ref target mismatches. |
| `HonuaMapRuntime` | class | `map`, `honuaMap`, `dataset`, `mapPackage`, `composedStyle`, `getLegend`, `setLayerVisibility`, `bindPopup`, `setViewState`, `updatePackage`, `on`, `reportSourceError`, `dispose`. |
| `HonuaMapPackage` | type | v1 package shape. `format` is gated against `HONUA_MAP_PACKAGE_FORMAT_V1` (`"honua_map_package.v1"`). |
| `HONUA_MAP_PACKAGE_FORMAT_V1` | const | Canonical format tag. |
| `HonuaMapPackageError` / `HonuaMapPackageErrorStage` | class / union | Stage union: `"load" \| "update" \| "style-compose" \| "source-bind" \| "view" \| "popup" \| "dispose"`. |
| `HonuaRuntimeEvent` / `HonuaRuntimeEventListener` | types | See Events below. |
| `HonuaRuntimeTelemetry` | type | `before` / `after` / `error` collector, matching the `HonuaRequestInterceptor` shape. |
| `MaplibreMap` | interface | Duck-typed subset of `maplibre-gl.Map`; keeps the SDK bundle-neutral. |
| `SetViewStateInput` | type | `{ bbox?, center?, zoom?, pitch?, bearing?, padding?, animate? }`. |
| `applyStyleRefs`, `applyTheme`, `composeStyle` | functions | Pure helpers — safe to call outside a runtime for testing / SSR composition. |
| `projectSourceBindings`, `toHonuaSourceSpec` | functions | Exposed for `#22` and adapter tickets that need the bridge without loading a package. |
| `buildWmsRasterSourceSpec`, `buildWmtsRasterSourceSpec` | functions | Pre-bake a MapLibre `raster` source spec from a WMS / WMTS `SourceDescriptor`. Used by callers that compose a map outside `loadMapPackage`. See the source-binding projection table for the URL templates emitted on each protocol. |
| `buildMapLibreQueryTileSourceSpec`, `buildQueryTileJson`, `buildQueryTileUrlTemplate`, `buildQueryTileUrl` | functions | Build TileJSON and MapLibre `vector` source specs from `QueryTileSourceDescriptor`. See [`dynamic-query-tiles.md`](./dynamic-query-tiles.md). |
| `QueryTileRequestController`, `queryTilesForViewport`, `diagnoseQueryTileSourceSupport` | class / functions | Opt-in viewport tile lifecycle helper with abortable requests, bounded cache, diagnostics, and unsupported-protocol/fallback reporting. |
| `diffPackages`, `MapPackageDiff` | function / type | Stable-id diff used by `updatePackage`. |
| `buildLegend`, `LegendEntry` | function / type | Shared with operator components. |
| `bindPopup`, `defaultPopupRenderer`, `PopupFactory`, `PopupRenderer` | function / types | The default DOM renderer is intentionally unstyled — rich popups belong in `#29`. |

## Loader options

```ts
interface LoadMapPackageOptions {
  client: HonuaClient;
  resolveStyleRef?: (styleId: string, presetId?: string) => Promise<HonuaStyleRefBody>;
  resolveTheme?: (themeId: string) => Promise<HonuaMapPackageThemeSpec>;
  resolveSource?: SourceResolver;          // forwarded to createDataset for tiles / MapLibre-native sources
  skipCompatibilityCheck?: boolean;        // tests / conformance fixtures
  telemetry?: HonuaRuntimeTelemetry;
  popupFactory?: PopupFactory;             // required only if runtime.bindPopup is called
  popupRenderer?: PopupRenderer;           // defaults to defaultPopupRenderer
  applyInitialView?: boolean;              // default true
  onEvent?: HonuaRuntimeEventListener;     // subscribed BEFORE initial emissions
  sourceErrorPolicy?: "tolerant" | "fail-fast"; // default "tolerant" — see Tolerant binding
}
```

`resolveStyleRef` and `resolveTheme` are only invoked when the package
omits the inline body. Draft-1 of `honua-server#731` attaches both
inline; out-of-band retrieval plugs in through these hooks without
reopening the loader.

`onEvent` is registered on the runtime before the first
`source-ready` / `package-loaded` emissions, so callers that need to
observe the initial lifecycle without racing against `loadMapPackage`'s
return must use this hook instead of calling `runtime.on(...)` after
`await`. Subsequent events (`package-updated`, `disposed`, ...) also
flow through the same listener.

## Hosted MapPackage Fetch

Builder-style usage starts from a package id instead of an inline
`MapPackage`:

```ts
import { HonuaClient } from "@honua/sdk-js";
import { loadMapPackageFromId, watchMapPackage } from "@honua/sdk-js/runtime";

const client = new HonuaClient({ baseUrl: "https://honua.example.com" });
const { runtime, diagnostics } = await loadMapPackageFromId("map_123", map, {
  client,
  popupFactory: () => new maplibregl.Popup(),
  resolveStyleRef: (styleId, presetId) => fetchStyleBody(styleId, presetId),
});

for (const diagnostic of diagnostics) {
  console.warn(diagnostic.code, diagnostic.message);
}

const watcher = watchMapPackage("map_123", {
  client,
  runtime,
  intervalMs: 30_000,
  onEvent: (event) => {
    if (event.type === "reload-required") {
      console.info(event.reason);
    }
  },
});

// Later, when the host tears down the map:
watcher.dispose();
```

`fetchMapPackage` accepts either an id (`"map_123"`), a direct path or
same-origin URL, a `honua://map-packages/{id}` locator, or an object with
`id`, `packageId`, `path`, `url`, or `href`. Id locators default to
`/api/v1/map-packages/{id}`; pass `resolvePath` when a deployment uses a
different hosted package route.

For low-latency hosted package updates, `watchMapPackage` can use a configured
or package-advertised realtime channel and fall back to polling when the
channel is unavailable. See [`map-package-realtime-watch.md`](./map-package-realtime-watch.md)
for the message schema, lifecycle events, reconnect behavior, auth notes, and
fallback contract.

Fetch results include:

- `mapPackage`: the validated package, with missing style-ref bodies
  inlined when `resolveStyleRef` succeeds.
- `diagnostics`: typed warnings/errors for unsupported formats,
  missing source bindings, unsupported protocols, stale packages
  (`maxAgeMs`), expired packages (`status: "Expired"` or `expiresAt`),
  missing layer sources, and style-ref resolution failures.
- `cache`: SDK fetch cache state. The helper stores validators in a
  per-client in-memory cache by default. On later fetches it sends
  `If-None-Match` / `If-Modified-Since` when the server supplied ETag or
  Last-Modified. Pass `cache: false` to bypass the SDK cache, or pass a
  `MapPackageFetchCache` to share cache state across clients/tests.

Validation errors throw `HonuaMapPackageError { stage: "validate" }`
with `{ diagnostics }` in `detail`. Pass `allowInvalid: true` when a
host wants to display diagnostics without rejecting the fetch.

### Tolerant binding (`sourceErrorPolicy`)

`loadMapPackage` defaults to `sourceErrorPolicy: "tolerant"`: a single
per-source binding failure (resolver throws, `toHonuaSourceSpec`
throws, eager `dataset.source(id)` materialization throws) does not
abort the load. The failed source is dropped from the composed style
along with any layer whose `source` references it; the runtime emits
one `source-error` event per failed source after the `source-ready`
events and before `package-loaded`; `HonuaRuntimeTelemetry.error`
receives a `source-bind` span. Remaining sources continue to render.

Pass `sourceErrorPolicy: "fail-fast"` to restore the historical
single-source behaviour, where any binding failure rejects the load
with `HonuaMapPackageError({ stage: "source-bind" })`.

Configuration-level binding errors (unknown protocol, missing
`locator.url`, duplicate `sourceId`, deferred `workspace_artifact`)
raised by `projectSourceBindings` always fail-fast under either
policy — those are operator errors that must be fixed.

Mixed-source consumers that fan a query out across the dataset can
broadcast a query-time rejection back through the runtime by calling
`runtime.reportSourceError(sourceId, error)` — the helper emits the
same `source-error` event and pipes the failure through the
`source-bind` telemetry span, so observers see one consistent
per-source error channel for both bind-time and query-time
failures. The full guide lives in [`composition.md`](./composition.md).

## `MapPackage` version gate

- `pkg.format` must equal `HONUA_MAP_PACKAGE_FORMAT_V1`
  (`"honua_map_package.v1"`). The loader throws
  `HonuaMapPackageError { stage: "load" }` for any other value.
- `updatePackage(next)` throws `HonuaMapPackageError { stage: "update" }`
  when `next.format` does not match the already-loaded format so
  version mismatches surface at the call site rather than silently
  corrupting the map.
- Unknown fields on `HonuaMapPackage` (and on each `SourceBinding`
  locator) are preserved on round-trip through `updatePackage`, so
  minor additive changes on the server do not force a runtime bump.

## Source binding projection

`projectSourceBindings` routes each `SourceBinding` to one of three
destinations, using the alignment table in
[`source-binding-alignment.md`](./source-binding-alignment.md):

| Server wire protocol (snake_case) | Route | SDK protocol / source type |
| --- | --- | --- |
| `geoservices_feature_service` | contract adapter | `geoservices-feature-service`, custom source type `honua-feature-service`. |
| `geoservices_map_service` | contract adapter | `geoservices-map-service`, custom source type `honua-map-service`. |
| `ogc_features` | contract adapter | `ogc-features`, custom source type `honua-ogc-features`. Collection id is copied from `locator.collectionId`. |
| `wfs` | contract adapter | `wfs` (built-in), custom source type `honua-wfs`. `locator.typeName` (and optional `locator.featureNamespace`) are forwarded; first-party WFS 2.0 adapter ships in `@honua/sdk-js/contract`. |
| `wms` | contract adapter | `wms`, custom source type `honua-wms`. `locator.typeName` projects as `layers`, `locator.styleId` as `styles`. Use `buildWmsRasterSourceSpec(descriptor)` to produce a MapLibre-ready `{ type: "raster", tiles, tileSize }` spec with a pre-baked KVP `GetMap` template that uses MapLibre's `{bbox-epsg3857}` / `{width}` / `{height}` placeholders. |
| `wmts` | contract adapter | `wmts`, custom source type `honua-wmts`. `locator.typeName` / `locator.styleId` / `locator.tileMatrixSetId` project as `layer` / `style` / `tileMatrixSet`. Use `buildWmtsRasterSourceSpec(descriptor)` to produce a MapLibre-ready `{ type: "raster", tiles, tileSize, scheme: "xyz" }` spec using the RESTful `{layer}/{style}/{tms}/{z}/{y}/{x}.{ext}` route. |
| `odata` | contract adapter | `odata`. The entity-set request path comes from `locator.entitySet` when set; otherwise it is derived from `locator.layerId` as `Layers(<layerId>)/Features` to match Honua Server's layer-scoped OData routes. Optional path prefix from `locator.url`. |
| `vector_tile` / `ogc_tiles` | MapLibre-native | Projected to a `{ type: "vector", tiles: [url], attribution? }` source entry — no contract adapter. |
| `raster_tile` / `ogc_maps` | MapLibre-native | Projected to a `{ type: "raster", tiles: [url], attribution? }` source entry. |
| `workspace_artifact` | deferred | Throws `HonuaMapPackageError { stage: "source-bind" }` — no artifact resolver is wired yet. |

`geoservices-image-service`, `geoservices-geometry-service`, and
`geoservices-gp-service` are contract-layer adapters (constructed
directly via `geoServicesImageSource`, `geoServicesGeometryServiceSource`,
`geoServicesGPServiceSource`) and are not currently translated by
`source-bridge.ts`. ImageServer / Geometry / GP bindings on a
`MapPackage` are rejected at `stage: "source-bind"` because those
services are typically utility / non-map surfaces; routing them through
the runtime is a follow-on for downstream tickets that need ImageServer
rasters or geoprocessing tasks composed alongside a map.

Additional contract:

- Duplicate `sourceId` across bindings is rejected at
  `stage: "source-bind"`.
- A protocol-backed binding without a `locator.url` is rejected at
  `stage: "source-bind"`.
- `binding.filter` is captured per source id and passed through to the
  Honua custom source spec (`definitionExpression` on
  `honua-feature-service`, `filter` on `honua-ogc-features` and the
  generic fallback). Edits never flow from the runtime.
- Locator fields are normalized during projection so the shared
  contract adapters can bind even when the server ships a URL-only
  `SourceBinding.locator`:
  - **GeoServices Feature / Map Service**: `serviceId` and numeric
    `layerId` are parsed from the canonical
    `/rest/services/<name>/FeatureServer/<id>` or
    `/rest/services/<name>/MapServer/<id>` URL shape when the binding
    omits them. Explicit locator fields always win over parsed ones.
  - **OGC API Features**: `collectionId` is parsed from the
    `/collections/<id>` URL segment when omitted.
  - **WMS / WMTS**: `serviceId` is parsed from
    `/rest/services/<name>/MapServer/WMS` (and `/WMTS`) and from
    `/ogc/services/<name>/wms` (and `/wmts`) when the binding omits
    it. `locator.typeName` and `locator.styleId` are not URL-derived
    today; the server ships them when a binding pins a specific layer
    or style.
  - **OData**: the server `SourceLocator` carries only `url`,
    `serviceId`, and `layerId`, so `entitySet` is typically absent on
    bindings produced by the server. The `odataSource` adapter derives
    the canonical layer-scoped request path
    `Layers(<layerId>)/Features` from `locator.layerId` when
    `locator.entitySet` is absent (see the *OData* notes in
    [`protocol-capability-matrix.md`](./protocol-capability-matrix.md)
    for the exact resolution rule).
  - **`locator.layerId`**: the server's canonical
    `SourceLocator.LayerId` is `string?`, so
    `HonuaMapPackageLocator.layerId` is typed `number | string`.
    Numeric strings (e.g. `"0"`) are coerced to numbers during
    projection; non-numeric strings are left unset so the adapter
    surfaces the typed validation error.
- Capabilities for protocol-backed descriptors are always sourced
  from `PROTOCOL_DEFAULT_CAPABILITIES[protocol]` (see
  [`protocol-capability-matrix.md`](./protocol-capability-matrix.md)).
  The server `SourceBinding` shape does not carry a `capabilities`
  field today, and the runtime does not expose a hook to downgrade
  per-source capabilities — callers that need a narrower set must
  call `createDataset` directly and pass explicit `SourceDescriptor`
  entries, then bind the map through the lower-level SDK primitives.

## Style composition

`composeStyle` runs two passes over `pkg.mapSpec`:

1. **`applyStyleRefs`** merges each `styleRefs[*].body` onto its
   corresponding layer by id. The body is a
   `Record<string, HonuaStyleRefLayerOverride>` where keys are
   `mapSpec.layers[].id` and values carry any of
   `paint`, `layout`, `minzoom`, `maxzoom`, `filter`, `metadata`.
   Unknown layer ids are silently skipped (they may belong to a
   downstream adapter plugin). If `ref.body` is absent and no
   `resolveStyleRef` was supplied, the loader throws
   `HonuaMapPackageError { stage: "style-compose" }`.
2. **`applyTheme`** substitutes `{theme:key}` placeholders in string
   `paint` / `layout` values against `pkg.theme.tokens` (or the
   resolved `pkg.themeId` body). Only a full-string match on
   `/^\{theme:([^}]+)\}$/` is replaced — substring interpolation is
   not supported in v1. Unresolved tokens are left untouched so
   authors can flag missing tokens at review time.

Theme application recurses into nested arrays / objects inside
`paint` / `layout` so expression literals can reference theme tokens.

## Operational API

| Method | Behavior |
| --- | --- |
| `addSource(sourceId, source)` | Adds a Honua custom source or MapLibre-native source to `runtime.honuaMap`, `runtime.composedStyle`, and the host map via `map.addSource()` when available. Falls back to `setStyle(..., { diff: true })` for renderer adapters that only expose full style application. |
| `updateSource(sourceId, source)` | Replaces a source spec and reapplies the composed style while preserving layer ids. Use for locator/data/source-option changes; paint/layout/filter-only updates should use layer helpers to avoid source reloads. |
| `removeSource(sourceId)` | Removes the source and any dependent layers from the runtime style, `HonuaMap`, and host map. Returns the removed layer ids. |
| `addLayer(layer, order?)` | Adds a typed layer spec, validates paint/layout/filter expressions first, and supports MapLibre `beforeId` as a string or `{ beforeId }`, `{ afterId }`, `{ position: "top" | "bottom" }`. |
| `updateLayer(layerId, patch)` | Patches layer paint/layout/filter in place with `setPaintProperty` / `setLayoutProperty` / `setFilter` when the layer shape is stable. Structural layer changes or explicit reordering use a diffed `setStyle` path. |
| `removeLayer(layerId)` / `moveLayer(layerId, order?)` | Removes or reorders runtime-owned layers while keeping `runtime.composedStyle` and `runtime.honuaMap` aligned with the renderer. |
| `setLayerPaint(layerId, paint)` / `setLayerLayout(layerId, layout)` / `setLayerFilter(layerId, filter)` | Convenience wrappers around `updateLayer` for common Mapbox-style style changes. |
| `setLayerVisibility(layerId, visible)` | `map.setLayoutProperty(layerId, "visibility", …)`. |
| `validateStyleExpression(value)` / `validateFilterExpression(filter, layerId?)` | Runs Honua's lightweight expression validator and returns typed diagnostics with path, layer id, source id, protocol, and severity context. Mutating helpers throw `HonuaRuntimeDiagnosticError` before touching the renderer when diagnostics contain errors. |
| `getLegend()` | Runs `buildLegend` against the current package and composed style; backfills missing swatches from the first `fill-color` / `circle-color` / `line-color` paint property when it is a string literal. |
| `bindPopup(layerId, binding?)` | Requires `opts.popupFactory`. When `binding` is omitted the runtime looks up `pkg.popupBindings[]` by the layer's source id. The default renderer emits an unstyled `<dl>` of the first feature's properties (or a `{field}` template when `binding.template` is set). Returns a `{ remove() }` handle; re-binding on the same layer tears down the prior handle. |
| `bindHover(layerId, options?)` / `bindClick(layerId, handler, options?)` / `bindSelect(layerId, options?)` | Infers source and source-layer from the runtime layer, binds MapLibre layer events, and manages hover/click/select feature-state without requiring app code to pass MapLibre types. `bindClick` emits a source-qualified selection target when a feature id is available. |
| `bindSelectionToExploration(layerId, view, options?)` / `syncSelectionFromExploration(layerId, view, options?)` | Bridges runtime layer interactions to `ExplorationContext` selection and reflects source-qualified shared selection back into MapLibre feature-state. |
| `layerSelectionTarget(layerId, id)` / `setFeatureStateForTarget(target, state)` / `getFeatureStateForTarget(target)` / `removeFeatureStateForTarget(target, key?)` | Converts layer + feature id pairs into source-qualified targets and applies feature-state using either runtime targets or `ExplorationContext` source-qualified targets. |
| `setViewState(view)` | If `view.bbox` is supplied and `map.fitBounds` exists, fits the bounds (`animate: false` by default). Otherwise falls back to `map.jumpTo` for `center` / `zoom` / `pitch` / `bearing`. A final fallback applies `pkg.initialView.bbox` when no input is given. |
| `updatePackage(next)` | See the Update lifecycle section. |
| `on(listener)` | Subscribes to `HonuaRuntimeEvent`. Returns a `{ remove() }` handle. |
| `dispose()` | Clears popup bindings, removes every layer and source owned by the composed style via `honuaMap.clear()` + `map.removeLayer` / `map.removeSource`, emits `disposed`, and rejects subsequent mutating calls. Idempotent. |

`runtime.map`, `runtime.honuaMap`, `runtime.dataset`,
`runtime.mapPackage`, and `runtime.composedStyle` are readable at any
time. The runtime helpers delegate to the lower-level
`src/interactions/feature-state` and
`src/interactions/exploration-bindings` modules, so apps can still use
those lower-level primitives directly when they need custom behavior.

## Update lifecycle

`updatePackage(next)` does three things in order:

1. **Format gate.** `next.format` must match the currently loaded
   format, or the call throws `HonuaMapPackageError { stage: "update" }`
   before any map mutation.
2. **Diff.** `diffPackages(previous, next)` produces a
   `MapPackageDiff` keyed by stable ids:
   - Added / removed / changed source bindings (locator, filter,
     attribution, or protocol differences).
   - Added / removed / changed layer ids (paint, layout, filter,
     source, source-layer, min/max zoom, metadata).
   - A `structuralReason` string and `incremental: false` when any of
     the following hold: `mapSpec.version` changed, the layer set
     changed, the layer order changed, any source binding was added /
     removed / changed, OR the composed layer changed outside the
     runtime's paint / layout / filter patch surface. Source-binding
     changes force the structural path because the runtime must rebuild
     the underlying `Dataset` and `HonuaMap` so
     `runtime.dataset.source(id)` observes the new locator / filter.
3. **Apply.** If `diff.incremental` is false, the runtime rebuilds the
   composed style and calls `map.setStyle(composed)` first; only once
   that returns does it clear the old `HonuaMap` and swap in the
   freshly projected `dataset` / `honuaMap` references. This ordering
   guarantees that if the host map's `setStyle` throws, the runtime's
   previous state — `dataset`, `honuaMap`, `mapPackage`,
   `composedStyle`, and all popup bindings — is left intact so the
   caller can retry without a half-applied update. After a successful
   swap, any popup binding whose layer id is no longer present, whose
   layer source changed, or whose package-resolved binding changed is
   torn down so stale click listeners do not linger. Otherwise it
   removes dropped layers, patches changed layers in place via
   `setPaintProperty` / `setLayoutProperty` / `setFilter`, and emits a
   single `package-updated` event with the diff attached. Theme-only
   tweaks and single-layer paint/filter edits never trigger a full
   `setStyle`; root layer changes such as `minzoom`, `maxzoom`,
   `metadata`, `source`, `source-layer`, or `type` do.

Incremental layer patching iterates the **union** of previous and
next paint / layout keys. Keys present in the previous layer but
dropped in the next are cleared by calling
`setPaintProperty(layerId, key, undefined)` /
`setLayoutProperty(layerId, key, undefined)` so MapLibre resets them
to the property default rather than retaining the stale value.
Identical values are short-circuited with a strict-equality check so
unchanged properties do not trip a MapLibre setter call.

After any structural reload, `runtime.dataset` and `runtime.honuaMap`
return the new references (both are exposed through getters, not
fixed `readonly` fields, so live callers see the refreshed state
immediately).

## Events

Subscribe through `LoadMapPackageOptions.onEvent` to observe the
initial emissions, or `runtime.on(listener)` for subsequent events.
`onEvent` is the only way to capture `source-ready` /
`package-loaded` on a successful load because those events are
dispatched synchronously before `loadMapPackage` returns the runtime
handle. `runtime.on(...)` handles every subsequent event.

| Event | Emitted when |
| --- | --- |
| `{ type: "package-loaded", packageId }` | After the first `setStyle` + initial view apply succeed. Fired last, once per successful load. |
| `{ type: "source-ready", sourceId }` | Once per source id produced by the contract `Dataset`, fired synchronously just before `package-loaded`. |
| `{ type: "source-error", sourceId, error }` | Per-source binding or query-time failure. Under `sourceErrorPolicy: "tolerant"` the loader emits one `source-error` per source whose bind-time projection / spec-build / eager materialization threw; the runtime fans this through the listener chain right after `source-ready` and before `package-loaded`, with telemetry observing a `source-bind` error span. Consumers that fan a query out across the dataset broadcast query-time rejections through `runtime.reportSourceError(sourceId, error)`, which emits the same event so listeners do not have to subscribe to a parallel error channel. |
| `{ type: "package-updated", packageId, diff }` | After `updatePackage` completes (both incremental and full-`setStyle` paths). |
| `{ type: "layer-rendered", layerId }` | Declared for MapLibre render callbacks bridged by the host. The runtime itself does not fire it today. |
| `{ type: "disposed", packageId }` | Once inside `dispose()`, just before listeners are cleared. |

Listeners fire synchronously in subscription order. Adapter-level
request errors continue to flow through the `HonuaClient` interceptor
chain for trace correlation — the runtime does not add a parallel
pipeline.

## Errors

`HonuaMapPackageError` wraps every runtime-binding failure and carries
`{ packageId, stage, detail, cause }`. Stages:

- `load` — format validation, `mapSpec` missing, unknown loader error.
- `update` — `updatePackage` format mismatch or unhandled error.
- `style-compose` — missing style-ref body with no resolver, theme
  resolver threw, general composition failure.
- `source-bind` — unknown protocol, missing locator, duplicate source
  id, deferred `workspace_artifact`.
- `view` — `initialView` application failed.
- `popup` — `bindPopup` called without a `popupFactory`, or no binding
  found for the layer.
- `dispose` — mutating call after `dispose()`.

Per-source protocol failures keep their existing classes
(`HonuaCapabilityNotSupportedError`, `HonuaHttpError`, adapter-specific
errors) and are not wrapped by the runtime. They surface on the
per-`Source` promises exposed by `runtime.dataset` and through the
shared `HonuaClient` interceptor chain. The runtime additionally emits
`source-error` events for per-source binding failures absorbed under
the tolerant policy and for any query-time rejection a consumer
broadcasts through `runtime.reportSourceError(sourceId, error)`. See
*Tolerant binding* above and [`composition.md`](./composition.md) for
the full mixed-source contract.

## Telemetry

`HonuaRuntimeTelemetry` is a `{ before?, after?, error? }` collector
matching the `HonuaRequestInterceptor` contract. The runtime emits
spans for `kind: "load" | "update" | "dispose" | "source-bind" | "popup"`
with `startedAt` / `finishedAt` / `durationMs`. The `source-bind`
error span fires once per source whose binding fails under the
tolerant `sourceErrorPolicy`, and once per call to
`runtime.reportSourceError(sourceId, error)`; its `detail` carries
`{ sourceId }` so observability stacks see the failure alongside other
runtime spans. Adapter traffic is still instrumented through the
shared `HonuaClient` interceptor chain, so distributed-trace
correlation is preserved end-to-end.

## Peer dependency posture

- `maplibre-gl` is a peer/dev dependency — the runtime never imports
  it at the type or value level. `MaplibreMap` and `PopupHandle` are
  duck-typed, matching the pattern used by
  `src/interactions/feature-state`.
- Hosts pass their own `maplibre-gl.Map` instance. Custom subclasses
  and third-party wrappers (deck.gl overlay, OpenLayers bridge) are
  supported as long as they satisfy the `MaplibreMap` method shape.
- `popupFactory` keeps the popup dependency on the host side; omit it
  when the app does not call `runtime.bindPopup`.

## Test coverage

`test/runtime/runtime.test.ts` exercises the full `load →
updatePackage → dispose` lifecycle against a recording mock map
(31 tests). Behavior covered includes:

- Format gate rejects non-v1 packages and `workspace_artifact`
  bindings surface `HonuaMapPackageError { stage: "source-bind" }`.
- Source projection routes each protocol to the correct destination,
  captures filters, translates `snake_case` server protocol names to
  `kebab-case` SDK protocols, and rejects duplicate source ids.
- `composeStyle` applies `StyleRef` overrides; `applyTheme` substitutes
  `{theme:key}` placeholders and leaves unknown tokens in place.
- `diffPackages` flags structural changes (layer reorder, mapSpec
  version bump, source bindings added / removed / changed), and the
  runtime promotes composed root-layer changes to the same path;
  incremental patches update paint / layout / filter without
  re-running `setStyle`.
- Event stream emits `package-loaded`, `source-ready`,
  `package-updated`, `disposed` in the documented order.
- `dispose` removes layers and sources in reverse and ignores
  subsequent calls; further mutating calls throw
  `stage: "dispose"`.

Regression coverage added alongside this release (+11 tests) locks in
the fix-pass behaviors:

- **Source-binding structural fallback.** A locator change or a new
  binding forces a full `setStyle` *and* swaps
  `runtime.dataset` / `runtime.honuaMap` to fresh references so
  `runtime.dataset.source(id)` observes the new locator / filter.
- **Paint / layout key removal.** Removing a paint or layout key
  (e.g. dropping `fill-opacity` or `fill-sort-key` from the next
  layer) calls `setPaintProperty` / `setLayoutProperty` with
  `undefined` so MapLibre resets the property instead of retaining
  the stale value.
- **URL-only locator backfill.** `projectSourceBindings` parses
  `serviceId` / numeric `layerId` from a canonical
  `/rest/services/<name>/FeatureServer/<id>` (and `MapServer` variant)
  URL when the binding omits them, parses `collectionId` from
  `/collections/<id>` for OGC API Features bindings, and coerces
  numeric-string `layerId` values to numbers so the C# server mirror
  (which serialises `LayerId` as a string) still binds through the
  built-in adapters. An end-to-end test loads a URL-only GeoServices
  binding and verifies `runtime.dataset.source(id).adapter(...)` is
  reachable.
- **`onEvent` captures initial lifecycle.**
  `LoadMapPackageOptions.onEvent` receives `source-ready` and
  `package-loaded` without racing against `loadMapPackage`'s
  `await`-return.
- **Structural-update error containment.** When `map.setStyle`
  throws during a structural `updatePackage`, the previous
  `honuaMap` / `dataset` / `mapPackage` references are preserved so
  the runtime is not left half-applied.
- **Popup reap on layer removal.** A structural update that drops
  a previously bound layer tears down the layer's popup click
  listener before emitting `package-updated`.
- **Non-patchable composed layer changes.** A package update that
  changes a root layer field such as `minzoom` routes through
  `setStyle` rather than claiming an incremental paint/layout/filter
  patch applied it.
- **Popup reap on binding changes.** Updating `popupBindings[]` for an
  active package-resolved popup tears down the existing click listener
  so the closed-over binding cannot go stale.

Conformance-style assertions rely only on the duck-typed `MaplibreMap`
interface so no `maplibre-gl` dependency creeps into the SDK's
runtime bundle.

## Deferred follow-ups

- `workspace_artifact` resolver wiring — blocked on server surface.
- Partial-load recovery (skip unresolved sources, continue) — the
  loader is strict in v1; an `opts.allowPartial` escape hatch is
  tracked alongside `#22` mixed-source composition.
- Refinement / preview components — opaque pass-through today;
  `#29` operator components are the documented home.
- Finer-grained diff primitives (layer reorder without teardown) —
  extension point already in `diff.ts`; no consumer yet.
