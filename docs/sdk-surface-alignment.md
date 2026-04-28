# Cross-SDK Surface Alignment

Status: pending review for https://github.com/honua-io/honua-sdk-js/issues/44.
Once the PR merges this becomes the canonical reference for downstream Python
and .NET SDK alignment work; flip the status line to `reviewed` at that point.

The Honua SDKs should share one mental model even when each language keeps its
own naming conventions. JavaScript may use `queryAll()`, Python may use
`query_all()`, and .NET may use `QueryAllAsync()`. Those names are allowed to
differ. The semantics behind them must not.

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
| `MapBinding` | Source → renderer-layer binding (used by `MapPackage` round-trips). |
| `protocol(...)` | Explicit native protocol escape hatch. |

These are the canonical nouns pinned in
[`test/fixtures/sdk-contract/semantic-contract.v1.json`](../test/fixtures/sdk-contract/semantic-contract.v1.json)
and validated by the drift gate
([`test/contract/sdk-contract-fixtures.test.ts`](../test/contract/sdk-contract-fixtures.test.ts)).
Renaming a noun without updating both sites trips CI.

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
`PROTOCOLS` in `src/contract/types.ts`. Serialized descriptors and docs should
prefer the canonical identifiers; SDKs may accept short or legacy aliases for
already-shipped public names by normalizing on read through the
`protocolAliases` map in the fixture pack:

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
operation. Default capability sets per protocol live in
`PROTOCOL_DEFAULT_CAPABILITIES` and are mirrored in
[`docs/protocol-capability-matrix.md`](./protocol-capability-matrix.md).

Capability misses must be explicit. The required behavior is a typed SDK error
that names the missing capability and protocol (`HonuaCapabilityNotSupportedError`
in JS; equivalent typed errors in Python and .NET). Returning an empty result
for an unsupported operation is not acceptable because it is indistinguishable
from a valid query with no matches.

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

## Backwards Compatibility And Deprecation Policy

The RFC aligns semantics — it does not delete shipped APIs.

- **Existing public names are preserved** as aliases or facades over the
  canonical surface. JS keeps `Source.adapter()` as a documented alias of
  `Source.protocol()`; Python keeps `FeatureQuery` and friends; .NET keeps
  `FeatureQueryRequest` and friends. Each binding may add the canonical name
  alongside the legacy name without renaming the legacy name.
- **Deprecation requires a documented removal timeline.** A binding that
  introduces a canonical alternative may mark the legacy name deprecated and
  remove it at the next major version, never sooner. The deprecation note
  must point at the canonical replacement and (where applicable) at this RFC.
- **Protocol aliases normalize on read.** Short and legacy protocol names that
  already shipped in any SDK appear in the `protocolAliases` map of
  [`semantic-contract.v1.json`](../test/fixtures/sdk-contract/semantic-contract.v1.json).
  SDKs accept those aliases as input, but every serialized descriptor — fixture,
  server `SourceBinding`, telemetry, log line — emits the canonical id.
  Adding a new alias is backwards-compatible; renaming a canonical id is not.
- **Capability behavior may not silently change.** Adding a capability to a
  protocol is backwards-compatible. Removing one (or downgrading from
  first-party to client-side fallback) is a breaking change and must ship in a
  major version with a `degraded[]` migration path documented in the
  per-protocol notes of `docs/protocol-capability-matrix.md`.
- **`canonicalNouns` is part of the contract.** Renaming `Dataset`,
  `SourceDescriptor`, `Source`, `Protocol`, `Capability`, `Query`, `Result`,
  `EditEnvelope`, `EditResult`, or `MapBinding` is a breaking change to every
  downstream SDK; the drift gate enforces this.

## Decisions Locked By This RFC

These are the alignment points the RFC nails down. Any future change to one of
these requires a follow-up RFC plus coordinated multi-SDK updates.

- Canonical protocol identifiers and the canonical → alias normalization
  direction.
- Canonical capability identifiers and per-protocol default capability sets.
- Query field names and semantics for `where`, spatial filter / bbox,
  `outFields`, `orderBy`, `pagination`, `returnGeometry`, `outSr`, and
  cancellation.
- Result envelope shape: features array (never undefined), pagination state,
  `totalCount`, field schema, extent, degraded reasons, and raw payload
  access.
- Unsupported-capability behavior: typed error, never a silent no-op or empty
  result.
- Native protocol escape hatch: every protocol-specific operation that does
  not belong on the shared surface lives behind the binding-idiomatic
  `protocol(...)` accessor (`Source.protocol(...)` in JS / Python,
  `Source.Protocol(...)` in .NET). The shared surface stays free of
  protocol-typed structures.

## Fixture Pack

The cross-SDK fixture pack lives under
[`test/fixtures/sdk-contract/semantic-contract.v1.json`](../test/fixtures/sdk-contract/semantic-contract.v1.json).
It is intentionally JSON-only so Python and .NET can consume the same payloads
without depending on the JS test helpers.

Coverage today:

- `protocols`, `capabilities`, and `defaultCapabilities` are pinned against the
  live JS exports — drift trips CI.
- `protocolAliases` records the short / legacy names already shipped (or about
  to ship) in Python and .NET so each SDK normalizes on read.
- `canonicalNouns` enumerates the ten contract nouns the drift gate enforces.
- `languageBindings` documents idiomatic per-language method and field names.
- `resultScenarios` cover FeatureServer, OGC API Features, STAC, OData, and
  WFS; included variants exercise nominal queries, empty pages, exceeded
  transfer limits, and the `queryAggregate` client-side degraded fallback for
  OGC API Features.
- `unsupportedCapabilityScenarios` cover render-only protocols (WMTS, OGC API
  Tiles, OGC API Maps), utility-only GeoServices protocols (Geometry Service,
  GP Service), and protocol-specific capability gaps (OGC API Features
  `queryRelated`).

The JS drift gate in `test/contract/sdk-contract-fixtures.test.ts` validates
that the fixture pack stays aligned with the exported JS contract registries
and with the documented result/error/degraded semantics. Downstream SDK work
should consume this fixture pack directly or mirror it with a clear
checksum/update process.

## Downstream Implementation Work

This RFC is JS-side and docs-only. The Python and .NET SDK alignment lands as
separate downstream tickets:

- **Python**: `honua-sdk-python` will pin against
  `semantic-contract.v1.json`, expose the canonical surface as
  `Source.query_all` / `Source.protocol(...)`, and keep `FeatureQuery` plus
  the existing free-function helpers as backwards-compatible facades. Track
  via `honua-io/honua-sdk-python` issue (TODO: add link once issue is filed).
- **.NET**: `honua-sdk-dotnet` will mirror the same fixture pack, expose
  `Source.QueryAllAsync` / `Source.Protocol(...)` / `Source.QueryObjectIdsAsync`,
  and keep `FeatureQueryRequest` as a facade. Track via
  `honua-io/honua-sdk-dotnet` issue (TODO: add link once issue is filed).

This ticket explicitly does not edit either repository. Filing the downstream
issues is part of merging this RFC; updating the placeholders above with the
real issue links is the only follow-up edit allowed inside `honua-sdk-js`
once the downstream tickets are open.

## References

- Canonical type definitions:
  [`src/contract/types.ts`](../src/contract/types.ts)
- Cross-protocol matrix:
  [`docs/protocol-capability-matrix.md`](./protocol-capability-matrix.md)
- Shared client contract design:
  [`docs/shared-client-contract.md`](./shared-client-contract.md)
- Source-binding round-trip:
  [`docs/source-binding-alignment.md`](./source-binding-alignment.md)
- Drift gate test:
  [`test/contract/sdk-contract-fixtures.test.ts`](../test/contract/sdk-contract-fixtures.test.ts)
- Tracking issue: https://github.com/honua-io/honua-sdk-js/issues/44
- Cross-repo coordination: `honua-io/honua-server#813`
