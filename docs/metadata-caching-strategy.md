# Metadata Caching Strategy

This strategy is the Honua platform default for metadata caching across SDKs,
MCP tools, examples, and server-backed source orchestration. It separates
metadata from spatial feature state and query results: metadata is cached by
default with explicit revalidation and invalidation rules, while feature,
query, and result caching is opt-in materialization only.

The policy applies to adapter metadata needed to construct source handles,
render layers, validate capabilities, and drive app startup. It does not make
live or ad hoc spatial feature responses cacheable by default.

## Default Metadata Set

Honua caches the following metadata types by default when the adapter can
identify a stable source, tenant/project boundary, and auth scope:

| Metadata type | Examples | Default behavior |
| --- | --- | --- |
| Service lists | GeoServices folders/services, OGC landing page links, STAC catalogs | Cache by source root and auth scope. Revalidate after the service-list TTL or any source refresh/import event. |
| Layer descriptors | Layer/table summaries, extents, geometry type, min/max scale, object id metadata | Cache by service and layer/table/collection id. Revalidate after descriptor TTL and hard-invalidate after schema or admin changes. |
| Fields | Names, aliases, types, nullable/editable flags, default values | Cache with layer descriptors. Hard-invalidate after schema changes, imports, migrations, and admin field edits. |
| Domains | Coded value domains, range domains, inherited subtype domains | Cache with fields. Hard-invalidate after schema, import, migration, or admin domain updates. |
| Capabilities | Supported operations, conformance classes, edit/query/statistics flags | Cache by protocol adapter and source/layer. Revalidate with upstream validators and hard-invalidate after admin capability changes. |
| Relationships | Relationship classes, related table ids, key fields, cardinality | Cache by service and layer/table id. Hard-invalidate after schema, migration, or admin relationship changes. |
| Renderers | Drawing info, style layers, symbolizers, classification metadata | Cache by layer/style id and CRS/format when renderer output differs by request context. Hard-invalidate after style/admin changes. |
| Legends | Legend entries, symbols, labels, scale-dependent groups | Cache by layer/style id and format. Revalidate more often than static schemas and hard-invalidate after renderer/style changes. |
| Tile matrix sets | WMTS/OGC tile matrix definitions, tile sets, limits | Cache for long TTLs because these are usually static. Hard-invalidate when source config or upstream tile metadata changes. |
| STAC collection metadata | Collection summaries, assets, item properties schema, extents, temporal ranges | Cache by collection id and auth scope. Revalidate after collection TTL and hard-invalidate after catalog refresh/import jobs. |
| OGC process descriptions | Process input/output schemas, execution modes, job controls | Cache by process id and protocol endpoint. Revalidate after process TTL and hard-invalidate after process deployment/admin changes. |

Feature rows, feature tiles, object id query responses, statistics responses,
viewport queries, geometry-service results, route outputs, and analysis outputs
are not part of the default metadata cache. Those responses may be persisted
only by an explicit materialization workflow.

## Cache Keys

Every cache entry uses a deterministic logical key. The key must exclude bearer
tokens, session cookies, and raw credentials, and it must include enough context
to prevent cross-tenant or cross-scope reuse.

Required cache-key dimensions:

- `tenantId` and `projectId` when the source belongs to a Honua tenant/project.
- Auth scope fingerprint derived from user/service-principal id, role grants,
  source ACL version, and token audience/scope. The fingerprint must not expose
  the token value.
- Normalized source URL: lowercase scheme/host, normalized path, sorted stable
  query parameters, removed transient parameters such as tokens and cache
  busters, and normalized trailing slashes.
- Protocol/adapter id, such as `geoservices-feature-service`, `wms`, `wmts`,
  `wfs`, `ogc-features`, `ogc-tiles`, `ogc-maps`, `stac`, `odata`, or
  `ogc-processes`.
- Service, layer, table, collection, tileset, style, entity set, or process id
  where the metadata is scoped below the source root.
- CRS, tile matrix set, output format, legend format, language/locale, and
  profile/media type when the upstream metadata differs by those inputs.
- Upstream `ETag` and `Last-Modified` validators when available. Validators are
  stored with the entry, sent on revalidation requests, and included in the
  cache-state version fingerprint returned to SDK/MCP callers.
- Adapter schema version and Honua projection version for SDK-shaped metadata
  derived from raw upstream documents.

The server should normalize keys centrally so SDKs and MCP tools can report a
stable key fingerprint without re-implementing credential-sensitive logic.

## TTL And Revalidation Policy

TTL is a freshness budget, not a correctness guarantee. Any explicit
invalidation event wins over TTL. If an upstream endpoint provides stronger
cache headers, Honua may use the shorter of the Honua default TTL and the
upstream `Cache-Control: max-age` value, while still retaining the invalidation
rules in this document.

| Metadata category | Default fresh TTL | Stale-if-error window | Revalidation policy |
| --- | --- | --- | --- |
| Service lists and source root discovery | 5 minutes | 30 minutes | Use conditional requests with `ETag`/`Last-Modified` when available. Otherwise refetch after TTL. |
| Layer descriptors, fields, domains, relationships | 15 minutes | 2 hours | Revalidate in background on reads after TTL; block and refresh when a caller requests `refresh: true`. |
| Capabilities and conformance metadata | 30 minutes | 4 hours | Conditional revalidation after TTL. Do not reuse stale capability metadata after an admin capability change. |
| Renderers and legends | 10 minutes | 1 hour | Revalidate after TTL; hard-invalidate after renderer/style/admin changes. |
| Tile matrix sets and static tile metadata | 24 hours | 7 days | Conditional revalidation; allow stale-if-error for startup rendering if the source config has not changed. |
| STAC collection metadata | 15 minutes | 2 hours | Revalidate after TTL and after catalog refresh/import jobs. Item search results are not covered by this cache. |
| OGC process descriptions | 30 minutes | 4 hours | Revalidate after TTL and hard-invalidate after process deployment/admin changes. |
| SDK/MCP projection documents | Match source metadata | Match source metadata | Projection entries must be invalidated whenever their raw metadata dependency invalidates. |

`refresh: true` means bypass the fresh-cache shortcut, send conditional
validators if available, and return either `refreshed` or `hit` with a
not-modified validator result. It does not bypass auth checks.

`stale-if-error` is allowed only for metadata. A stale metadata response must be
marked as stale in SDK/MCP cache state and must include the refresh error class
or diagnostic id. Stale metadata must not be silently presented as fresh.

## Invalidation Triggers

Honua treats invalidation as an event-driven operation scoped as tightly as the
source can identify.

| Trigger | Invalidate |
| --- | --- |
| Source refresh completes | Service lists, layer descriptors, fields, domains, capabilities, relationships, renderers, legends, STAC collection metadata, tile metadata, and OGC process descriptions for the refreshed source. |
| Import job completes | All metadata for created or replaced services/layers/collections; service lists for the owning source root. |
| Migration job completes | All metadata for migrated services/layers/tables plus relationships, fields, domains, renderers, legends, and capability projections. |
| Feature edits complete | No default feature-query cache invalidation is needed because feature queries are not cached by default. Invalidate metadata only when the edit changes schema, domains, relationships, renderers, extents, or capabilities. |
| Schema changes | Layer descriptors, fields, domains, relationships, capabilities, SDK/MCP projections, and any materialization definitions that depend on the schema. |
| Admin actions | Metadata touched by source configuration, auth/ACL, style, renderer, legend, process deployment, tile metadata, or catalog settings. Auth/ACL changes must also rotate the auth scope fingerprint or purge affected entries. |
| Upstream validator change | Replace the cached entry version and invalidate derived SDK/MCP projections for that resource. |
| Adapter/projection version change | Invalidate SDK-shaped projections while raw upstream metadata may remain reusable after re-projection. |

Distributed deployments should publish invalidation events with tenant/project,
source, adapter, resource id, and reason. SDK-local in-memory caches must expose
a clear method to drop affected handles or re-read metadata after the platform
reports invalidation.

## SDK And MCP Cache-State Visibility

SDK responses and MCP tool results that use default metadata caching must expose
cache state in a machine-readable field. This keeps demos, logs, and operators
from guessing whether a value was fresh, stale, or revalidated.

Recommended `cache` shape:

```ts doc-test=compile
type HonuaCacheState = {
  scope: "metadata" | "materialized-result";
  status: "hit" | "miss" | "stale" | "refreshed" | "bypass";
  keyFingerprint: string;
  ageMs?: number;
  ttlMs?: number;
  staleIfErrorMs?: number;
  revalidatedAt?: string;
  sourceUpdatedAt?: string;
  validator?: {
    etag?: string;
    lastModified?: string;
  };
  invalidationReason?: string;
  refreshErrorId?: string;
};
```

SDK adapters should return this state from metadata calls such as WMS/WFS/WMTS
capabilities, OData `$metadata`, STAC collection discovery, OGC process
descriptions, service/layer descriptors, renderer/legend reads, and source-list
discovery. MCP tools should include the same state in structured tool metadata
or a `cache` field on the resource/tool response. Text summaries may mention
the status, but the structured field is the contract.

Cache-state visibility requirements:

- A fresh cache reuse returns `status: "hit"` with `ageMs` and `ttlMs`.
- A first fetch returns `status: "miss"` unless the caller explicitly bypassed
  cache lookup.
- A conditional `304 Not Modified` revalidation returns `status: "hit"` or
  `status: "refreshed"` with `revalidatedAt`; SDKs should prefer
  `refreshed` when the caller requested `refresh: true`.
- A changed upstream response returns `status: "refreshed"` and updates the
  validator fingerprint.
- A stale-if-error metadata fallback returns `status: "stale"` and includes
  `refreshErrorId` or an equivalent diagnostic.
- A caller-forced bypass returns `status: "bypass"` and must not populate a
  shared cache unless the caller also opts into write-through.

### JavaScript SDK Surface

`@honua/sdk-js` exports the transport-neutral `HonuaCacheState`,
`HonuaCacheStatus`, `HonuaCacheScope`, `HonuaCacheValidator`, and
`HonuaMetadataRequestOptions` types from both the root and `/honua`
entrypoints. Metadata and discovery helpers accept:

```ts doc-test=skip reason="partial excerpt requires application host context"
await client.getLayerMetadata("civic-services", 0);
await client.getLayerMetadata("civic-services", 0, { refresh: true });
await client.getLayerMetadata("civic-services", 0, { cache: "bypass" });
```

Default metadata reads reuse the SDK-local metadata entry when present and
return `cache.status: "hit"`. `refresh: true` skips that fresh-cache shortcut,
sends `ETag` / `Last-Modified` validators when the adapter has them, and
reports `refreshed` for successful revalidation. `cache: "bypass"` skips cache
lookup and write-through for that call.

Feature rows, object ids, counts, statistics, spatial queries, STAC searches,
tiles, and process/job results remain uncached by default. Those result reads
should expose `scope: "materialized-result"` only when a separate
materialization workflow explicitly owns the persisted result.

## Feature, Query, And Result Caching

Feature/query/result caching is opt-in materialization only. Default SDK and
MCP read paths must execute ad hoc spatial requests against the current source
or live stream instead of reusing long-lived result caches.

Default non-cacheable operations include:

- `queryFeatures`, object-id queries, counts, statistics, aggregates, and
  viewport/bbox/intersects filters triggered by user interaction.
- Feature tiles or feature pages whose content depends on current edit state.
- Search results, route results, geometry-service outputs, and process outputs
  unless a materialization job explicitly owns the result.
- Realtime incident feature snapshots, deltas, cursors, and watermarks.

Materialized outputs are allowed only when the workflow declares:

- Owner, tenant/project, source ids, auth scope, query parameters, geometry,
  CRS, time extent, upstream metadata versions, and refresh cadence.
- Whether stale materialized results are allowed and how that state is shown to
  users.
- Provenance fields linking the result to the import, migration, analysis, or
  scheduled refresh job that produced it.
- A hard invalidation or recompute policy for edits, schema changes, source
  refreshes, and admin actions.

Materialization caches must use `scope: "materialized-result"` in cache-state
metadata. They must never be confused with default metadata caches.

## Realtime Incident Dashboard Constraints

The incident operations dashboard is realtime by default. It may use cached
metadata for schemas, layer descriptors, renderers, domains, capabilities, and
legends during startup, but it must not show stale spatial feature state from a
default feature/result cache.

Incident dashboard requirements:

- Live incident rows, geometries, selections, and counts are driven by realtime
  events, cursor/watermark replay, or a fresh explicit snapshot request.
- If the realtime transport disconnects, the UI may show the last reconciled
  in-memory state only with an explicit stale/offline status. It must not
  replace the live state with long-lived cached query results.
- Reconnect paths must resume from cursor/watermark or request a fresh snapshot.
  A materialized analytics layer may be shown only if it is labeled as
  materialized and not used as the authoritative incident state.
- Metadata cache state can be surfaced alongside connection state, but metadata
  freshness must not imply feature freshness.
- Alerting, dispatch, assignment, and detail panes must hide or disable actions
  that require authoritative live state when the incident stream is stale.

## Recommended Follow-Up Tickets

Do not create these issues automatically from this document. They are proposed
implementation slices if the platform wants to schedule the strategy.

| Title | Owning repo | Notes |
| --- | --- | --- |
| [Platform metadata cache: keys, TTLs, validators, and invalidation events](https://github.com/honua-io/honua-server/issues/916) | `honua-io/honua-server` | Central cache service, source-aware key normalization, validator storage, and invalidation event payloads. |
| [SDK metadata cache state and refresh hooks](https://github.com/honua-io/honua-sdk-js/issues/94) | `honua-io/honua-sdk-js` | `HonuaCacheState`, `refresh: true`, conditional validators, and stale-if-error reporting across metadata adapters. |
| [MCP metadata cache state visibility](https://github.com/honua-io/geospatial-mcp/issues/12) | `honua-io/geospatial-mcp` | Structured cache state on metadata-oriented MCP tool responses. |
| [Realtime samples: guard live state against stale feature-result caches](https://github.com/honua-io/honua-sdk-js/issues/95) | `honua-io/honua-sdk-js` | Sample/runtime assertions that incident feature state comes from realtime cursor/watermark flow or fresh snapshots. |
