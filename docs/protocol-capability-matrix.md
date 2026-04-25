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
| `stream` | ✓ | ✓ | — | — | — | ✓ | — | — | ✓ | ✓ | — | — | — |
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
