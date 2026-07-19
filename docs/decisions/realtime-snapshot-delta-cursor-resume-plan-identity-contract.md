# Realtime snapshot, delta, cursor, resume, and plan-identity contract

Status: **accepted** on 2026-07-18 for
[`honua-sdk-js#556`](https://github.com/honua-io/honua-sdk-js/issues/556),
parent epic [`honua-sdk-js#393`](https://github.com/honua-io/honua-sdk-js/issues/393).
This decision ratifies the SDK-side realtime contract as production surface
under `@honua/sdk-js/realtime` and closes three concrete gaps against it
(plan identity, explicit authority state, deterministic/redacted
serialization). It does not implement a transport
([`honua-sdk-js#557`](https://github.com/honua-io/honua-sdk-js/issues/557)),
change a renderer, or require a live server.

The normative surface is production TypeScript, not a design-only proposal:
[`src/realtime/resumable.ts`](../../src/realtime/resumable.ts) (the durable
delivery gate), [`src/realtime/reducer.ts`](../../src/realtime/reducer.ts)
(pure snapshot/delta/tombstone reduction), and
[`src/realtime/contract.ts`](../../src/realtime/contract.ts) (plan identity,
authority, and redaction added by this decision). Acceptance evidence is the
fixture at
[`test/fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json`](../../test/fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json)
run by
[`test/realtime-contract-fixtures.test.ts`](../../test/realtime-contract-fixtures.test.ts),
plus [`test/realtime-contract.test.ts`](../../test/realtime-contract.test.ts)
and [`test/realtime-resumable.test.ts`](../../test/realtime-resumable.test.ts).
If prose disagrees with those files, the compiled/tested code wins and this
document must be corrected in the same change.

## Why this was blocked, and why it no longer is

This issue carried a `blocked` label naming three blockers, all now closed:
[`#523`](https://github.com/honua-io/honua-sdk-js/issues/523) (vendor-neutral
source schema v2), [`#525`](https://github.com/honua-io/honua-sdk-js/issues/525)
(claimed/observed/effective capability truth), and
[`#530`](https://github.com/honua-io/honua-sdk-js/issues/530) (structured
plan cost/cache/fidelity/provenance). The label also named the external
[`honua-server#2428`](https://github.com/honua-io/honua-server/issues/2428)
("Promote Real-time feature streams to GA"). That issue is closed too; it
tracked hardening an experimental server-side feature-stream flag
(`Capabilities:Experimental:realtime.feature-streams:Enabled`) for cursor
durability, backpressure, and reconnect — the same concerns this document
covers client-side. Because this is a *design/contract* issue, not a
transport issue, none of the four blockers gate it: the SDK can define and
test versioned snapshot/delta/cursor/resume/plan-identity semantics against
fixtures without a running server. The concrete server-side gap that
remains, tracked for #557 rather than this issue, is a shared conformance
suite that exercises this contract against a real (or recorded) honua-server
stream; no such suite exists yet, and none is claimed here.

## Decision summary

A realtime subscription's resume identity, delivery ordering, and observable
authority are normative, versioned, and independent of transport:

1. **Snapshot and delta are the only data-bearing envelopes.** A `snapshot`
   establishes or replaces the live set; `upsert`/`delete`/`delta` mutate it.
   Every one may carry `cursor`, `watermark`, `timestamp`, `sequence`, and
   `deltaToken` resume positions, redundantly at the top level and inside a
   nested `checkpoint`; a mismatch between the two is a protocol violation,
   not a merge.
2. **Ordering and deduplication are sequence-driven.** Only a trustworthy,
   contiguous, safe-integer `sequence` on every snapshot/delta advances a
   checkpoint. A sequence at or below the last accepted one is a silent
   duplicate (covers exact replays and reordered late delivery alike); a
   sequence beyond `last + 1` is a `sequence-gap` that stops delivery.
   Event-id reuse at a new sequence is rejected the same way. Cursor-only or
   delta-token-only protocols without a trustworthy sequence must declare
   resume unsupported rather than have the SDK invent one.
3. **Delete is a tombstone, not a silent removal.** `reducer.ts` writes a
   keyed tombstone (`sourceId:id`) on every delete so selection, detail, and
   popup state can drop archived features even when the delete is observed
   during replay; a later upsert of the same id clears its tombstone. A
   `replace: true` snapshot clears all tombstones; an append snapshot or
   delta clears a tombstone only for ids it re-upserts.
4. **Resume requires exact identity, never inference.** A durable checkpoint
   (`honua.realtime-checkpoint@1`) binds every resume position to a
   `honua.realtime-resume-context@1`: `sourceId`, `sourceVersion`,
   `schemaVersion`, `queryFingerprint`, and `authorizationScopeFingerprint`.
   Any mismatch on any one of those five fields — a different source, a
   superseded source version, a schema change, a different accepted
   query/plan, or a different authorization scope — is `resnapshot-required`
   with an explicit compatibility code
   (`evaluateRealtimeCheckpoint`/`RealtimeCheckpointCompatibilityCode`).
   **No cursor or delta is ever accepted across a source, query, schema, or
   authorization-scope boundary.**
5. **Plan identity binds `queryFingerprint` to the query planner, not a
   caller string.** `realtimePlanFingerprint(plan)` reads the accepted
   `QueryExecutionPlan`'s own trusted `fingerprint` field — the same
   canonical, credential-free content hash already used for plan cache
   identity (`queryPlanCacheKey`), satisfying `hashQueryPlan(plan) ===
   plan.fingerprint` for every plan `explainQuery`/`parseQueryPlan`
   produce. That fingerprint already folds in `capabilityPolicy` and
   `fallback`, so binding to it satisfies "bind to policy" per REQ-003
   without a second fingerprint field. `assertRealtimePlanIdentity(context,
   plan)` throws the existing `query-changed` /
   `realtime.checkpoint.invalid` taxonomy on mismatch — the identical
   failure mode a hand-written `queryFingerprint` mismatch already produced,
   now checkable against a real accepted plan instead of an opaque string a
   caller could get wrong. This reads the already-trusted field rather than
   re-deriving it through `hashQueryPlan`: plan *integrity* (that the
   fingerprint actually matches the plan's content) is the query planner's
   trust boundary, verified once against every protocol compiler when the
   plan is built or reloaded. Re-verifying it here would import DuckDB,
   gRPC, GeoServices, OGC, OData, and WFS compilers — several hundred KB —
   into `@honua/sdk-js/realtime` for a check that already happened; only
   `QueryExecutionPlan`'s type is imported, never `planner.js`.
6. **Authority is one explicit derived value, not an inference from reason
   codes.** `deriveRealtimeContractAuthority(resumableState, options)`
   projects `phase` (plus checkpoint age against a caller `staleAfterMs`)
   into exactly one of `replaying | live | stale | terminal` plus an
   `authoritative: boolean`. `awaiting-snapshot`, `resuming`, and
   `resnapshot-required` are all `replaying`/unauthoritative — nothing is
   safe to render as ground truth. `live` is authoritative and fresh;
   `stale` is authoritative but aged past the caller's threshold; `terminal`
   (`error`/`closed`) keeps `authoritative: true` only if a checkpoint
   already existed, so a UI can keep showing last-known-good state
   read-only without confusing it with live data.
7. **Durable serialization is deterministic; log/telemetry serialization is
   redacted.** `serializeRealtimeCheckpoint` produces canonical
   (sorted-key) JSON — two checkpoints with identical accepted content
   serialize byte-identically regardless of construction order, which
   content-addressed storage and cross-process diffing require.
   `redactRealtimeCheckpoint` / `serializeRedactedRealtimeCheckpoint`
   produce a projection safe for logs: `context` stays in the clear because
   every one of its fields is already an opaque fingerprint, never a
   credential; `resume.cursor`, `resume.watermark`, and `resume.deltaToken`
   are replaced with a deterministic SHA-256 digest (correlatable across log
   lines, never reversible to the raw value); `recentEventIds` collapses to
   a count.
8. **Cancellation, backpressure, and terminal error are explicit and
   bounded.** `maxPendingEvents` bounds the applying event plus queued
   work; overflow aborts the active delivery, drains the queue as
   `resnapshot-required`, and refuses further ordinary deltas — one
   replacement snapshot is still allowed through as the sole recovery path.
   Every subscription owns a lifecycle `AbortSignal`; consumer, delivery,
   and checkpoint-save failures set `phase: "error"` and stop delivery
   without silently dropping or duplicating the last accepted checkpoint.
   The gate never reconnects a transport itself — that ownership stays with
   the transport adapter (#557), which projects an expired cursor, an
   unsupported resume mode, or a detected gap through
   `requireResnapshot(...)`.

## Scope and non-goals

In scope for this decision: the versioned envelope and checkpoint shapes,
the resumable delivery state machine, tombstone semantics, the compatibility
matrix, plan-identity binding, the authority projection, and deterministic/
redacted serialization — all transport-neutral, all covered by fixtures.

Not in scope, and not claimed: SSE/WebSocket/OData-delta transport adapters
and their reconnect/backoff behavior (#557); renderer, cache, or
columnar-batch patch integration (#558+); a shared cross-transport
conformance suite against a live honua-server stream; server-side capability
discovery for which `resumeModes` a given source actually supports.

## Contract fixtures

[`test/fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json`](../../test/fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json)
is the portable (non-TypeScript-specific) description of accepted behavior,
run by
[`test/realtime-contract-fixtures.test.ts`](../../test/realtime-contract-fixtures.test.ts):

- `deliveryScenarios`: `duplicate-sequence`, `reordered-delta-arrives-late`,
  `sequence-gap-requires-resnapshot`, `expired-cursor-requires-resnapshot` —
  each a full step-by-step event script against
  `createResumableRealtimeSubscription`, asserting delivery status/reason at
  every step and the final phase.
- `compatibilityScenarios`: `source-changed`, `query-changed`,
  `source-version-changed`, `schema-version-changed`,
  `authorization-scope-changed` — each proves `evaluateRealtimeCheckpoint`
  rejects the mismatched scope with the exact compatibility code, and that a
  subscription constructed against the mismatched context never applies a
  delta (`applied` stays empty).
- `deleteScenario`: snapshot with two features, a delta that deletes one, and
  a later upsert that reopens it — proves the tombstone appears, the record
  disappears, and the tombstone clears again through `reduceRealtimeFeatureState`.

`test/realtime-contract.test.ts` covers what a JSON fixture cannot express
directly: `realtimePlanFingerprint`/`assertRealtimePlanIdentity` against a
real `explainQuery` plan, every `deriveRealtimeContractAuthority` state
transition (including the `staleAfterMs` boundary), and that redacted
serialization never contains a raw cursor/watermark/delta-token substring
while remaining deterministic and stable-key-ordered.

## Compatibility and migration

`RealtimeResumeContextV1.queryFingerprint` keeps its `string` type — it was
already conventionally `sha256:...`-prefixed in existing tests and docs — so
this decision adds `realtimePlanFingerprint`/`assertRealtimePlanIdentity` as
new, additive exports rather than narrowing an existing public field type.
Callers who already computed their own accepted-query fingerprint are
unaffected; callers with an `explainQuery` plan available should adopt
`realtimePlanFingerprint(plan)` going forward so plan identity — including
capability policy and fallback policy — is bound by construction instead of
by convention. `deriveRealtimeContractAuthority`,
`redactRealtimeCheckpoint`, `serializeRealtimeCheckpoint`, and
`serializeRedactedRealtimeCheckpoint` are new exports with no prior surface
to migrate.

## Follow-on work

- [`#557`](https://github.com/honua-io/honua-sdk-js/issues/557): bounded
  SSE/WebSocket transports against this contract.
- [`#558`](https://github.com/honua-io/honua-sdk-js/issues/558)–[`#560`](https://github.com/honua-io/honua-sdk-js/issues/560):
  renderer/cache/columnar-batch and sample-app integration once a transport
  exists.
- A shared cross-transport conformance suite against honua-server's
  `realtime.feature-streams` capability, once that capability is generally
  available server-side, is explicitly deferred rather than claimed here.
