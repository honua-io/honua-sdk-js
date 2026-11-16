# Map API changelog

## Unreleased: Map vocabulary

### Breaking changes

- Map APIs use `Map` instead of `SavedMap`: `HonuaSavedMapsClient` → `HonuaMapsClient`,
  `HonuaSavedMap` → `HonuaMap`, `HonuaSavedMapSummary` → `HonuaMapSummary`, and
  `HonuaCreateSavedMapRequest` / `HonuaUpdateSavedMapRequest` → the corresponding `Map` request types.
  `client.savedMaps` is now `client.maps`. Collaboration exports replace `SavedMap` with `Map`,
  including the client, session, transport, fixture and event types; `joinSavedMap` is now `joinMap`.
  See [every renamed export](../vocabulary-renames.md). The old names are removed without aliases.

## Renames

| Old | New |
| --- | --- |
| `FixtureSavedMapCollaborationTransport` | `FixtureMapCollaborationTransport` |
| `FixtureSavedMapCollaborationTransportOptions` | `FixtureMapCollaborationTransportOptions` |
| `HonuaCreateSavedMapRequest` | `HonuaCreateMapRequest` |
| `HonuaSavedMap` | `HonuaMap` |
| `HonuaSavedMapCollaborationClient` | `HonuaMapCollaborationClient` |
| `HonuaSavedMapCollaborationClientOptions` | `HonuaMapCollaborationClientOptions` |
| `HonuaSavedMapCollaborationSession` | `HonuaMapCollaborationSession` |
| `HonuaSavedMapSummary` | `HonuaMapSummary` |
| `HonuaSavedMapsClient` | `HonuaMapsClient` |
| `HonuaUpdateSavedMapRequest` | `HonuaUpdateMapRequest` |
| `SavedMapCollaborationCapabilities` | `MapCollaborationCapabilities` |
| `SavedMapCollaborationConnectionStatus` | `MapCollaborationConnectionStatus` |
| `SavedMapCollaborationEnvelope` | `MapCollaborationEnvelope` |
| `SavedMapCollaborationErrorCode` | `MapCollaborationErrorCode` |
| `SavedMapCollaborationErrorEvent` | `MapCollaborationErrorEvent` |
| `SavedMapCollaborationEvent` | `MapCollaborationEvent` |
| `SavedMapCollaborationJoinRequest` | `MapCollaborationJoinRequest` |
| `SavedMapCollaborationJoinResult` | `MapCollaborationJoinResult` |
| `SavedMapCollaborationObserver` | `MapCollaborationObserver` |
| `SavedMapCollaborationParticipant` | `MapCollaborationParticipant` |
| `SavedMapCollaborationParticipantId` | `MapCollaborationParticipantId` |
| `SavedMapCollaborationReconnectOptions` | `MapCollaborationReconnectOptions` |
| `SavedMapCollaborationSessionId` | `MapCollaborationSessionId` |
| `SavedMapCollaborationSessionRef` | `MapCollaborationSessionRef` |
| `SavedMapCollaborationSnapshot` | `MapCollaborationSnapshot` |
| `SavedMapCollaborationSnapshotListener` | `MapCollaborationSnapshotListener` |
| `SavedMapCollaborationSubscriptionHandle` | `MapCollaborationSubscriptionHandle` |
| `SavedMapCollaborationTransport` | `MapCollaborationTransport` |
| `SavedMapCollaborationTransportCapabilities` | `MapCollaborationTransportCapabilities` |
| `SavedMapCollaborationTransportKind` | `MapCollaborationTransportKind` |
| `SavedMapCommittedOperation` | `MapCommittedOperation` |
| `SavedMapCursor` | `MapCursor` |
| `SavedMapEditOperation` | `MapEditOperation` |
| `SavedMapFeatureLock` | `MapFeatureLock` |
| `SavedMapFeatureLockReleaseRequest` | `MapFeatureLockReleaseRequest` |
| `SavedMapFeatureLockRequest` | `MapFeatureLockRequest` |
| `SavedMapFollowTarget` | `MapFollowTarget` |
| `SavedMapId` | `MapId` |
| `SavedMapOperationReplayRequest` | `MapOperationReplayRequest` |
| `SavedMapOperationReplayResult` | `MapOperationReplayResult` |
| `SavedMapOperationSubmitRequest` | `MapOperationSubmitRequest` |
| `SavedMapSelection` | `MapSelection` |
| `createFixtureSavedMapCollaborationTransport` | `createFixtureMapCollaborationTransport` |
| `createHonuaSavedMapCollaboration` | `createHonuaMapCollaboration` |
| `reduceSavedMapCollaborationSnapshot` | `reduceMapCollaborationSnapshot` |
| `HonuaControlPlaneClient.savedMaps` | `HonuaControlPlaneClient.maps` |
| `HonuaSavedMapCollaborationClient.joinSavedMap()` | `HonuaMapCollaborationClient.joinMap()` |

