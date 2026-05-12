import { HonuaCollaborationError } from "./errors.js";
import type {
  SavedMapCollaborationCapabilities,
  SavedMapCollaborationEnvelope,
  SavedMapCollaborationErrorCode,
  SavedMapCollaborationEvent,
  SavedMapCollaborationJoinRequest,
  SavedMapCollaborationJoinResult,
  SavedMapCollaborationObserver,
  SavedMapCollaborationSessionRef,
  SavedMapCollaborationSnapshot,
  SavedMapCollaborationSubscriptionHandle,
  SavedMapCollaborationTransport,
  SavedMapCommittedOperation,
  SavedMapCursor,
  SavedMapEditOperation,
  SavedMapFeatureLock,
  SavedMapFeatureLockReleaseRequest,
  SavedMapFeatureLockRequest,
  SavedMapFollowTarget,
  SavedMapOperationReplayRequest,
  SavedMapOperationReplayResult,
  SavedMapOperationSubmitRequest,
  SavedMapSelection,
} from "./types.js";

export interface FixtureSavedMapCollaborationTransportOptions {
  readonly now?: () => Date;
  readonly capabilities?: Partial<SavedMapCollaborationCapabilities>;
  readonly deniedMapIds?: ReadonlyArray<string>;
  readonly unsupportedMapIds?: ReadonlyArray<string>;
}

const DEFAULT_CAPABILITIES: SavedMapCollaborationCapabilities = {
  cursors: true,
  selections: true,
  follow: true,
  featureLocks: true,
  operations: true,
  replay: true,
};

interface FixtureMapState<TPayload> {
  sequence: number;
  participants: Map<string, SavedMapCollaborationJoinResult<TPayload>["snapshot"]["participants"][number]>;
  sessions: Map<string, SavedMapCollaborationSessionRef>;
  cursors: Map<string, SavedMapCursor>;
  selections: Map<string, SavedMapSelection>;
  followTargets: Map<string, SavedMapFollowTarget>;
  locks: Map<string, SavedMapFeatureLock>;
  operations: Array<SavedMapCommittedOperation<TPayload>>;
  eventLog: Array<SavedMapCollaborationEnvelope<TPayload>>;
  subscribers: Map<string, SavedMapCollaborationObserver<TPayload>>;
  resyncError: { code: SavedMapCollaborationErrorCode; message: string } | undefined;
}

export function createFixtureSavedMapCollaborationTransport<TPayload = unknown>(
  options: FixtureSavedMapCollaborationTransportOptions = {},
): FixtureSavedMapCollaborationTransport<TPayload> {
  return new FixtureSavedMapCollaborationTransport<TPayload>(options);
}

export class FixtureSavedMapCollaborationTransport<TPayload = unknown>
  implements SavedMapCollaborationTransport<TPayload>
{
  public readonly capabilities = {
    kind: "mock" as const,
    resumable: true,
    ordered: true,
    replay: true,
  };

  readonly #maps = new Map<string, FixtureMapState<TPayload>>();
  readonly #now: () => Date;
  readonly #capabilities: SavedMapCollaborationCapabilities;
  readonly #deniedMapIds: ReadonlySet<string>;
  readonly #unsupportedMapIds: ReadonlySet<string>;
  #sessionCounter = 0;
  #lockCounter = 0;
  #operationCounter = 0;

  public constructor(options: FixtureSavedMapCollaborationTransportOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.#deniedMapIds = new Set(options.deniedMapIds ?? []);
    this.#unsupportedMapIds = new Set(options.unsupportedMapIds ?? []);
  }

  public async join(request: SavedMapCollaborationJoinRequest): Promise<SavedMapCollaborationJoinResult<TPayload>> {
    this.rejectUnavailableMap(request.mapId);
    const map = this.mapState(request.mapId);
    if (map.resyncError && (request.resumeFrom?.cursor || request.resumeFrom?.sequence !== undefined)) {
      throw new HonuaCollaborationError(map.resyncError.code, map.resyncError.message, { resyncRequired: true });
    }

    const sessionId = request.sessionId ?? `fixture-session-${++this.#sessionCounter}`;
    const participantId = request.participantId ?? sessionId;
    const joinedAt = this.nowIso();
    const participant = {
      id: participantId,
      sessionId,
      displayName: request.displayName,
      color: request.color,
      permissions: request.permissions,
      joinedAt,
      lastSeenAt: joinedAt,
    };
    const session = { mapId: request.mapId, sessionId, participantId };
    map.sessions.set(sessionId, session);
    map.participants.set(participantId, participant);

    const envelope = this.envelope(request.mapId, session, {
      type: "participant-joined",
      participant,
    });
    this.appendAndFanOut(map, envelope);

    return {
      ...session,
      capabilities: this.#capabilities,
      snapshot: this.snapshot(request.mapId, map, "live"),
    };
  }

  public async leave(session: SavedMapCollaborationSessionRef): Promise<void> {
    const map = this.mapState(session.mapId);
    map.sessions.delete(session.sessionId);
    map.participants.delete(session.participantId);
    map.cursors.delete(session.participantId);
    map.selections.delete(session.participantId);
    map.followTargets.delete(session.participantId);
    for (const [key, lock] of [...map.locks]) {
      if (lock.ownerId === session.participantId) map.locks.delete(key);
    }
    this.appendAndFanOut(
      map,
      this.envelope(session.mapId, session, {
        type: "participant-left",
        participantId: session.participantId,
        sessionId: session.sessionId,
      }),
    );
  }

  public subscribe(
    session: SavedMapCollaborationSessionRef,
    observer: SavedMapCollaborationObserver<TPayload>,
  ): SavedMapCollaborationSubscriptionHandle {
    const map = this.mapState(session.mapId);
    map.subscribers.set(session.sessionId, observer);
    observer.next(this.snapshotEnvelope(session.mapId, session, map));
    if (map.resyncError) {
      observer.next(this.errorEnvelope(session.mapId, session, map.resyncError.code, map.resyncError.message));
    }
    return {
      close: () => {
        map.subscribers.delete(session.sessionId);
        observer.complete();
      },
    };
  }

  public async publishCursor(
    session: SavedMapCollaborationSessionRef,
    cursor: SavedMapCursor,
  ): Promise<SavedMapCollaborationEnvelope<TPayload>> {
    const map = this.mapState(session.mapId);
    const updated = { ...cursor, updatedAt: cursor.updatedAt ?? this.nowIso() };
    map.cursors.set(session.participantId, updated);
    const envelope = this.envelope(session.mapId, session, {
      type: "cursor",
      participantId: session.participantId,
      cursor: updated,
    });
    return this.appendAndFanOut(map, envelope);
  }

  public async publishSelection(
    session: SavedMapCollaborationSessionRef,
    selection: SavedMapSelection,
  ): Promise<SavedMapCollaborationEnvelope<TPayload>> {
    const map = this.mapState(session.mapId);
    const updated = { ...selection, updatedAt: selection.updatedAt ?? this.nowIso() };
    map.selections.set(session.participantId, updated);
    const envelope = this.envelope(session.mapId, session, {
      type: "selection",
      participantId: session.participantId,
      selection: updated,
    });
    return this.appendAndFanOut(map, envelope);
  }

  public async publishFollow(
    session: SavedMapCollaborationSessionRef,
    follow: SavedMapFollowTarget,
  ): Promise<SavedMapCollaborationEnvelope<TPayload>> {
    const map = this.mapState(session.mapId);
    const updated = { ...follow, updatedAt: follow.updatedAt ?? this.nowIso() };
    map.followTargets.set(session.participantId, updated);
    const envelope = this.envelope(session.mapId, session, {
      type: "follow",
      participantId: session.participantId,
      follow: updated,
    });
    return this.appendAndFanOut(map, envelope);
  }

  public async claimFeatureLock(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapFeatureLockRequest,
  ): Promise<SavedMapFeatureLock> {
    const map = this.mapState(session.mapId);
    const key = lockKey(request);
    const existing = map.locks.get(key);
    if (existing && existing.ownerId !== session.participantId && !isExpired(existing, this.#now())) {
      throw new HonuaCollaborationError("lock-held", "Feature lock is already held.", { details: { lock: existing } });
    }
    const lock = this.lockFor(session, request, request.token ?? `fixture-lock-${++this.#lockCounter}`);
    map.locks.set(key, lock);
    this.appendAndFanOut(map, this.envelope(session.mapId, session, { type: "feature-lock-claimed", lock }));
    return lock;
  }

  public async releaseFeatureLock(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapFeatureLockReleaseRequest,
  ): Promise<void> {
    const map = this.mapState(session.mapId);
    const key = lockKey(request);
    const existing = map.locks.get(key);
    if (existing && (existing.ownerId !== session.participantId || !tokenMatches(existing, request.token))) {
      throw new HonuaCollaborationError("conflict", "Feature lock cannot be released by this session.", {
        details: { lock: existing },
      });
    }
    map.locks.delete(key);
    this.appendAndFanOut(
      map,
      this.envelope(session.mapId, session, {
        type: "feature-lock-released",
        featureId: request.featureId,
        sourceId: request.sourceId,
        layerId: request.layerId,
        ownerId: session.participantId,
        token: request.token,
      }),
    );
  }

  public async renewFeatureLock(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapFeatureLockRequest,
  ): Promise<SavedMapFeatureLock> {
    const map = this.mapState(session.mapId);
    const key = lockKey(request);
    const existing = map.locks.get(key);
    if (!existing || existing.ownerId !== session.participantId || !tokenMatches(existing, request.token)) {
      throw new HonuaCollaborationError("conflict", "Feature lock cannot be renewed by this session.", {
        details: { lock: existing },
      });
    }
    const lock = this.lockFor(session, request, existing.token);
    map.locks.set(key, lock);
    this.appendAndFanOut(map, this.envelope(session.mapId, session, { type: "feature-lock-renewed", lock }));
    return lock;
  }

  public async submitOperation(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapOperationSubmitRequest<TPayload>,
  ): Promise<SavedMapCommittedOperation<TPayload>> {
    const map = this.mapState(session.mapId);
    if (request.expectedRevision !== undefined && request.expectedRevision !== map.operations.length) {
      throw new HonuaCollaborationError("conflict", "Saved-map operation revision conflict.", {
        details: { expectedRevision: request.expectedRevision, actualRevision: map.operations.length },
      });
    }

    const sequence = map.sequence + 1;
    const revision = map.operations.length + 1;
    const operation = this.operationFor(session, request.operation, sequence, revision);
    map.operations.push(operation);
    this.appendAndFanOut(map, this.envelope(session.mapId, session, { type: "operation-appended", operation }));
    return operation;
  }

  public async replayOperations(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapOperationReplayRequest = {},
  ): Promise<SavedMapOperationReplayResult<TPayload>> {
    const map = this.mapState(session.mapId);
    if (map.resyncError) {
      throw new HonuaCollaborationError(map.resyncError.code, map.resyncError.message, { resyncRequired: true });
    }
    const afterSequence = sequenceFromReplayRequest(map, request);
    const operations = map.operations
      .filter((operation) => operation.sequence > afterSequence)
      .slice(0, request.limit ?? Number.POSITIVE_INFINITY);
    const lastOperation = operations[operations.length - 1];
    return {
      operations,
      cursor: lastOperation?.cursor ?? `fixture:${map.sequence}`,
      sequence: lastOperation?.sequence ?? map.sequence,
    };
  }

  public markResyncRequired(mapId: string, message = "Collaboration stream requires a fresh snapshot."): void {
    const map = this.mapState(mapId);
    map.resyncError = { code: "resync-required", message };
    const firstSession = [...map.sessions.values()][0] ?? { mapId, sessionId: "fixture", participantId: "fixture" };
    this.appendAndFanOut(map, this.errorEnvelope(mapId, firstSession, "resync-required", message));
  }

  private rejectUnavailableMap(mapId: string): void {
    if (this.#deniedMapIds.has(mapId)) {
      throw new HonuaCollaborationError("permission-denied", "Collaboration access denied for saved map.");
    }
    if (this.#unsupportedMapIds.has(mapId)) {
      throw new HonuaCollaborationError("unsupported-collaboration", "Saved-map collaboration is not supported.");
    }
  }

  private mapState(mapId: string): FixtureMapState<TPayload> {
    let map = this.#maps.get(mapId);
    if (!map) {
      map = {
        sequence: 0,
        participants: new Map(),
        sessions: new Map(),
        cursors: new Map(),
        selections: new Map(),
        followTargets: new Map(),
        locks: new Map(),
        operations: [],
        eventLog: [],
        subscribers: new Map(),
        resyncError: undefined,
      };
      this.#maps.set(mapId, map);
    }
    return map;
  }

  private appendAndFanOut(
    map: FixtureMapState<TPayload>,
    envelope: SavedMapCollaborationEnvelope<TPayload>,
  ): SavedMapCollaborationEnvelope<TPayload> {
    map.sequence = envelope.sequence;
    map.eventLog.push(envelope);
    for (const observer of map.subscribers.values()) observer.next(envelope);
    return envelope;
  }

  private snapshot(
    mapId: string,
    map: FixtureMapState<TPayload>,
    status: SavedMapCollaborationSnapshot<TPayload>["status"],
  ): SavedMapCollaborationSnapshot<TPayload> {
    return {
      mapId,
      sequence: map.sequence,
      cursor: `fixture:${map.sequence}`,
      capabilities: this.#capabilities,
      participants: [...map.participants.values()],
      cursors: Object.fromEntries(map.cursors),
      selections: Object.fromEntries(map.selections),
      followTargets: Object.fromEntries(map.followTargets),
      featureLocks: [...map.locks.values()],
      operations: [...map.operations],
      status,
    };
  }

  private envelope(
    mapId: string,
    session: SavedMapCollaborationSessionRef,
    event: SavedMapCollaborationEvent<TPayload>,
  ): SavedMapCollaborationEnvelope<TPayload> {
    const map = this.mapState(mapId);
    const sequence = map.sequence + 1;
    return {
      envelopeVersion: "honua.saved-map-collaboration.v1",
      mapId,
      eventId: `fixture-event-${sequence}`,
      sequence,
      cursor: `fixture:${sequence}`,
      serverTime: this.nowIso(),
      sessionId: session.sessionId,
      actorId: session.participantId,
      event,
    };
  }

  private snapshotEnvelope(
    mapId: string,
    session: SavedMapCollaborationSessionRef,
    map: FixtureMapState<TPayload>,
  ): SavedMapCollaborationEnvelope<TPayload> {
    return {
      envelopeVersion: "honua.saved-map-collaboration.v1",
      mapId,
      eventId: `fixture-snapshot-${map.sequence}`,
      sequence: map.sequence,
      cursor: `fixture:${map.sequence}`,
      serverTime: this.nowIso(),
      sessionId: session.sessionId,
      actorId: session.participantId,
      event: {
        type: "snapshot",
        snapshot: this.snapshot(mapId, map, "live"),
      },
    };
  }

  private errorEnvelope(
    mapId: string,
    session: SavedMapCollaborationSessionRef,
    code: SavedMapCollaborationErrorCode,
    message: string,
  ): SavedMapCollaborationEnvelope<TPayload> {
    return this.envelope(mapId, session, {
      type: "error",
      code,
      message,
      terminal: true,
      resyncRequired: true,
    });
  }

  private lockFor(
    session: SavedMapCollaborationSessionRef,
    request: SavedMapFeatureLockRequest,
    token: string,
  ): SavedMapFeatureLock {
    const claimedAt = this.nowIso();
    return {
      mapId: session.mapId,
      featureId: request.featureId,
      sourceId: request.sourceId,
      layerId: request.layerId,
      ownerId: session.participantId,
      sessionId: session.sessionId,
      token,
      claimedAt,
      expiresAt:
        request.ttlMs === undefined ? undefined : new Date(this.#now().getTime() + request.ttlMs).toISOString(),
      metadata: request.metadata,
    };
  }

  private operationFor(
    session: SavedMapCollaborationSessionRef,
    operation: SavedMapEditOperation<TPayload>,
    sequence: number,
    revision: number,
  ): SavedMapCommittedOperation<TPayload> {
    return {
      ...operation,
      id: operation.id ?? `fixture-operation-${++this.#operationCounter}`,
      mapId: session.mapId,
      revision,
      sequence,
      cursor: `fixture:${sequence}`,
      authorId: session.participantId,
      submittedAt: this.nowIso(),
    };
  }

  private nowIso(): string {
    return this.#now().toISOString();
  }
}

function lockKey(request: Pick<SavedMapFeatureLockRequest, "featureId" | "sourceId" | "layerId">): string {
  return `${request.sourceId ?? ""}:${request.layerId ?? ""}:${String(request.featureId)}`;
}

function tokenMatches(lock: SavedMapFeatureLock, token: string | undefined): boolean {
  return token === undefined || token === lock.token;
}

function isExpired(lock: SavedMapFeatureLock, now: Date): boolean {
  return lock.expiresAt !== undefined && new Date(lock.expiresAt).getTime() <= now.getTime();
}

function sequenceFromReplayRequest<TPayload>(
  map: FixtureMapState<TPayload>,
  request: SavedMapOperationReplayRequest,
): number {
  if (request.afterSequence !== undefined) return request.afterSequence;
  if (!request.afterCursor) return 0;
  const match = /^fixture:(\d+)$/.exec(request.afterCursor);
  if (!match) throw new HonuaCollaborationError("stale-cursor", "Replay cursor is not valid for this transport.");
  const sequence = Number(match[1]);
  if (sequence > map.sequence) {
    throw new HonuaCollaborationError("stale-cursor", "Replay cursor is newer than the saved-map stream.", {
      resyncRequired: true,
    });
  }
  const known = sequence === 0 || map.eventLog.some((event) => event.sequence === sequence);
  if (!known) {
    throw new HonuaCollaborationError("stale-cursor", "Replay cursor has fallen out of the operation log.", {
      resyncRequired: true,
    });
  }
  return sequence;
}
