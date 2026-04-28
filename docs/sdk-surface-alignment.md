# Cross-SDK Surface Alignment

Status: draft contract anchor for https://github.com/honua-io/honua-sdk-js/issues/44.

The Honua SDKs should share one mental model even when each language keeps its
own naming conventions. JavaScript may use `queryAll()`, Python may use
`query_all()`, and .NET may use `QueryAllAsync()`. Those names are allowed to
differ. The semantics behind them should not.

## Canonical Semantics

Use the `@honua/sdk-js/contract` vocabulary as the current source of truth:

| Concept | Meaning |
| --- | --- |
| `Dataset` | Logical grouping of one or more sources plus compatibility checks. |
| `SourceDescriptor` | Serializable source identity: protocol, locator, capabilities, schema, and attribution. |
| `Source` | Runtime handle for the common query, edit, related-record, attachment, and escape-hatch surface. |
| `Protocol` | Stable source protocol identifier. |
| `Capability` | Stable operation capability identifier. |
| `Query` | Protocol-neutral request intent. |
| `Result` | Protocol-neutral result envelope. |
| `EditEnvelope` / `EditResult` | Protocol-neutral write envelope and result. |
| `protocol(...)` | Explicit native protocol escape hatch. |

## Language Bindings

Language bindings must be idiomatic. The binding table below is guidance for
public API names, not a byte-for-byte requirement:

| Concept | TypeScript | Python | .NET |
| --- | --- | --- | --- |
| query all records | `queryAll()` | `query_all()` | `QueryAllAsync()` |
| stream pages | `stream()` | `stream()` / `iter_*()` | `StreamAsync()` / `QueryPagesAsync()` |
| query object ids | `queryObjectIds()` | `query_object_ids()` | `QueryObjectIdsAsync()` |
| apply edits | `applyEdits()` | `apply_edits()` | `ApplyEditsAsync()` |
| return geometry | `returnGeometry` | `return_geometry` | `ReturnGeometry` |
| output fields | `outFields` | `out_fields` | `OutFields` |
| pagination | `pagination` | `pagination` / `limit` / `offset` | `Pagination` / `Limit` / `Offset` |
| native protocol escape hatch | `source.protocol(...)` | `source.protocol(...)` | `source.Protocol(...)` |

Existing SDK names can remain as aliases or facades. For example, Python's
`FeatureQuery` and .NET's `FeatureQueryRequest` can continue to exist while
new source-oriented facades converge on the same behavior.

## Stable Protocol IDs

The canonical protocol identifiers are the values exported from
`PROTOCOLS` in `src/contract/types.ts`. SDKs may accept aliases for already
shipped public names, but serialized descriptors and docs should prefer the
canonical identifiers:

- `geoservices-feature-service`
- `geoservices-map-service`
- `geoservices-image-service`
- `geoservices-geometry-service`
- `geoservices-gp-service`
- `ogc-features`
- `ogc-tiles`
- `ogc-maps`
- `stac`
- `wfs`
- `wms`
- `wmts`
- `odata`
- `maplibre-vector`
- `maplibre-raster`
- `maplibre-geojson`

## Stable Capability IDs

The canonical capability identifiers are the values exported from
`CAPABILITIES` in `src/contract/types.ts`. SDKs should gate behavior on these
semantic identifiers rather than inventing per-repo names for the same
operation.

Capability misses must be explicit. The preferred behavior is a typed SDK error
or an unsupported-capability result that names the missing capability and
protocol. Returning an empty result for an unsupported operation is not
acceptable because it is indistinguishable from a valid query with no matches.

## Query Semantics

All SDKs should preserve these query semantics even when the local request type
uses language-specific names:

- `where`: logical attribute filter. Adapters translate it to SQL-92, CQL2,
  OData `$filter`, FES, or provider-native syntax as appropriate.
- `spatialFilter` / `bbox`: spatial constraint. SDKs may expose a compact bbox
  helper, but the behavior must be documented.
- `outFields`: fields or properties to return.
- `orderBy`: provider-supported sort order.
- `pagination.offset`: records to skip before returning data.
- `pagination.limit`: record cap. `query()`, `queryAll()`, and `stream()` must
  document whether the limit is per-page or total.
- `returnGeometry`: whether returned features include geometry.
- `outSr`: requested output spatial reference when the protocol supports it.
- `signal` / cancellation token: caller-driven cancellation.

## Result Semantics

All SDKs should expose the same result facts:

- features are an array, empty when no records matched.
- each feature has an identifier when available, attributes/properties, and
  optional geometry.
- result envelopes preserve paging state (`exceededTransferLimit`,
  `hasMoreResults`, or an idiomatic alias).
- total count is present when the protocol reports it.
- field schema is present when the protocol reports it.
- extent is present for extent-only or extent-enriched queries.
- degraded results carry structured reasons with capability, protocol, and
  optional source id.
- raw/provider-native payload access remains available for advanced workflows.

## Fixture Pack

The cross-SDK fixture pack lives under
`test/fixtures/sdk-contract/semantic-contract.v1.json`. It is intentionally
JSON-only so Python and .NET can consume the same payloads without depending on
the JS test helpers.

The JS drift gate in `test/contract/sdk-contract-fixtures.test.ts` validates
that the fixture pack stays aligned with the exported JS contract registries and
with the documented result/error/degraded semantics.

Downstream SDK work should consume this fixture pack directly or mirror it with
a clear checksum/update process.
