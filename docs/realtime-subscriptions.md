# Realtime Feature State

The `@honua/sdk-js/realtime` entrypoint defines the SDK-side contract for live operational layers. It does not require apps to choose SSE, WebSocket, or delta polling directly. A transport adapter emits normalized `RealtimeFeatureEvent` values, and apps consume a reconciled `RealtimeFeatureState`.

## Event Model

- `snapshot`: initial or resumed feature set, optionally replacing the current set.
- `upsert`: create or update one feature.
- `delete`: remove one feature and retain a tombstone for selection cleanup.
- `heartbeat`: keepalive with optional cursor and watermark.
- `status`: explicit connection status such as `connecting`, `live`, `reconnecting`, `stale`, or `closed`.
- `error`: recoverable or terminal transport failure.

Events may carry `eventId`, `sequence`, `cursor`, and `watermark`. The reducer ignores duplicate event IDs and out-of-order sequence values, which keeps map/table/detail state stable during reconnect and replay.

## Store Usage

```ts
import { createRealtimeFeatureStore } from "@honua/sdk-js/realtime";

const store = createRealtimeFeatureStore();
const unsubscribe = store.subscribe((state) => {
  renderRows(Object.values(state.records));
  renderConnectionStatus(state.status, state.cursor, state.watermark);
});

const handle = store.connect(transport, {
  sourceId: "incidents",
  cursor: savedCursor,
});

// Later
handle.close();
unsubscribe();
```

The same store can be driven manually in tests with `store.apply(event)`.

## Linked Exploration Cleanup

Use `reconcileRealtimeSelection(view, state)` with an `ExplorationViewController` to remove deleted or missing features from shared map/table/detail selection.

```ts
import { reconcileRealtimeSelection } from "@honua/sdk-js/realtime";

store.subscribe((state) => {
  reconcileRealtimeSelection(detailView, state, { sourceId: "incidents" });
});
```

Metadata and schemas can still use platform metadata caching. Live feature state should be treated as volatile and driven by cursor/watermark semantics rather than long-lived feature-result cache reuse.
