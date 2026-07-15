# Source capability profiles

> **Experimental.** `@honua/sdk-js/source-capabilities` is the canonical v2
> claimed/observed/effective capability evaluator. It does not yet change the
> stable `Source.capabilities` set or perform discovery or execution.

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
        sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        kind: "conformance",
        truth: "supported",
        reference: "ogcapi-features:conf/core",
        observedAt: "2026-07-13T12:00:00Z",
        expiresAt: "2026-07-20T12:00:00Z",
        sourceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
const evidenceProfile = createCapabilityEvidenceProfile(entries);

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

`entries` and nested set-like values are sorted, deduplicated, cloned, and
deeply frozen. Omitted constraint sets mean unknown or unbounded; explicit
empty arrays mean observed none and remain present. `supportedCrs` is capped at
64 definitions per capability and validated through the complete resolved-CRS
and pinned official PROJJSON v0.7 boundary during evidence-profile creation.

The evidence fingerprint covers the complete normalized static envelope,
including observation windows and source identity. The evaluated fingerprint
binds that evidence fingerprint to the normalized dynamic context, effective
states, reasons, `evaluatedAt`, and `validUntil`; repeat evaluation therefore
does not walk full static PROJJSON documents.

## Cache and transport boundaries

Cache `CapabilityEvidenceProfile`, never `CapabilityProfile`. Effective truth
expires and must be recomputed with current dynamic state after each cache read:

```ts doc-test=skip reason="cache and runtime context are application-owned"
const cached = parseCapabilityEvidenceProfile(await evidenceCache.get(sourceId), {
  expectedSourceFingerprint: currentSourceSchema.fingerprint,
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
recompute the content fingerprint. All evidence in one profile belongs to one
SourceSchemaV2 identity. A sole evidence `sourceFingerprint` is promoted to the
required envelope field; otherwise creation requires an explicit
`sourceFingerprint`. Mixed fingerprints are rejected. Cached parsing accepts
`expectedSourceFingerprint` and rejects stale evidence from a different current
schema; use `verifyCapabilityEvidenceProfileSource` for the same check on an
already parsed in-memory cache value.

Use `serializeCapabilityProfile` and `parseCapabilityProfile` for evaluated
diagnostics or audit transport. Parsing reconstructs the static evidence
profile and replays evaluation; a forged effective state, reason, fingerprint,
context, or freshness boundary is rejected. This is internal consistency, not
current-source authorization: pass `expectedSourceFingerprint` when parsing for
current use. Fingerprints are content addresses, not signatures, so authenticate
the surrounding channel when origin matters.

## Sensitive caller data

Capability profiles are potentially sensitive. The SDK rejects common
credential-bearing forms: raw/parameterized URL evidence references,
authorization headers, JWTs/private keys, non-structural peer or scope values,
and credential-named or credential-shaped extension metadata. Evidence
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

This slice does not add `source.supports()`, decorate legacy sources, or wire
`connect()` discovery into the v2 profile. Those layers consume this evaluator
in later slices. Existing stable `ReadonlySet` capability behavior is unchanged.
