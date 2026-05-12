export type SavedMapId = string;
export type SavedMapCollaborationSessionId = string;
export type SavedMapCollaborationParticipantId = string;
export type SavedMapCollaborationTransportKind = "mock" | "websocket" | "webtransport" | "sse" | "custom";

export type SavedMapCollaborationConnectionStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "stale"
  | "closed"
  | "error";

export type SavedMapCollaborationErrorCode =
  | "permission-denied"
  | "unsupported-collaboration"
  | "lock-held"
  | "stale-cursor"
  | "conflict"
  | "transport-failure"
  | "resync-required";

export interface SavedMapCollaborationCapabilities {
  readonly cursors: boolean;
  readonly selections: boolean;
  readonly follow: boolean;
  readonly featureLocks: boolean;
  readonly operations: boolean;
  readonly replay: boolean;
}

export interface SavedMapCollaborationParticipant {
  readonly id: SavedMapCollaborationParticipantId;
  readonly sessionId: SavedMapCollaborationSessionId;
  readonly displayName?: string;
  readonly color?: string;
  readonly permissions?: ReadonlyArray<string>;
  readonly joinedAt: string;
  readonly lastSeenAt?: string;
}

export interface SavedMapCursor {
  readonly x: number;
  readonly y: number;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly mapPoint?: unknown;
  readonly screenPoint?: unknown;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SavedMapSelection {
  readonly ids: ReadonlyArray<string | number>;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly mode?: "replace" | "add" | "remove";
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SavedMapFollowTarget {
  readonly targetParticipantId?: SavedMapCollaborationParticipantId;
  readonly following: boolean;
  readonly updatedAt?: string;
}

export interface SavedMapFeatureLock {
  readonly mapId: SavedMapId;
  readonly featureId: string | number;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly ownerId: SavedMapCollaborationParticipantId;
  readonly sessionId: SavedMapCollaborationSessionId;
  readonly token: string;
  readonly claimedAt: string;
  readonly expiresAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SavedMapEditOperation<TPayload = unknown> {
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

export interface SavedMapCommittedOperation<TPayload = unknown> extends SavedMapEditOperation<TPayload> {
  readonly id: string;
  readonly mapId: SavedMapId;
  readonly revision: number;
  readonly sequence: number;
  readonly cursor: string;
  readonly authorId: SavedMapCollaborationParticipantId;
  readonly submittedAt: string;
}

export interface SavedMapCollaborationSnapshot<TPayload = unknown> {
  readonly mapId: SavedMapId;
  readonly sequence: number;
  readonly cursor?: string;
  readonly capabilities: SavedMapCollaborationCapabilities;
  readonly participants: ReadonlyArray<SavedMapCollaborationParticipant>;
  readonly cursors: Readonly<Record<SavedMapCollaborationParticipantId, SavedMapCursor>>;
  readonly selections: Readonly<Record<SavedMapCollaborationParticipantId, SavedMapSelection>>;
  readonly followTargets: Readonly<Record<SavedMapCollaborationParticipantId, SavedMapFollowTarget>>;
  readonly featureLocks: ReadonlyArray<SavedMapFeatureLock>;
  readonly operations: ReadonlyArray<SavedMapCommittedOperation<TPayload>>;
  readonly status: SavedMapCollaborationConnectionStatus;
  readonly error?: SavedMapCollaborationErrorEvent;
}

export type SavedMapCollaborationEvent<TPayload = unknown> =
  | {
      readonly type: "snapshot";
      readonly snapshot: SavedMapCollaborationSnapshot<TPayload>;
    }
  | {
      readonly type: "participant-joined";
      readonly participant: SavedMapCollaborationParticipant;
    }
  | {
      readonly type: "participant-left";
      readonly participantId: SavedMapCollaborationParticipantId;
      readonly sessionId: SavedMapCollaborationSessionId;
    }
  | {
      readonly type: "cursor";
      readonly participantId: SavedMapCollaborationParticipantId;
      readonly cursor: SavedMapCursor;
    }
  | {
      readonly type: "selection";
      readonly participantId: SavedMapCollaborationParticipantId;
      readonly selection: SavedMapSelection;
    }
  | {
      readonly type: "follow";
      readonly participantId: SavedMapCollaborationParticipantId;
      readonly follow: SavedMapFollowTarget;
    }
  | {
      readonly type: "feature-lock-claimed" | "feature-lock-renewed";
      readonly lock: SavedMapFeatureLock;
    }
  | {
      readonly type: "feature-lock-released";
      readonly featureId: string | number;
      readonly sourceId?: string;
      readonly layerId?: string | number;
      readonly ownerId: SavedMapCollaborationParticipantId;
      readonly token?: string;
    }
  | {
      readonly type: "operation-appended";
      readonly operation: SavedMapCommittedOperation<TPayload>;
    }
  | {
      readonly type: "status";
      readonly status: SavedMapCollaborationConnectionStatus;
      readonly reason?: string;
      readonly retryAfterMs?: number;
    }
  | SavedMapCollaborationErrorEvent;

export interface SavedMapCollaborationErrorEvent {
  readonly type: "error";
  readonly code: SavedMapCollaborationErrorCode;
  readonly message: string;
  readonly terminal?: boolean;
  readonly retryAfterMs?: number;
  readonly resyncRequired?: boolean;
  readonly details?: unknown;
}

export interface SavedMapCollaborationEnvelope<TPayload = unknown> {
  readonly envelopeVersion: "honua.saved-map-collaboration.v1";
  readonly mapId: SavedMapId;
  readonly eventId: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly serverTime: string;
  readonly sessionId?: SavedMapCollaborationSessionId;
  readonly actorId?: SavedMapCollaborationParticipantId;
  readonly event: SavedMapCollaborationEvent<TPayload>;
}

export interface SavedMapCollaborationTransportCapabilities {
  readonly kind: SavedMapCollaborationTransportKind;
  readonly resumable: boolean;
  readonly ordered: boolean;
  readonly replay: boolean;
}

export interface SavedMapCollaborationJoinRequest {
  readonly mapId: SavedMapId;
  readonly sessionId?: SavedMapCollaborationSessionId;
  readonly participantId?: SavedMapCollaborationParticipantId;
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

export interface SavedMapCollaborationSessionRef {
  readonly mapId: SavedMapId;
  readonly sessionId: SavedMapCollaborationSessionId;
  readonly participantId: SavedMapCollaborationParticipantId;
}

export interface SavedMapCollaborationJoinResult<TPayload = unknown> extends SavedMapCollaborationSessionRef {
  readonly capabilities: SavedMapCollaborationCapabilities;
  readonly snapshot: SavedMapCollaborationSnapshot<TPayload>;
}

export interface SavedMapFeatureLockRequest {
  readonly featureId: string | number;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly ttlMs?: number;
  readonly token?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SavedMapFeatureLockReleaseRequest {
  readonly featureId: string | number;
  readonly sourceId?: string;
  readonly layerId?: string | number;
  readonly token?: string;
}

export interface SavedMapOperationSubmitRequest<TPayload = unknown> {
  readonly operation: SavedMapEditOperation<TPayload>;
  readonly expectedRevision?: number;
}

export interface SavedMapOperationReplayRequest {
  readonly afterCursor?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface SavedMapOperationReplayResult<TPayload = unknown> {
  readonly operations: ReadonlyArray<SavedMapCommittedOperation<TPayload>>;
  readonly cursor?: string;
  readonly sequence: number;
  readonly resyncRequired?: boolean;
}

export interface SavedMapCollaborationReconnectOptions extends SavedMapOperationReplayRequest {
  readonly replayOperations?: boolean;
}

export interface SavedMapCollaborationObserver<TPayload = unknown> {
  next(envelope: SavedMapCollaborationEnvelope<TPayload>): void;
  error(error: unknown): void;
  complete(): void;
}

export interface SavedMapCollaborationSubscriptionHandle {
  close(): void;
}

export interface SavedMapCollaborationTransport<TPayload = unknown> {
  readonly capabilities?: SavedMapCollaborationTransportCapabilities;
  join(request: SavedMapCollaborationJoinRequest): Promise<SavedMapCollaborationJoinResult<TPayload>>;
  leave(session: SavedMapCollaborationSessionRef): Promise<void>;
  subscribe(
    session: SavedMapCollaborationSessionRef,
    observer: SavedMapCollaborationObserver<TPayload>,
  ): SavedMapCollaborationSubscriptionHandle;
  publishCursor(
    session: SavedMapCollaborationSessionRef,
    cursor: SavedMapCursor,
  ): Promise<SavedMapCollaborationEnvelope<TPayload>>;
  publishSelection(
    session: SavedMapCollaborationSessionRef,
    selection: SavedMapSelection,
  ): Promise<SavedMapCollaborationEnvelope<TPayload>>;
  publishFollow(
    session: SavedMapCollaborationSessionRef,
    follow: SavedMapFollowTarget,
  ): Promise<SavedMapCollaborationEnvelope<TPayload>>;
  claimFeatureLock(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapFeatureLockRequest,
  ): Promise<SavedMapFeatureLock>;
  releaseFeatureLock(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapFeatureLockReleaseRequest,
  ): Promise<void>;
  renewFeatureLock(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapFeatureLockRequest,
  ): Promise<SavedMapFeatureLock>;
  submitOperation(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapOperationSubmitRequest<TPayload>,
  ): Promise<SavedMapCommittedOperation<TPayload>>;
  replayOperations(
    session: SavedMapCollaborationSessionRef,
    request?: SavedMapOperationReplayRequest,
  ): Promise<SavedMapOperationReplayResult<TPayload>>;
}

export type SavedMapCollaborationSnapshotListener<TPayload = unknown> = (
  snapshot: SavedMapCollaborationSnapshot<TPayload>,
  envelope?: SavedMapCollaborationEnvelope<TPayload>,
) => void;
