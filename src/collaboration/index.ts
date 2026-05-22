/**
 * Saved-map collaboration client contract.
 *
 * The public session API is transport-neutral so Portal can use the fixture
 * transport today and a WebSocket/WebTransport adapter when the server
 * endpoints land.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export {
  HonuaSavedMapCollaborationClient,
  HonuaSavedMapCollaborationSession,
  createHonuaSavedMapCollaboration,
  reduceSavedMapCollaborationSnapshot,
} from "./client.js";
export type { HonuaSavedMapCollaborationClientOptions } from "./client.js";
export {
  HonuaCollaborationError,
  isHonuaCollaborationError,
} from "./errors.js";
export {
  FixtureSavedMapCollaborationTransport,
  createFixtureSavedMapCollaborationTransport,
} from "./fixture.js";
export type { FixtureSavedMapCollaborationTransportOptions } from "./fixture.js";
export type {
  SavedMapCollaborationCapabilities,
  SavedMapCollaborationConnectionStatus,
  SavedMapCollaborationEnvelope,
  SavedMapCollaborationErrorCode,
  SavedMapCollaborationErrorEvent,
  SavedMapCollaborationEvent,
  SavedMapCollaborationJoinRequest,
  SavedMapCollaborationJoinResult,
  SavedMapCollaborationObserver,
  SavedMapCollaborationParticipant,
  SavedMapCollaborationParticipantId,
  SavedMapCollaborationReconnectOptions,
  SavedMapCollaborationSessionId,
  SavedMapCollaborationSessionRef,
  SavedMapCollaborationSnapshot,
  SavedMapCollaborationSnapshotListener,
  SavedMapCollaborationSubscriptionHandle,
  SavedMapCollaborationTransport,
  SavedMapCollaborationTransportCapabilities,
  SavedMapCollaborationTransportKind,
  SavedMapCommittedOperation,
  SavedMapCursor,
  SavedMapEditOperation,
  SavedMapFeatureLock,
  SavedMapFeatureLockReleaseRequest,
  SavedMapFeatureLockRequest,
  SavedMapFollowTarget,
  SavedMapId,
  SavedMapOperationReplayRequest,
  SavedMapOperationReplayResult,
  SavedMapOperationSubmitRequest,
  SavedMapSelection,
} from "./types.js";
