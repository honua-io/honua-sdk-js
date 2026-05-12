# Saved-Map Collaboration

`@honua/sdk-js/collaboration` defines the SDK-side contract for collaborative saved-map editing. Portal code talks to `HonuaSavedMapCollaborationSession`; transport adapters hide whether the server uses WebSocket, WebTransport, SSE, or a fixture.

```ts
import {
  createFixtureSavedMapCollaborationTransport,
  createHonuaSavedMapCollaboration,
} from "@honua/sdk-js/collaboration";

const collaboration = createHonuaSavedMapCollaboration({
  transport: createFixtureSavedMapCollaborationTransport(),
});

const session = await collaboration.joinSavedMap({
  mapId: "map-ops",
  participantId: "user-123",
  displayName: "Kai",
});

session.subscribe((snapshot) => {
  console.log(snapshot.participants, snapshot.featureLocks);
});

await session.publishCursor({ x: 320, y: 184, sourceId: "parcels" });
```

## Envelope

Server adapters should map each server message to `SavedMapCollaborationEnvelope`:

```ts
{
  envelopeVersion: "honua.saved-map-collaboration.v1",
  mapId: "map-ops",
  eventId: "evt-42",
  sequence: 42,
  cursor: "server-cursor-42",
  serverTime: "2026-05-11T10:00:00.000Z",
  sessionId: "session-a",
  actorId: "user-a",
  event: { type: "cursor", participantId: "user-a", cursor: { x: 10, y: 20 } },
}
```

`sequence` is stream ordering. `cursor` is the server replay token. Consumers keep the latest `snapshot.cursor` and pass it back through `joinSavedMap({ resumeFrom: { cursor } })`, `replayOperations({ afterCursor })`, or `reconnect()`.

## Reconnect

Use `session.disconnect()` when the host detects an interrupted channel but should keep the logical saved-map participant. The snapshot status becomes `stale` and subscriptions remain registered. `session.reconnect()` closes the stale subscription, replays committed operations from the last snapshot cursor by default, merges unseen operations, and opens a fresh subscription:

```ts
session.disconnect();

try {
  const replay = await session.reconnect();
  console.log(replay?.operations.length ?? 0);
} catch (error) {
  if (error instanceof HonuaCollaborationError && error.resyncRequired) {
    await session.leave();
  }
}
```

Pass `reconnect({ replayOperations: false })` when the server channel itself will deliver an authoritative snapshot on subscribe. Pass `afterCursor` or `afterSequence` to override the default resume point.

## Event Shapes

- `snapshot`: authoritative participants, cursors, selections, follow targets, locks, and committed operations.
- `participant-joined` / `participant-left`: session membership.
- `cursor`: participant pointer or map-position update.
- `selection`: participant feature selection.
- `follow`: follow or unfollow another participant.
- `feature-lock-claimed` / `feature-lock-renewed` / `feature-lock-released`: edit lock state.
- `operation-appended`: committed saved-map edit operation with revision, sequence, cursor, and author.
- `status`: connection lifecycle.
- `error`: typed terminal or recoverable collaboration error.

## Errors

`HonuaCollaborationError.code` is one of:

- `permission-denied`
- `unsupported-collaboration`
- `lock-held`
- `stale-cursor`
- `conflict`
- `transport-failure`
- `resync-required`

`stale-cursor` and `resync-required` set `resyncRequired: true`. Portal should request a fresh saved-map collaboration snapshot before allowing more collaborative edits.

## Portal Integration Notes

Use the fixture transport for component and smoke tests until honua-server#971/#972/#973 expose the production transport. Portal should not branch on WebSocket/WebTransport details; only the adapter should decode server frames and call the SDK transport interface.

Typical Portal flow:

1. Join with the saved map id and active user profile.
2. Subscribe to snapshots and render participants, cursors, selections, follow target, locks, and operation status from the current snapshot.
3. Publish cursor/selection/follow events from UI interactions.
4. Claim a feature lock before editing; handle `lock-held` by keeping the feature read-only.
5. Submit saved-map operations with `expectedRevision` when optimistic concurrency is available.
6. On reconnect, call `session.reconnect()` to replay operations from the last cursor. On `resync-required`, discard local collaboration state and join without a resume cursor.
