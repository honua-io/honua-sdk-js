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

## MapLibre 5 and 6 compatibility

**Supported MapLibre majors: 5 and 6.** The optional `maplibre-gl` peer range is
`^5.0.0 || ^6.0.0`, and 6.x is the recommended major for new apps — it is what
the development dependency and every runnable example in this repository
install. MapLibre 5 stays supported for apps that have not migrated yet; it is
not deprecated in this release, and any future narrowing will be a dated
decision recorded here rather than a silent break.

> **Registry status (2026-08-05).** The widened range is published:
> `@honua/sdk-js@0.1.4-beta.0` declares `maplibre-gl@^5.0.0 || ^6.0.0`, so an app
> that installs the SDK from npm and asks for MapLibre 6 resolves cleanly. The
> `create-honua-app` starters and the generated sample playgrounds pin 6.1.0 on
> that release (`docs/create-honua-app.md`, `docs/playgrounds.md`), with no
> `overrides` entry and no `--legacy-peer-deps`. The two registry lanes —
> `create-app:time-to-map` and `samples:playgrounds:smoke` — are what keep that
> claim observed rather than asserted.

That claim is gated, not asserted. CI runs a `MapLibre peer-major matrix
(5.x + 6.x)` step (`npm run test:maplibre-compat`) that:

- typechecks the whole tree against MapLibre 5's typings
  (`npm run typecheck:maplibre-v5`, `tsconfig.maplibre-v5.json`), while the
  ordinary `npm run typecheck` covers 6.x;
- imports the real peer module on both majors and asserts every symbol the SDK
  reaches for, including live `pmtiles://` protocol registration
  (`test/maplibre-peer-major-compat.test.ts`, re-run under
  `vitest.maplibre-v5.config.ts` with the `maplibre-gl-v5` alias);
- exercises both module packagings the `<honua-map>` renderer must accept
  (`test/web-components-maplibre-module-compat.test.ts`);
- renders the same Honua-generated style in a real browser under 5.x and 6.x
  (`test/playwright/migration-browser-maplibre.spec.mjs`).

MapLibre 6 is ESM-only, targets ES2022, and requires WebGL2. Use namespace or
named imports (`import * as maplibregl from "maplibre-gl"`) rather than the v5
default import or removed UMD bundle. Vite hosts must also configure the module
worker; the examples share `examples/shared/maplibre-vite-worker.ts` and the
starters ship `src/maplibre-worker.ts`, both of which use Vite's `?worker&url`
pipeline before creating a map. See MapLibre's official
[v5-to-v6 migration guide](https://github.com/maplibre/maplibre-gl-js/blob/v6.0.0/docs/guides/v5-to-v6-migration-guide.md).

WebGL context attributes belong under `canvasContextAttributes` on both
supported majors — MapLibre 5.0 moved `preserveDrawingBuffer`, `antialias`, and
`failIfMajorPerformanceCaveat` there, and 6.x kept them. A top-level
`preserveDrawingBuffer` is silently ignored, which is why the snapshot export in
`@honua/sdk-js/web-components` requires the nested form:

```ts doc-test=skip reason="requires a live MapLibre map"
const map = new maplibregl.Map({
  container,
  style,
  canvasContextAttributes: { preserveDrawingBuffer: true },
});
```

Because MapLibre 6 dropped WebGL1, a WebGL1-only device has no supported
renderer at all. The reviewed deck.gl capability policy
(`bench/browser/capability-policy.mjs`) classifies such a device `unsupported`
rather than routing it to a MapLibre fallback that cannot draw.

The SDK keeps its direct style validator on style-spec 24.x so headless users
are not coupled to MapLibre 6's style-spec 26 dependency. Renderer mounting,
GeoJSON updates, events, controls, and PMTiles registration are covered on both
renderer majors; v6-only style extensions should use `renderer-deferred`
validation for now.

MapLibre 6 itself declares Node `>=16.14.0`, and the compatibility checks pass
under this repository's Node 20.19.0 baseline. The SDK pins
`@mapbox/jsonlint-lines-primitives` 2.0.2 so its direct style-spec 24.x validator
continues to honor that Node baseline. MapLibre 6's style-spec 26.x dependency
declares no engine constraint as of 26.2.1 (observed 2026-08-03), so an
`engine-strict=true` install no longer rejects v6 on Node 20.

## Standalone data-to-map bridge

For the shortest path — any contract `Source` to a styled, interactive
MapLibre layer set without a MapPackage, plan review, or Honua server — use
`mountSource(map, source, options)` from `@honua/sdk-js/map`
(`@experimental`). It selects bounded GeoJSON vs the dynamic query-tile path
from capabilities plus a result-size heuristic, applies geometry-appropriate
default styling, wires optional popups/hover, and returns one disposable
handle with diff-updating `setFilter()`/`refresh()`. See the cookbook:
[`docs/data-to-map-bridge.md`](./data-to-map-bridge.md). The plan-bound
workflows below remain the right tool when you need fingerprinted plan
review, provenance, and freshness policy.

## Accepted plan to native GeoJSON

`@honua/sdk-js/map` includes the first production slice of the automatic
source-to-map workflow. It executes an already-accepted query plan against a
canonical `Source`, projects the result to a native MapLibre GeoJSON source,
generates geometry-aware default layers, and owns refresh/disposal without
importing `maplibre-gl`:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { mountSourceToMapLibre } from "@honua/sdk-js/map";
import { explainQuery } from "@honua/sdk-js/query-planner";

const plan = explainQuery({ descriptor: parcels.descriptor, query: { pagination: { limit: 5_000 }, outSr: 4326 } });
const mounted = await mountSourceToMapLibre(map, parcels, plan);
console.table(mounted.diagnostics);
await mounted.refresh();
mounted.dispose();
```

The mount is peer-injected and therefore safe to import in browser, SSR, Node,
and worker builds. `executeQueryPlan` verifies the accepted fingerprint and
source context before querying. The adapter then:

- selects the exact `geojson-query` strategy and records plan fingerprint,
  source/schema versions, authorization scope, attribution, and strategy on the
  projection;
- promotes the descriptor primary key to MapLibre feature identity;
- emits point, line, and polygon layers with stable ids and default paint,
  including filtered layers for mixed-geometry results;
- reports empty, mixed, and unsupported-geometry states through stable
  machine-readable diagnostics rather than hiding fidelity loss;
- rejects descriptor/runtime capability drift, aggregate or attribute-only
  plans, existing source/layer ids, invalid clustering, stale plan context, and
  renderer mutation failures with typed errors;
- treats invalid, missing, and explicitly mismatched geometry as visible
  degraded diagnostics rather than an exact-ready map;
- rolls back partial source/layer mutation (including renderers that mutate and
  then throw), serializes refreshes through `setData`, cancels in-flight work,
  and disposes its layers/source idempotently.

The focused API remains available when an application has already chosen the
materialized feature lane. The automatic workflow below composes it with the
native tile and raster lanes without changing its plan-binding guarantees.

## Explain and mount automatically

`explainAutomaticSourceToMapLibre` evaluates every currently representable
lane before renderer mutation: bounded GeoJSON, vector tiles, vector/raster
PMTiles, dynamic query tiles, native raster, WMS, and WMTS. It returns the
selected and rejected candidates with stable reason codes, fidelity,
native-versus-materialized path, optional-peer requirements, bounds,
freshness, credential-free provenance, authorization scope, and cache
implications.

```ts doc-test=skip reason="partial excerpt requires application source and host context"
import {
  explainAutomaticSourceToMapLibre,
  mountAutomaticSourceToMapLibre,
} from "@honua/sdk-js/map";
import { explainQuery } from "@honua/sdk-js/query-planner";

const queryPlan = explainQuery({
  descriptor: parcels.descriptor,
  query: { pagination: { limit: 5_000 }, returnGeometry: true, outSr: 4326 },
  sourceVersion: "parcels-2026-07-12",
  authorizationScope: ["parcels:read"],
});
const strategyPlan = explainAutomaticSourceToMapLibre(parcels, { queryPlan });

console.table(strategyPlan.candidates);
const mounted = await mountAutomaticSourceToMapLibre(map, parcels, strategyPlan, { queryPlan });
await mounted.ready;
await mounted.refresh();
mounted.dispose();
```

Native vector and PMTiles plans require an accepted `sourceLayer`; PMTiles also
requires archive payload evidence (`pmtilesType`) from archive metadata. A
dynamic query-tile plan accepts the pure source spec returned by
`buildMapLibreQueryTileSourceSpec`. This avoids network discovery or protocol
guessing inside the planner:

```ts doc-test=skip reason="partial excerpt requires an accepted query-tile descriptor"
const strategyPlan = explainAutomaticSourceToMapLibre(parcels, {
  queryTileSource: buildMapLibreQueryTileSourceSpec(queryTileDescriptor),
  sourceLayer: "parcels",
});
```

Selection is fail-closed. Unsafe credential-bearing URLs, unsupported CRS,
missing capabilities or metadata, unbounded feature queries, stale evidence,
and ineligible explicit overrides produce typed diagnostics and no selected
strategy. Freshness checks require an explicit `observedAt`, `now`, and
`maxAgeMs`, keeping explanation deterministic. Mounting re-explains the source
and policy to reject stale or tampered plans, checks cancellation before host
mutation, rolls back partial native mounts, and provides one
`ready`/`refresh`/`cancel`/`dispose` lifecycle. Native immutable/source-owned
lanes use a no-op refresh; bounded GeoJSON delegates to the query-backed
`setData` refresh. No API in this section imports `maplibre-gl` or `pmtiles`.

This automatic slice does not complete the broader #390 application runtime.
Owned map construction, generalized styling, labels/popups/selection, edits,
realtime subscription orchestration, and the published browser sample matrix
remain explicit residual work.

## Metadata-driven raster sources

`@honua/sdk-js/map` can select and mount an exact raster strategy directly from
a discovered `SourceDescriptor`. The peer-injected workflow supports native XYZ
raster templates (`maplibre-raster`), WMS GetMap, and RESTful WMTS tiles:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { mountRasterSourceToMapLibre } from "@honua/sdk-js/map";

const mounted = mountRasterSourceToMapLibre(map, imagery.descriptor, {
  tileSize: 512,
  paint: { "raster-opacity": 0.85 },
});

console.log(mounted.strategy); // native-raster-tiles, wms-raster, or wmts-raster
console.table(mounted.diagnostics);
mounted.dispose();
```

Selection is deterministic and fail-closed. All three strategies require the
descriptor's `render` and `tiles` capabilities. Native raster URLs must contain
the `{z}`, `{x}`, and `{y}` placeholders; WMS requires `locator.typeName`; WMTS
requires both `locator.typeName` and `locator.tileMatrixSetId`. Unsupported
vector, PMTiles, query-tile, and query-only descriptors throw
`HonuaMapLibreRasterStrategyError` before map mutation instead of falling back
to GeoJSON or guessing protocol metadata.

`projectRasterSourceToMapLibre` is the pure projection half. It returns the
selected strategy, native raster source, raster layer, and stable fidelity
diagnostics without touching the renderer or network. The mount checks source
and layer conflicts, rolls back renderers that mutate and then throw, and owns
idempotent best-effort cleanup. Neither API imports `maplibre-gl`, so both are
safe in Node, SSR, and worker module graphs.

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

### Connection-owned automatic mount

The application kernel can own discovery, accepted-plan execution, renderer
resources, and disposal as one path while MapLibre remains caller-injected:

```ts doc-test=skip reason="requires a browser MapLibre peer and public endpoint"
import * as maplibregl from "maplibre-gl";
import { createHonua } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";

const honua = createHonua();
const connection = await honua.connect(PUBLIC_FEATURE_LAYER_URL);
const mounted = await connection.mount("#map", {
  renderer: maplibreRenderer(maplibregl),
  style: "auto",
});
await mounted.ready; // first usable render frame, not merely source mutation
await honua.dispose(); // cascades through connection, layers/sources, and owned map
```

Passing an existing `maplibregl.Map` borrows it by default: disposal removes
only Honua-created sources and layers. `style` and
`rendererOptions.mapOptions` are owned-map construction controls and are
rejected for an existing host rather than ignored. An explicit `query` is
materialized only through the accepted `geojson-query` strategy; native
vector, PMTiles, and raster strategies fail closed instead of displaying the
unfiltered source. Use `mounted.raw("maplibre")` only for renderer-specific
escape hatches.

```ts doc-test=skip reason="partial excerpt requires application host context"
import * as maplibregl from "maplibre-gl";
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
| `maplibreRenderer(peer, opts)` | `RendererAdapter<"maplibre", MapLibreRendererMap, MapLibreRendererOptions>` | Caller-injected connection adapter. Reuses automatic feature/vector/PMTiles/raster planning, exposes first-frame readiness/refresh/diagnostics, and never enters the root runtime graph as a value import. |
| `loadMapPackage(pkg, map, opts)` | `Promise<HonuaMapRuntime>` | Inline-package load entry point. Throws `HonuaMapPackageError` for binding failures under `sourceErrorPolicy: "fail-fast"`; under the default `"tolerant"` policy a single per-source binding failure does not abort the load — see *Tolerant binding* below. Query-time adapter failures surface on the per-`Source` promises from `runtime.dataset` and through the shared `HonuaClient` interceptor chain; consumers can broadcast them through `runtime.reportSourceError(sourceId, error)` to convert query-time rejections into the canonical `source-error` event. |
| `fetchMapPackage(idOrLocator, opts)` | `Promise<FetchMapPackageResult>` | Fetches a hosted package through `HonuaClient.pipelineFetch`, validates it, resolves style refs when a resolver is supplied, and uses ETag / Last-Modified validators from the server when available. |
| `loadMapPackageFromId(idOrLocator, map, opts)` | `Promise<LoadMapPackageFromIdResult>` | Builder-style helper: fetches a hosted package, then delegates to `loadMapPackage`. The result includes the runtime plus fetch diagnostics/cache state. |
| `watchMapPackage(idOrLocator, opts)` | `MapPackageWatchHandle` | Opt-in polling watcher with `dispose()` and `refresh()`. It reuses `fetchMapPackage`, reports structural updates that require full style reload, and can apply updates to an existing `HonuaMapRuntime`. |
| `validateMapPackage(pkg, opts)` | `ValidateMapPackageResult` | Returns typed diagnostics for format/version, missing sources, unsupported protocols, stale/expired packages, and style-ref target mismatches. |
| `HonuaMapRuntime` | class | `map`, `honuaMap`, `dataset`, `mapPackage`, `composedStyle`, `getLegend`, `setLayerVisibility`, `bindPopup`, `setViewState`, `updatePackage`, `on`, `reportSourceError`, `dispose`. |
| `runtime.hitTest(input, opts)` | `Promise<HonuaHitTestResult>` | Renderer-neutral hit-test wrapper over MapLibre `queryRenderedFeatures`. Returns normalized pointer location, source-qualified feature identities, raw rendered features, geometry/properties when supplied by the renderer, optional detail payloads, and typed degraded states for unsupported or partial renderer data. |
| `runtime.onPointer(handler, opts)` | `{ remove() }` | Subscribes to `"click"`, `"dblclick"`, or `"mousemove"` and invokes `hitTest` for each pointer event. |
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
| `hitTestMap`, `normalizePointerEvent`, `normalizeHitTestFeatures`, `createQueryTileDetailLoader` | functions | Framework-neutral interaction helpers exported from `@honua/sdk-js/interactions`; useful for apps that do not load a full `HonuaMapRuntime`. |
| `diffPackages`, `MapPackageDiff` | function / type | Stable-id diff used by `updatePackage`. |
| `buildLegend`, `LegendEntry` | function / type | Shared with operator components. |
| `bindPopup`, `defaultPopupRenderer`, `PopupFactory`, `PopupRenderer` | function / types | The default DOM renderer is intentionally unstyled — rich popups belong in `#29`. |

## Loader options

```ts doc-test=skip reason="partial excerpt requires application host context"
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
  styleSpecValidationMode?: "strict" | "warning-only" | "renderer-deferred"; // default "strict"
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

Runtime source/layer mutation helpers lazily use
`@maplibre/maplibre-gl-style-spec` without constructing a MapLibre map.
`"strict"` reports style-spec errors as fatal
`HonuaRuntimeDiagnosticError` entries before renderer mutation,
`"warning-only"` preserves the diagnostics as warnings, and
`"renderer-deferred"` skips SDK style-spec checks so the host renderer
reports invalid values.

## Source and Layer Mutation

`HonuaMapRuntime` owns the renderer-specific implementation used by
`HonuaController`'s app-level CRUD surface. The API follows Mapbox GL source
and layer concepts:

```ts doc-test=skip reason="partial excerpt requires application host context"
runtime.addSource("dispatch", {
  type: "geojson",
  data: { type: "FeatureCollection", features: [] },
});

runtime.addLayer(
  {
    id: "dispatch-points",
    type: "circle",
    source: "dispatch",
    paint: { "circle-color": "#00a884", "circle-radius": 6 },
  },
  { beforeId: "parcels-fill" },
);

runtime.updateLayer("dispatch-points", {
  paint: { "circle-color": "#006f5f" },
  metadata: { editedBy: "operator" },
});
runtime.moveLayer("dispatch-points", { position: "top" });
runtime.refreshSource("dispatch");
runtime.removeLayer("dispatch-points");
runtime.removeSource("dispatch");
```

Supported source inputs include common native MapLibre source entries and Honua
custom source entries for GeoServices, OGC Features, WMS, and WMTS. Query-tile
sources can be created with `buildMapLibreQueryTileSourceSpec()`, while hosted
MapPackage source bindings should continue to flow through `loadMapPackage()`
or `updatePackage()` when server state is the source of truth.

The mutation helpers validate source specs, layer specs, style expressions,
filters, layer ordering, and duplicate/missing IDs before mutating the map.
Renderer failures are wrapped as `HonuaRuntimeDiagnosticError` diagnostics. For
incremental paint/layout/filter patches the runtime uses MapLibre's property
setters when available; structural updates fall back to `setStyle(..., { diff:
true })`.

## Hosted MapPackage Fetch

Builder-style usage starts from a package id instead of an inline
`MapPackage`:

```ts doc-test=skip reason="partial excerpt requires application host context"
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

## Hit Testing and Pointer Events

`hitTest` accepts a MapLibre-style event, `{ point, lngLat }`, or a raw
DOM pointer event. It returns screen point, optional longitude/latitude,
and a feature stack normalized to Honua source identity:

```ts doc-test=skip reason="partial excerpt requires application host context"
const hit = await runtime.hitTest(event, {
  layers: ["incidents-symbol", "incidents-fill"],
  sourceIds: ["incidents"],
  featureIdProperty: "incident_id",
  tolerance: 4,
  maxResults: 5,
});

const first = hit.features[0];
if (first?.selectionTarget) {
  view.select([first.selectionTarget], { replace: true });
}
```

Every `HonuaHitFeature` includes `layerId`, `sourceId`, `sourceLayer`,
`featureId`, `selectionTarget`, `properties`, `geometry`, `rawFeature`,
and `degraded[]` when the renderer omits a field. The top-level result
also has `degraded[]`; for example, non-MapLibre renderers without
`queryRenderedFeatures` return an empty feature list plus
`{ reason: "renderer-unsupported" }`.

Optional detail loading is bounded by the caller's `AbortSignal`:

```ts doc-test=skip reason="partial excerpt requires application host context"
const controller = new AbortController();
const hit = await runtime.hitTest(event, {
  layers: ["incidents-symbol"],
  queryTileSources: { incidents: incidentsQueryTileDescriptor },
  loadDetails: true,
  signal: controller.signal,
});
```

When `queryTileSources` includes a descriptor for the hit source, the
runtime composes with the existing query-tile detail path and
`runtime.dataset.source(sourceId)`. Without a descriptor it falls back
to a single-feature source query when an id field is available. Failed,
aborted, or unavailable detail reads are reported in `feature.degraded`
instead of rejecting the whole hit-test result.

Apps that do not use `HonuaMapRuntime` can use the neutral helpers
directly:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { hitTestMap } from "@honua/sdk-js/interactions";

map.on("click", async (event) => {
  const hit = await hitTestMap(map, event, {
    layers: interactiveLayerIds,
    sourceIds: ["incidents"],
    featureIdProperty: "incident_id",
    maxResults: 1,
  });
  openInspector(hit.features[0]);
});
```

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
| `wms` | contract adapter | `wms`, custom source type `honua-wms`. `locator.typeName` projects as `layers`, `locator.styleId` as `styles`. Use `buildWmsRasterSourceSpec(descriptor)` to produce a MapLibre-ready `{ type: "raster", tiles, tileSize }` spec with a pre-baked KVP `GetMap` template that uses MapLibre's exact `{bbox-epsg-3857}` placeholder and validated 1–4096 literal `WIDTH` / `HEIGHT` values equal to `tileSize`. |
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
| `validateStyleExpression(value)` / `validateFilterExpression(filter, layerId?)` | Runs Honua expression checks plus MapLibre style-spec validation when enabled, returning typed diagnostics with path, layer id, source id, protocol, severity, and MapLibre validation context. Mutating helpers throw `HonuaRuntimeDiagnosticError` before touching the renderer when diagnostics contain errors. |
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
