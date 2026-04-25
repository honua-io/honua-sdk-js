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

| Capability | GS Feature | GS Map | GS Image | GS Geometry | GS GP | OGC Features | WFS | WMS | OData |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `query` | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | — | ✓ |
| `queryAggregate` | ✓ | ✓ | — | — | — | ◐ | — | — | — |
| `queryExtent` | ✓ | ✓ | ✓ | — | — | ◐ | ✓ | — | — |
| `queryObjectIds` | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | — | ✓ |
| `queryRelated` | ✓ | ✓ | — | — | — | — | — | — | — |
| `applyEdits` | ✓ | — | — | — | — | ✓ | ✓ | — | — |
| `attachments` | ✓ | — | — | — | — | — | — | — | — |
| `render` | — | ✓ | ✓ | — | — | — | — | ✓ | — |
| `tiles` | ◐ | ✓ | ✓ | — | — | — | — | ✓ | — |
| `sql` | ✓ | ✓ | — | — | — | — | — | — | — |
| `stream` | ✓ | ✓ | — | — | — | ✓ | — | — | — |
| `pbf` | ✓ | — | — | — | — | — | — | — | — |
| `connect` | ✓ | — | ✓ | ✓ | ✓ | — | — | — | — |
| `image` | — | — | ✓ | — | — | — | — | — | — |
| `geometry` | — | — | — | ✓ | — | — | — | — | — |
| `geoprocess` | — | — | — | — | ✓ | — | — | — | — |

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
`Source.attachments.query()` requires a non-empty
`parentIds` set of numeric ObjectIDs and rejects `AttachmentQuery.where`:
the FeatureServer `queryAttachments` endpoint filters by `objectIds`
only, returns `400 "objectIds parameter is required"` when the set is
empty, accepts only long-integer ids, and silently ignores `where`. The
adapter throws explicitly rather than make a failing wire call or let
callers think `where` filtered. Use `attachments.list(parentId)` for
the single-parent shortcut, and filter by attachment metadata
client-side over the returned `AttachmentGroups` when richer predicates
are needed.

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
Render-only. The `query` column is `—` because WMS does not expose a
feature-query path; the GetFeatureInfo response is converted to features
in the adapter under the `attachments`-adjacent path but not exposed via
`Source.query`. The adapter ticket may add a `wms-feature-info` capability
if richer reuse is needed.

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
