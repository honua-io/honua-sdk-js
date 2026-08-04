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
- **Non-goal:** replacing the v1 `Query` envelope while protocol compilers
  migrate. `Query.filter` (typed, protocol-neutral) and `Query.temporalFilter`
  are the stable filtering members; `Query.where` remains only as a deprecated,
  source-native compatibility string. The experimental schema-verified semantic
  AST in `@honua/sdk-js/query-planner` follows separate compiler/execution
  workflows over the same filter shape.

## Module layout

```
src/contract/
├── index.ts                 # barrel — re-exports types and source factories
├── spatial-aggregation.ts   # indexed aggregation request/response metadata
├── tiles.ts                 # dynamic query tile descriptors, cache keys, identity
├── types.ts                 # protocol, capability, source, dataset, query, result
└── source.ts                # createDataset + built-in adapters
```

Public entrypoint: `@honua/sdk-js/contract` (also re-exported from the
top-level `@honua/sdk-js` and `@honua/sdk-js/honua` barrels).

## Cross-SDK binding policy

This JS contract is also the draft semantic anchor for the Python and .NET SDKs.
The SDKs should align behavior and vocabulary while keeping language-native
names and casing. For example, the same operation may surface as `queryAll()`
in TypeScript, `query_all()` in Python, and `QueryAllAsync()` in .NET.

The binding policy and cross-SDK fixture pack are documented in
[`sdk-surface-alignment.md`](./sdk-surface-alignment.md). The JSON fixture pack
lives under `test/fixtures/sdk-contract/`; it is intentionally language-neutral
so downstream SDKs can consume the same protocol, capability, result,
unsupported-capability, and degraded-result scenarios.

## Canonical nouns

| Type | What it is |
| --- | --- |
| `Protocol` | One of twenty identifiers — shared canonical gRPC FeatureService transport (`grpc`), five GeoServices service types (`geoservices-feature-service`, `geoservices-map-service`, `geoservices-image-service`, `geoservices-geometry-service`, `geoservices-gp-service`), OGC API + STAC adapters (`ogc-features`, `ogc-tiles`, `ogc-maps`, `ogc-records`, `stac`), `wfs`, `wms`, `wmts`, `odata`, static-data adapters (`pmtiles`, `geoparquet`), plus three MapLibre-native sources (`maplibre-vector`, `maplibre-raster`, `maplibre-geojson`). |
| `Capability` | A coarse-grained per-source operation capability (`query`, `queryAggregate`, `spatialAggregate`, `queryExtent`, `queryObjectIds`, `queryRelated`, `applyEdits`, `attachments`, `render`, `tiles`, `sql`, `stream`, `pbf`, `image`, `geometry`, `geoprocess`, `processes`). The canonical `Source` surface standardizes the query / edit / related / attachment / object-id subset today; `spatialAggregate`, `image` / `geometry` / `geoprocess` / `processes` are negotiated for indexed analytics, `Source.protocol()` escape hatches, and for the `IJobRun`-based OGC API Processes runner because their request shapes are too protocol-specific to belong on the unified query envelope. Top-level `connect()` is product discovery, not an operation on one `Source`, and is tracked as a `discovery` support claim instead. |
| `Capabilities` | `ReadonlySet<Capability>`. Set membership = first-party protocol support, whether the caller consumes it through a canonical `Source` method or the typed protocol escape hatch. Under `strict` (default) a missing capability throws `HonuaCapabilityNotSupportedError`. Under `degraded` only call sites with a defined fallback proceed (today: OGC `queryAggregate` and `queryExtent`); every other missing capability still throws. |
| `SourceLocator` | Protocol-specific endpoint info (`url`, `serviceId`, `layerId`, `collectionId`, `tileMatrixSetId`, `styleId`, `typeName`, `entitySet`, `taskName`, and an optional reviewed WMS/WMTS `raster` binding). It is a superset of the server `SourceBinding.locator`; additive route and binding hints are tracked in [`source-binding-alignment.md`](./source-binding-alignment.md). |
| `SourceDescriptor` | `{ id, protocol, locator, capabilities, schema?, attribution? }`. The serializable identity of one source. |
| `Source<T>` | Runtime handle. Methods: `query`, `queryAll`, `queryAggregate`, `queryExtent`, `stream`, `queryObjectIds`, `applyEdits`, `queryRelated`, `attachments` (namespace), `protocol` (typed escape hatch; `adapter` is the legacy alias). |
| `Dataset` | Logical grouping of sources sharing identity. Methods: `source(id)`, `sourceIds()`, `isCompatible()`, `supportsFeature()`. |
| `Query<T>` | The v1 compatibility envelope `{ where?, spatialFilter?, outFields?, orderBy?, pagination?, aggregation?, returnGeometry?, outSr?, signal? }`; `where` is deprecated, source-native migration compatibility. The experimental typed planner AST uses separate compiler/execution workflows and is not accepted by `Source.query()`. |
| `Result<T>` | `{ features, exceededTransferLimit, totalCount?, aggregateRows?, extent?, fields?, degraded? }`. |
| `SpatialAggregationRequest` / `SpatialAggregationResult` | Indexed spatial aggregation contract for large result sets. Requests carry `where`, `spatialFilter`, `viewport`, zoom/index-resolution hints, opaque index selection, summary specs (`category`, `histogram`, `range`, `count`, `sum`, `avg`, `min`, `max`), and optional `groupBy`. Results carry opaque indexed cells, grouped/totals summaries, backend index metadata, widget metadata, and progressive loading state. |
| `EditEnvelope<T>` | `{ adds?, updates?, deletes?, rollbackOnFailure?, signal? }`. Each add / update is a `CanonicalFeature<T>` (attributes + optional geometry + optional id). |
| `EditResult` | `{ added, updated, deleted, degraded? }` — one `EditOutcome` per requested operation. |
| `EditWorkflowSession<T>` | Form/edit session over one `Source`: projects field metadata and domains, exposes relationship / attachment capability states, stages feature and attachment edits, runs optimistic hooks, and returns a normalized `EditWorkflowSubmitResult`. |
| `RelatedQuery` / `RelatedResult<T>` | Canonical related-records request and response. Adapters that lack relationships (OGC, OData, ImageServer) throw rather than return empty groups. |
| `AttachmentApi` | Namespace returned by `Source.attachments`. Methods: `query`, `list`, `add`, `update`, `delete`. Adapters that do not advertise `attachments` throw `HonuaCapabilityNotSupportedError` from each method so the namespace property is always present and capability negotiation stays uniform. |
| `MapBinding` | `{ sourceId, layerIds, style?, minzoom?, maxzoom? }`. Maps onto `MapPackage.sourceBindings` + `MapPackage.mapSpec` server-side. The `@honua/sdk-js/runtime` module consumes a full `MapPackage` on the client — see [`maplibre-runtime.md`](./maplibre-runtime.md). |
| `QueryTileSourceDescriptor` | Typed dynamic vector/query tile descriptor. It binds a canonical `Source` or source id to tile endpoint metadata, query/projection cache identity, fallback policy, and feature identity hooks. Runtime MapLibre helpers and the canonical `/query-tiles` server contract live in [`dynamic-query-tiles.md`](./dynamic-query-tiles.md). |

## Dynamic query tile server contract

Dynamic query tiles have a server-side contract in addition to the client
descriptor. The canonical route prefix is `/query-tiles`, with TileJSON,
vector tile, and feature-detail routes under
`/query-tiles/sources/{sourceId}`. The contract defines request parameters for
filters, projection fields, output spatial reference, tile matrix set, extent,
simplification tolerance, max features, cache partitioning, and cache busting.

`@honua/sdk-js/contract` exports route builders, parser helpers, response
types, and the `QUERY_TILE_SERVER_CONTRACT_VERSION` constant. The reusable
fixture lives at `test/fixtures/sdk-contract/query-tile-server.v1.json` and is
intended for Honua server implementation repos to consume in their own
conformance tests.

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
`queryObjectIds` / `spatialAggregate` / etc. without inventing a second
capability vocabulary. `spatialAggregate` has no default protocol support
today; sources should advertise it only when source-specific metadata confirms
an indexed aggregation backend. Apps must treat returned cell ids and
`index.model.id` as opaque, so H3, Quadbin, or a provider-specific grid can
drive the same widgets.

For multi-source compositions, use `intersectCapabilities` from
`@honua/sdk-js/contract` to compute the **weakest** capability set
across the participating sources before fanning a call out — the rule
plus the partition-then-intersect pattern for per-operation reasoning
lives in [`composition.md`](./composition.md). Adapters that emit
`Result.degraded[]` populate `DegradedReason.sourceId` from
`descriptor.id` so a fan-out can attribute each degradation back to
the exact source that triggered it.

## Source factory

```ts doc-test=skip reason="partial excerpt requires application host context"
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
const result = await parcels.query({ pagination: { limit: 100 } });
```

`Source.query()` accepts the stable protocol-neutral `Query` envelope. Its
deprecated `where` string is retained only for source-native migration
compatibility. The experimental typed semantic AST follows separate
compiler/execution workflows in `@honua/sdk-js/query-planner`; it is not
accepted by `Source.query()`.

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
- `ogcRecordsSource` — OGC API Records metadata catalog search
  (`/collections/{catalogId}/items`, queryObjectIds, stream; Records-specific
  `q` / `type` / `externalIds` and raw response access via `protocol()`).
- `stacSearchSource` — STAC API search (`/search` query, queryObjectIds,
  stream; cross-collection scope via `locator.collectionId`).

The WMS / WMTS factories cover the OGC web-map services per
`docs/protocol-capability-matrix.md`:

- `wmsSource` — WMS 1.3.0 (render + tiles via `GetMap`; canonical Honua
  service bindings may expose point-only `GetFeatureInfo` query; raw
  third-party discovery remains render-only and uses its reviewed
  `locator.raster` GetMap URL; raw multi-pixel `featureInfo()` and the
  per-layer service handles reachable via
  `Source.protocol("wms" | "wms-layer")`).
- `wmtsSource` — WMTS 1.0.0 (render + tiles through a reviewed ResourceURL
  or KVP binding for raw discovery, or canonical RESTful tiles for Honua
  descriptors; query family throws; service / layer / tileset handles reachable via
  `Source.protocol("wmts" | "wmts-layer" | "wmts-tileset")`).

`docs/wfs.md` documents the WFS 2.0 factory in the same shape:

- `wfsSource` — WFS 2.0 (query, queryAll, queryExtent, queryObjectIds,
  applyEdits, stream; FES 2.0 emission for `Query.spatialFilter` and the
  deprecated, source-native `Query.where` migration field; raw GML /
  `<wfs:Transaction>` payloads via `protocol("wfs")`).

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

## Edit Workflow Sessions

`createEditSession({ source, kind, feature, metadata, optimistic })`
is the SDK-level workflow contract for form and editor surfaces. It is
intentionally layered over `Source.applyEdits`, `Source.queryRelated`,
and `Source.attachments` rather than replacing the protocol adapters.

The session resolves fields from `source.descriptor.schema.fields` plus
caller-supplied domains, validates required / read-only / length /
coded-value / range constraints before submit, and exposes
`capabilities()` so unsupported `applyEdits`, `attachments`, and
`queryRelated` states are explicit and testable. Relationship reads use
`session.queryRelated(...)`; attachment reads and staged add / update /
delete mutations use the same source attachment namespace.

`submit()` sends the feature edit envelope first, then applies staged
attachment mutations against the committed feature id when the backend
returns one. Optimistic hooks run in this order: `optimistic.apply`
before the remote edit, `optimistic.commit` on full success, and
`optimistic.rollback` for failed or partial feature / attachment
results. `EditWorkflowSubmitResult.failures` normalizes per-row errors
from GeoServices, OGC Features, WFS, and OData into `validation`,
`conflict`, `capability`, `transport`, `server`, or `partial-failure`.
When a version / ETag / updated-at field is present (or supplied in
`metadata.conflict`), conflict failures carry that information so hosts
can present reload / merge / overwrite workflows without parsing
protocol-specific error text.

`createEditSketchWorkflow(...)` wraps the same session contract with
UI-independent sketch state. It exposes explicit support for point,
line, polygon, rectangle, circle, and buffer tools; dirty state;
undo / redo / discard; attachment staging; validation; submit; and an
optional annotation persistence hook that runs only after a successful
edit commit. Unsupported sketch, attachment, relationship, conflict, or
annotation persistence capabilities remain visible in the returned
snapshot instead of being hidden by component state.

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
`grpc` is a canonical protocol id for the shared FeatureService transport
and fixture pack; it is consumed through the client gRPC-Web transport
rather than a `Source.protocol("grpc")` adapter handle in this package.

```ts doc-test=skip reason="partial excerpt requires application host context"
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

Long-running server-side operations surface through the canonical
`IJobRun<T>` interface in `@honua/sdk-js/contract`. OGC API Processes,
GeoServices REST GPServer, and the open `honua-io/geospatial-grpc`
`ProcessService` all normalize onto the same lifecycle vocabulary:

```ts doc-test=skip reason="partial excerpt requires application host context"
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

For app code that should not know which protocol is behind a workflow,
use `HonuaProcessRunner`:

```ts doc-test=skip reason="partial excerpt requires application host context"
const ogc = client.ogcProcessRunner();
const gp = client.geoprocessingRunner("Analysis", "OverlayFacilities");
const grpc = client.geospatialGrpcProcessRunner(processServiceClient);

await ogc.execute({ processId: "buffer", inputs });
await gp.execute({ inputs: gpParameters, resultNames: ["outputLayer"] });
await grpc.execute({ plan: executionPlan, context: executionContext });
```

`createOgcProcessesAdapter`, `createGeoServicesGpAdapter`, and
`createGeospatialGrpcProcessAdapter` expose the same adapter contract for
callers that construct protocol handles outside `HonuaClient`. The
geospatial-grpc adapter is structural: it expects a generated
`ProcessService` client with `validatePlan`, `dryRunPlan`, `submitJob`,
`getJob`, `getJobResult`, and `cancelJob`, but this package does not
vendor the `honua-io/geospatial-grpc` generated process proto directly.

`IJobRun` exposes `id`, `type`, `status`, `progress`, `poll()`,
`watch()`, `results()`, and `cancel()`. The OGC API Processes 1.0
status vocabulary (`accepted`, `running`, `successful`, `failed`,
`dismissed`) is canonical. GeoServices `esriJobSubmitted` /
`esriJobExecuting` / `esriJobSucceeded` / `esriJobFailed` /
`esriJobCancelled` and geospatial-grpc `JobState` values
(`JOB_STATE_RUNNING`, `JOB_STATE_COMPLETED`, `JOB_STATE_FAILED`,
`JOB_STATE_CANCELLED`, etc.) translate onto it. Failed OGC runs reject
`results()` with `HonuaJobFailedError`, whose `message` is populated
from the server's `statusInfo.exception.message` when present and falls
back to `statusInfo.message` otherwise (to match honua-server's
`StatusInfo` DTO, which exposes only `message`).
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

## OGC API Tiles / Maps / Records / Processes / STAC

The first-party OGC adapters live alongside `HonuaOgcFeatures`:

| Conformance area | Entry point | Source protocol | Contract capabilities |
| --- | --- | --- | --- |
| OGC API Features | `client.ogcFeatures()` / `HonuaOgcFeatures` | `ogc-features` | `query`, `queryObjectIds`, `applyEdits`, `stream` |
| OGC API Tiles | `client.ogcTiles()` / `HonuaOgcTiles`, `HonuaOgcTileset` | `ogc-tiles` | `render`, `tiles` (tileset-bound when locator includes `tileMatrixSetId`; root discovery handle otherwise) |
| OGC API Maps | `client.ogcMaps()` / `HonuaOgcMaps`, `HonuaOgcCollectionMap` | `ogc-maps` | `render` |
| OGC API Records | `client.ogcRecords()` / `HonuaOgcRecords`, `HonuaOgcRecordCollection` | `ogc-records` | `query`, `queryObjectIds`, `stream` |
| OGC API Processes | `client.ogcProcesses()` / `HonuaOgcProcesses` | (no source — job runner) | `processes` from conformance negotiation, not `PROTOCOL_DEFAULT_CAPABILITIES` |
| STAC API | `client.stac()` / `HonuaStacSearch` | `stac` | `query`, `queryObjectIds`, `stream` |

OGC API Tiles and OGC API Maps are render-only — their `Source.query*`
methods throw, and renderers reach the underlying class through
`Source.adapter("ogc-tiles")` / `Source.adapter("ogc-maps")`. OGC API
Records and STAC both flow through the canonical `Source.query()` path,
but Records is metadata catalog search and STAC is asset/item search. OGC
API Processes does not register as a `Source` because its inputs are not queryable; it produces `IJobRun<T>` from
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
