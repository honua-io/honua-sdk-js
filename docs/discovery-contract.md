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

## Explicit connect facade (bounded OGC Features slice)

The experimental `connect()` facade now composes this truth contract for raw
OGC API Features landing pages. The protocol hint is mandatory. Passing
`protocol: "auto"` throws `HonuaDiscoveryError` with code
`ambiguous-protocol` before cache hooks, authentication, or network requests
run; passing a protocol without a reviewed connect adapter throws
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

At a service root, all advertised collections become `Dataset` source
descriptors. `connection.source()` is only implicit when exactly one source
was selected; otherwise it throws `ambiguous-source` and lists the valid IDs.
`connection.source(id)` and `connection.dataset` retain the existing reviewed
`Dataset` / `Source` execution contract.

Authentication, retry, timeout, interceptors, and transport fetch overrides
are passed in `clientOptions`, or callers may inject an existing `HonuaClient`
whose normalized base URL exactly matches the endpoint. Landing endpoints must
be absolute HTTP(S) URLs without user info, query parameters, or fragments;
authentication belongs in `clientOptions`. `signal` cancels metadata work and
settles `connect()` even when a caller cache hook ignores its supplied signal.
Cache implementations remain responsible for stopping their own late work.
`refresh: true` skips the caller cache read and forwards conditional-refresh
semantics to the client's metadata cache.

`ConnectDiscoveryCache` is an optional caller-owned cache hook. Its logical
identity uses `createDiscoveryCacheIdentity()`, including the opaque
authorization-scope fingerprint plus connect adapter and projection versions.
Stored values are raw, versioned observations; capability policy is reapplied
after every cache read. Cross-version, cross-endpoint, cross-scope, and
cross-collection snapshots are rejected as `invalid-discovery-cache` instead
of being trusted. Cache hooks must not persist access tokens, API keys, or raw
authorization material.

This slice is intentionally not universal-connect completion: WFS, STAC,
GeoServices, static files, and the remaining raw OGC families still fail as
unsupported rather than falling through to heuristic detection.

## Remaining #391 work

- URL/asset classification and ambiguity recovery.
- Per-protocol metadata projections and raw OGC Tiles, Maps, Records, and
  Processes endpoint discovery.
- Remaining protocol adapters, normalized schema/queryables, partial metadata
  diagnostics, and the owning `createHonua()` disposal lifecycle.
- Cross-language semantic descriptor fixtures and scheduled third-party smoke.

Those layers should consume this contract rather than publish capabilities or
cache keys through protocol-specific conventions.

Invalid locators, protocols, capability identifiers, mismatched resolutions,
and cache identities throw `HonuaDiscoveryError`. Its stable `.code` is also
recognized by the root `isHonuaError()` guard; these input/metadata failures
are not retryable until the declaration or discovery projection is corrected.
