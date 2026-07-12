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

## Connect facade (OGC Features, STAC API, GeoServices, WFS, and OData slices)

The experimental `connect()` facade composes this truth contract for raw OGC
API Features and STAC API landing pages, WFS 2.0 endpoints, OData v4 service
roots, and canonical
GeoServices `FeatureServer` / `MapServer` service or layer URLs. OGC, STAC,
WFS, and OData endpoints require explicit `protocol: "ogc-features"`,
`protocol: "stac"`, `protocol: "wfs"`, or `protocol: "odata"` hints.
Canonical GeoServices URLs may use
`protocol: "auto"`: classification comes entirely from the URL path and makes
no network request. An ambiguous auto target throws `HonuaDiscoveryError` with
code `ambiguous-protocol` before cache hooks, authentication, or network
requests run. Passing a protocol without a reviewed connect adapter throws
`unsupported-protocol`. Discovery never probes a Honua facade or a second
authenticated protocol endpoint as fallback.

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

This slice is intentionally not universal-connect completion: static STAC,
static-file/GeoParquet assets, GeoServices Image/Geometry/GP services, and the
remaining raw OGC families still fail as unsupported rather than falling through
to heuristic detection.

## Remaining #391 work

- Static asset classification (static-file/GeoParquet) and an explicit
  ambiguity-recovery contract.
- GeoServices ImageServer, GeometryServer, and GPServer metadata projections.
- Raw OGC Tiles, Maps, Records, and Processes endpoint discovery. These wire
  methods and source adapters are currently facade-path-bound (unlike OGC API
  Features, which already threads a discovered endpoint layout); raw endpoint
  discovery for them requires threading a layout through those adapters, and OGC
  Processes additionally is not a `Source`-backed `Protocol`.
- Remaining protocol adapters, normalized schema/queryables, partial metadata
  diagnostics, and the owning `createHonua()` disposal lifecycle.
- Cross-language semantic descriptor fixtures and scheduled third-party smoke.

Those layers should consume this contract rather than publish capabilities or
cache keys through protocol-specific conventions.

Invalid locators, protocols, capability identifiers, mismatched resolutions,
and cache identities throw `HonuaDiscoveryError`. Its stable `.code` is also
recognized by the root `isHonuaError()` guard; these input/metadata failures
are not retryable until the declaration or discovery projection is corrected.
