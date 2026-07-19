# Resumable realtime delivery

The `@honua/sdk-js/realtime` subpath includes an opt-in, transport-neutral
delivery gate for snapshot-plus-delta streams. It sits between a transport and
the existing realtime reducer/store. The gate does not open or reconnect a
network transport; it decides whether an event is safe to apply and whether a
durable cursor can resume the exact accepted subscription.

See
[the snapshot/delta/cursor/resume/plan-identity contract decision](decisions/realtime-snapshot-delta-cursor-resume-plan-identity-contract.md)
for the normative, fixture-backed version of everything below, plus plan
identity (`realtimePlanFingerprint`), explicit authority state
(`deriveRealtimeContractAuthority`), and deterministic/redacted checkpoint
serialization (`serializeRealtimeCheckpoint`, `redactRealtimeCheckpoint`).

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createRealtimeFeatureStore,
  createResumableRealtimeSubscription,
} from "@honua/sdk-js/realtime";

const featureStore = createRealtimeFeatureStore();
const delivery = await createResumableRealtimeSubscription({
  context: {
    kind: "honua.realtime-resume-context",
    version: 1,
    sourceId: "incidents",
    queryFingerprint: acceptedPlan.fingerprint,
    sourceVersion: "incident-snapshot-v7",
    schemaVersion: "incident-schema-v3",
    authorizationScopeFingerprint: aclFingerprint,
  },
  checkpointStore: durableCheckpointStore,
  apply: (event, signal) => {
    if (signal.aborted) return;
    featureStore.apply(event);
  },
});

transportObserver.next = (event) => {
  if (event.type === "snapshot" || event.type === "delta" || event.type === "upsert" || event.type === "delete") {
    void delivery.enqueue(event);
  }
};
```

## Safety model

A `honua.realtime-checkpoint@1` binds all resume positions to:

- source identity and source version;
- accepted query/plan fingerprint;
- schema version;
- an opaque authorization-scope fingerprint;
- the last contiguous sequence plus available cursor, watermark, timestamp,
  and delta-token positions;
- a bounded recent event-id window.

Changing any bound identity produces `resnapshot-required`; the SDK never
silently reuses the cursor. A new subscription without a compatible checkpoint
also requires a replacement snapshot before deltas can apply.

Adapters project a server-expired cursor, an unsupported resume mode, or a
transport-detected gap through `delivery.requireResnapshot(...)`. That method
invalidates queued work and accepts only a replacement snapshot next; it does
not silently restart from the newest delta.

After a baseline exists, only the next contiguous safe-integer sequence can
advance it. Older sequences are reported as duplicates. Missing sequences,
conflicting top-level/nested checkpoint fields, or reuse of a recent event id
at a new sequence stop delivery and require a replacement snapshot. A
replacement snapshot received during ordinary live delivery must advance the
existing sequence; a stale or equal snapshot cannot regress the baseline. A
replacement snapshot may establish a lower sequence only after an explicit
`requireResnapshot(...)` transition, which marks a deliberate new recovery
epoch. Accepted replacement snapshots reset the bounded event-id window.

`enqueue` treats transport input as untrusted at runtime. Only snapshot,
upsert, delete, and delta discriminators reach the consumer. The SDK captures
event identity and resume metadata synchronously, projects only cursor,
watermark, timestamp, sequence, and delta-token fields into the versioned
checkpoint envelope, and drops unrelated fields before application or
persistence. Caller mutation after enqueue therefore cannot change durable
deduplication identity, and credentials or adapter metadata cannot hitchhike
inside a saved checkpoint.

The persisted recent-event-id history defaults to 256 entries and has an
absolute 4,096-entry safety ceiling. Oversized loaded histories are rejected
before their elements are scanned; accepted histories are copied directly from
their configured bounded tail.

This first gate requires a trustworthy monotonic sequence on every snapshot or
delta. Cursor-only and delta-token-only protocols are not silently assigned a
client sequence: their future adapters must obtain an ordering guarantee from
the server or report resume as unsupported and resnapshot.

## Backpressure and cancellation

`maxPendingEvents` bounds the applying event plus queued data events (default
64). Overflow aborts the active delivery, resolves queued work as
`resnapshot-required`, and refuses more deltas. One replacement snapshot may
wait behind an abort-ignoring consumer because it is the only recovery path;
ordinary data remains bounded. Consumers should honor the supplied
`AbortSignal` and make application idempotent, because JavaScript cannot undo a
side effect already performed by a callback that ignores cancellation.

Closing or aborting the gate prevents any later result from advancing its
checkpoint. Consumer errors leave the prior checkpoint unchanged. Checkpoint
save errors are explicit: the in-memory accepted position remains visible with
`checkpointPersisted: false`, phase becomes `error`, and no further events are
accepted by that gate.

Without a `checkpointStore`, accepted checkpoints remain available in memory
but `checkpointPersisted` stays false. Callers may persist them as part of their
own atomic application transaction; the SDK does not claim durability it did
not observe.

Checkpoint persistence occurs after successful consumer application. This is
an at-least-once boundary, not a transaction spanning an arbitrary application
store and checkpoint database. Applications that require atomic exactly-once
effects must persist their materialized state and checkpoint transactionally,
or use event ids/versions to make replay idempotent.

## Bounded, reconnecting transports (#557)

`createResumableRealtimeTransport` (and the `createResumableServerSentEventsTransport` /
`createResumableWebSocketTransport` convenience factories) wrap a raw
`RealtimeFeatureTransport` — `sse.ts` or `websocket.ts` — with this gate, plus
reconnect ownership, a heartbeat/liveness timeout, and redacted telemetry. See
[`docs/realtime-subscriptions.md`](realtime-subscriptions.md#bounded-resumable-transports-557)
for usage. That module is the transport adapter this document's "Scope and
remaining work" section originally deferred: it owns reconnect/backoff and
projects a detected gap through `requireResnapshot(...)` on the caller's
behalf, so application code enqueuing events directly against
`createResumableRealtimeSubscription` (as shown above) remains the
lower-level, transport-neutral building block for callers that want to own
reconnect themselves.

## OData v4 delta-link pull adapter (#558)

`createOdataDeltaTransport` (`src/realtime/odata-delta.ts`) is a pull-based
`RealtimeFeatureTransport`, not a socket transport: it polls an OData v4
entity set's `@odata.deltaLink` on a caller-configured interval instead of
holding an open connection. It follows `@odata.nextLink` pages to establish
an initial snapshot (sending `Prefer: odata.track-changes`), then polls the
resulting delta link, normalizing `@removed` / `@odata.removed` entries into
deletes and failing explicitly — rather than silently dropping or
misreading them — on OData relationship (link) delta entries, which are out
of scope. Every `@odata.nextLink` / `@odata.deltaLink` it follows, and any
resumed `resumeFrom.deltaToken`, must resolve to the exact origin and
collection path it was configured for; a foreign link is rejected instead of
followed. An expired or rejected delta link (HTTP 410 by default, overridable
via `isDeltaLinkExpiredResponse`) is recovered by re-running a full snapshot
cycle — an explicit resnapshot, bounded by `maxConsecutiveResnapshots` so a
server that keeps rejecting the token cannot loop forever. See
[`docs/realtime-subscriptions.md`](realtime-subscriptions.md#odata-v4-delta-link-pull-adapter-558)
for the honesty model behind its `capabilities.kind: "polling"` /
`onPoll` telemetry, and why it does not compose with
`resumable-transport.ts`'s reconnect wrapper.

## Scope and remaining work

This is the first production slice of issue
[#393](https://github.com/honua-io/honua-sdk-js/issues/393), not completion of
the full workstream. It does not claim:

- protocol-feed reconnection beyond SSE, WebSocket (`resumable-transport.ts`,
  #557), and OData delta-link polling (`odata-delta.ts`, #558);
- cursor-only protocol adaptation where no trustworthy ordering sequence is
  available;
- server support for cursor retention or expiry negotiation;
- renderer, cache, columnar-batch, or offline-store patch integration;
- a shared cross-transport conformance suite against a live honua-server
  stream.

Adapters should declare unsupported resume behavior before subscription when
the protocol can determine it. Expired server cursors must be projected as an
explicit replacement-snapshot transition rather than fixture fallback or an
unverified continuation.
