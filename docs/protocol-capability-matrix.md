# Protocol × Capability Matrix

Status: implemented in `src/contract/types.ts` (`PROTOCOL_DEFAULT_CAPABILITIES`).
Update both this document and the table in code together.

The matrix below is the **default** capability set per protocol. Callers
that need a narrower surface for a specific source (for example a Feature
Service whose metadata reports `supportsStatistics: false`) must intersect
the default set themselves and pass the result on
`SourceDescriptor.capabilities`. The built-in adapter constructors do not
read service metadata today; automatic metadata-driven downgrades are
tracked as future work.

This matrix spans the full shared capability vocabulary, not just the
protocol-neutral `Source` methods implemented in this ticket. Capabilities
without a canonical `Source` method today are negotiated for
`Source.adapter()` escape hatches and follow-on adapter tickets.

`✓` = first-party support, no client-side fallback needed.
`◐` = supported only under `degraded` capability policy (client-side fallback).
`—` = not supported.

| Capability | GS Feature | GS Map | GS Image | GS Geometry | GS GP | OGC Features | OGC Tiles | OGC Maps | STAC | WFS | WMS | WMTS | OData |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `query` | ✓ | ✓ | ✓ | — | — | ✓ | — | — | ✓ | ✓ | ✓ | — | ✓ |
| `queryAggregate` | ✓ | ✓ | — | — | — | ◐ | — | — | — | — | — | — | — |
| `queryExtent` | ✓ | ✓ | ✓ | — | — | ◐ | — | — | — | ✓ | — | — | — |
| `queryObjectIds` | ✓ | ✓ | ✓ | — | — | ✓ | — | — | ✓ | ✓ | — | — | ✓ |
| `queryRelated` | ✓ | ✓ | — | — | — | — | — | — | — | — | — | — | — |
| `applyEdits` | ✓ | — | — | — | — | ✓ | — | — | — | ✓ | — | — | — |
| `attachments` | ✓ | — | — | — | — | — | — | — | — | — | — | — | — |
| `render` | — | ✓ | ✓ | — | — | — | ✓ | ✓ | — | — | ✓ | ✓ | — |
| `tiles` | ◐ | ✓ | ✓ | — | — | — | ✓ | — | — | — | ✓ | ✓ | — |
| `sql` | ✓ | ✓ | — | — | — | — | — | — | — | — | — | — | — |
| `stream` | ✓ | ✓ | — | — | — | ✓ | — | — | ✓ | — | — | — | — |
| `pbf` | ✓ | — | — | — | — | — | — | — | — | — | — | — | — |
| `connect` | ✓ | — | ✓ | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `image` | — | — | ✓ | — | — | — | — | — | — | — | — | — | — |
| `geometry` | — | — | — | ✓ | — | — | — | — | — | — | — | — | — |
| `geoprocess` | — | — | — | — | ✓ | — | — | — | — | — | — | — | — |
| `processes` | — | — | — | — | — | — | — | — | — | — | — | — | — |

MapLibre-native sources (`maplibre-vector`, `maplibre-raster`,
`maplibre-geojson`) are render-only and contribute `render` and (where
applicable) `tiles`. They are excluded from the table above because they
do not flow through the `Source.query` path.

## Notes by protocol

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
capabilities advertise only `geometry` and `connect`. Operations
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
capabilities advertise only `geoprocess` and `connect`; the canonical
query family throws. Task lifecycle — `submitJob`, `jobStatus`,
`cancelJob`, `jobResult` — lives behind
`Source.protocol("geoservices-gp-service")` on a
`HonuaGeoprocessingService` instance. The service id and task name come
from `SourceLocator.serviceId` / `SourceLocator.taskName` so a single
descriptor uniquely identifies a task without leaking task parameters
into the canonical descriptor shape. `createDataset` rejects descriptors
that advertise `geoprocess` without a `locator.taskName` because Honua
Server publishes the lifecycle routes only under
`/rest/services/<serviceId>/GPServer/<taskName>/...`; descriptors that
advertise only `connect` (service-root metadata probe) may omit the
task name.

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
Read + edit, no aggregation, no relates. `queryExtent` is supported via
`getCapabilities` extent metadata and per-feature-type bounding boxes.
Adapter ticket should map `Query.where` to OGC Filter Encoding XML.

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
`{bbox-epsg3857}` / `{width}` / `{height}` placeholders.

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
Tabular query with $filter, $select, $orderby, $top, $skip — maps cleanly
to `Query.where`, `outFields`, `orderBy`, `pagination`. Geometry is
modelled when the entity exposes a GeoJSON or Edm.Geography column. No
aggregation in the canonical surface (OData `$apply` is too dialect-specific
for protocol-neutral consumers; downstream tickets can expose it through
the adapter escape hatch).

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
