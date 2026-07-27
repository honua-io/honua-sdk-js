# Protocol × Capability Matrix

<!-- support-manifest:protocol-matrix:start -->
Status: generated from [`config/support-manifest.v1.json`](../config/support-manifest.v1.json); do not edit this section by hand.

Native (`✓`) claims mirror the default capability set per protocol; per-source
metadata may narrow them at runtime. Client-fallback (`◐`) claims are explicit
opt-in paths and are not protocol defaults. An absent operation is explicitly
`unsupported`; capability misses throw `HonuaCapabilityNotSupportedError`
rather than returning empty data.

- `✓` supported with native execution
- `◐` supported through an explicit client fallback
- `β` beta
- `◇` experimental
- `†` deprecated
- `F` facade-required
- `—` unsupported

| Capability | gRPC | GS Feature | GS Map | GS Image | GS Geometry | GS GP | OGC Features | OGC Tiles | OGC Maps | OGC Records | STAC | WFS | WMS | WMTS | OData | PMTiles | GeoParquet | MapLibre vector | MapLibre raster | MapLibre GeoJSON |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `query` | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | ◇ | — | — | — |
| `queryAggregate` | ✓ | ✓ | ✓ | — | — | — | ◐ | — | — | — | — | — | — | — | — | — | ◇ | — | — | — |
| `spatialAggregate` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `queryExtent` | ✓ | ✓ | ✓ | ✓ | — | — | ◐ | — | — | — | — | ✓ | — | — | — | — | — | — | — | — |
| `queryObjectIds` | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | — | — | ✓ | ✓ | ✓ | — | — | ✓ | — | — | — | — | — |
| `queryRelated` | — | ✓ | ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `applyEdits` | ✓ | ✓ | — | — | — | — | ✓ | — | — | — | — | ✓ | — | — | ✓ | — | — | — | — | — |
| `attachments` | — | ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `render` | — | — | ✓ | ✓ | — | — | — | ✓ | ✓ | — | — | — | ✓ | ✓ | — | — | — | ✓ | ✓ | — |
| `tiles` | — | ◐ | ✓ | ✓ | — | — | — | ✓ | — | — | — | — | ✓ | ✓ | — | ✓ | — | ✓ | ✓ | — |
| `sql` | — | ✓ | ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `stream` | ✓ | ✓ | ✓ | — | — | — | ✓ | — | — | ✓ | ✓ | ✓ | — | — | ✓ | — | ◇ | — | — | — |
| `pbf` | — | ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `image` | — | — | — | ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `geometry` | — | — | — | — | ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `geoprocess` | — | — | — | — | — | ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `processes` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

### Generated claim evidence

Every non-unsupported operation claim maps to executable evidence and a freshness
policy in the manifest.

| Protocol | Operations | Status | Environment | Execution mode | Evidence |
| --- | --- | --- | --- | --- | --- |
| `grpc` | `query`, `queryAggregate`, `queryExtent`, `queryObjectIds`, `applyEdits`, `stream` | `supported` | `honua-facade` | `native` | [fixture: contract-conformance](../test/contract/conformance.test.ts)<br>[conformance: grpc-conformance](../test/conformance/feature-service.conformance.ts) |
| `geoservices-feature-service` | `query`, `queryAggregate`, `queryExtent` | `supported` | `protocol-adapter` | `native` | [fixture: contract-conformance](../test/contract/conformance.test.ts) |
| `geoservices-feature-service` | `queryObjectIds`, `queryRelated`, `applyEdits`, `attachments` | `supported` | `protocol-adapter` | `native` | [fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts) |
| `geoservices-feature-service` | `sql` | `supported` | `protocol-adapter` | `native` | [fixture: core-client-fixtures](../test/core-client.test.ts) |
| `geoservices-feature-service` | `stream` | `supported` | `protocol-adapter` | `native` | [fixture: contract-conformance](../test/contract/conformance.test.ts)<br>[fixture: honua-surface-fixtures](../test/honua-surface.test.ts) |
| `geoservices-feature-service` | `pbf` | `supported` | `protocol-adapter` | `native` | [fixture: core-client-fixtures](../test/core-client.test.ts) |
| `geoservices-feature-service` | `tiles` | `supported` | `protocol-adapter` | `client-fallback` | [fixture: query-tiles-fixtures](../test/contract/query-tiles.test.ts) |
| `geoservices-map-service` | `query`, `queryAggregate`, `queryExtent` | `supported` | `protocol-adapter` | `native` | [fixture: contract-conformance](../test/contract/conformance.test.ts)<br>[fixture: honua-surface-fixtures](../test/honua-surface.test.ts) |
| `geoservices-map-service` | `queryObjectIds`, `queryRelated` | `supported` | `protocol-adapter` | `native` | [fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts)<br>[fixture: honua-surface-fixtures](../test/honua-surface.test.ts) |
| `geoservices-map-service` | `render` | `supported` | `protocol-adapter` | `native` | [fixture: honua-surface-fixtures](../test/honua-surface.test.ts) |
| `geoservices-map-service` | `tiles` | `supported` | `protocol-adapter` | `native` | [fixture: connect-fixtures](../test/connect.test.ts)<br>[fixture: tile-layer-fixtures](../test/tile-layer-compat.test.ts) |
| `geoservices-map-service` | `sql` | `supported` | `protocol-adapter` | `native` | [fixture: honua-surface-fixtures](../test/honua-surface.test.ts) |
| `geoservices-map-service` | `stream` | `supported` | `protocol-adapter` | `native` | [fixture: contract-conformance](../test/contract/conformance.test.ts)<br>[fixture: honua-surface-fixtures](../test/honua-surface.test.ts) |
| `geoservices-image-service` | `query`, `queryExtent`, `queryObjectIds` | `supported` | `protocol-adapter` | `native` | [fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts) |
| `geoservices-image-service` | `image`, `render` | `supported` | `protocol-adapter` | `native` | [fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts) |
| `geoservices-image-service` | `tiles` | `supported` | `protocol-adapter` | `native` | [fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts) |
| `geoservices-geometry-service` | `geometry` | `supported` | `protocol-adapter` | `native` | [fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts) |
| `geoservices-gp-service` | `geoprocess` | `supported` | `protocol-adapter` | `native` | [fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts)<br>[fixture: geoprocessing-job-run-fixtures](../test/contract/geoprocessing-job-run.test.ts)<br>[fixture: process-runner-fixtures](../test/process-runner.test.ts) |
| `ogc-features` | `query`, `queryObjectIds`, `applyEdits`, `stream` | `supported` | `protocol-adapter` | `native` | [fixture: ogc-features-fixtures](../test/contract/ogc-features-backend-agnostic.test.ts) |
| `ogc-features` | `queryAggregate`, `queryExtent` | `supported` | `protocol-adapter` | `client-fallback` | [fixture: contract-conformance](../test/contract/conformance.test.ts) |
| `ogc-tiles` | `render`, `tiles` | `supported` | `protocol-adapter` | `native` | [fixture: ogc-tiles-fixtures](../test/connect-ogc-tiles.test.ts)<br>[live: live-conformance](../scripts/live-conformance-evidence.mjs) |
| `ogc-maps` | `render` | `supported` | `protocol-adapter` | `native` | [fixture: ogc-maps-fixtures](../test/connect-ogc-maps.test.ts)<br>[live: live-conformance](../scripts/live-conformance-evidence.mjs) |
| `ogc-records` | `query` | `supported` | `protocol-adapter` | `native` | [fixture: ogc-records-fixtures](../test/connect-ogc.test.ts)<br>[live: live-conformance](../scripts/live-conformance-evidence.mjs) |
| `ogc-records` | `queryObjectIds`, `stream` | `supported` | `protocol-adapter` | `native` | [fixture: ogc-records-fixtures](../test/connect-ogc.test.ts) |
| `stac` | `query`, `queryObjectIds`, `stream` | `supported` | `protocol-adapter` | `native` | [fixture: stac-fixtures](../test/contract/stac-backend-agnostic.test.ts) |
| `wfs` | `query`, `queryExtent`, `queryObjectIds`, `applyEdits`, `stream` | `supported` | `protocol-adapter` | `native` | [fixture: wfs-fixtures](../test/contract/wfs-backend-agnostic.test.ts) |
| `wms` | `render`, `tiles`, `query` | `supported` | `protocol-adapter` | `native` | [fixture: wms-fixtures](../test/contract/wms.test.ts) |
| `wmts` | `render`, `tiles` | `supported` | `protocol-adapter` | `native` | [fixture: wmts-fixtures](../test/contract/wmts.test.ts) |
| `odata` | `query`, `queryObjectIds`, `stream`, `applyEdits` | `supported` | `protocol-adapter` | `native` | [fixture: odata-fixtures](../test/contract/odata-backend-agnostic.test.ts) |
| `pmtiles` | `tiles` | `supported` | `client-only` | `native` | [fixture: pmtiles-fixtures](../test/pmtiles-contract.test.ts) |
| `geoparquet` | `query`, `queryAggregate`, `stream` | `experimental` | `client-only` | `native` | [fixture: geoparquet-fixtures](../test/geoparquet-source.test.ts) |
| `maplibre-vector` | `render` | `supported` | `client-only` | `native` | [fixture: maplibre-automatic-source-fixtures](../test/automatic-source-strategy.test.ts)<br>[integration: maplibre-automatic-browser](../test/playwright/automatic-source-workflow.spec.mjs) |
| `maplibre-vector` | `tiles` | `supported` | `client-only` | `native` | [fixture: maplibre-automatic-source-fixtures](../test/automatic-source-strategy.test.ts) |
| `maplibre-raster` | `render` | `supported` | `client-only` | `native` | [fixture: maplibre-raster-source-fixtures](../test/raster-source-strategy.test.ts)<br>[integration: maplibre-automatic-browser](../test/playwright/automatic-source-workflow.spec.mjs) |
| `maplibre-raster` | `tiles` | `supported` | `client-only` | `native` | [fixture: maplibre-raster-source-fixtures](../test/raster-source-strategy.test.ts) |
<!-- support-manifest:protocol-matrix:end -->

MapLibre-native and PMTiles sources are included in the generated table even
though they do not flow through the `Source.query` path. GeoParquet is the
experimental DuckDB-WASM-backed `Source` from `@honua/sdk-js/geoparquet`;
envelope filters push down to `ST_Intersects`, while non-envelope filters reduce
to their bounding box and are reported through `Result.degraded`.

`maplibre-vector` and `maplibre-raster` are executable descriptor strategies
with release-gated renderer coverage. `maplibre-geojson` remains a reserved
protocol identifier with no positive default capability: the runtime can load
an inline MapLibre `type: "geojson"` source, but the automatic/app descriptor
path does not implement that protocol today.

`spatialAggregate` is an indexed analytics capability rather than the
field-statistics `queryAggregate` path. No protocol receives it by default. A
source may advertise it only after backend metadata confirms an indexed
aggregation implementation for that source.

## Notes by protocol

### gRPC FeatureService
Canonical transport shared across the SDKs and generated from the
`geospatial-grpc` FeatureService definitions. The default capability set is
`query`, `queryAggregate`, `queryExtent`, `queryObjectIds`, `applyEdits`, and
`stream`. In JS, gRPC-Web is selected on `HonuaClient` with
`transport: "grpc-web"`; it is not exposed as a `Source.protocol("grpc")`
adapter handle — `buildBuiltInSource` resolves a `protocol: "grpc"`
descriptor onto the same `HonuaFeatureLayer` used by
`geoservices-feature-service`, which transparently routes `queryFeatures`
over gRPC-Web when the client's transport is configured that way.

`connect({ endpoint, protocol: "grpc" })` discovers a canonical FeatureServer
URL through the same REST service/layer metadata `geoservices-feature-service`
discovery uses (the generated `FeatureService` proto has no separate
descriptor RPC), deriving capabilities through the identical algorithm and
additionally executing one bounded `QueryFeatures` RPC per layer over the
gRPC-Web transport to verify the facade's read path agrees with the
REST-declared schema before advertising `query` / `stream` — a disagreement
throws `protocol-mismatch`; a transient probe failure narrows those two
capabilities without failing discovery. `protocol: "grpc"` is never inferred
by `protocol: "auto"` (the identical URL is ambiguous between REST and gRPC
transport intent) and only resolves against FeatureServer semantics —
MapServer / ImageServer have no gRPC query surface.

### GeoServices Feature Service
First-class. Aggregations set `outStatistics`, `groupByFieldsForStatistics`,
and `returnGeometry=false` as top-level fields on the translated
`QueryFeaturesRequest` so both the REST serializer and the gRPC-Web
adapter pick them up (they are not stashed in `extraParams`, which the
gRPC path would silently drop). Pagination uses `resultOffset` /
`resultRecordCount`. Streaming wraps
`HonuaFeatureLayer.queryFeaturesStream`; the adapter derives `pageSize`
from `Query.pagination.limit` so `source.stream({ pagination: { limit } })`
yields pages of at most `limit` rows instead of the core helper's
default 2000. `pbf` is supported when the server returns `f=pbf`; the
contract accepts both encodings transparently.

### GeoServices Map Service / Map Layer
Same query semantics as Feature Service for the layers it exposes
(including the root-level aggregation encoding and `pagination.limit`
→ `pageSize` bridge for `stream()`). `render` and `tiles` come from
the service-level export endpoints. `applyEdits` and `attachments` are
not supported because the Map Service endpoint is read-only —
`Source.applyEdits()` and `Source.attachments.*` throw
`HonuaCapabilityNotSupportedError` so a mixed-source app does not
silently drop the edits. `Source.queryObjectIds()` and
`Source.queryRelated()` round-trip through the same canonical envelopes
as the FeatureServer adapter.

### GeoServices Image Service
The Image Service adapter wraps Honua Server's ImageServer endpoints
(see `feature-server-matrix.md`'s sibling
`image-server-matrix.md`). `Source.query()` returns the raster catalog
as canonical features (one row per raster, footprint geometry on each).
`Source.queryAll()` drains pages from the catalog endpoint internally
(`resultOffset` / `resultRecordCount`) and uses a `limit + 1` lookahead
row to stamp `exceededTransferLimit: true` when the cap is hit, mirroring
the FeatureServer / OGC `queryAll` semantics. `Source.queryExtent()` and
`Source.queryObjectIds()` reuse the same catalog endpoint with the
standard GeoServices shaping flags (`returnExtentOnly`, `returnIdsOnly`).
Tile URLs come from
`Source.protocol("geoservices-image-service").tileUrl(level, row, col)`.
`exportImage`, `identify`, `legend` live on the same
`HonuaImageService` typed escape hatch — these protocol-specific
operations are not on the canonical `Source` because their request
shapes (mosaic rule, rendering rule, pixel size, raster function chains)
are ImageServer-specific. The wrapper accepts both `GET` (params on the
query string) and `POST` (form-encoded body) per request; `POST` is the
correct mode when payload size or proxy URL limits would truncate a
`GET` URL. The catalog endpoint does not honor `Query.spatialFilter`,
`Query.orderBy`, or `Query.outFields`, so the adapter rejects those
fields explicitly rather than silently widening the result; use
`Query.where` to constrain the catalog or move to a FeatureServer
source for richer query semantics. `applyEdits`, `attachments`,
`queryRelated`, `queryAggregate`, and `stream` are intentionally absent
from the default capability set; the canonical methods throw
`HonuaCapabilityNotSupportedError` rather than silently no-op.

### GeoServices Geometry Service
Geometry Service is a stateless utility — it does not host features —
so the canonical query family throws on every method. The default
capabilities advertise only `geometry`. Operations
(`buffer`, `simplify`, `project`, `intersect`, `union`, `clip`,
`difference`) live behind
`Source.protocol("geoservices-geometry-service")` on a
`HonuaGeometryService` instance whose request shapes match the routes
in `honua-server/docs/gis/geometry-service-matrix.md`. The wrapper
targets the `EndpointRegistry` prefix
`/rest/services/Utilities/Geometry/GeometryServer/<op>` (the canonical
Esri Utilities path); `POST` requests submit form-encoded bodies (the
default), `GET` keeps params in the query string. Operations the server
does not implement (`autoComplete`, `convexHull`, `cut`, `densify`,
etc.) intentionally have no wrapper.

### GeoServices GP Service
GP Services run async tasks rather than hosting features. The default
capabilities advertise only `geoprocess`; the canonical
query family throws. Task lifecycle — `submitJob`, `jobStatus`,
`cancelJob`, `jobResult` — lives behind
`Source.protocol("geoservices-gp-service")` on a
`HonuaGeoprocessingService` instance. The service id and task name come
from `SourceLocator.serviceId` / `SourceLocator.taskName` so a single
descriptor uniquely identifies a task without leaking task parameters
into the canonical descriptor shape. `createDataset` rejects descriptors
that advertise `geoprocess` without a `locator.taskName` because Honua
Server publishes the lifecycle routes only under
`/rest/services/<serviceId>/GPServer/<taskName>/...`.

GeoServices GPServer also participates in the unified process runner:
`client.geoprocessingRunner(serviceId, taskName)` returns a
`HonuaProcessRunner` that submits GP parameters and exposes the same
`IJobRun` lifecycle as OGC API Processes and geospatial-grpc
ProcessService clients.

### Geospatial gRPC Process Service
The open `honua-io/geospatial-grpc` protocol defines
`geospatial.v1.ProcessService` with `ValidatePlan`, `DryRunPlan`,
`ExecutePlan`, `ExecutePlanStream`, `SubmitJob`, `GetJob`,
`GetJobResult`, and `CancelJob`. The JS SDK keeps the adapter structural
because generated process proto lives outside this package today:
`client.geospatialGrpcProcessRunner(processServiceClient)` accepts a
generated Connect client and normalizes `JobState` values onto
`IJobRun`. `JOB_STATE_COMPLETED` maps to `successful`,
`JOB_STATE_FAILED` to `failed`, `JOB_STATE_CANCELLED` to `dismissed`,
and draft/clarification/validated/approval states map to `accepted`.

### OGC API Tiles
Render-only adapter. `tiles` and `render` are the first-party capabilities; the
canonical `Source.query*` family throws `HonuaCapabilityNotSupportedError`
because the conformance class is tile-fetch, not feature-query. The
canonical tile path is `/collections/{id}/tiles/{tms}/{z}/{y}/{x}`;
tile-matrix-set discovery uses `/tileMatrixSets` and `/tileMatrixSets/{id}`.
Styled-tile access (OGC `/styles/{styleId}/tiles/...`) is part of the
standard but is not exposed by honua-server today, so the SDK does not
synthesize that route.

`Source.adapter("ogc-tiles")` returns a `HonuaOgcTileset` bound to
`(collectionId, tileMatrixSetId)` when both are set in the locator; when
only `collectionId` is set, the adapter falls back to the root
`HonuaOgcTiles` handle so callers can discover which tile-matrix-sets
the server advertises before rebinding.

### OGC API Maps
Render-only adapter. `render` is the first-party capability; same
escape-hatch model as Tiles. `Source.adapter("ogc-maps")` returns either
the dataset-level `HonuaOgcMaps` (when `locator.collectionId` is unset)
or a `HonuaOgcCollectionMap` bound to the descriptor's collection +
optional style. The wire path is
`/maps[/collections/{id}][/styles/{styleId}]/map`; bbox / crs / format
flow through query parameters. The `format` field is normalized to the
server's short-name token (`png`, `jpeg`, `jpg`, `tiff`, `tif`) before
it is written to `f=`; media-type aliases (`image/png`, etc.) are
accepted for ergonomics and translated. The public request envelope has
no `filter` field because honua-server's Maps request model has none.

### OGC API Processes
No `Source` adapter — Processes is a job runner, not a queryable source.
`HonuaClient.ogcProcesses().execute(...)` returns the canonical
`IJobRun<T>` (the same interface every other long-running operation in
the SDK speaks). The implementation polls `/jobs/{jobId}` until
terminal, fetches `/jobs/{jobId}/results` on `successful`, and maps
failure terminals onto `JobSnapshot.error`: it prefers
`statusInfo.exception` (OGC Processes Part 1 vocabulary) and falls back
to `statusInfo.message` so honua-server's single-`message` failure text
still surfaces through `HonuaJobFailedError.message`. `cancel()` issues
`DELETE /jobs/{jobId}` and is idempotent only on the documented benign
paths: 404 (job gone) returns the cached status; 409 with problem-details
title `"Cannot dismiss completed job"` triggers a follow-up GET and
returns the authoritative terminal status — but only if the poll confirms
a terminal state, otherwise the original 409 is rethrown. The
non-benign 409 titles `"Dismiss could not be confirmed"` (backend
dismissal unconfirmed) and `"Cancellation not supported"` (backend
lacks dismissal capability) are rethrown verbatim. The canonical
`processes` capability is part of `CAPABILITIES` and is returned by
`negotiateOgcCapabilities("ogc-processes", conformance)`; it is
intentionally absent from `PROTOCOL_DEFAULT_CAPABILITIES` because there
is no `ogc-processes` `Source` protocol.

### OGC API Records
Metadata-catalog adapter. `query`, `queryObjectIds`, and `stream` are
first-party capabilities over `/ogc/records/collections/{catalogId}/items`.
The direct `client.ogcRecords()` surface exposes Records-specific query
parameters (`q`, `type`, `externalIds`, `datetime`, `bbox`, `ids`,
`profile`) and raw response access for HTML/JSON/profile negotiation.
The canonical `Source.query` path maps `Query.where` to CQL2 `filter`
and `spatialFilter` envelopes to Records `bbox`; aggregation, edits,
attachments, related records, and extent-only queries are not advertised.
Records describes metadata about resources and remains separate from STAC
asset search and Honua admin/control-plane metadata APIs.

### STAC API
STAC piggy-backs on OGC API Features for items but adds a
cross-collection `/search` endpoint. The canonical `Source.query` uses
`/search` (GET by default; opt into POST with `usePost: true`). Both
the GET and POST paths serialize `intersects` (as JSON on GET, raw on
POST) and `fields` (as a CSV with `-` prefixes on GET, structured on
POST) so caller-supplied geometry constraints and selections are not
silently dropped. `spatialFilter` translates to STAC `bbox` only —
`intersects` geometry support requires CQL2 and is left to a downstream
extension. Paging follows the server's `rel=next` link: honua-server
emits `?offset=N` on the href and the adapter parses that numeric
offset; non-Honua STAC servers that emit an opaque `?next=…` token
remain supported as a fallback. `Query.pagination.offset` propagates
through to the STAC `offset` parameter on the initial request.
`queryAggregate` and `queryExtent` are not advertised. STAC's
collection-scoping is handled via `locator.collectionId`; the adapter
forwards it as the `collections=[id]` parameter on the wire.

### OGC API Features
`query`, `queryObjectIds`, `applyEdits`, `stream` are first-party.
OGC has no batch edit endpoint, so `applyEdits` fans out to per-item
`createItem` / `replaceItem` / `deleteItem` calls and forwards
`EditEnvelope.signal` to every request — aborting the signal cancels
every operation that has not yet been issued, while operations already
in flight resolve into per-item failures on the returned `EditResult`.
`queryAll()` requests `limit + 1` rows from `itemsAll()` when the caller
caps the result with `Query.pagination.limit` so the adapter can stamp
`exceededTransferLimit: true` when more records exist (mirroring the
GeoServices lookahead-row pattern). `queryAggregate` is degraded —
`Source.query({ aggregation })` aggregates client-side over the returned
page, while `Source.queryAggregate()` drains every page first and then
aggregates. Both stamp a `queryAggregate` `DegradedReason` on the
`Result` so downstream views can flag the number as non-authoritative.
`queryExtent` is also degraded: an unfiltered `queryExtent()` with no
`outSr` returns the collection metadata's `extent.spatial.bbox[0]`
shortcut, while a filtered request (`where` or `spatialFilter`) — or
any request that sets `outSr` — drains `itemsAll()` and computes the
bbox client-side over matching features. The `outSr` carve-out exists
because the metadata bbox is frozen in the collection's native CRS
(typically CRS84) and the OGC `/collections/{id}` endpoint does not
accept a target CRS, so reusing the shortcut when the caller asked for
a different CRS would silently return the wrong coordinates.
`queryExtent` returns `{ extent, count? }` and does not carry a
`degraded` array. Only `spatialFilter.geometryType =
"esriGeometryEnvelope"` is translated (to the OGC `bbox` query param);
other geometry types would require CQL2, which the adapter does not
yet emit, so they throw rather than silently drop the constraint.
Likewise, only `spatialRel` values of `esriSpatialRelIntersects` or
`esriSpatialRelEnvelopeIntersects` are accepted — the OGC `bbox`
parameter is defined as an envelope-intersects predicate (OGC
17-069r4 §7.15.3), so `contains`/`within`/`crosses`/etc. throw rather
than silently widen to bbox semantics. `queryRelated`, `attachments`,
and `pbf` are out-of-scope for the OGC standard.

### WFS
First-party WFS 2.0 adapter (`wfsSource`); see [`wfs.md`](./wfs.md) for
the full reference. `query` / `queryAll` / `stream`
all route through `GetFeature` after a one-time `GetCapabilities`
negotiation; `Query.where` compiles to FES 2.0 (comparison, `IN`,
`BETWEEN`, `LIKE`, `IS NULL`, boolean combinators, parenthesization), and
`Query.spatialFilter` becomes either a KVP `bbox=` for envelope-only
requests or a `<fes:Filter>` for everything else (envelope, point,
polygon, polyline). Filters longer than ~7 KB switch to POST GetFeature
with the `<fes:Filter>` body. Anything richer than the supported subset
(subqueries, function calls, vendor extensions, curves / surfaces)
throws `HonuaCapabilityNotSupportedError("query")` rather than ship a
silent partial filter — callers reach the wire through
`Source.protocol("wfs")`.
WFS `propertyName=` drops every property the caller does not list,
including the geometry column, so `Query.outFields` and
`Query.returnGeometry` are resolved together: an `outFields` list with
`returnGeometry !== false` appends the geometry property
(`the_geom` by default) before the projection lands on the wire so
geometry survives; `returnGeometry === false` paired with an
`outFields` list emits exactly the requested fields (no geometry); a
`returnGeometry === false` request without an `outFields` list throws
`HonuaCapabilityNotSupportedError("query")` because WFS cannot
suppress geometry without enumerating non-geometry properties.
`queryExtent` prefers the per-feature-type `WGS84BoundingBox` from
`GetCapabilities` for unfiltered requests so no extra HTTP traffic is
issued; filtered or `outSr`-bearing requests drain every matching
page (2000 features per page) and compute the bbox client-side,
ignoring caller pagination, `Query.outFields`, and
`Query.returnGeometry` so geometry is preserved on every drained
page and the returned extent covers the full matching set.
`queryObjectIds` has no interoperable server-side ids-only mode, so the
adapter drains the matching set in 2000-feature pages and projects each
GeoJSON `id`. The drain strips `Query.outFields` and
`Query.returnGeometry` (the GeoJSON `id` is read from each feature's
top-level field, so neither knob affects the result) so the request
cannot push the geometry property onto the wire and a caller-supplied
`returnGeometry: false` cannot trip the field-projection guard.
`Query.pagination.limit` caps the global id count (callers can stop
the drain without learning the server's page size) and
`Query.pagination.offset` chooses where the drain starts.
`pagination.limit === 0` is treated as an explicit zero cap across
`query`, `stream`, and `queryObjectIds` (each short-circuits before
the wire call); `queryAll` still issues a single 1-row lookahead so
`exceededTransferLimit` can flip when more records exist — matching
the `withPagingBounds` / `applyQueryAllLimit` semantics shared with
GeoServices and OGC Features.
Content negotiation prefers `application/geo+json` /
`application/json` when the server's `OperationsMetadata`
advertises it; if only GML is offered the canonical `query()` throws
and callers reach the GML payload through `Source.protocol("wfs")`. GML
decoding is intentionally out of scope. `applyEdits` builds a single
`<wfs:Transaction>` POST body (`<wfs:Insert>` / `<wfs:Update>` /
`<wfs:Delete>`) and surfaces the per-handle `InsertResults` IDs onto
`EditOutcome.id`. Each `<wfs:Insert>` is stamped with a stable
`handle="add-N"` (1-based, matching `envelope.adds` order) and the
returned `<wfs:Feature handle="…">` buckets are indexed by that
handle, so reordered or omitted (`releaseAction="SOME"` partial
failure) buckets never misassign IDs to the wrong `envelope.adds[i]`;
inserts whose handle is missing from the response surface as
`{ success: false }`. The handle attribute is informational in WFS
2.0, so when no `<wfs:Feature>` carries one the adapter falls back
to the legacy positional pairing rather than dropping every id.
`rollbackOnFailure` drives the transaction `releaseAction` (`ALL` vs
`SOME`). Updates whose `id` is `undefined` / `null` are filtered out
before the transaction body is built and surface as per-item failures
(`{ success: false, error: { code: 400, description: "update.id is
required" } }`) so an unaddressed `<wfs:Update>` can never reach the
server; if every operation in the envelope is absent or malformed the
wire round-trip is skipped.
Stored-query discovery (`ListStoredQueries`) and execution
(`GetFeature?storedquery_id=...`) are reachable through
`Source.protocol("wfs")!.root.storedQuery(id).execute({ parameters })`.
Stored queries that advertise only GML (e.g. Honua Server's
`urn:ogc:def:query:OGC-WFS::GetFeatureById`) cannot be projected onto
the canonical `Source.query()` envelope; the canonical surface throws
`HonuaCapabilityNotSupportedError("query")` and points the caller at
the protocol escape hatch.
Locking (`LockFeature` / `GetFeatureWithLock`) is not exposed in the
canonical surface; callers that need it reach the wire through
`Source.protocol("wfs")`.
The capabilities XML walker refuses any document declaring
`<!DOCTYPE>` or `<!ENTITY>` to defend against XXE-class attacks.
WFS `Result.totalCount` populates from the `numberMatched` GeoJSON
field; `exceededTransferLimit` is set when `numberMatched >
features.length`.

### WMS
First-party WMS 1.3.0 adapter. `render` and `tiles` come from `GetMap`;
`query` is supported through `GetFeatureInfo` with a point spatial
filter (`Query.spatialFilter.geometryType === "esriGeometryPoint"`). The
adapter constructs a 1×1 render envelope around the requested point,
asks for `INFO_FORMAT=application/json`, and decodes the JSON response
into the canonical `Result<T>` envelope. The wire CRS is derived from
the spatial filter geometry's `spatialReference` (`latestWkid` first,
then `wkid`, then `wkt`) and falls back to `CRS:84` (the WMS 1.3.0
longitude/latitude code that preserves the canonical `(x, y)` axis
order). `Query.outSr` is intentionally not consulted on this path
because it is the **output** spatial reference, not the input CRS for
GetFeatureInfo. Non-point queries throw
`HonuaCapabilityNotSupportedError("query", "wms", id)` because WMS has
no spatial-rel semantics for envelopes / polygons; raw multi-pixel
GetFeatureInfo lives behind `Source.protocol("wms").featureInfo()`.
Other canonical `Query` fields that GetFeatureInfo cannot honor are
rejected up front rather than silently dropped: `query({ aggregation })`
throws `HonuaCapabilityNotSupportedError("queryAggregate", ...)`, and
`Query.where` / `Query.outFields` / `Query.orderBy` /
`Query.pagination.offset` / `Query.returnGeometry === false` /
`Query.outSr` throw typed `Error` messages so a mixed-source caller
cannot get an unfiltered, reprojected, or differently-shaped result.
`Query.outSr` fails fast because honua-server's WMS GetFeatureInfo
projects the response in the request CRS itself and exposes no
separate output-SR knob — callers that need a specific projection
must stamp the spatial filter geometry's `spatialReference` with the
desired CRS (the wire CRS is derived from there) or reproject the
result client-side. `Query.pagination.limit` is honored — it maps to
`FEATURE_COUNT` on the wire.

`Source.protocol("wms-layer")` is registered only when
`locator.typeName` parses to a single non-empty layer token because
`HonuaWmsLayer` is a single-layer handle (its `describe()` resolves
exactly one `<Layer>` from the parsed Capabilities). Multi-layer
composites (`typeName: "a,b"`) keep `Source.protocol("wms-layer")`
unset and route through the service-level `Source.protocol("wms")`
handle, which can target the composite verbatim via
`featureInfo()` / `map()`.

Styled-map selection enumerates per-layer styles from
`HonuaWms.capabilities()` and is bound on the layer handle (`layer.map`,
`layer.featureInfo`) via the `style` parameter or descriptor
`locator.styleId`. Dimension handling (`TIME` / `ELEVATION`) flows
through the typed `WmsMapRequest` envelope; defaults come from
`Capabilities`, request overrides go on the wire. honua-server does not
implement `GetLegendGraphic` today, so the adapter raises
`HonuaCapabilityNotSupportedError` from `legend()` when the parsed
Capabilities advertise no `<GetLegendGraphic>` request element. The
gating always runs: when the caller does not pre-supply
`options.capabilities`, the handle lazy-loads them once via
`getWmsCapabilities` and caches the in-flight promise on the instance
so repeat `legend()` calls reuse the same fetch (transient failures
clear the cache so the next call retries). The `HonuaWms` parser
extracts each `<Layer>`'s own `<Name>`, `<Title>`, `<CRS>`,
`<BoundingBox>`, `<Style>`, and `<Dimension>` from the layer's direct
children only — descendant `<Layer>` subtrees are stripped before
metadata reads so child fields never leak upward into the parent (or,
through ancestor-merge, sideways into sibling layers). CRS axis
order is honored per WMS 1.3 §6.7.3.2 — `EPSG:4326` is swapped to
(lat, lon) on the wire while `CRS:84` and `EPSG:3857` keep canonical
(x, y) tuples. MapLibre integration ships through
`buildWmsRasterSourceSpec(descriptor)`, which emits a `raster` source
spec with a pre-baked KVP `tiles` template using MapLibre's runtime
`{bbox-epsg-3857}` placeholder plus validated 1–4096 literal `WIDTH` /
`HEIGHT` values equal to `tileSize`.

### WMTS
First-party WMTS 1.0.0 adapter. Render-only — `Source.query()` throws
because WMTS GetFeatureInfo is keyed on tile pixels (which doesn't fit
the canonical `Query.spatialFilter`). Capabilities expose advertised
TileMatrixSets through the typed surface; honua-server only advertises
`WebMercatorQuad` today and the parser-driven design tolerates additional
sets without a client refactor. Protocol escape hatches:
`Source.protocol("wmts")` returns the service handle,
`Source.protocol("wmts-layer")` a layer-bound handle, and
`Source.protocol("wmts-tileset")` a (layer × style × TMS) tileset handle.
`fetchWmtsTile` defaults to the RESTful route (`{layer}/{style}/{tms}/{z}/{y}/{x}.{ext}`)
because it is a single string substitution per tile and skips
`URLSearchParams`; `mode: "kvp"` is opt-in for KVP-only proxies.
The `Format` MIME → RESTful `.ext` mapping is canonical and shared
between the wire client and the MapLibre helper via
`wmtsExtensionForFormat` (`src/core/wms-types.ts`): `image/png` →
`png`, `image/jpeg` / `image/jpg` → `jpeg`, `image/webp` → `webp`;
unknown formats fall back to `png`. The same caller-supplied `format`
therefore lands on the same path extension whether the URL is composed
by `fetchWmtsTile` or `buildWmtsRasterSourceSpec`.
`request.extraParams` is honored on both routing modes — under
`mode: "kvp"` keys are merged into the query string verbatim; under
the default RESTful route the path-encoded WMTS keys (`LAYER`,
`STYLE`, `TILEMATRIXSET`, `TILEMATRIX`, `TILEROW`, `TILECOL`,
`FORMAT`, `INFOFORMAT`, `I`, `J`, plus `SERVICE` / `VERSION` /
`REQUEST`) take precedence and any conflicting `extraParams` keys
(case-insensitive) are dropped so the same URL never carries the
value twice. `buildWmtsRasterSourceSpec(descriptor)` emits a
MapLibre `raster` source spec using the same RESTful path with
`{z}/{y}/{x}` placeholders.

### OData
First-party adapter: `query`, `queryObjectIds`, `stream`, `applyEdits`.
Tabular query with `$filter`, `$select`, `$orderby`, `$top`, `$skip`,
`$expand` maps cleanly onto `Query.where`, `outFields`, `orderBy`,
`pagination`. `Query.where` accepts SQL-92 / OData `$filter` text;
the adapter rewrites a small intersection (`IS NULL` → `eq null`,
`<>` → `ne`, `=` → `eq`, plus the SQL comparison operators `>=` /
`<=` / `>` / `<` → `ge` / `le` / `gt` / `lt`) and rejects operators
the parity matrix documents as unsupported (`has`, `in`, `any`,
`all`, `cast`, `isof`) rather than letting them reach the wire.
The rewrite tokenizes single-quoted string literals (with `''`
escape sequences preserved) so values like `NAME = 'A=B'` or
`NAME = 'has'` or `NAME = 'A>B'` round-trip unchanged — rewrites
and unsupported-operator detection only run against non-literal
spans.

`Query.outFields` lowers onto OData's `$select` for plain field
names and `$expand` for navigation paths. Plain entries
(`["STATE", "ACRES"]`) become `$select=STATE,ACRES`. Dotted entries
identify a navigation property and a sub-field — `["Owner.name"]`
becomes `$expand=Owner($select=name)`, multiple sub-fields under
the same navigation share one expand entry
(`$expand=Owner($select=name,email)`), and multi-level dotted paths
nest as `$expand=Owner($expand=address($select=street))`. The same
`outFields` list can mix plain and dotted entries; each goes to the
matching query option so a server that distinguishes `$select` from
`$expand` honors both.

The descriptor locator resolves to the entity-set request path one of
two ways. SDK callers that pass `locator.entitySet` (e.g. `"Parcels"`
or the navigation path `"Layers(1)/Features"`) win unchanged. Bindings
produced by Honua Server only carry `url`, `serviceId`, and `layerId`,
so when `entitySet` is absent the adapter derives the canonical
layer-scoped path `Layers(<layerId>)/Features` from `locator.layerId`.
A descriptor that has neither field is rejected with
`createDataset: source "<id>" (odata) requires locator.entitySet or
locator.layerId`. The resolved token is the wire path used for entity
requests; CSDL metadata lookups (capabilities, key fields, schema)
key on the **unqualified entity-set name** instead — for navigation
paths that is the trailing segment, exposed as
`HonuaOdataEntitySet.entitySetName` so the lookup still hits the
`<EntitySet Name="…">` entry the server emits.

`Query.spatialFilter` translates to a `geo.intersects` / `geo.distance`
predicate against the geometry column. Only `esriSpatialRelIntersects`
/ `esriSpatialRelEnvelopeIntersects` (intersects) and
`esriSpatialRelDistance` (distance, requires `spatialFilter.distance`)
are accepted; other relations throw rather than silently widen. The
WKT literal carries the **input** geometry's SRID (resolved from
`spatialFilter.geometry.spatialReference.{wkid|latestWkid}` first,
then the metadata-declared SRID on the *selected* geometry column —
matched by name when the descriptor or metadata pinned a column, never
borrowed across columns when an entity type declares more than one
spatial field); `Query.outSr` is a request for the *output* CRS and
is not stamped onto the input WKT (the OData server has no
request-side output-CRS knob — output geometry comes back in the
column's declared SRID). The geometry
column resolves from `SourceDescriptor.schema.fields` first
(prefers a field whose canonical `type === "esriFieldTypeGeometry"`),
otherwise from the lazy `$metadata` probe (the first property typed
`Edm.Geography` / `Edm.Geometry` per CSDL parsing). For spatial
filters the adapter throws when neither declares one rather than
guess at the column name; the same resolved name is reused by
`returnGeometry === false` $select trimming and the row-to-feature
geometry split, so a schema-declared spatial column named anything
other than `Geometry` / `Geography` / `Shape` is honored end-to-end.

`Query.returnGeometry === false` keeps the geometry column off the
wire: when `outFields` is set the resolved geometry column is
filtered out of `$select`; when `outFields` is unset the adapter
derives `$select` from `$metadata` to include only non-spatial
columns. The canonical name guesses (`Geometry` / `Geography` /
`Shape`) are kept as a fallback for the `$select` filter only when
neither the descriptor schema nor `$metadata` declares a spatial
column. As a defensive backstop, the canonical `Result` drops
geometry from each feature even if the server still emitted it.

Server-driven pagination (`$skiptoken` via `@odata.nextLink`) is
consumed transparently inside `queryAll()` and `stream()`. `queryAll`
honors `Query.pagination.limit` with the GeoServices/OGC `limit + 1`
lookahead pattern (sent on the wire as `$top = limit + 1`) so
`exceededTransferLimit: true` is stamped accurately when the cap is
hit. As a belt-and-braces signal, `@odata.count > limited.length`
also sets the flag for servers that respect `$top` exactly but report
a higher matched-row total. The lookahead is added by the canonical
`Source.queryAll` only — the lower-level `HonuaOdataEntitySet.queryAll`
treats `params.top` as an exact hard cap (including `top === 0`,
which collects zero rows) so callers that already added a lookahead
row do not double-count. `queryObjectIds` projects the metadata key
field through `$select`, drains the matching set, and slices the
resulting id list to `Query.pagination.limit` (no lookahead row is
needed because the result is ids, not features, and there is no
`exceededTransferLimit` flag to stamp on `FeatureId[]`); a
`pagination.limit === 0` cap collapses to an empty array.

`applyEdits` routes adds → `POST /<entitySet>`, updates → `PATCH
/<entitySet>(<key>)` with the full canonical body, deletes → `DELETE
/<entitySet>(<key>)`. PUT is not issued — Honua Server's OData v4
parity matrix lists PUT as unsupported (PATCH-only); the documented
`PATCH with full body` path matches `PUT` replacement semantics on the
canonical surface. Composite-key entities address rows by passing the
pre-formatted key expression on `deletes: FeatureId[]` (e.g.
`"LayerId=1,ObjectId=3"`) or by populating each key field on
`updates[].attributes`. Layer-scoped paths
(`Layers(<n>)/Features`) carry the parent key (`LayerId`) in the URL
itself, so callers can — and should — pass a bare ObjectId on
`feature.id` or `deletes: FeatureId[]`; the adapter strips `LayerId`
from the entity-set key parens to produce
`/odata/Layers(<n>)/Features(<objectId>)` directly.

Exact EDM write encoding is available through the explicit
`odataSource(..., { writeEncoding: "lossless-json" })` opt-in. The option
preflights the complete edit envelope against the adapter's existing cached
`$metadata` snapshot. It preserves `Edm.Int64` and `Edm.Decimal` values as
validated JSON strings, recursively encodes complex values and collections,
uses `NaN` / `INF` / `-INF` for non-finite `Edm.Single` and `Edm.Double`
values, and formats URL keys by their declared metadata types. A body receives
`application/json;IEEE754Compatible=true` only when it contains a non-null
Int64 or Decimal; JSON `$batch` carries that media type on the individual
request part. Direct and atomic edits consume the same preflight projection.
Nesting, container breadth, and aggregate value nodes are hard-bounded;
malformed or over-budget values and keys fail locally with a bounded,
value-redacted path. When the option is omitted, the original body bytes, ordinary
`application/json` media type, and legacy key formatter are unchanged.

The codec module is lazy and memoized, so legacy/default writes do not load it.
Lossless updates reject a scalar `feature.id` that disagrees with the
metadata-encoded single key in `attributes`, and reject scalar ids altogether
for composite updates because equivalence to the named components cannot be
proved. The generic `deletes: FeatureId[]` envelope cannot carry a structured
composite identity; opted-in composite deletes therefore fail before any
direct or `$batch` request. Legacy preformatted composite delete expressions
remain available only on the unchanged legacy encoding path.

When `EditEnvelope.rollbackOnFailure === true` AND `$metadata`
advertises `Capabilities.BatchSupported`, the adapter collapses the
envelope into a single `$batch` request whose every operation carries
the same `atomicityGroup` token. Honua Server's `ODataBatchHandler`
groups requests by `request.AtomicityGroup` and rolls the entire
group back when any operation fails. The per-operation outcomes are
threaded back into the canonical `EditOutcome` buckets in the
original order. When `$batch` is not advertised, the adapter
degrades to per-call edits and stamps a `degraded[]` entry citing
`applyEdits` so downstream views can flag the result as non-atomic.

`queryAggregate`, `queryExtent`, `queryRelated`, and `attachments` are
intentionally absent from the canonical surface. Aggregation lives
behind `Source.protocol("odata").apply(...)` (`$apply` driver),
extent computation is a caller-side concern when the entity exposes
`Edm.Geography`, related navigation goes through `$expand` on the
escape-hatch `query()` (or `protocol("odata").raw(...)`), and
attachments are not in the parity matrix.

OData is the **first adapter** to implement automatic
metadata-driven capability intersection. The lazy `$metadata` fetch
on first method call parses `Capabilities.*` annotations and
intersects against the descriptor's declared `Capabilities`; declared
capabilities the service explicitly advertises as `false` raise
`HonuaCapabilityNotSupportedError` with both protocol and reason in
the message. The CSDL parser accepts both annotation shapes — inline
inside `<EntitySet>` *and* sibling `<Annotations
Target="<schema>.<container>/<entitySet>">` blocks (the form Honua
Server emits next to the `EntityContainer`) — and parses the OData
v4 capability vocabulary including `Insertable` / `Updatable` /
`Deletable` / `Searchable` / `Filterable` / `Selectable` /
`Expandable` / `Countable` plus the generic `Supported` property
records use for `ChangeTracking`. Other adapters (GeoServices
`supportsStatistics`, OGC `conformsTo`) follow the same pattern but
currently rely on caller-supplied caps; the contract doc tracks this
as the precedent for that future work.

Dialect-specific `$batch`, `$apply`, `$search`, and `$deltatoken`
operations live behind `Source.protocol("odata")` on a
`HonuaOdataEntitySet` instance:

- `metadata({ refresh? })` — cached, SDK-shaped projection of
  `$metadata` (`entitySets`, `keys`, `fields`, `capabilities`).
- `batch(operations, { atomicity })` — JSON `$batch` envelope. Pass
  `atomicity: "all"` to stamp the same `atomicityGroup` token on every
  request item so the server runs them as one change-set with rollback
  on any failure (per OData v4 §11.7.7.3 and Honua Server's
  `ODataBatchHandler`, which groups by `request.AtomicityGroup`).
  Default behavior (`"none"`) leaves the field unset so each request
  runs independently.
- `apply(transformations)` — `$apply` driver (`aggregate` / `groupby`
  / `filter` / `compute`) returning `{ rows, totalCount? }`.
- `search(text, params)` — `$search` driver returning a
  `HonuaOdataPage<T>`.
- `delta({ since? })` — async-iterable `$deltatoken` change feed; the
  final page carries `deltaLink` for the caller to persist.
- `raw(method, path, init?)` — last-resort passthrough that still
  flows through `HonuaClient.pipelineFetch` (auth headers, retry,
  timeout, interceptors, telemetry, normalized `HonuaHttpError`,
  `init.signal` propagation for caller-driven cancellation).

All HTTP traffic — including `$metadata` discovery and `raw()`
passthrough — is routed through `HonuaClient.pipelineFetch` /
`pipelineRequestJson` rather than the GeoServices-shaped
`HonuaClient.request()` helper, so the OData wire request never
carries the `f=json` parameter (Honua Server's OData validators
reject it as `InvalidQueryOption`). Auth headers, interceptors,
retry, timeout, and normalized error mapping all apply to OData the
same way they do to every other adapter.

Library posture is recorded in
[`decisions/odata-library-selection.md`](./decisions/odata-library-selection.md).

### PMTiles
Tiles-only. A PMTiles archive is a single immutable file (raster or vector
tile pyramid) on any static host or object storage. The default capability
set is `{ tiles }`, so the entire canonical query family
(`query` / `queryAll` / `queryExtent` / `queryObjectIds` / `applyEdits` /
`stream`) throws `HonuaCapabilityNotSupportedError` — an archive has no
feature-query surface. Archive metadata (bounds, min/max zoom, and vector
layer names) is inspected through the typed escape hatch:
`Source.protocol("pmtiles").describe()` (or the standalone
`describePmtilesArchive(url)` helper), which returns a normalized
`PmtilesArchiveDescription`.

The `pmtiles` package is an optional peer dependency imported lazily — a
build that never inspects or renders a PMTiles archive pays no cost. The
MapLibre runtime auto-registers the `pmtiles://` protocol on map attach
(`loadMapPackage`), so a `pmtiles` MapPackage source binding renders with no
manual `addProtocol` wiring; see [`pmtiles.md`](./pmtiles.md).

## Multi-source negotiation

When more than one source participates in a composition, the
composition supports a capability **only when every participating
source supports it**. Use `intersectCapabilities` from
`@honua/sdk-js/contract` to compute that weakest set:

```ts doc-test=compile
import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  intersectCapabilities,
} from "@honua/sdk-js/contract";

const weakest = intersectCapabilities([
  { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"] },
  { capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms },
]);
weakest.has("query"); // true
weakest.has("applyEdits"); // false — WMS lacks edits
```

The helper is structurally typed on `{ capabilities }` so it accepts
both `SourceDescriptor[]` (declared capabilities) and live `Source[]`
(post-metadata-negotiation capabilities — the OData adapter, for
example, intersects the descriptor's declared set with `$metadata`
flags on first capability-gated method).

Promising a capability the weakest source lacks is the worst possible
mixed-source failure mode (silent wrong result). The full guide and
the per-operation partitioning pattern live in
[`composition.md`](./composition.md).

## Maintaining the matrix

When you add or remove a capability for any protocol:

1. Update `PROTOCOL_DEFAULT_CAPABILITIES` in `src/contract/types.ts`.
2. Update this table.
3. Update the conformance scenario in `test/contract/` so the canonical
   tests fail the right way for the new shape.
4. Per-source downgrades are the caller's responsibility today: pass an
   intersected `Capabilities` set on `SourceDescriptor.capabilities`. When
   automatic metadata-driven downgrades land in the adapter constructors,
   document the override in the adapter's source file and add a unit test
   covering the intersected set.
5. Adapters that emit `Result.degraded[]` should populate
   `DegradedReason.sourceId` with `descriptor.id` so mixed-source fan-outs
   can attribute the degradation back to the source that emitted it.
