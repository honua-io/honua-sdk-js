export type MapId = string;
export type MapCollaborationSessionId = string;
export type MapCollaborationParticipantId = string;
export type MapCollaborationTransportKind = "mock" | "websocket" | "webtransport" | "sse" | "custom";

export type MapCollaborationConnectionStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "stale"
  | "closed"
  | "error";

export type MapCollaborationErrorCode =
  | "permission-denied"
  | "unsupported-collaboration"
  | "lock-held"
  | "stale-cursor"
  | "conflict"
  | "transport-failure"
  | "resync-required";

export interface MapCollaborationCapabilities {
  readonly cursors: boolean;
  readonly selections: boolean;
  readonly follow: boolean;
  readonly featureLocks: boolean;
  readonly operations: boolean;
  readonly replay: boolean;
}

export interface MapCollaborationParticipant {
  readonly id: MapCollaborationParticipantId;
  readonly sessionId: MapCollaborationSessionId;
  readonly displayName?: string;
  readonly color?: string;
  readonly permissions?: ReadonlyArray<string>;
  readonly joinedAt: string;
  readonly lastSeenAt?: string;
}

export interface MapCursor {
  readonly x: number;
  readonly y: number;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly mapPoint?: unknown;
  readonly screenPoint?: unknown;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MapSelection {
  readonly ids: ReadonlyArray<string | number>;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly mode?: "replace" | "add" | "remove";
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MapFollowTarget {
  readonly targetParticipantId?: MapCollaborationParticipantId;
  readonly following: boolean;
  readonly updatedAt?: string;
}

export interface MapFeatureLock {
  readonly mapId: MapId;
  readonly featureId: string | number;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly ownerId: MapCollaborationParticipantId;
  readonly sessionId: MapCollaborationSessionId;
  readonly token: string;
  readonly claimedAt: string;
  readonly expiresAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MapEditOperation<TPayload = unknown> {
  readonly id?: string;
  readonly kind: "create" | "update" | "delete" | "style" | "metadata" | "view" | (string & {});
  readonly target?: {
    readonly sourceId?: string;
    readonly layerId?: string | number;
    readonly featureId?: string | number;
  };
  readonly payload: TPayload;
  readonly baseRevision?: number;
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MapCommittedOperation<TPayload = unknown> extends MapEditOperation<TPayload> {
  readonly id: string;
  readonly mapId: MapId;
  readonly revision: number;
  readonly sequence: number;
  readonly cursor: string;
  readonly authorId: MapCollaborationParticipantId;
  readonly submittedAt: string;
}

export interface MapCollaborationSnapshot<TPayload = unknown> {
  readonly mapId: MapId;
  readonly sequence: number;
  readonly cursor?: string;
  readonly capabilities: MapCollaborationCapabilities;
  readonly participants: ReadonlyArray<MapCollaborationParticipant>;
  readonly cursors: Readonly<Record<MapCollaborationParticipantId, MapCursor>>;
  readonly selections: Readonly<Record<MapCollaborationParticipantId, MapSelection>>;
  readonly followTargets: Readonly<Record<MapCollaborationParticipantId, MapFollowTarget>>;
  readonly featureLocks: ReadonlyArray<MapFeatureLock>;
  readonly operations: ReadonlyArray<MapCommittedOperation<TPayload>>;
  readonly status: MapCollaborationConnectionStatus;
  readonly error?: MapCollaborationErrorEvent;
}

export type MapCollaborationEvent<TPayload = unknown> =
  | {
      readonly type: "snapshot";
      readonly snapshot: MapCollaborationSnapshot<TPayload>;
    }
  | {
      readonly type: "participant-joined";
      readonly participant: MapCollaborationParticipant;
    }
  | {
      readonly type: "participant-left";
      readonly participantId: MapCollaborationParticipantId;
      readonly sessionId: MapCollaborationSessionId;
    }
  | {
      readonly type: "cursor";
      readonly participantId: MapCollaborationParticipantId;
      readonly cursor: MapCursor;
    }
  | {
      readonly type: "selection";
      readonly participantId: MapCollaborationParticipantId;
      readonly selection: MapSelection;
    }
  | {
      readonly type: "follow";
      readonly participantId: MapCollaborationParticipantId;
      readonly follow: MapFollowTarget;
    }
  | {
      readonly type: "feature-lock-claimed" | "feature-lock-renewed";
      readonly lock: MapFeatureLock;
    }
  | {
      readonly type: "feature-lock-released";
      readonly featureId: string | number;
      readonly sourceId?: string;
      readonly layerId?: string | number;
      readonly ownerId: MapCollaborationParticipantId;
      readonly token?: string;
    }
  | {
      readonly type: "operation-appended";
      readonly operation: MapCommittedOperation<TPayload>;
    }
  | {
      readonly type: "status";
      readonly status: MapCollaborationConnectionStatus;
      readonly reason?: string;
      readonly retryAfterMs?: number;
    }
  | MapCollaborationErrorEvent;

export interface MapCollaborationErrorEvent {
  readonly type: "error";
  readonly code: MapCollaborationErrorCode;
  readonly message: string;
  readonly terminal?: boolean;
  readonly retryAfterMs?: number;
  readonly resyncRequired?: boolean;
  readonly details?: unknown;
}

export interface MapCollaborationEnvelope<TPayload = unknown> {
  readonly envelopeVersion: "honua.saved-map-collaboration.v1";
  readonly mapId: MapId;
  readonly eventId: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly serverTime: string;
  readonly sessionId?: MapCollaborationSessionId;
  readonly actorId?: MapCollaborationParticipantId;
  readonly event: MapCollaborationEvent<TPayload>;
}

export interface MapCollaborationTransportCapabilities {
  readonly kind: MapCollaborationTransportKind;
  readonly resumable: boolean;
  readonly ordered: boolean;
  readonly replay: boolean;
}

export interface MapCollaborationJoinRequest {
  readonly mapId: MapId;
  readonly sessionId?: MapCollaborationSessionId;
  readonly participantId?: MapCollaborationParticipantId;
  readonly displayName?: string;
  readonly color?: string;
  readonly permissions?: ReadonlyArray<string>;
  readonly resumeFrom?: {
    readonly cursor?: string;
    readonly sequence?: number;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface MapCollaborationSessionRef {
  readonly mapId: MapId;
  readonly sessionId: MapCollaborationSessionId;
  readonly participantId: MapCollaborationParticipantId;
}

export interface MapCollaborationJoinResult<TPayload = unknown> extends MapCollaborationSessionRef {
  readonly capabilities: MapCollaborationCapabilities;
  readonly snapshot: MapCollaborationSnapshot<TPayload>;
}

export interface MapFeatureLockRequest {
  readonly featureId: string | number;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly ttlMs?: number;
  readonly token?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MapFeatureLockReleaseRequest {
  readonly featureId: string | number;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly token?: string;
}

export interface MapOperationSubmitRequest<TPayload = unknown> {
  readonly operation: MapEditOperation<TPayload>;
  readonly expectedRevision?: number;
}

export interface MapOperationReplayRequest {
  readonly afterCursor?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface MapOperationReplayResult<TPayload = unknown> {
  readonly operations: ReadonlyArray<MapCommittedOperation<TPayload>>;
  readonly cursor?: string;
  readonly sequence: number;
  readonly resyncRequired?: boolean;
}

export interface MapCollaborationReconnectOptions extends MapOperationReplayRequest {
  readonly replayOperations?: boolean;
}

export interface MapCollaborationObserver<TPayload = unknown> {
  next(envelope: MapCollaborationEnvelope<TPayload>): void;
  error(error: unknown): void;
  complete(): void;
}

export interface MapCollaborationSubscriptionHandle {
  close(): void;
}

export interface MapCollaborationTransport<TPayload = unknown> {
  readonly capabilities?: MapCollaborationTransportCapabilities;
  join(request: MapCollaborationJoinRequest): Promise<MapCollaborationJoinResult<TPayload>>;
  leave(session: MapCollaborationSessionRef): Promise<void>;
  subscribe(
    session: MapCollaborationSessionRef,
    observer: MapCollaborationObserver<TPayload>,
  ): MapCollaborationSubscriptionHandle;
  publishCursor(session: MapCollaborationSessionRef, cursor: MapCursor): Promise<MapCollaborationEnvelope<TPayload>>;
  publishSelection(
    session: MapCollaborationSessionRef,
    selection: MapSelection,
  ): Promise<MapCollaborationEnvelope<TPayload>>;
  publishFollow(
    session: MapCollaborationSessionRef,
    follow: MapFollowTarget,
  ): Promise<MapCollaborationEnvelope<TPayload>>;
  claimFeatureLock(session: MapCollaborationSessionRef, request: MapFeatureLockRequest): Promise<MapFeatureLock>;
  releaseFeatureLock(session: MapCollaborationSessionRef, request: MapFeatureLockReleaseRequest): Promise<void>;
  renewFeatureLock(session: MapCollaborationSessionRef, request: MapFeatureLockRequest): Promise<MapFeatureLock>;
  submitOperation(
    session: MapCollaborationSessionRef,
    request: MapOperationSubmitRequest<TPayload>,
  ): Promise<MapCommittedOperation<TPayload>>;
  replayOperations(
    session: MapCollaborationSessionRef,
    request?: MapOperationReplayRequest,
  ): Promise<MapOperationReplayResult<TPayload>>;
}

export type MapCollaborationSnapshotListener<TPayload = unknown> = (
  snapshot: MapCollaborationSnapshot<TPayload>,
  envelope?: MapCollaborationEnvelope<TPayload>,
) => void;
