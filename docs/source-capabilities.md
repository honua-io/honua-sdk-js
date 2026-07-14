# Source capability profiles

> **Experimental.** `@honua/sdk-js/source-capabilities` is a focused preview
> surface. It does not change the legacy `Source.capabilities` set and does not
> perform discovery or execution.

The capability evaluator keeps three different statements separate:

- `claimed` is the adapter default or an explicit service declaration;
- `observed` is metadata, conformance, or probe evidence, including explicit
  `unknown` and `not-observed` states;
- `effective` is recomputed from those two truths plus current application
  policy, runtime environment, optional peers, and authorization.

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
  environment: "browser",
  authorization: { grantedScopes: ["dataset:parcels:read"] },
});

profile.entries[0]?.effective; // "supported"
profile.entries[0]?.reasons;   // ["supported-by-claim-and-observation"]
```

`entries` and nested set-like values are sorted, deduplicated, cloned, and
frozen. The profile fingerprint includes claimed, observed, effective,
constraints, reason codes, authorization-scope identifiers, and evidence. It
excludes only observation timestamps, so refreshing the same evidence does not
invalidate semantic identity.

## Cache boundary

Cache `CapabilityEvaluationEntry[]`, never `CapabilityProfile`. Effective truth
depends on dynamic state and must be recomputed after every cache read:

```ts doc-test=skip reason="cache and runtime context are application-owned"
const cachedEvidence = await evidenceCache.get(sourceId);

const current = evaluateCapabilityProfile(cachedEvidence, {
  policy: currentPolicy,
  environment: currentEnvironment,
  availablePeers: currentlyLoadedPeers,
  authorization: currentAuthorization,
});
```

The evaluator rejects a previously effective decision passed back as evidence.
It performs no network requests, reads no globals, and supplies no timestamps,
so equivalent inputs always produce the same profile.

SourceSchemaV2 identity is evidence, not a separate evaluator dependency. Put a
validated schema fingerprint in `CapabilityEvidence.sourceFingerprint` when
the claim or observation depends on that schema. The subpath imports schema
types only; it does not retain the SourceSchemaV2 validator at runtime.

## Effective states

| State | Meaning |
| --- | --- |
| `supported` | Claim and observation support the operation and every dynamic gate passes. |
| `unsupported` | The adapter claim or endpoint observation rejects the operation. |
| `unknown` | Claim or observation is unknown, or observation was not requested. |
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
