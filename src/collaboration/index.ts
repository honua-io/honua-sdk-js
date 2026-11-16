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
  HonuaMapCollaborationClient,
  HonuaMapCollaborationSession,
  createHonuaMapCollaboration,
  reduceMapCollaborationSnapshot,
} from "./client.js";
export type { HonuaMapCollaborationClientOptions } from "./client.js";
export {
  HonuaCollaborationError,
  isHonuaCollaborationError,
} from "./errors.js";
export {
  FixtureMapCollaborationTransport,
  createFixtureMapCollaborationTransport,
} from "./fixture.js";
export type { FixtureMapCollaborationTransportOptions } from "./fixture.js";
export type {
  MapCollaborationCapabilities,
  MapCollaborationConnectionStatus,
  MapCollaborationEnvelope,
  MapCollaborationErrorCode,
  MapCollaborationErrorEvent,
  MapCollaborationEvent,
  MapCollaborationJoinRequest,
  MapCollaborationJoinResult,
  MapCollaborationObserver,
  MapCollaborationParticipant,
  MapCollaborationParticipantId,
  MapCollaborationReconnectOptions,
  MapCollaborationSessionId,
  MapCollaborationSessionRef,
  MapCollaborationSnapshot,
  MapCollaborationSnapshotListener,
  MapCollaborationSubscriptionHandle,
  MapCollaborationTransport,
  MapCollaborationTransportCapabilities,
  MapCollaborationTransportKind,
  MapCommittedOperation,
  MapCursor,
  MapEditOperation,
  MapFeatureLock,
  MapFeatureLockReleaseRequest,
  MapFeatureLockRequest,
  MapFollowTarget,
  MapId,
  MapOperationReplayRequest,
  MapOperationReplayResult,
  MapOperationSubmitRequest,
  MapSelection,
} from "./types.js";
