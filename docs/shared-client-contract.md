# Shared Client Contract

Status: implemented in `src/contract/` (ticket `honua-sdk-js-23`).

The shared contract is the protocol-neutral vocabulary every Honua data
adapter speaks. It exists so cross-protocol code — exploration views,
visual builders, and the server `SourceBinding`/`MapPackage` exporters
— can be written once against `Dataset` / `Source` / `Query` / `Result`
/ `MapBinding` rather than re-litigating the surface in each ticket.

## Goals (and non-goals)

- **Goal:** one canonical name for "the dataset", "the source", "the
  capability", "the query", "the result", "the map binding", and "the
  exploration state" across `HonuaFeatureLayer`, `HonuaMapService`,
  `HonuaOgcFeatures`, first-party OGC render/search adapters,
  first-party WMS / WMTS adapters, the first-party WFS 2.0 adapter,
  and the first-party OData adapter.
- **Goal:** wrap (do not replace) the existing runtime classes in
  `src/core/surfaces.ts`. Existing callers continue to work; adapter
  tickets opt in to the canonical surface.
- **Goal:** stable serialization shape that survives a round-trip with
  the server `SourceBinding` / `MapPackage` documents (see
  [`source-binding-alignment.md`](./source-binding-alignment.md)).
- **Non-goal:** a runtime rewrite. The contract is a typed surface plus
  thin adapter functions — one per built-in protocol
  (`geoServicesFeatureSource`, `geoServicesMapServiceSource`,
  `geoServicesImageSource`, `geoServicesGeometryServiceSource`,
  `geoServicesGPServiceSource`, `ogcFeaturesSource`, `ogcTilesSource`,
  `ogcMapsSource`, `stacSearchSource`, `wmsSource`, `wmtsSource`,
  `wfsSource`, `odataSource`).
- **Non-goal:** a query DSL. `Query.where` is still a SQL-92 / CQL2
  string; adapters translate to their wire format.

## Module layout

```
src/contract/
├── index.ts        # barrel — re-exports types and source factories
├── types.ts        # protocol, capability, source, dataset, query, result
└── source.ts       # createDataset + built-in adapters
```

Public entrypoint: `@honua/sdk-js/contract` (also re-exported from the
top-level `@honua/sdk-js` and `@honua/sdk-js/honua` barrels).

## Canonical nouns

| Type | What it is |
| --- | --- |
| `Protocol` | One of sixteen identifiers — five GeoServices service types (`geoservices-feature-service`, `geoservices-map-service`, `geoservices-image-service`, `geoservices-geometry-service`, `geoservices-gp-service`), four OGC API + STAC adapters (`ogc-features`, `ogc-tiles`, `ogc-maps`, `stac`), `wfs`, `wms`, `wmts`, `odata`, plus three MapLibre-native (`maplibre-vector`, `maplibre-raster`, `maplibre-geojson`). |
| `Capability` | A coarse-grained protocol capability (`query`, `queryAggregate`, `queryExtent`, `queryObjectIds`, `queryRelated`, `applyEdits`, `attachments`, `render`, `tiles`, `sql`, `stream`, `pbf`, `connect`, `image`, `geometry`, `geoprocess`, `processes`). The canonical `Source` surface standardizes the query / edit / related / attachment / object-id subset today; `image` / `geometry` / `geoprocess` / `processes` are negotiated for `Source.protocol()` escape hatches and for the `IJobRun`-based OGC API Processes runner because their request shapes are too protocol-specific to belong on the unified envelope. |
| `Capabilities` | `ReadonlySet<Capability>`. Set membership = first-party protocol support, whether the caller consumes it through a canonical `Source` method or the typed protocol escape hatch. Under `strict` (default) a missing capability throws `HonuaCapabilityNotSupportedError`. Under `degraded` only call sites with a defined fallback proceed (today: OGC `queryAggregate` and `queryExtent`); every other missing capability still throws. |
| `SourceLocator` | Protocol-specific endpoint info (`url`, `serviceId`, `layerId`, `collectionId`, `tileMatrixSetId`, `styleId`, `typeName`, `entitySet`, `taskName`). Field-compatible with the server `SourceBinding.locator`; `tileMatrixSetId` / `styleId` carry OGC API Tiles / Maps route hints for downstream `SourceBinding` work tracked in [`source-binding-alignment.md`](./source-binding-alignment.md). |
| `SourceDescriptor` | `{ id, protocol, locator, capabilities, schema?, attribution? }`. The serializable identity of one source. |
| `Source<T>` | Runtime handle. Methods: `query`, `queryAll`, `queryAggregate`, `queryExtent`, `stream`, `queryObjectIds`, `applyEdits`, `queryRelated`, `attachments` (namespace), `protocol` (typed escape hatch; `adapter` is the legacy alias). |
| `Dataset` | Logical grouping of sources sharing identity. Methods: `source(id)`, `sourceIds()`, `isCompatible()`, `supportsFeature()`. |
| `Query<T>` | `{ where?, spatialFilter?, outFields?, orderBy?, pagination?, aggregation?, returnGeometry?, outSr?, signal? }`. |
| `Result<T>` | `{ features, exceededTransferLimit, totalCount?, aggregateRows?, extent?, fields?, degraded? }`. |
| `EditEnvelope<T>` | `{ adds?, updates?, deletes?, rollbackOnFailure?, signal? }`. Each add / update is a `CanonicalFeature<T>` (attributes + optional geometry + optional id). |
| `EditResult` | `{ added, updated, deleted, degraded? }` — one `EditOutcome` per requested operation. |
| `RelatedQuery` / `RelatedResult<T>` | Canonical related-records request and response. Adapters that lack relationships (OGC, OData, ImageServer) throw rather than return empty groups. |
| `AttachmentApi` | Namespace returned by `Source.attachments`. Methods: `query`, `list`, `add`, `update`, `delete`. Adapters that do not advertise `attachments` throw `HonuaCapabilityNotSupportedError` from each method so the namespace property is always present and capability negotiation stays uniform. |
| `MapBinding` | `{ sourceId, layerIds, style?, minzoom?, maxzoom? }`. Maps onto `MapPackage.sourceBindings` + `MapPackage.mapSpec` server-side. The `@honua/sdk-js/runtime` module consumes a full `MapPackage` on the client — see [`maplibre-runtime.md`](./maplibre-runtime.md). |

## Capability negotiation

Two policies, declared at `createDataset({ capabilityPolicy })`:

- `strict` (default): `Source` operations whose required capability is
  missing throw `HonuaCapabilityNotSupportedError`. Callers can branch on
  `error.capability` and `error.protocol` to swap protocols, fall back, or
  surface the limitation to the user.
- `degraded`: `Source` operations attempt a client-side fallback when the
  server cannot serve the capability natively. The result envelope carries
  `degraded: DegradedReason[]` documenting what was approximated and why.

The capability matrix lives in
[`protocol-capability-matrix.md`](./protocol-capability-matrix.md). Callers
must pass the capability set they want enforced via
`SourceDescriptor.capabilities` — per-source overrides (e.g. downgrading
`queryAggregate` on a Feature Service whose metadata reports
`supportsStatistics: false`) are the caller's responsibility for the
GeoServices, OGC, STAC, WFS, and WMS adapters today. **OData is the
first adapter to implement automatic metadata-driven downgrades**: the
entity-set adapter lazily fetches `$metadata` on the first
capability-gated method, parses `Capabilities.*` annotations, and
intersects the declared capability set with what the server advertises.
See [`protocol-capability-matrix.md`](./protocol-capability-matrix.md)
under *OData* for the implementation details. Other adapters (GeoServices
`supportsStatistics`, OGC `conformsTo`) follow the same pattern as
follow-up work.

The registry is intentionally broader than the current `Source` method list so
downstream adapter tickets can negotiate `render` / `tiles` / `sql` /
`queryObjectIds` / etc. without inventing a second capability vocabulary.

## Source factory

```ts
import { createDataset, type SourceDescriptor } from "@honua/sdk-js/contract";

const dataset = createDataset({
  id: "parcels",
  client,
  capabilityPolicy: "strict",
  sources: [
    {
      id: "parcels-fs",
      protocol: "geoservices-feature-service",
      locator: { url: "...", serviceId: "Parcels", layerId: 0 },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    },
  ] satisfies SourceDescriptor[],
});

const parcels = dataset.source("parcels-fs")!;
const result = await parcels.query({ where: "STATE = 'CA'", pagination: { limit: 100 } });
```

The built-in resolver handles `geoservices-feature-service`,
`geoservices-map-service`, `geoservices-image-service`,
`geoservices-geometry-service`, `geoservices-gp-service`, `ogc-features`,
`ogc-tiles`, `ogc-maps`, `stac`, `wfs`, `wms`, `wmts`, and `odata`.
MapLibre-native sources register through
`CreateDatasetOptions.resolveSource`. OGC API
Processes is a job runner rather than a queryable source — reach it
through `HonuaClient.ogcProcesses().execute(...)` (returns the canonical
`IJobRun<T>`) instead of `Dataset.source()`.

The five GeoServices factories cover the surface published in
`honua-server/docs/gis/geoservices-rest-parity.md`:

- `geoServicesFeatureSource` — FeatureServer (query, edits, related,
  attachments, object ids, replica/calculate/validateSQL/append/bins/estimate
  via `protocol()`).
- `geoServicesMapServiceSource` — MapServer (read-only query family,
  related records; export/identify/find/legend/tile via `protocol()`).
- `geoServicesImageSource` — ImageServer (raster catalog query,
  exportImage / identify / tile / legend via `protocol()`).
- `geoServicesGeometryServiceSource` — Geometry Service (utility-only;
  query family throws, operations live behind `protocol()`).
- `geoServicesGPServiceSource` — GP Service (utility-only; submitJob /
  jobStatus / cancelJob / jobResult via `protocol()`).

The OGC API and STAC factories cover `docs/ogc-api.md`:

- `ogcFeaturesSource` — OGC API Features (query, edits, object ids,
  stream; `queryAggregate` / `queryExtent` degrade client-side).
- `ogcTilesSource` — OGC API Tiles (render-only; query family throws,
  `HonuaOgcTileset` / `HonuaOgcTiles` reachable via `protocol()`).
- `ogcMapsSource` — OGC API Maps (render-only; same shape as Tiles).
- `stacSearchSource` — STAC API search (`/search` query, queryObjectIds,
  stream; cross-collection scope via `locator.collectionId`).

The WMS / WMTS factories cover the OGC web-map services per
`docs/protocol-capability-matrix.md`:

- `wmsSource` — WMS 1.3.0 (render + tiles via `GetMap`; `query` via
  point-only `GetFeatureInfo`; raw multi-pixel `featureInfo()` and the
  per-layer service handles reachable via
  `Source.protocol("wms" | "wms-layer")`).
- `wmtsSource` — WMTS 1.0.0 (render + tiles via RESTful tiles; query
  family throws; service / layer / tileset handles reachable via
  `Source.protocol("wmts" | "wmts-layer" | "wmts-tileset")`).

`docs/wfs.md` documents the WFS 2.0 factory in the same shape:

- `wfsSource` — WFS 2.0 (query, queryAll, queryExtent, queryObjectIds,
  applyEdits, stream; FES 2.0 emission for `Query.where` /
  `Query.spatialFilter`; raw GML / `<wfs:Transaction>` payloads via
  `protocol("wfs")`).

The OData factory wraps an OData v4 entity set behind the canonical
surface:

- `odataSource` — query / queryObjectIds / stream / applyEdits
  first-party (POST/PATCH/DELETE; PUT is unsupported per the parity
  matrix and addressed by `PATCH` with the full canonical body).
  Dialect-specific `$batch` / `$apply` / `$search` / `$deltatoken`
  reach `HonuaOdataEntitySet` through `Source.protocol("odata")`.
  OData is the **first adapter** to lazily fetch service metadata
  (`$metadata`) and intersect the declared `Capabilities` set with
  what the server advertises through `Capabilities.*` annotations —
  see [`protocol-capability-matrix.md`](./protocol-capability-matrix.md)
  for the precedent and [`decisions/odata-library-selection.md`](./decisions/odata-library-selection.md)
  for the runtime-library posture.

`Source.queryAll()` and `Source.stream()` drain every page the server
returns — the built-in adapters override the core helpers' 100-page
default so a large `queryAll()` is not silently truncated. Callers who
want a hard cap should paginate with `Query.pagination` (`offset` skips
ahead; `limit` clips, and its meaning depends on the method):

- `query()` — `limit` is the single-page record count.
- `queryAll()` — `limit` is the total-row cap on the materialized result.
  The adapter sizes `pageSize` and `maxPages` from `limit` so the paging
  loop fetches at most `limit + 1` rows; the extra row lets the result
  stamp `exceededTransferLimit: true` when more records exist.
- `stream()` — `limit` is the per-batch page size (not a global cap).
  Each yielded `Result` carries up to `limit` features; callers that
  want a global cap must stop iterating explicitly.

## Compatibility gating

`Dataset.isCompatible()` calls `HonuaClient.checkCompatibility()` once and
caches the result. `Dataset.supportsFeature(feature)` proxies to
`HonuaClient.supportsFeature` for fine-grained checks. Both reuse the
existing compatibility-gate workflow — no new wire calls were introduced.

## Protocol escape hatch

`Source.protocol("geoservices-feature-service")` returns the underlying
`HonuaFeatureLayer` instance (or `undefined` for the wrong kind). The
accessor name is `protocol` because it surfaces protocol-specific
operations — raw `where`, raw `outFields`, GeoServices `calculate` /
`validateSQL` / replica / `queryBins` / `getEstimates` — that the
canonical `Source` surface intentionally does not expose. The
`adapter()` method is preserved as a legacy alias for callers written
against the original ticket-23 surface; it returns the same instance.
The `AdapterTypeMap` interface uses TypeScript declaration merging so
adapter tickets can plug in their own kind → instance type mapping
without touching this file.

```ts
declare module "@honua/sdk-js/contract" {
  interface AdapterTypeMap {
    "my-protocol": MyProtocolLayer;
  }
}
```

The shipped map covers `geoservices-feature-service` →
`HonuaFeatureLayer`, `geoservices-map-service` → `HonuaMapService`,
`geoservices-map-layer` → `HonuaMapLayer`, `geoservices-image-service`
→ `HonuaImageService`, `geoservices-geometry-service` →
`HonuaGeometryService`, `geoservices-gp-service` →
`HonuaGeoprocessingService`, `ogc-features` →
`HonuaOgcFeatureCollection`, `ogc-tiles` → `HonuaOgcTileset |
HonuaOgcTiles`, `ogc-maps` → `HonuaOgcMaps |
HonuaOgcCollectionMap`, `ogc-processes` → `HonuaOgcProcesses`,
`stac` → `HonuaStacSearch`, `wms` → `HonuaWms`, `wms-layer` →
`HonuaWmsLayer`, `wmts` → `HonuaWmts`, `wmts-layer` →
`HonuaWmtsLayer`, `wmts-tileset` → `HonuaWmtsTileset`,
`wfs` → `HonuaWfsFeatureType`, and `odata` → `HonuaOdataEntitySet`.
The WFS root handle (capabilities cache, stored-query discovery) is
reachable through `Source.protocol("wfs").root`.

## What downstream tickets must consume

1. New protocol adapters must implement `Source<T>` and register either
   as a built-in `case` in `buildBuiltInSource` (the precedent followed
   by `wmsSource` / `wmtsSource` / `wfsSource` / `odataSource`) or
   through `CreateDatasetOptions.resolveSource`. They must declare
   their default capability set in `PROTOCOL_DEFAULT_CAPABILITIES`
   (this file owns that table — adapter PRs extend it).
2. Visual builder, exploration, and server-export tickets must consume
   `Dataset` / `Source` / `Query` / `Result` / `MapBinding` rather than
   the per-class request shapes (`QueryFeaturesRequest`, etc.). Per-class
   shapes are still available via `Source.adapter()` for legacy paths.
3. New error types must flow through `HonuaError` and `isHonuaError`.
   This ticket added `HonuaCapabilityNotSupportedError` and
   `HonuaExplorationContextError`. The first-party WMS / WMTS adapter
   ticket extended the union with `HonuaWmsCapabilitiesParseError` and
   `HonuaWmtsCapabilitiesParseError` so callers can classify XML parser
   failures through the same guard.

## Async operations: `IJobRun`

Long-running server-side operations (OGC API Processes execution today;
future GeoServices async exports, OData function imports, etc.) surface
through the canonical `IJobRun<T>` interface in `@honua/sdk-js/contract`:

```ts
import type { IJobRun } from "@honua/sdk-js/contract";

const job: IJobRun = await client.ogcProcesses().execute({
  processId: "buffer",
  inputs: { feature: someGeoJson },
  mode: "async",
});

const unwatch = job.watch((snap) => {
  console.log(snap.status, snap.progress);
});
const { outputs } = await job.results();
unwatch();
```

`IJobRun` exposes `id`, `type`, `status`, `progress`, `poll()`,
`watch()`, `results()`, and `cancel()`. The OGC API Processes 1.0
status vocabulary (`accepted`, `running`, `successful`, `failed`,
`dismissed`) is canonical; adapters for other protocols translate onto
it. Failed runs reject `results()` with `HonuaJobFailedError`, whose
`message` is populated from the server's `statusInfo.exception.message`
when present and falls back to `statusInfo.message` otherwise (to match
honua-server's `StatusInfo` DTO, which exposes only `message`).
`cancel()` is idempotent against the two documented benign paths:
"job gone" (404) returns the cached status, and the terminal race
(409 "Cannot dismiss completed job" from honua-server) triggers a
follow-up GET and returns the authoritative terminal status — but
only if the poll confirms a terminal state. honua-server also emits
409 for "Dismiss could not be confirmed" (backend dismissal unconfirmed)
and "Cancellation not supported" (backend lacks cancel support); both
rethrow as `HonuaHttpError` so callers can branch or retry instead of
seeing a fabricated success. Submitted processes are typed as
`IJobRun<T>`; `HonuaOgcProcessJobRun` is the implementation behind that
interface and should not be the caller-facing contract.

## OGC API Tiles / Maps / Processes / STAC

The first-party OGC adapters live alongside `HonuaOgcFeatures`:

| Conformance area | Entry point | Source protocol | Contract capabilities |
| --- | --- | --- | --- |
| OGC API Features | `client.ogcFeatures()` / `HonuaOgcFeatures` | `ogc-features` | `query`, `queryObjectIds`, `applyEdits`, `stream` |
| OGC API Tiles | `client.ogcTiles()` / `HonuaOgcTiles`, `HonuaOgcTileset` | `ogc-tiles` | `render`, `tiles` (tileset-bound when locator includes `tileMatrixSetId`; root discovery handle otherwise) |
| OGC API Maps | `client.ogcMaps()` / `HonuaOgcMaps`, `HonuaOgcCollectionMap` | `ogc-maps` | `render` |
| OGC API Processes | `client.ogcProcesses()` / `HonuaOgcProcesses` | (no source — job runner) | `processes` from conformance negotiation, not `PROTOCOL_DEFAULT_CAPABILITIES` |
| STAC API | `client.stac()` / `HonuaStacSearch` | `stac` | `query`, `queryObjectIds`, `stream` |

OGC API Tiles and OGC API Maps are render-only — their `Source.query*`
methods throw, and renderers reach the underlying class through
`Source.adapter("ogc-tiles")` / `Source.adapter("ogc-maps")`. STAC
search flows through the canonical `Source.query()` like every other
tabular protocol. OGC API Processes does not register as a `Source`
because its inputs are not queryable; it produces `IJobRun<T>` from
`execute(...)`.

## WMS / WMTS web-map services

The first-party OGC web-map adapters share the contract surface:

| Service | Entry point | Source protocol | Contract capabilities |
| --- | --- | --- | --- |
| WMS 1.3.0 | `client.wms(serviceId)` / `HonuaWms`, `HonuaWmsLayer` | `wms` | `render`, `tiles`, `query` (point-only `GetFeatureInfo`) |
| WMTS 1.0.0 | `client.wmts(serviceId)` / `HonuaWmts`, `HonuaWmtsLayer`, `HonuaWmtsTileset` | `wmts` | `render`, `tiles` |

`Source.protocol("wms")` returns the service handle and
`Source.protocol("wms-layer")` a layer-bound handle (when
`locator.typeName` is set). WMTS exposes three handles —
`Source.protocol("wmts")` (service), `"wmts-layer"` (layer-bound), and
`"wmts-tileset"` (layer × style × tile-matrix-set bound). MapLibre
integration ships through the runtime helpers
`buildWmsRasterSourceSpec(descriptor)` /
`buildWmtsRasterSourceSpec(descriptor)` from `@honua/sdk-js/runtime` —
they emit a `raster` source spec without forcing callers to hand-assemble
a `GetMap` URL or RESTful tile template. The style-spec resolver
`createSources(client, style)` (from `@honua/sdk-js`) and
`HonuaMap.getSource(name)` both produce the same `HonuaWms` /
`HonuaWmsLayer` / `HonuaWmts` / `HonuaWmtsTileset` handles when a
style declares a `honua-wms` / `honua-wmts` source type — the shared
`src/style/wms-wmts-resolvers.ts` module owns the URL parsing and
layer / tileset selection rules so the two surfaces never diverge.
The WMS `LAYERS=` / `locator.typeName` / `spec.layers` value is
parsed through the canonical `parseWmsLayerNames` helper (in
`src/core/wms.ts`); the layer-bound `HonuaWmsLayer` handle is only
returned for a single non-empty token, while multi-layer composites
(`"a,b"`) stay on the service-level `HonuaWms` handle.
See [`docs/protocol-capability-matrix.md`](./protocol-capability-matrix.md)
for axis-order, dimension, legend, and TileMatrixSet notes.

OGC conformance class identifiers are intentionally kept *internal*.
`negotiateOgcCapabilities(protocol, conformsTo)` from
`@honua/sdk-js/honua` translates a server-advertised `conformsTo[]`
list into a canonical `Capabilities` set; downstream callers that want
to gate on a specific extension (CQL2, transactions, etc.) use
`hasOgcConformanceClass(...)` with a substring match. No OGC
conformance class name appears as a primary SDK type, per the ticket
constraint.

## Test coverage

Conformance fixtures under `test/contract/` exercise the canonical
surface against mock adapters for each protocol. Adding a new protocol
adapter means adding a fixture there; the parametrized scenarios run
unchanged.

- `test/contract/conformance.test.ts` — cross-protocol parametric
  scenarios. Each new adapter registers a harness; the suite runs the
  same query / queryExtent / queryAggregate / stream cases against
  every harness.
- `test/contract/odata-conformance.test.ts` — adapter-specific
  translation rules and escape-hatch surface (`metadata`, `batch`,
  `apply`, `search`, `delta`, `raw`).
- `test/contract/ogc-conformance.test.ts` — the conformance-class
  → capability negotiation translation table.
