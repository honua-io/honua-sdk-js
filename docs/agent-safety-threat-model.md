# Agent-safety threat model

`@honua/sdk-js/agent-safety` is the deterministic trust boundary between
untrusted agent plan proposals and host-owned effect execution, and
`@honua/sdk-js/agent-tools` is the bounded runtime-action surface those plans
ultimately drive. Both entrypoints are in the SDK's **stable tier** (see
[`docs/decisions/agent-surface-stabilization.md`](./decisions/agent-surface-stabilization.md)),
so the contracts described here are semver-protected: security reviews may cite
this document knowing a breaking change to any envelope or verification step
requires a major version.

This document enumerates the threats the surface is designed to stop, the
mechanism that stops each one, and the conformance test that exercises it.
Companion reference: [`docs/agent-safety.md`](./agent-safety.md) (full API
walkthrough) and [`docs/nl-map-control.md`](./nl-map-control.md) (the NL layer
that consumes this boundary end to end).

## Trust boundaries and assumptions

- **The plan proposer is untrusted.** Plans, operations, approvals, contexts,
  evidence, and receipts all enter as `unknown` and are descriptor-snapshotted,
  bounded (`AGENT_SAFETY_HARD_LIMITS`), and frozen before any digest or
  signature check. Accessors are rejected without invocation; `Proxy` inputs
  are out of contract.
- **Key custody and persistence are host-owned.** `AgentEnvelopeSigner` /
  `AgentEnvelopeVerifier` and the atomic `AgentApprovalUseConsumer` replay
  store are host callbacks. The SDK guarantees *what* is signed and verified,
  not *where* keys live.
- **The SDK never invokes an effect on its own.** Dry runs are side-effect
  free; `executeAgentPlanStep` is the single explicit effect boundary and only
  runs a host executor after authorization, single-use consumption, and a
  durable start audit.

## Threats and mitigations

Every threat below is exercised by a committed conformance test; the tests run
in the default `npm test` suite.

### 1. Envelope forgery

**Threat.** An attacker fabricates or alters an approval envelope (or the dry
run it binds to) to authorize a plan no reviewer signed — forging digests,
swapping the approver, or presenting an approval for a different plan/policy.

**Mitigation.** An approval binds `planDigest`, `policyDigest`,
`bindingsDigest`, and `evaluatedAt` to one exact dry run, which is itself
recomputed (`revalidateDryRun`) from the supplied plan and policy — a forged
dry run cannot digest-match. The envelope digest is recomputed over the
canonical unsigned payload, the signer identity (algorithm + key ID) must match
the configured verifier, and the host `verifier.verify` must return exactly
`true`. Any mutated field fails `integrity-failed` or `signature-invalid`
before an effect is possible.

**Tests.**
- `test/agent-safety.test.ts` — "rejects forged dry runs, signature tampering,
  expiry, and context drift"
- `test/agent-safety.test.ts` — "binds the exact plan/policy/context and
  permits only budget narrowing"
- `test/agent-safety.test.ts` — "cannot issue a receipt from public digests
  without host-authenticated consumption evidence"

### 2. Replay (single-use consumption)

**Threat.** A valid, signed approval is presented twice — concurrently or
sequentially — to run the same approved step more than once (duplicate
mutation, publish, job, …).

**Mitigation.** Approvals are `use: "single"` per step. Authorization requires
the host `AgentApprovalUseConsumer` to *atomically* consume the
(approval digest, step ID, input digest) key and return an authenticated
consumption record (nonce, consumption time, opaque token), which the SDK
immediately re-verifies with the same store. A second consumption attempt
returns nothing and fails `policy-denied`; the consumption record is bound into
the receipt so post-hoc verification also proves single use. Expiry
(`expiresAt`, bounded `maxClockSkewMs`) limits the replay window of any stolen
envelope.

**Tests.**
- `test/agent-safety.test.ts` — "binds exact operation input and atomically
  consumes each approved step once"
- `test/agent-execution.test.ts` — "does not invoke an effect after
  start-audit failure, executor mismatch, or replay"
- `test/agent-safety.test.ts` — "rejects forged dry runs, signature tampering,
  expiry, and context drift" (expiry arm)

### 3. Effect-budget bypass

**Threat.** A plan, approval, or execution result exceeds the reviewed
row/byte/step/effect budget — a widened approval, an aggregate that hides a
per-step overrun, an oversized operation payload, or an executor returning more
data than approved.

**Mitigation.** `dryRunAgentPlan` computes a frozen `AgentEffectBudgetV1` and
rejects plans over policy ceilings (which are themselves capped by
`AGENT_SAFETY_HARD_LIMITS`). Approvals may only *narrow* step limits — widening
fails `policy-denied`, multi-step narrowing requires explicit `stepLimits`, and
aggregate `approvedRows`/`approvedBytes` must equal the per-step sums. Operation
parameters are bounded by policy byte/node/depth budgets before the replay
store is touched. Execution evidence and receipts exceeding the approved
per-step rows/bytes are refused before signing and on verification.

**Tests.**
- `test/agent-safety.test.ts` — "binds the exact plan/policy/context and
  permits only budget narrowing"
- `test/agent-safety.test.ts` — "requires explicit per-step allocation when
  narrowing a multi-step approval"
- `test/agent-safety.test.ts` — "enforces the policy operation-parameter budget
  before replay-store consumption"
- `test/agent-safety.test.ts` — "rejects over-budget evidence before receipt
  signing and detects receipt tampering" (over-budget arm)
- `test/agent-execution.test.ts` — "bounds wide results before reading excess
  values and uses one captured array length"

### 4. Receipt tampering

**Threat.** An execution receipt is altered after signing — rows, result
digest, approval binding, step ID, or use digest — to misrepresent what was
executed or how much data was returned; or a receipt is minted from publicly
visible digests without a real authenticated consumption.

**Mitigation.** `issueAgentExecutionReceipt` signs the canonical union of
evidence and the plan/policy/bindings/approval digests; the receipt digest is
recomputed on verification and the receipt signer identity must match the
verifier. `verifyAgentExecutionReceipt` deterministically repeats every
issuance check (budget, binding, consumption authentication via the host
`verify` callback, approval signature, digest equality) and rejects any
modified field. Receipts are append-only evidence: nothing in the SDK mutates
or re-issues one.

**Tests.**
- `test/agent-safety.test.ts` — "rejects over-budget evidence before receipt
  signing and detects receipt tampering"
- `test/agent-safety.test.ts` — "cannot issue a receipt from public digests
  without host-authenticated consumption evidence"
- `test/agent-safety-evidence.test.ts` — "fails closed on plan, discovery,
  capability, and receipt substitution"

### 5. Plan-fingerprint mismatch

**Threat.** The operation a host is about to execute quietly differs from what
the reviewer approved: same step ID and tool but a substituted query-plan body,
different fields, a different source, or drifted parameters — including a
"fingerprint-consistent" forgery where the attacker recomputes content hashes
over altered content.

**Mitigation.** Every plan step carries `queryPlan.fingerprint` (from
`@honua/sdk-js/query-planner`), a canonical `parametersDigest`, and an
`inputDigest` recomputed from the visible tool/effect/source/query-plan/fields
identity — the claims cannot disagree at parse time. At authorization,
`digestAgentOperationInput` recomputes the digest from the *proposed* operation
and requires exact equality with the approved step's digest before the replay
store is consumed; any divergence (id, fingerprint, fields, parameters) fails
`integrity-failed`. The same binding is revalidated when receipts are issued
and verified. In the NL layer, plan execution additionally re-derives effects
and tool identity from plan content, so recomputed-fingerprint forgeries are
rejected there too.

**Tests.**
- `test/agent-safety.test.ts` — "rejects an operation whose query-plan
  fingerprint differs from the approved step"
- `test/agent-safety.test.ts` — "binds exact operation input and atomically
  consumes each approved step once" (query-plan id divergence arm)
- `test/nl-map-control.test.ts` — "rejects a fingerprint-consistent plan whose
  executed call differs from its declared tool" / "…that launders action
  effects as read-only" / "…whose step names an unknown tool"

## Adjacent hardening (context, not primary threats)

- **Context drift** — approvals are re-verified against the *current* source
  bindings (schema/source versions, data mode, provenance freshness); drift
  fails `context-mismatch` ("rejects forged dry runs, signature tampering,
  expiry, and context drift", "rechecks provenance freshness at the execution
  clock").
- **Secret exfiltration through tool results** — the `/agent-tools` executor
  deeply redacts credential-bearing metadata before results reach a model
  (`test/agent-tools.test.ts`), and audit events carry pseudonymous digests
  only (`test/agent-execution.test.ts` — "persists only digests for every
  free-text plan and source identity").
- **Hostile host-callback shapes** — accessors on executors, stores, and
  callbacks are rejected without invocation (`test/agent-execution.test.ts`).

## What this model does not cover

The SDK does not manage signing keys, persist the replay store or audit log,
authenticate approvers, or constrain what a *host-authorized* executor does
with data it legitimately received. Prompt-injection resistance of any LLM
driving the surface is out of scope here; the mitigation posture is that a
compromised model can only propose plans, and every effect still requires a
signed, budgeted, single-use, context-checked approval.
