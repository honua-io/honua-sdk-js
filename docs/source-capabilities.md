# Source capability profiles

> **Experimental.** `@honua/sdk-js/source-capabilities` is a focused preview
> surface. It does not change the legacy `Source.capabilities` set and does not
> perform discovery or execution.

The capability evaluator keeps three different statements separate:

- `claimed` is the adapter default or an explicit service declaration;
- `observed` is metadata, conformance, or probe evidence, including explicit
  `unknown` and `not-observed` states;
- `effective` is recomputed from those two truths plus current application
  policy, runtime environment, optional peers, authorization, and an explicit
  deterministic evaluation instant.

Only matching `supported` claim and observation can become effective support.
An `unsupported` claim or observation wins, so metadata can downgrade a default
but cannot silently enable an unsupported adapter. Missing or failed optional
discovery remains `unknown`.

## Evaluate cacheable evidence

```ts doc-test=compile
import {
  evaluateCapabilityProfile,
  type CapabilityEvaluationEntry,
} from "@honua/sdk-js/source-capabilities";

const evidence: readonly CapabilityEvaluationEntry[] = [
  {
    id: "query",
    claimed: "supported",
    observed: "supported",
    evidence: [
      {
        kind: "protocol-default",
        truth: "supported",
        reference: "ogc-api-features:core",
      },
      {
        kind: "conformance",
        truth: "supported",
        reference: "https://example.test/conformance#core",
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

const profile = evaluateCapabilityProfile(evidence, {
  evaluatedAt: "2026-07-14T12:00:00Z",
  environment: "browser",
  authorization: { grantedScopes: ["dataset:parcels:read"] },
});

profile.entries[0]?.effective; // "supported"
profile.entries[0]?.reasons;   // ["supported-by-claim-and-observation"]
```

`entries` and nested set-like values are sorted, deduplicated, cloned, and
frozen. Omitted constraint sets mean unknown/unbounded; explicit empty arrays
mean observed none and remain present in both the decision and fingerprint.
The profile fingerprint includes claimed, observed, effective, constraints,
requirements, reason codes, authorization-scope identifiers, and evidence. It
excludes observation and expiry timestamps, so refreshing semantically
identical evidence does not invalidate identity while it remains fresh.

## Cache boundary

Cache `CapabilityEvaluationEntry[]`, never `CapabilityProfile`. Effective truth
depends on dynamic state and must be recomputed after every cache read:

```ts doc-test=skip reason="cache and runtime context are application-owned"
const cachedEvidence = await evidenceCache.get(sourceId);

const current = evaluateCapabilityProfile(cachedEvidence, {
  evaluatedAt: new Date().toISOString(),
  policy: currentPolicy,
  environment: currentEnvironment,
  availablePeers: currentlyLoadedPeers,
  authorization: currentAuthorization,
});
```

Metadata, conformance, and probe evidence must include both `observedAt` and an
exclusive `expiresAt`. The caller must pass `evaluatedAt`; omitting it produces
`unknown` with `freshness-not-evaluated`, and an instant at or beyond expiry
produces `unknown` with `evidence-stale`. The evaluator rejects a previously
effective decision passed back as evidence. It performs no network requests,
reads no globals, and supplies no timestamps, so equivalent inputs always
produce the same profile.

SourceSchemaV2 identity is evidence, not a separate evaluator dependency. Put a
validated schema fingerprint in `CapabilityEvidence.sourceFingerprint` when
the claim or observation depends on that schema. `supportedCrs` values pass
through the same complete CRS and pinned official PROJJSON v0.7 validation
boundary as SourceSchemaV2; shallow kind-only CRS objects are rejected.

Every versioned evaluator object rejects unknown keys, including typo-plus-
valid-key mixtures. Inputs are snapshotted from own enumerable data properties
without consulting inherited prototype fields or invoking accessors. Synchronous
work is bounded to 256 entries, 64 evidence records per entry, 1,024 values per
set, a 2 MiB/65,536-node profile graph, 256 KiB extension graphs, and 128 KiB
CRS graphs. Depth and size violations throw `TypeError` before canonicalization
or recursive freezing.

## Effective states

| State | Meaning |
| --- | --- |
| `supported` | Claim and observation support the operation and every dynamic gate passes. |
| `unsupported` | The adapter claim or endpoint observation rejects the operation. |
| `unknown` | Claim/observation is unknown, observation was not requested, or freshness cannot be established. |
| `policy-disabled` | Current application policy excludes otherwise supported behavior. |
| `peer-unavailable` | The current environment is ineligible or a required optional peer is absent. |
| `authorization-required` | One or more stable scope identifiers are not currently granted. |
| `authorization-denied` | The current principal is explicitly denied a required scope. |

Every decision contains a stable reason code. Environment, peer, and scope
failures suffix the code with the relevant non-secret identifier. Do not put
tokens, signed URLs, or credentials in evidence references, peer ids, or scope
ids.

## Delivery boundary

This first slice deliberately does not add `source.supports()`, decorate legacy
sources, or integrate `connect()` discovery. Those layers consume this pure
evaluator in later slices. Existing `ReadonlySet` capability behavior remains
unchanged.
