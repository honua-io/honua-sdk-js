# Realtime Feature State

The `@honua/sdk-js/realtime` entrypoint defines the SDK-side contract for live operational layers. Apps subscribe once to a `RealtimeFeatureTransport` and consume normalized `RealtimeFeatureEvent` values through `RealtimeFeatureState`; they do not branch on SSE, WebSocket, or delta polling protocols in map, table, or detail code.

## Subscription Identity

A `RealtimeSubscriptionRequest` identifies the logical live stream with `sourceId`, optional `layerId`, `where`, `fields`, `spatialFilter`, and optional caller-owned `requestId`. Use the same identity when reconnecting the same UI state. Non-identity values such as `metadata`, `signal`, and tracing fields must not change replay semantics.

Use `realtimeSubscriptionKey(request)` when a runtime needs a stable client key for one source/layer/filter subscription:

```ts
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

```ts
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

```ts
const mapFeatures = selectRealtimeFeatures(store.state, { sourceId: "incidents" });
const tableRows = selectRealtimeFeatureRecords(store.state, {
  sourceId: "incidents",
  sort: (left, right) => left.receivedAt - right.receivedAt,
});
const detail = selectRealtimeDetail(store.state, selectedId, { sourceId: "incidents" });
const tombstones = selectRealtimeFeatureTombstones(store.state, { sourceId: "incidents" });
```

Use `reconcileRealtimeSelection(view, state)` with an `ExplorationViewController` to remove deleted or missing features from shared map/table/detail selection.

## Adapter Expectations

SSE adapters should emit `snapshot` or `delta` after open, `heartbeat` for server keepalives, `status: "reconnecting"` before retry, and `error` only when the stream cannot recover. WebSocket adapters should use the same event vocabulary for server messages and close codes. Delta polling adapters should emit `delta` batches, preserve server ordering, and pass cursor/timestamp/delta-token checkpoints through `checkpoint`.

Metadata and schemas can use platform metadata caching. Live feature state should be driven by checkpoint semantics rather than a long-lived feature-result cache.
