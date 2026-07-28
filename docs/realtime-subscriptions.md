# Realtime Feature State

The `@honua/sdk-js/realtime` entrypoint defines the SDK-side contract for live operational layers. Apps subscribe once to a `RealtimeFeatureTransport` and consume normalized `RealtimeFeatureEvent` values through `RealtimeFeatureState`; they do not branch on SSE, WebSocket, or delta polling protocols in map, table, or detail code.

The full versioned contract — including plan identity, explicit authority state, and cross-scope resume rejection — is ratified in [the snapshot/delta/cursor/resume/plan-identity contract decision](decisions/realtime-snapshot-delta-cursor-resume-plan-identity-contract.md) and exercised by [`test/fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json`](../test/fixtures/realtime/snapshot-delta-cursor-resume-contract.v1.json).

## Subscription Identity

A `RealtimeSubscriptionRequest` identifies the logical live stream with `sourceId`, optional `layerId`, `where`, `fields`, `spatialFilter`, and optional caller-owned `requestId`. Use the same identity when reconnecting the same UI state. Non-identity values such as `metadata`, `signal`, and tracing fields must not change replay semantics.

Use `realtimeSubscriptionKey(request)` when a runtime needs a stable client key for one source/layer/filter subscription:

```ts doc-test=skip reason="partial excerpt requires application host context"
const request = {
  requestId: "incident-ops",
  sourceId: "incidents",
  layerId: "active-incidents",
  where: "status <> 'resolved'",
  fields: ["id", "status", "severity"],
  mode: "snapshot-then-delta",
};

const key = realtimeSubscriptionKey(request);
```

## Cursors And Checkpoints

Events may carry `eventId`, `sequence`, `cursor`, `watermark`, `timestamp`, `deltaToken`, or a normalized `checkpoint`. The reducer copies those values into state and exposes `realtimeResumeCheckpoint(state)` so callers can resume where the backend supports it:

```ts doc-test=skip reason="partial excerpt requires application host context"
const store = createRealtimeFeatureStore();

store.connect(transport, {
  sourceId: "incidents",
  mode: "snapshot-then-delta",
  resumeFrom: savedCheckpoint,
});

const checkpoint = realtimeResumeCheckpoint(store.state);
```

Cursor, watermark, timestamp, sequence, and delta-token support is transport-dependent. A transport declares its contract with `capabilities.resumeModes`, for example `["cursor", "timestamp", "delta-token"]`.

## Event Model

- `snapshot`: initial or resumed feature set, optionally replacing the current set.
- `upsert`: create or update one feature.
- `delete`: remove one feature and retain a tombstone for selection cleanup.
- `delta`: batch upserts and deletes from a polling or replay endpoint.
- `heartbeat`: keepalive with optional checkpoint data.
- `status`: explicit connection status such as `connecting`, `live`, `reconnecting`, `stale`, `offline`, or `closed`.
- `error`: recoverable or terminal transport failure.

The reducer treats `sequence` as stream-wide ordering. Duplicate `eventId` values and events with a sequence less than or equal to `lastSequence` are ignored and counted in `ignoredEventCount`. This keeps map/table/detail state stable when a reconnect replays recent events.

## Lifecycle Semantics

Connection state is visible on `state.status`:

- `connecting`: initial subscribe is in progress.
- `live`: data or heartbeat has been received.
- `reconnecting`: a recoverable transport error or explicit reconnect is in progress.
- `stale`: no heartbeat or event arrived before the caller's staleness threshold.
- `offline`: the adapter knows the client or server is offline.
- `error`: terminal failure; user or app intervention is required.
- `closed`: the handle was closed or the transport completed.

Use `store.checkStale({ staleAfterMs, now })` from the app's timer policy. Recoverable errors keep the store usable and move it to `reconnecting`; terminal error events set `terminalError: true` and leave the last good feature state available for read-only rendering.

## Tombstones And Replay

Deletes remove the live record and write a tombstone keyed by `sourceId:id`. Tombstones allow detail panels, table selections, popups, and linked exploration state to drop archived features even when the delete arrived during replay. A replacement snapshot clears tombstones; an append snapshot or delta only clears tombstones for features that are upserted again.

## Map, Table, And Detail Helpers

Use the projection helpers to keep app code protocol-neutral:

```ts doc-test=skip reason="partial excerpt requires application host context"
const mapFeatures = selectRealtimeFeatures(store.state, { sourceId: "incidents" });
const tableRows = selectRealtimeFeatureRecords(store.state, {
  sourceId: "incidents",
  sort: (left, right) => left.receivedAt - right.receivedAt,
});
const detail = selectRealtimeDetail(store.state, selectedId, { sourceId: "incidents" });
const tombstones = selectRealtimeFeatureTombstones(store.state, { sourceId: "incidents" });
```

Use `reconcileRealtimeSelection(view, state)` with an `ExplorationViewController` to remove deleted or missing features from shared map/table/detail selection.

## honua-server Preset

honua-server exposes live feature changes at `/api/v1/streaming/features`. That endpoint expects `serviceId=` / `layers=` query params (not the default `sourceId=` / `layerId=`) and emits its own feature-change envelopes. The `honuaServerRealtimePreset` packages the matching `encodeRequest` and `decodeEvent` hooks so consumers do not re-write the adapter:

```ts doc-test=compile
import {
  createRealtimeServerSentEventsTransport,
  honuaServerRealtimePreset,
} from "@honua/sdk-js/realtime";

const transport = createRealtimeServerSentEventsTransport({
  url: "https://honua.example/api/v1/streaming/features",
  ...honuaServerRealtimePreset(),
});
```

Or use the convenience factory, which appends the default streaming path to a server origin:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createHonuaServerRealtimeSubscription } from "@honua/sdk-js/realtime";

const transport = createHonuaServerRealtimeSubscription({
  baseUrl: "https://honua.example",
});

store.connect(transport, { sourceId: "incidents", layerId: "0", mode: "snapshot-then-delta" });
```

The preset decodes honua-server feature-change envelopes (`{ op: "insert" | "update" | "delete", featureId, feature, ... }`, batched under `changes` or inlined) into SDK `delta` events, carrying `serviceId` through as the event `sourceId`. Status, heartbeat, and error envelopes that already use the SDK vocabulary pass through unchanged. The default `sourceId=` / `layerId=` encoder remains the transport default; the preset is opt-in.

## Bounded, Resumable Transports (#557)

`sse.ts` and `websocket.ts` are raw wire adapters: they open exactly one
connection per `subscribe()` call, decode the default JSON event vocabulary
(or a custom `encodeRequest`/`decodeEvent` pair, as with the honua-server
preset), and never reconnect on their own. `createResumableRealtimeTransport`
wraps either one (or a custom `RealtimeFeatureTransport`) with the
[resumable delivery gate](decisions/realtime-snapshot-delta-cursor-resume-plan-identity-contract.md),
reconnect ownership, a heartbeat timeout, and redacted telemetry — closing
the "automatic SSE/WebSocket reconnection" gap called out in
[the resume doc](realtime-resume.md#scope-and-remaining-work).

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createResumableServerSentEventsTransport,
  createRealtimeFeatureStore,
} from "@honua/sdk-js/realtime";

const transport = createResumableServerSentEventsTransport(
  { url: "https://honua.example/api/v1/streaming/features" },
  {
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
    heartbeatTimeoutMs: 30_000,
    reconnect: { maxAttempts: 8, baseDelayMs: 250, maxDelayMs: 30_000 },
    onTelemetry: (telemetry) => reportRealtimeTelemetry(telemetry),
  },
);

const store = createRealtimeFeatureStore();
store.connect(transport, { sourceId: "incidents", mode: "snapshot-then-delta" });
```

`createResumableWebSocketTransport` is the same shape over `websocket.ts`.
The wrapped transport still satisfies `RealtimeFeatureTransport`, so it
composes with `createRealtimeFeatureStore.connect(...)` exactly like a raw
adapter — the store never has to know reconnect is happening underneath it.

Behavior:

- **Resume only with a valid scoped cursor (REQ-003).** Every reconnect asks
  the delivery gate whether its current checkpoint is still authoritative
  (`phase !== "resnapshot-required"`); only then does the next connection
  attempt carry `resumeFrom`. A detected gap — a transport-reported
  `transport-gap`/`cursor-expired`/`resume-unsupported` failure, a
  gate-detected sequence gap, buffer overflow, or a heartbeat timeout —
  always reconnects with a fresh snapshot request instead.
- **Bounded queue, explicit overflow.** `maxPendingEvents` (delegated to the
  gate) bounds in-flight delivery; exceeding it forces a fresh-snapshot
  reconnect rather than silently dropping an event.
- **Reconnect is bounded and fails closed.** `reconnect.maxAttempts`
  (default 8) caps consecutive reconnect attempts with exponential backoff
  and jitter (`computeReconnectDelayMs`); exhausting them surfaces a
  terminal `HonuaRealtimeResumeError` instead of retrying forever. An
  unrecognized (non-SDK) or non-retryable transport failure fails closed
  immediately, on the first attempt, with no guessed retry.
- **Idempotent disposal.** The returned handle's `close()`, an external
  `AbortSignal`, and an unrecoverable failure all route through the same
  one-time teardown: timers, the active connection, and the delivery gate
  all stop exactly once.
- **Redacted telemetry.** `onTelemetry` receives
  `deriveRealtimeContractAuthority`'s explicit `replaying`/`live`/`stale`/
  `terminal` state, reconnect/duplicate/gap/overflow counters, and a
  `redactRealtimeCheckpoint` projection of the current checkpoint — never a
  raw cursor, watermark, or delta-token.

## Adapter Expectations

SSE adapters should emit `snapshot` or `delta` after open, `heartbeat` for server keepalives, `status: "reconnecting"` before retry, and `error` only when the stream cannot recover. WebSocket adapters should use the same event vocabulary for server messages and close codes. Delta polling adapters should emit `delta` batches, preserve server ordering, and pass cursor/timestamp/delta-token checkpoints through `checkpoint`.

Metadata and schemas can use platform metadata caching. Live feature state should be driven by checkpoint semantics rather than a long-lived feature-result cache.
