import { HonuaCollaborationError } from "./errors.js";
import type {
  SavedMapCollaborationEnvelope,
  SavedMapCollaborationJoinRequest,
  SavedMapCollaborationReconnectOptions,
  SavedMapCollaborationSessionRef,
  SavedMapCollaborationSnapshot,
  SavedMapCollaborationSnapshotListener,
  SavedMapCollaborationSubscriptionHandle,
  SavedMapCollaborationTransport,
  SavedMapCursor,
  SavedMapFeatureLock,
  SavedMapFeatureLockReleaseRequest,
  SavedMapFeatureLockRequest,
  SavedMapFollowTarget,
  SavedMapOperationReplayRequest,
  SavedMapOperationReplayResult,
  SavedMapOperationSubmitRequest,
  SavedMapSelection,
} from "./types.js";

export interface HonuaSavedMapCollaborationClientOptions<TPayload = unknown> {
  readonly transport: SavedMapCollaborationTransport<TPayload>;
}

export function createHonuaSavedMapCollaboration<TPayload = unknown>(
  options: HonuaSavedMapCollaborationClientOptions<TPayload>,
): HonuaSavedMapCollaborationClient<TPayload> {
  return new HonuaSavedMapCollaborationClient(options);
}

export class HonuaSavedMapCollaborationClient<TPayload = unknown> {
  readonly #transport: SavedMapCollaborationTransport<TPayload>;

  public constructor(options: HonuaSavedMapCollaborationClientOptions<TPayload>) {
    this.#transport = options.transport;
  }

  public async joinSavedMap(
    request: SavedMapCollaborationJoinRequest,
  ): Promise<HonuaSavedMapCollaborationSession<TPayload>> {
    const joined = await this.#transport.join(request);
    const session = new HonuaSavedMapCollaborationSession(this.#transport, joined, joined.snapshot);
    session.connect();
    return session;
  }
}

export class HonuaSavedMapCollaborationSession<TPayload = unknown> {
  readonly #transport: SavedMapCollaborationTransport<TPayload>;
  readonly #session: SavedMapCollaborationSessionRef;
  readonly #listeners = new Set<SavedMapCollaborationSnapshotListener<TPayload>>();
  #snapshot: SavedMapCollaborationSnapshot<TPayload>;
  #handle: SavedMapCollaborationSubscriptionHandle | undefined;
  #closed = false;
  #subscriptionGeneration = 0;

  public constructor(
    transport: SavedMapCollaborationTransport<TPayload>,
    session: SavedMapCollaborationSessionRef,
    snapshot: SavedMapCollaborationSnapshot<TPayload>,
  ) {
    this.#transport = transport;
    this.#session = session;
    this.#snapshot = snapshot;
  }

  public get mapId(): string {
    return this.#session.mapId;
  }

  public get sessionId(): string {
    return this.#session.sessionId;
  }

  public get participantId(): string {
    return this.#session.participantId;
  }

  public get snapshot(): SavedMapCollaborationSnapshot<TPayload> {
    return this.#snapshot;
  }

  public subscribe(
    listener: SavedMapCollaborationSnapshotListener<TPayload>,
    options: { readonly fireImmediately?: boolean } = {},
  ): () => void {
    this.#listeners.add(listener);
    if (options.fireImmediately) listener(this.#snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public connect(status: "connecting" | "reconnecting" = "connecting"): void {
    if (this.#closed || this.#handle) return;
    const generation = ++this.#subscriptionGeneration;
    this.#snapshot = { ...this.#snapshot, status, error: undefined };
    this.emit();
    this.#handle = this.#transport.subscribe(this.#session, {
      next: (envelope) => {
        if (generation === this.#subscriptionGeneration) this.apply(envelope);
      },
      error: (error) => {
        if (generation === this.#subscriptionGeneration) this.applyError(error);
      },
      complete: () => {
        if (generation !== this.#subscriptionGeneration) return;
        this.#snapshot = { ...this.#snapshot, status: "closed" };
        this.#handle = undefined;
        this.emit();
      },
    });
  }

  public disconnect(): void {
    if (this.#closed) return;
    this.closeSubscription();
    this.#snapshot = { ...this.#snapshot, status: "stale" };
    this.emit();
  }

  public async reconnect(
    options: SavedMapCollaborationReconnectOptions = {},
  ): Promise<SavedMapOperationReplayResult<TPayload> | undefined> {
    if (this.#closed) {
      throw new HonuaCollaborationError("transport-failure", "Cannot reconnect a closed collaboration session.");
    }

    this.closeSubscription();
    this.#snapshot = { ...this.#snapshot, status: "reconnecting", error: undefined };
    this.emit();

    let replay: SavedMapOperationReplayResult<TPayload> | undefined;
    if (options.replayOperations !== false) {
      try {
        replay = await this.#transport.replayOperations(
          this.#session,
          replayRequestForSnapshot(this.#snapshot, options),
        );
        this.#snapshot = mergeReplayedOperations(this.#snapshot, replay);
        this.emit();
      } catch (error) {
        this.applyError(error);
        throw error;
      }
    }

    this.connect("reconnecting");
    return replay;
  }

  public async leave(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.closeSubscription();
    await this.#transport.leave(this.#session);
    this.#snapshot = { ...this.#snapshot, status: "closed" };
    this.emit();
    this.#listeners.clear();
  }

  public publishCursor(cursor: SavedMapCursor): Promise<SavedMapCollaborationEnvelope<TPayload>> {
    return this.#transport.publishCursor(this.#session, cursor);
  }

  public publishSelection(selection: SavedMapSelection): Promise<SavedMapCollaborationEnvelope<TPayload>> {
    return this.#transport.publishSelection(this.#session, selection);
  }

  public follow(participantId: string): Promise<SavedMapCollaborationEnvelope<TPayload>> {
    return this.#transport.publishFollow(this.#session, { following: true, targetParticipantId: participantId });
  }

  public unfollow(): Promise<SavedMapCollaborationEnvelope<TPayload>> {
    return this.#transport.publishFollow(this.#session, { following: false });
  }

  public claimFeatureLock(request: SavedMapFeatureLockRequest): Promise<SavedMapFeatureLock> {
    return this.#transport.claimFeatureLock(this.#session, request);
  }

  public releaseFeatureLock(request: SavedMapFeatureLockReleaseRequest): Promise<void> {
    return this.#transport.releaseFeatureLock(this.#session, request);
  }

  public renewFeatureLock(request: SavedMapFeatureLockRequest): Promise<SavedMapFeatureLock> {
    return this.#transport.renewFeatureLock(this.#session, request);
  }

  public submitOperation(
    request: SavedMapOperationSubmitRequest<TPayload>,
  ): Promise<SavedMapOperationReplayResult<TPayload>["operations"][number]> {
    return this.#transport.submitOperation(this.#session, request);
  }

  public replayOperations(
    request: SavedMapOperationReplayRequest = {},
  ): Promise<SavedMapOperationReplayResult<TPayload>> {
    return this.#transport.replayOperations(this.#session, request);
  }

  private apply(envelope: SavedMapCollaborationEnvelope<TPayload>): void {
    if (envelope.mapId !== this.mapId) return;
    const next = reduceSavedMapCollaborationSnapshot(this.#snapshot, envelope);
    if (Object.is(next, this.#snapshot)) return;
    this.#snapshot = next;
    this.emit(envelope);
  }

  private emit(envelope?: SavedMapCollaborationEnvelope<TPayload>): void {
    for (const listener of [...this.#listeners]) listener(this.#snapshot, envelope);
  }

  private closeSubscription(): void {
    if (!this.#handle) return;
    const handle = this.#handle;
    this.#handle = undefined;
    this.#subscriptionGeneration++;
    handle.close();
  }

  private applyError(error: unknown): void {
    const collaborationError =
      error instanceof HonuaCollaborationError
        ? error
        : new HonuaCollaborationError("transport-failure", "Collaboration transport failed.", { cause: error });
    this.#snapshot = {
      ...this.#snapshot,
      status: "error",
      error: {
        type: "error",
        code: collaborationError.code,
        message: collaborationError.message,
        retryAfterMs: collaborationError.retryAfterMs,
        resyncRequired: collaborationError.resyncRequired,
        details: collaborationError.details,
      },
    };
    this.emit();
  }
}

export function reduceSavedMapCollaborationSnapshot<TPayload>(
  snapshot: SavedMapCollaborationSnapshot<TPayload>,
  envelope: SavedMapCollaborationEnvelope<TPayload>,
): SavedMapCollaborationSnapshot<TPayload> {
  if (envelope.event.type === "snapshot") {
    return { ...envelope.event.snapshot, status: "live", cursor: envelope.cursor, sequence: envelope.sequence };
  }
  if (envelope.sequence <= snapshot.sequence) return snapshot;

  const base = {
    ...snapshot,
    sequence: envelope.sequence,
    cursor: envelope.cursor,
    status: "live" as const,
    error: undefined,
  };

  switch (envelope.event.type) {
    case "participant-joined":
      return {
        ...base,
        participants: upsertById(base.participants, envelope.event.participant),
      };
    case "participant-left": {
      const event = envelope.event;
      return {
        ...base,
        participants: base.participants.filter((participant) => participant.id !== event.participantId),
        cursors: omitKey(base.cursors, event.participantId),
        selections: omitKey(base.selections, event.participantId),
        followTargets: omitKey(base.followTargets, event.participantId),
        featureLocks: base.featureLocks.filter((lock) => lock.ownerId !== event.participantId),
      };
    }
    case "cursor":
      return {
        ...base,
        cursors: { ...base.cursors, [envelope.event.participantId]: envelope.event.cursor },
      };
    case "selection":
      return {
        ...base,
        selections: { ...base.selections, [envelope.event.participantId]: envelope.event.selection },
      };
    case "follow":
      return {
        ...base,
        followTargets: { ...base.followTargets, [envelope.event.participantId]: envelope.event.follow },
      };
    case "feature-lock-claimed":
    case "feature-lock-renewed":
      return {
        ...base,
        featureLocks: upsertLock(base.featureLocks, envelope.event.lock),
      };
    case "feature-lock-released": {
      const event = envelope.event;
      return {
        ...base,
        featureLocks: base.featureLocks.filter(
          (lock) =>
            !sameFeatureLockTarget(lock, {
              featureId: event.featureId,
              sourceId: event.sourceId,
              layerId: event.layerId,
            }),
        ),
      };
    }
    case "operation-appended":
      return {
        ...base,
        operations: [...base.operations, envelope.event.operation],
      };
    case "status":
      return { ...base, status: envelope.event.status };
    case "error":
      return {
        ...base,
        status: "error",
        error: envelope.event,
      };
  }
}

function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, item: T): ReadonlyArray<T> {
  const existing = items.findIndex((candidate) => candidate.id === item.id);
  if (existing === -1) return [...items, item];
  return items.map((candidate, index) => (index === existing ? item : candidate));
}

function upsertLock(
  locks: ReadonlyArray<SavedMapFeatureLock>,
  lock: SavedMapFeatureLock,
): ReadonlyArray<SavedMapFeatureLock> {
  const existing = locks.findIndex((candidate) => sameFeatureLockTarget(candidate, lock));
  if (existing === -1) return [...locks, lock];
  return locks.map((candidate, index) => (index === existing ? lock : candidate));
}

function sameFeatureLockTarget(
  left: Pick<SavedMapFeatureLock, "featureId" | "sourceId" | "layerId">,
  right: Pick<SavedMapFeatureLock, "featureId" | "sourceId" | "layerId">,
): boolean {
  return left.featureId === right.featureId && left.sourceId === right.sourceId && left.layerId === right.layerId;
}

function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function replayRequestForSnapshot<TPayload>(
  snapshot: SavedMapCollaborationSnapshot<TPayload>,
  options: SavedMapCollaborationReconnectOptions,
): SavedMapOperationReplayRequest {
  const { replayOperations: _replayOperations, ...request } = options;
  if (request.afterCursor !== undefined || request.afterSequence !== undefined) return request;
  if (snapshot.cursor !== undefined) return { ...request, afterCursor: snapshot.cursor };
  return { ...request, afterSequence: snapshot.sequence };
}

function mergeReplayedOperations<TPayload>(
  snapshot: SavedMapCollaborationSnapshot<TPayload>,
  replay: SavedMapOperationReplayResult<TPayload>,
): SavedMapCollaborationSnapshot<TPayload> {
  const operationIds = new Set(snapshot.operations.map((operation) => operation.id));
  const operations = [...snapshot.operations];
  for (const operation of replay.operations) {
    if (operationIds.has(operation.id)) continue;
    operationIds.add(operation.id);
    operations.push(operation);
  }
  return {
    ...snapshot,
    operations,
    sequence: Math.max(snapshot.sequence, replay.sequence),
    cursor: replay.cursor ?? snapshot.cursor,
  };
}
