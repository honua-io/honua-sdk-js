# Discovery truth and cache identity

Issue [#391](https://github.com/honua-io/honua-sdk-js/issues/391) introduces a
universal connect workflow in protocol-sized slices. The first production
slice is the protocol-neutral truth contract used by endpoint detectors and
metadata adapters. It does not claim that every protocol can already be
passed to one `connect()` implementation.

## Capability truth

`PROTOCOL_DEFAULT_CAPABILITIES` describes the maximum operations implemented
by an SDK adapter. It is not proof that a particular server or asset enables
those operations. Discovery code should pass endpoint evidence to
`resolveDiscoveryCapabilities()` and use the returned intersection:

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  inspectDiscoveredSource,
  resolveDiscoveryCapabilities,
} from "@honua/sdk-js/contract";

const resolution = resolveDiscoveryCapabilities(
  "ogc-features",
  {
    kind: "metadata",
    capabilities: ["query", "queryObjectIds"],
    provenance: [{ source: "GET /conformance" }],
  },
  { deny: ["queryObjectIds"] },
);

const inspection = inspectDiscoveredSource(sourceDescriptor, resolution);
// inspection.descriptor.capabilities contains only "query".
// inspection.capabilityDecisions explains every enabled or excluded operation.
```

Evidence is explicit and may be supplied as multiple capability-scoped records:

- `metadata` means a server or asset document advertised support.
- `declared` means trusted caller/source configuration guarantees support.
- `inferred` is recorded but enables nothing unless the caller sets
  `acceptInferred: true`.
- `unavailable` enables nothing and emits a structured diagnostic. Protocol
  defaults are never silently substituted.

This lets a connection retain declared known-safe operations, metadata-backed
operations, and a failed optional metadata endpoint at the same time. Every
capability decision preserves the records and provenance that supported or
excluded it; conflicting metadata is resolved conservatively.

The resolver also rejects unknown capability identifiers, reports evidence
that exceeds the adapter implementation, and applies allow/deny policy after
the adapter/evidence intersection. A failed optional metadata endpoint does
not erase explicitly `declared` known-safe operations; callers must preserve
that provenance instead of relabeling defaults as observed metadata.

## Cache identity

`createDiscoveryCacheIdentity()` builds the common logical key for later
connection caches. It requires an opaque authorization-scope fingerprint so
authenticated metadata cannot accidentally share an anonymous cache entry.
The identity includes opaque SHA-256 endpoint/auth-scope digests, protocol,
source resource dimensions (including WFS/WMS `typeName`), and
adapter/projection versions. The returned
display endpoint is credential-redacted; the logical key never embeds raw URL
or authorization-scope values.

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createDiscoveryCacheIdentity } from "@honua/sdk-js/contract";

const identity = await createDiscoveryCacheIdentity({
  endpoint: collectionUrl,
  protocol: "ogc-features",
  authorizationScopeFingerprint: aclFingerprint,
  collectionId: "parcels",
  adapterVersion: "ogc-features@1",
  projectionVersion: "source-inspection@1",
});
```

URL user information, fragments, OAuth/session/API-key parameters, and cloud
signed-URL credentials are removed. Stable query parameters are sorted and
remain identity-bearing inside the opaque endpoint digest. Ambiguous credential
aliases such as `key`, `api-key`, `subscription-key`, `auth`, `code`, and
`session` are redacted from the display endpoint while their values remain in
the hash input, so `key=roads` cannot collide with `key=buildings`. Adapters
classify additional vendor cache busters with `transientQueryParameters`. The
caller fingerprint is hashed again internally, but it should still be a stable
identity derived from the caller, grants, audience, and ACL version rather than
a token.

Omitting `adapterVersion` and `projectionVersion` uses the exported
`HONUA_DISCOVERY_ADAPTER_VERSION` and
`HONUA_DISCOVERY_PROJECTION_VERSION` constants. Both dimensions are always in
the cache key, so adapter or normalized-schema upgrades cannot reuse older
entries accidentally.

## Public surface

The root and `/honua` barrels expose the curated workflow: the four primary
evidence/policy/resolution/cache-option types, error, and helper functions.
`@honua/sdk-js/contract` additionally exports the version constants and the
complete decision, diagnostic, provenance, cache-result, and inspection type
vocabulary for adapter authors. This keeps the beginner surface bounded while
preserving a fully typed protocol integration seam.

## Connect facade (OGC Features/Records/Tiles/Maps, STAC API, GeoServices, WFS, OData, and GeoParquet slices)

The experimental `connect()` facade composes this truth contract for raw OGC
API Features and STAC API landing pages, raw OGC API Records catalog roots, raw
OGC API Tiles and Maps service roots (render-only sources),
WFS 2.0 endpoints, OData v4 service
roots, static-file GeoParquet assets, and canonical GeoServices
`FeatureServer` / `MapServer` / `ImageServer` service or layer URLs. OGC, STAC,
WFS, OData, Records, Tiles, Maps, and GeoParquet endpoints require an explicit
`protocol: "ogc-features"`,
`protocol: "stac"`, `protocol: "wfs"`, `protocol: "odata"`,
`protocol: "ogc-records"`, `protocol: "ogc-tiles"`, `protocol: "ogc-maps"`, or
`protocol: "geoparquet"` hint. OGC API Processes is deliberately **not** a
Source-backed protocol; `connect()` rejects `protocol: "ogc-processes"` and
directs callers to `discoverOgcProcesses()`, which returns a
capability/metadata result rather than a `Source` (see below).
Canonical source-backed GeoServices URLs may use
`protocol: "auto"`: classification comes entirely from the URL path and makes
no network request. An ambiguous auto target throws `HonuaDiscoveryError` with
code `ambiguous-protocol` before cache hooks, authentication, or network
requests run. Passing a protocol without a reviewed connect adapter throws
`unsupported-protocol`. Discovery never probes a Honua facade or a second
authenticated protocol endpoint as fallback.

`connect()` is product-level discovery, not an operation on an individual
`Source`, so it is intentionally absent from `Capability`, `CAPABILITIES`, and
`PROTOCOL_DEFAULT_CAPABILITIES`. The reviewed connector inventory is exported
internally as `CONNECT_SOURCE_PROTOCOLS` and projected as `connectProtocols` in
the support manifest. CI requires every entry to have exactly one positive
`discovery` support claim and rejects connector claims outside that inventory.

```ts doc-test=compile
import { connect } from "@honua/sdk-js/honua";

const connection = await connect({
  endpoint: "https://demo.pygeoapi.io/master",
  protocol: "ogc-features",
  authorizationScopeFingerprint: "anonymous",
  collectionId: "lakes",
});

const inspection = connection.inspection.sources[0];
// Capabilities are the intersection of the SDK adapter and advertised
// conformance evidence, never PROTOCOL_DEFAULT_CAPABILITIES by assumption.
const lakes = connection.source();
```

GeoServices service discovery reads the service document and then resolves
layer/table metadata with a maximum concurrency of four. A layer URL performs
only the single selected-layer metadata request:

```ts doc-test=compile
import { connect } from "@honua/sdk-js/honua";

const parcels = await connect({
  endpoint:
    "https://sampleserver.example/arcgis/rest/services/Cadastre/Parcels/FeatureServer/0",
  protocol: "auto",
  authorizationScopeFingerprint: "anonymous",
});

const layer = parcels.source();
// locator.serviceId === "Cadastre/Parcels"; locator.layerId === 0
```

The client base URL is derived from the portion before `/rest/services`; the
full service/layer URL remains the redacted discovery identity. A pasted
`?f=json`, `?f=pjson`, or equivalent `format` query is removed before
classification; all identity-bearing query parameters remain rejected. An
injected `HonuaClient` must be configured for that derived service root. URL
user info, other query parameters, and fragments remain rejected; credentials
belong in `clientOptions`.

GeoServices capabilities come from the advertised `capabilities` string and
reviewed metadata flags (`supportsStatistics`, attachments, relationships,
standardized queries, and PBF formats). MapServer tile-cache status is retained
from service metadata; a selected layer URL reports it as unavailable rather
than performing a second request. Missing capability
metadata produces `discovery-unavailable` and enables nothing by assumption.
Discovery only advertises canonical `query` and `stream` when layer metadata
explicitly reports `supportsPagination: true`: canonical `query` also promises
a safe `queryAll()`, and repeatedly sending an unsupported or unverified offset
can duplicate the first page indefinitely. Independently safe operations such
as `queryObjectIds` and `queryExtent` remain available when advertised.
At a service root, if one optional layer metadata request fails, service-level
evidence retains known-safe operations and the affected source reports
`partial-discovery`; no adapter default is silently substituted. Layer fields
and the object-id primary key are projected into the common source schema.

### Service-shaped GeoServices discovery

`discoverGeoServices()` accepts canonical `FeatureServer`, `MapServer`,
`ImageServer`, `GeometryServer`, and `GPServer` service URLs. It uses the same
strict endpoint classifier as `connect()`, including nested folder/service ids,
optional numeric layer/catalog ids, selected GP task names, and removal of a
pasted JSON-format query. Other query parameters, credentials, fragments, and
non-canonical layouts fail before metadata is requested.

```ts doc-test=compile
import { discoverGeoServices } from "@honua/sdk-js/honua";

const discovery = await discoverGeoServices({
  endpoint:
    "https://sampleserver.example/arcgis/rest/services/Analysis/Visibility/GPServer",
});

// GPServer and GeometryServer operations are intentionally not Sources.
for (const task of discovery.operations) {
  console.log(task.id, task.execution, task.availability, task.href);
}
```

Every result carries a common service identity, credential-free authentication
evidence, advertised formats, CRS definitions, numeric limits, provenance, and
structured diagnostics. `ImageServer` is source-backed because its raster
catalog already has a reviewed `Source` adapter; its effective capabilities are
the intersection of explicit metadata and that adapter, never the ImageServer
defaults. `GeometryServer` and `GPServer` instead return immutable operation
descriptors and an empty `sources` array, so neither can masquerade as a feature
collection. Image edit, attachment, relationship, and stream capabilities are
never inferred.

CRS evidence keeps native `wkid` and `latestWkid` values separate from an
authority identity. A legacy Esri WKID is never relabeled as EPSG; `authority`
and `code` appear only when an explicit or reviewed alias establishes the EPSG
code. Likewise, `operation.sdkSupported` means the current SDK can execute the
advertised binding, not merely that its operation name is familiar. The
existing geometry adapter is bound to `Utilities/Geometry`, so an equivalent
operation advertised under another GeometryServer id remains discoverable but
reports `sdkSupported: false`.

Geometry operations are derived only from advertised operation metadata.
GPServer discovery reads the advertised task list with a maximum concurrency of
four, then classifies each task as synchronous `execute`, asynchronous
`submitJob` plus job-lifecycle URL templates, or unknown. Discovery never calls
an operation, submits a job, polls status, or reads a dynamic result. Relative
operation links must resolve inside the credential-free service root;
cross-origin links and identity-bearing query strings are rejected.

HTTP 401/403 and GeoServices 498/499 token errors preserve the normalized
service identity with `authentication-required` and `partial-discovery`
diagnostics instead of inventing operations. A failed GP task metadata request
similarly yields an `unavailable` task descriptor while retaining successful
siblings. `signal`, `refresh`, metadata cache headers, retry, and transport/auth
options follow the same client contract as `connect()`.

At an OGC service root, all advertised collections become `Dataset` source
descriptors; at a GeoServices root, advertised layers and tables do. A layer
or collection URL/selection returns a single source. `connection.source()` is
only implicit when exactly one source was selected; otherwise it throws
`ambiguous-source` and lists the valid IDs. `connection.source(id)` and
`connection.dataset` retain the existing reviewed `Dataset` / `Source`
execution contract.

WFS discovery performs exactly one `GetCapabilities` request with
`service=WFS`, `version=2.0.0`, and `request=GetCapabilities`. It returns every
advertised feature type or the exact `typeName` selection. The common
`query`/`queryAll` and `stream` contract is enabled only when the document is
WFS 2.0, advertises a recognized JSON/GeoJSON representation, and exposes both
GET and POST bindings with validated non-empty DCP URLs for `GetFeature`; the runtime needs GET for ordinary
queries and switches long FES filters to POST. `applyEdits` additionally
requires a POST `Transaction` binding with a validated URL and a root namespace
declaration resolved from the feature-type prefix. Unprefixed types remain
non-editable when capabilities provide no provable feature namespace.
`queryObjectIds` remains unavailable because
capabilities cannot prove GeoJSON `feature.id`; `queryExtent` remains
unavailable because the common filtered-extent drain is not bounded by this
metadata. Those negative decisions are explicit rather than adapter defaults.

Advertised WFS operation URLs must remain on the endpoint origin and carry no
user information, query, or fragment before the connection is accepted.
Relative DCP links are resolved against the capabilities endpoint and retained
as canonical absolute URLs before the runtime can issue GetFeature or
Transaction requests. The
baseline does not issue `DescribeFeatureType`, so it has no hidden per-type
fan-out and does not invent a field schema. Default CRS, WGS84 bounds, titles,
and feature namespace bindings are parsed from `GetCapabilities`; the default
CRS and namespace are retained on the WFS locator, while the bbox is not
promoted to the filtered canonical extent capability.

OData v4 discovery performs exactly one `$metadata` (CSDL) request against the
service base path carried by the endpoint (for example `/odata`); the client is
bound to the endpoint origin. Every entity set declared in the container becomes
a source, keyed by its entity-set name. Capabilities are read only from the CSDL:
`query` and bounded paged `stream` are enabled for every declared entity set
(OData exposes `$top`/`$skip` server-driven paging), `queryObjectIds` additionally
requires a declared entity key, and `applyEdits` is enabled unless the
`Capabilities.*` insert, update, and delete restriction annotations are all
explicitly `false`. This mirrors the runtime OData adapter's `applyEdits` gate, so
a discovered descriptor and the live source agree. Declared properties (including
`Edm.Geography`/`Edm.Geometry` typing) are projected into the source schema with
the single-key field promoted to `primaryKey`; the descriptor carries
`locator.entitySet` so the existing OData source adapter executes against the same
base path. Missing or malformed `$metadata` fails as `invalid-endpoint` rather
than inventing an entity set or an adapter-default capability set.

Raw STAC API discovery performs exactly two metadata requests on a valid
service: the root landing page and `/collections`. Exact STAC API Core 1.0.0
conformance and a credential-free, same-root `rel=data` collections link must
be established from the landing document before the second request. An
explicit protocol hint never substitutes for protocol identity or authorizes a
guessed operation URL. Discovery never searches items or fans out to
per-collection metadata. Every advertised collection becomes a source, or
`collectionId` selects exactly one. The descriptor retains
`layout: "stac-api"`, so the existing source adapter executes against the raw
root's `/search` path rather than the Honua `/stac` facade. Collection CRS and
spatial/temporal extents are deeply immutable under `metadata` on the matching
`connection.inspection.sources` entry; dynamic item properties are not
invented as a field schema.

`query`, `queryObjectIds`, and bounded paged `stream` are enabled together only
when the landing page advertises both STAC API Core 1.0.0 and Item Search
1.0.0, plus a credential-free `rel=search` link under the connected service
root. Generic STAC catalog conformance does not prove a search API. Missing
Item Search evidence leaves those operations disabled with structured
`not-advertised` decisions. Cross-origin, credential-bearing, query-bearing,
or path-divergent search/data links are rejected after the landing request and
before any linked endpoint can be contacted. Static STAC catalogs remain a
separate explicit discovery slice; `auto` never probes an ambiguous URL to
guess STAC API versus static STAC.

Raw OGC API Records discovery performs three metadata requests against the
discovered service root — the landing page, `/conformance`, and `/collections`.
The landing page must advertise a collections data link before the follow-up
requests run. Every advertised catalog collection becomes a source keyed by its
collection id. Effective capabilities are the intersection of the OGC Records
adapter surface and the advertised conformance classes: `query` and
`queryObjectIds` are enabled only when the service advertises the Records API /
searchable-catalog conformance, and a service that advertises no Records query
conformance leaves those operations disabled with structured `not-advertised`
decisions rather than adapter defaults. The discovered service-root prefix is
retained on `locator.basePath`, so the existing OGC Records source adapter
threads it through every wire request — the reviewed descriptor executes the
same catalog search against a third-party root that it would against the Honua
`/ogc/records` facade (semantic descriptor parity).

Raw OGC API Tiles and Maps discovery follows the identical shape through the
same `basePath` threading seam (`OgcMetadataRequest.basePath`,
`SourceLocator.basePath`): three metadata requests against the discovered
service root (landing, `/conformance`, and the OGC API Common `/collections`
list), a required collections data link on the landing page, and one reviewed
render-only source per advertised collection. Their effective capabilities are
the intersection of the render-only adapter surface (`render`, `tiles` for
Tiles; `render` for Maps) and the advertised conformance classes; a service
that advertises no Tiles/Maps conformance leaves those operations disabled with
structured `not-advertised` decisions. The discovered root is retained on
`locator.basePath`, so the render-only Tiles/Maps source adapters resolve every
tile / map-image request against the third-party root through the same seam
rather than the `/ogc/tiles` or `/ogc/maps` facade.

OGC API Processes is intentionally not a `Source`-backed `Protocol`: a process
is an invocable operation, not a queryable dataset. `discoverOgcProcesses()` is
its raw-discovery counterpart — it threads the discovered service root through
the Processes wire methods (the same `basePath` seam), performs three bounded
metadata requests (landing, `/conformance`, `/processes`), and returns a
capability/metadata result: the advertised process list plus the effective
`processes` capability intersected from conformance (with a structured
`discovery-unavailable` diagnostic when Processes core conformance is absent).
It never constructs a `connect()` `Source` or dataset.

GeoParquet / static-file discovery has no HTTP metadata document: it reads the
Parquet footer and the GeoParquet `geo` metadata through an injected
`geoparquet.profiler` seam (`GeoParquetSourceProfiler`, satisfied structurally
by `GeoparquetRuntime` from `@honua/sdk-js/geoparquet`). The DuckDB engine must
never enter the connect static graph, so the reader is injected rather than
imported. A successful footer read is positive metadata evidence for the
canonical `query`, `queryAggregate`, and bounded `stream` operations the
GeoParquet adapter implements; the detected geometry column, physical encoding,
and any GeoParquet 1.1 bbox-covering column are pinned on `locator.geoparquet`
so the runtime resolves without a second profiling round-trip, and the file
CRS is retained under `metadata`. A purely tabular Parquet file discovers the
same three read capabilities (spatial filters simply throw at query time).
Because the GeoParquet `Source` is resolver-only (DuckDB stays out of the
static graph), an injected `resolveSource` (for example `geoparquetResolver()`)
lets the reviewed descriptor execute directly through `connection.source()`.

Authentication, retry, timeout, interceptors, and transport fetch overrides
are passed in `clientOptions`, or callers may inject an existing `HonuaClient`
whose normalized base URL matches the OGC/STAC/WFS endpoint, the OData origin, or
the derived GeoServices
root. Endpoints must be absolute HTTP(S) URLs without user info,
identity-bearing query parameters, or fragments; authentication belongs in
`clientOptions`. `signal` cancels metadata work and
settles `connect()` even when a caller cache hook ignores its supplied signal.
Cache implementations remain responsible for stopping their own late work.
`refresh: true` skips the caller cache read and forwards conditional-refresh
semantics to the client's metadata cache.

`ConnectDiscoveryCache` is an optional caller-owned cache hook. Its logical
identity uses `createDiscoveryCacheIdentity()`, including the opaque
authorization-scope fingerprint plus connect adapter and projection versions.
Stored values are raw, versioned observations; capability policy is reapplied
after every cache read. Cross-version, cross-endpoint, cross-scope, and
cross-collection and cross-WFS-type snapshots are rejected as
`invalid-discovery-cache` instead
of being trusted. Cache values cross a persistence trust boundary: the SDK
rejects accessors, proxies that throw, cycles, sparse arrays, malformed
evidence/provenance/extents, and non-plain objects as typed
`invalid-discovery-cache` failures. Accepted values are copied into deeply
owned immutable data before capability resolution, so later caller/cache
mutation cannot change an inspection. The clone is bounded to 32 levels,
10,000 values, 20,000 properties, 10,000 entries per dense array, one million
UTF-16 code units per string, and four million string code units overall.
Owned records use null prototypes, so data keys such as `__proto__` cannot
alter object prototypes. A bound violation fails without a network fallback.
Cache hooks must not persist access tokens, API keys, or raw authorization
material.

This slice is intentionally not universal-connect completion: GeometryServer
and GPServer remain operation-shaped and therefore fail through `connect()`;
callers use `discoverGeoServices()` instead. No protocol falls through to
heuristic detection.

## Remaining #391 work

- Static asset classification for GeoParquet via `auto` (structural URL
  recognition) and an explicit ambiguity-recovery contract; today GeoParquet
  requires an explicit `protocol: "geoparquet"` hint plus a metadata reader.
- Remaining protocol adapters, normalized schema/queryables, partial metadata
  diagnostics, and the owning `createHonua()` disposal lifecycle.
- Cross-language semantic descriptor fixtures and scheduled third-party smoke.

Those layers should consume this contract rather than publish capabilities or
cache keys through protocol-specific conventions.

Invalid locators, protocols, capability identifiers, mismatched resolutions,
and cache identities throw `HonuaDiscoveryError`. Its stable `.code` is also
recognized by the root `isHonuaError()` guard; these input/metadata failures
are not retryable until the declaration or discovery projection is corrected.
