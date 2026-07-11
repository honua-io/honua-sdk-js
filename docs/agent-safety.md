# Safe agent plan boundary

`@honua/sdk-js/agent-safety` is an experimental, deterministic trust boundary
between untrusted plan proposals and host-owned effect execution. It validates
plain runtime JavaScript values, produces an immutable dry run and effect
budget, binds a reviewer signature to the exact plan and policy, revalidates
current source context, and signs/verifies execution evidence.

The module never invokes a model, tool, source, renderer, subscription, or job.
An accepted approval is evidence for a host executor; it is not an executor.
`@honua/sdk-js/agent-tools` remains the runtime action adapter, and
`@honua/sdk-js/query-planner` remains the source of query-plan fingerprints.

## Plan and policy

Every step declares its tool, effect, fields, row and byte ceilings, exact query
plan fingerprint, canonical parameters digest, canonical operation-input digest,
and source binding. The operation digest is recomputed from the visible tool,
effect, source ID, query-plan identity, fields, and parameters digest, so those
claims cannot disagree. The source binding includes schema/source
versions, stable authorization-scope identifiers, data mode, observation time,
attribution, and credential-free citations. The plan also identifies its actor
and can identify the proposing provider/model. Do not put prompts, credentials,
tokens, or tool arguments in this envelope.

```ts
import {
  dryRunAgentPlan,
  issueAgentApproval,
  verifyAgentStepAuthorization,
} from "@honua/sdk-js/agent-safety";

const policy = {
  allowedTools: ["query"],
  // Omission is deliberately read-only. Other effects require explicit opt-in.
  allowedEffects: ["read"],
  sources: {
    incidents: {
      fields: ["OBJECTID", "status"],
      authorizationScope: ["incidents:read"],
      schemaVersions: ["schema-7"],
      sourceVersions: ["snapshot-9"],
      dataModes: ["live"],
      maxProvenanceAgeMs: 60_000,
    },
  },
  maxSteps: 1,
  maxRows: 500,
  maxBytes: 2_000_000,
};
const dryRun = dryRunAgentPlan(untrustedPlan, policy, {
  now: "2026-07-10T20:00:00.000Z",
});

// The signer is supplied by a trusted host. Keep keys out of browser bundles.
const approval = await issueAgentApproval(
  dryRun,
  policy,
  {
    id: "approval-42",
    approver: "reviewer@example.test",
    issuedAt: "2026-07-10T20:00:00.000Z",
    expiresAt: "2026-07-10T20:05:00.000Z",
    maxRows: 100, // single-step shorthand; may narrow, never widen
  },
  hostSigner,
);

// Immediately before an effect, compare exact current bindings and operation
// parameters, then atomically consume the single-use approval step.
const authorization = await verifyAgentStepAuthorization(
  dryRun,
  policy,
  approval,
  hostVerifier,
  { sources: { incidents: currentIncidentSourceBinding } },
  "query-incidents",
  exactQueryPlanInput,
  hostAtomicApprovalUseStore,
);
// Execute only authorization.operation (the frozen validated snapshot), never
// the original mutable exactQueryPlanInput object.
```

`dryRunAgentPlan` rejects unknown properties, accessors, non-plain objects,
invalid or duplicate values, non-canonical timestamps, credentials in citation
URLs, conflicting bindings, unknown tools/sources, operation-input drift,
disallowed effects or fields, scope/version/data-mode drift, stale provenance,
and row/byte overflow.
Its default effect allowlist is only `read`.

## Signatures, cancellation, and receipts

Signer/verifier interfaces carry an algorithm and key ID and receive canonical
JSON. Hosts can back them with WebCrypto, KMS, HSM, or a remote same-origin
signing service. Approval and receipt verifiers require the configured
algorithm/key ID to match the envelope. Signatures cover the canonical payload;
SHA-256 envelope digests provide deterministic identity and diagnostics.

All operations accept `AbortSignal`. Cancellation is checked before validation,
across awaited signer/verifier boundaries, and before a successful value is
returned. Aborted work cannot return a usable approval or receipt.

Approval envelopes are explicitly single-use per step. The required
`AgentApprovalUseConsumer` must atomically consume the approval-digest/step key;
returning anything except `true` denies authorization. This host-owned replay
store is the concurrency boundary that prevents duplicate mutation, publish,
share, subscription, and job effects.

Signed approvals contain a row/byte allocation for every step. Multi-step
approvals must use `stepLimits` when narrowing; an ambiguous aggregate-only
narrowing is rejected. Step authorization returns a copy with those narrowed
limits, not the wider proposed limits.

After a separately authorized host executor finishes, it can call
`issueAgentExecutionReceipt` with bounded outcome evidence. The helper first
re-verifies approval and current context, refuses evidence beyond approved
row/byte ceilings, and signs the plan, policy, source bindings, approval,
step ID, operation-input digest, atomic-use digest, outcome, result digest, and
completion time. `verifyAgentExecutionReceipt`
repeats those checks deterministically and rejects any modified field. Receipt
verification evaluates the historical approval at the signed completion time,
so an authentic receipt remains verifiable after approval expiry. Supply the
bound historical source context, not newly discovered current metadata.

Trust-boundary values should come from JSON parsing or an equivalent structured
clone. Indexed accessors and object accessors are rejected without invocation,
and values are descriptor-snapshotted before use. JavaScript `Proxy` traps are
executable by language-level reflection itself and cannot be made inert by a
library validator; do not pass Proxies across this boundary. Citation URLs must
be HTTPS, contain no user info, query, or fragment, and should use public stable
resource paths rather than secret-bearing opaque paths.

## Deliberate boundaries

This is one production vertical slice of #397, not completion of that XL
workstream. It does not translate natural language, run tools, provide a model
adapter, manage signing keys, parse query predicates to infer field use, perform
compensating actions, implement an audit sink, or establish SDK/CLI/MCP execution
parity. Hosts must declare every field a step may read or write; query compiler
integration can automate that declaration in a later slice.
