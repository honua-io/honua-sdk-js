# Source capability profiles

> **Experimental.** `@honua/sdk-js/source-capabilities` is the canonical v2
> claimed/observed/effective capability evaluator and source support-check
> surface. Its evaluator-only graph does not perform discovery or execution;
> the heavier GeoServices/OData/WMS/WMTS integration is isolated in
> `@honua/sdk-js/source-capability-discovery`.

The v2 model keeps three statements separate:

- `claimed` is the adapter default or an explicit service declaration;
- `observed` is metadata, conformance, or probe evidence, including explicit
  `unknown` and `not-observed` states;
- `effective` is recomputed from static evidence plus current application
  policy, runtime environment, optional peers, authorization, and an explicit
  deterministic evaluation instant.

Only matching supported claim and observation can become effective support.
An unsupported claim or observation wins. Missing, expired, or failed optional
discovery remains unknown.

## Validate once, evaluate repeatedly

Static ingestion is deliberately separate from dynamic evaluation. Create one
versioned, content-addressed `CapabilityEvidenceProfile` when discovery changes,
cache or transport that envelope, then reuse it for cheap policy evaluations:

```ts doc-test=compile
import {
  createCapabilityEvidenceProfile,
  evaluateCapabilityProfile,
  type CapabilityEvidenceEntry,
} from "@honua/sdk-js/source-capabilities";

const entries: readonly CapabilityEvidenceEntry[] = [
  {
    id: "query",
    claimed: "supported",
    observed: "supported",
    evidence: [
      {
        kind: "protocol-default",
        truth: "supported",
        reference: "ogc-api-features:core",
        sourceFingerprint: "sha256:a2c9cb525692cf2e224b088147f1b23ae99bce3c974ba023ab4898f28bc79aa8",
      },
      {
        kind: "conformance",
        truth: "supported",
        reference: "ogcapi-features:conf/core",
        observedAt: "2026-07-13T12:00:00Z",
        expiresAt: "2026-07-20T12:00:00Z",
        sourceFingerprint: "sha256:a2c9cb525692cf2e224b088147f1b23ae99bce3c974ba023ab4898f28bc79aa8",
      },
    ],
    authorizationScopes: ["dataset:parcels:read"],
    constraints: {
      outputFormats: ["application/geo+json"],
      pagination: { modes: ["offset"], maxPageSize: 10_000 },
    },
  },
];

// Heavy validation, CRS/PROJJSON checks, normalization, and static hashing run once.
const sourceEndpoint = {
  endpoint: "https://example.test/ogc/features/collections/parcels",
  protocol: "ogc-features",
  sourceId: "parcels",
} as const;
const evidenceProfile = createCapabilityEvidenceProfile(entries, { sourceEndpoint });

// Repeat evaluation is synchronous and does not revalidate static CRS definitions.
const profile = evaluateCapabilityProfile(evidenceProfile, {
  evaluatedAt: "2026-07-14T12:00:00Z",
  environment: "browser",
  authorization: { grantedScopes: ["dataset:parcels:read"] },
});

profile.entries[0]?.effective; // "supported"
profile.evaluatedAt;           // "2026-07-14T12:00:00Z"
profile.validUntil;            // "2026-07-20T12:00:00Z"
```

## Source support checks and narrowing

`Dataset.source()` and `connect().source()` return a `CapabilityAwareSource`.
Its synchronous `supports()` method accepts built-in and reverse-DNS extension
identifiers. Only an exact `effective: "supported"` decision passes; unknown,
unsupported, policy-disabled, peer-unavailable, authorization-required, and
authorization-denied decisions all fail closed:

```ts doc-test=skip reason="source handle is supplied by the surrounding application"
const source = dataset.source("parcels")!;

if (source.supports("query")) {
  // `source` is narrowed to SourceWithCapability<Attributes, "query"> here.
  await executeQueryOnlyWorkflow(source);
}

const decision = source.capabilityProfile?.entries.find((entry) => entry.id === "query");
console.log(decision?.effective, decision?.reasons);
```

An attached profile must be evaluated or parsed by the same SDK instance and
its `sourceFingerprint` must match the descriptor's `schemaV2` fingerprint.
This prevents an internally valid profile from being replayed against a
different schema identity. Focused discovery also reconstructs canonical
GeoServices layer, OData entity-set, or WMS/WMTS service-and-layer coordinates from the descriptor and
binds the profile to their endpoint fingerprint. Cache parsing must continue
to supply both expected source coordinates as described below.

For built-in identifiers, the legacy `ReadonlySet` is derived as the
intersection of effective support and the adapter's existing capability
maximum. Consequently metadata and policy can downgrade an operation but a
profile cannot promote behavior the adapter does not implement. Supported
extension identifiers are available through `supports()` and are intentionally
absent from the built-in legacy set.

Sources without a v2 profile retain their exact legacy set behavior:
`supports()` delegates built-in checks to that set and returns `false` for
extension identifiers. Existing third-party `SourceResolver` implementations
do not need to add the method; the dataset decorates extensible results in
place and uses a behavior-preserving facade for non-extensible results.

## Focused GeoServices, OData, WMS, and WMTS discovery

Use the separate integration entrypoint when discovery should attach a
validated SourceSchemaV2 and an evaluated capability profile in one pass:

```ts doc-test=compile
import { connectWithSourceCapabilities } from "@honua/sdk-js/source-capability-discovery";

async function openParcels() {
  const connection = await connectWithSourceCapabilities(
    {
      endpoint: "https://example.test/arcgis/rest/services/Public/Parcels/FeatureServer/0",
      protocol: "auto",
      authorizationScopeFingerprint: "role:viewer:v1",
    },
    {
      evaluatedAt: new Date().toISOString(),
      environment: "browser",
      policy: { deny: ["applyEdits"] },
    },
  );

  const source = connection.source();
  if (source.supports("query")) return source.queryAll();
  return undefined;
}
```

The integration is certified for GeoServices FeatureServer/MapServer, OData
v4, WMS 1.3.0, and WMTS 1.0.0. WMS/WMTS capabilities are projected without a
second metadata request: WMS produces a zero-field schema with unknown feature
geometry because GetFeatureInfo has no portable field inventory; render-only
WMTS produces an explicit zero-field, no-geometry closed schema. Effective
profiles separate adapter claims from endpoint evidence, so raw WMS query stays
unsupported while a canonical Honua WMS binding may retain the existing
FeatureInfo adapter. Discovery caches retain raw metadata evidence
and SourceSchemaV2, never evaluated truth. Every cache hit reconstructs the
canonical descriptor endpoint, rebuilds the static profile, and reapplies the
current clock, freshness window, policy, runtime environment, peers, and
authorization context. The default observation lifetime is five minutes;
applications may set `observationTtlMs` explicitly.

`sourceCapabilityEndpointIdentity(descriptor)` is exported from both
capability subpaths for cache replay verification. Nested GeoServices service
folders are segment-encoded, already-resolved service URLs are checked for
service/layer contradictions, OData entity sets are bound as distinct resource
paths, and WMS/WMTS profiles bind the capabilities endpoint plus exact layer
identity without retaining operation URLs. Query strings, fragments, URL user-info, credentials, and
contradictory coordinates fail closed before hashing.

`entries` and nested set-like values are sorted, deduplicated, cloned, and
deeply frozen. Their normative order is the lexicographic unsigned-byte order
of each element's UTF-8 RFC 8785 canonical JSON, never locale order or
JavaScript's UTF-16 default `.sort()`. Omitted constraint sets mean unknown or
unbounded; explicit empty arrays mean observed none and remain present.
Arrays nested inside caller extension JSON are order-bearing and are preserved.
`supportedCrs` is capped at 64 definitions per capability and validated through
the complete resolved-CRS and pinned official PROJJSON v0.7 boundary during
evidence-profile creation.

The endpoint fingerprint uses the
`honua:capability-source-endpoint:1.0` domain over a normalized HTTP(S)
scheme/host/path plus protocol and optional source id. Endpoint query strings,
fragments, URL user-info, credential-shaped path content, and credential-shaped
source ids are rejected; only the digest is retained. The evidence fingerprint uses the
`honua:capability-evidence:1.0` domain and binds that endpoint digest, the
SourceSchemaV2 fingerprint, and semantic evidence. Observation and expiry
instants remain in transport but are excluded from semantic identity. The
evaluated `honua:capabilities:1.0` fingerprint binds the evidence/source
coordinates to normalized dynamic context and effective state/reason codes;
`evaluatedAt` and `validUntil` remain auditable transport state but do not churn
identity while the effective decision is unchanged. Repeat evaluation does not
walk full static PROJJSON documents.

## Cache and transport boundaries

Cache `CapabilityEvidenceProfile`, never `CapabilityProfile`. Effective truth
expires and must be recomputed with current dynamic state after each cache read:

```ts doc-test=skip reason="cache and runtime context are application-owned"
const cached = parseCapabilityEvidenceProfile(await evidenceCache.get(sourceId), {
  expectedSourceFingerprint: currentSourceSchema.fingerprint,
  expectedSourceEndpoint: currentSourceEndpoint,
});

const current = evaluateCapabilityProfile(cached, {
  evaluatedAt: new Date().toISOString(),
  policy: currentPolicy,
  environment: currentEnvironment,
  availablePeers: currentlyLoadedPeers,
  authorization: currentAuthorization,
});
```

Use `serializeCapabilityEvidenceProfile` and `parseCapabilityEvidenceProfile`
for static evidence transport. Both require the exact kind/version/key set and
recompute the semantic fingerprint. All evidence in one profile belongs to one
SourceSchemaV2 identity and one normalized endpoint identity. A sole evidence
`sourceFingerprint` is promoted to the required envelope field; otherwise
creation requires an explicit `sourceFingerprint`. Creation always requires
credential-free `sourceEndpoint` coordinates and transports only their digest.
Mixed schema fingerprints are rejected. Cached parsing accepts paired
`expectedSourceFingerprint` and `expectedSourceEndpoint` values and rejects
same-schema evidence replayed from another endpoint; supplying only one
coordinate fails closed. Use `verifyCapabilityEvidenceProfileSource` with both
coordinates for the same check on an already parsed in-memory cache value.

Use `serializeCapabilityProfile` and `parseCapabilityProfile` for evaluated
diagnostics or audit transport. Parsing reconstructs the static evidence
profile and replays evaluation; a forged effective state, reason, fingerprint,
context, or freshness boundary is rejected. This is internal consistency, not
current-source authorization: pass both expected source coordinates when
parsing for current use. Semantic fingerprints intentionally exclude clock-only
freshness state; fingerprints are content addresses, not signatures, so
authenticate the surrounding channel when origin or timestamp authenticity
matters. Only locally created profiles and profiles parsed with both expected
source coordinates retain the private endpoint-binding proof required for
attachment to a `SourceDescriptor`; an unbound audit parse cannot be replayed
onto a source. Parsing verifies that a supplied evaluation instant reproduces the
transported decision; it does not attest who supplied that clock input.

## Sensitive caller data

Capability profiles are potentially sensitive. The SDK rejects common
credential-bearing forms: raw/parameterized URL evidence references,
authorization headers, JWTs/private keys, non-structural peer or scope values,
and credential-named or credential-shaped extension metadata. Extension keys
are tokenized recursively across camel-case and separator boundaries, including
forms such as `authorizationHeader`, `access_token_value`,
`privateKeyPem`, and reverse-DNS keys such as `com.example.apiKey`. Evidence
references are bounded stable printable-ASCII identities; peers use npm package
identity syntax; scopes use bounded colon/slash-delimited identifiers.

Those checks cannot prove that an arbitrary accepted string is not a secret.
Supplying credentials, tokens, signed URLs, private endpoints, or confidential
metadata is a prohibited caller precondition. Serialization is canonical but
does not sanitize, redact, classify, or authorize caller data. Handle both
static and evaluated serialized profiles according to the sensitivity of their
inputs, and never publish or log them solely because parsing succeeded.

Metadata, conformance, and probe evidence requires both `observedAt` and an
exclusive `expiresAt`. Omitting `evaluatedAt` produces `evaluatedAt: null`,
`validUntil: null`, and `freshness-not-evaluated`. A fresh result reports the
earliest matching expiry as its conservative `validUntil`. A stale or not-yet-
current result uses its evaluation instant as the exclusive boundary.

## Policy vocabulary

`CapabilityEvaluationPolicy` (`allow`/`deny`) is the canonical v2 evaluator
policy. The two stable policy types remain supported adapters with narrower
legacy responsibilities:

- `DiscoveryCapabilityPolicy` controls stable discovery projection and whether
  inferred evidence may be accepted;
- stable `CapabilityPolicy` is the existing `"strict" | "degraded"` fallback
  mode used by v1 source/query adapters.

They are not peer v2 vocabularies. Integration layers translate them into a
`CapabilityEvaluationPolicy` at the compatibility boundary; new v2 code should
not overload or persist the legacy forms as evaluator policy.

## Validation and limits

Every versioned envelope rejects unknown keys, duplicate JSON object names,
undefined object members, non-finite numbers, unpaired UTF-16 surrogates,
accessors, symbols, sparse/extended arrays, cycles, and non-plain objects before
canonicalization. Inputs are snapshotted from own enumerable data properties
without consulting inherited prototype fields.

Synchronous static ingestion is bounded to 256 entries, 64 evidence records per
entry, 64 CRS definitions per constraint, 1,024 ordinary set values, a
2 MiB/65,536-node static envelope, 256 KiB extension graphs, and 128 KiB CRS
graphs. Dynamic context is bounded to 512 KiB/8,192 nodes. Evaluated transport
has a separate derived 8 MiB/196,608-node ceiling: it reserves the static
projection, repeated bounded identifiers and reason prefixes, normalized
context, and controlled headroom. Serializers and parsers enforce the same
envelope-specific limits. Violations throw `TypeError`.

## Effective states

| State | Meaning |
| --- | --- |
| `supported` | Claim and observation support the operation and every dynamic gate passes. |
| `unsupported` | The adapter claim or endpoint observation rejects the operation. |
| `unknown` | Claim/observation is unknown, observation was not requested, or freshness cannot be established. |
| `policy-disabled` | Current v2 evaluation policy excludes otherwise supported behavior. |
| `peer-unavailable` | The current environment is ineligible or a required optional peer is absent. |
| `authorization-required` | One or more stable scope identifiers are not currently granted. |
| `authorization-denied` | The current principal is explicitly denied a required scope. |

Every decision includes stable reason codes. Environment, peer, and scope
failures suffix the code with the relevant structural identifier. That identifier
is still caller-controlled and potentially sensitive; credentials remain
prohibited in evidence references, peer ids, scope ids, and extension values.

## Delivery boundary

The focused connection path attaches verified profiles for GeoServices, OData,
WMS, and WMTS. Existing sources without a profile retain their stable
`ReadonlySet` capability behavior; remaining protocol families continue on
their own rollout issues.
