# Protocol × Capability Matrix

Status: implemented in `src/contract/types.ts` (`PROTOCOL_DEFAULT_CAPABILITIES`).
Update both this document and the table in code together.

The matrix below is the **default** capability set per protocol. Adapter
constructors may downgrade per source when server metadata reports a
narrower surface (e.g. a Feature Service whose `supportsStatistics` is
`false` removes `queryAggregate` from its `Capabilities` set).

`✓` = first-party support, no client-side fallback needed.
`◐` = supported only under `degraded` capability policy (client-side fallback).
`—` = not supported.

| Capability | GeoServices Feature Service | GeoServices Map Service | OGC Features | WFS | WMS | OData |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| `query` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `queryAggregate` | ✓ | ✓ | ◐ | — | — | — |
| `queryExtent` | ✓ | ✓ | ◐ | ✓ | — | — |
| `queryObjectIds` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `queryRelated` | ✓ | ✓ | — | — | — | — |
| `applyEdits` | ✓ | — | ✓ | ✓ | — | — |
| `attachments` | ✓ | — | — | — | — | — |
| `render` | — | ✓ | — | — | ✓ | — |
| `tiles` | ◐ | ✓ | — | — | ✓ | — |
| `sql` | ✓ | ✓ | — | — | — | — |
| `stream` | ✓ | ✓ | ✓ | — | — | — |
| `pbf` | ✓ | — | — | — | — | — |
| `connect` | ✓ | — | — | — | — | — |

MapLibre-native sources (`maplibre-vector`, `maplibre-raster`,
`maplibre-geojson`) are render-only and contribute `render` and (where
applicable) `tiles`. They are excluded from the table above because they
do not flow through the `Source.query` path.

## Notes by protocol

### GeoServices Feature Service
First-class. Aggregations use the `outStatistics` JSON encoding. Pagination
uses `resultOffset` / `resultRecordCount`. Streaming wraps
`HonuaFeatureLayer.queryFeaturesStream`. `pbf` is supported when the server
returns `f=pbf`; the contract accepts both encodings transparently.

### GeoServices Map Service / Map Layer
Same query semantics as Feature Service for the layers it exposes.
`render` and `tiles` come from the service-level export endpoints.
`applyEdits` and `attachments` are not supported because the Map Service
endpoint is read-only.

### OGC API Features
`query`, `queryObjectIds`, `applyEdits`, `stream` are first-party.
`queryAggregate` is degraded — the adapter materializes the result page,
applies the aggregation client-side, and stamps `degraded` on the
`Result`. `queryExtent` is approximated from the collection metadata's
`extent.spatial.bbox[0]`. `queryRelated`, `attachments`, and `pbf` are
out-of-scope for the OGC standard.

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
4. If a server-side flag (e.g. `supportsStatistics`) changes capability
   per source, the adapter constructor must override the descriptor's
   `capabilities` set. Document the override in the adapter's source
   file and add a unit test.
