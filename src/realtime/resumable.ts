/**
 * Transport-neutral, resumable delivery gate for realtime feature events.
 *
 * This module deliberately does not reconnect a transport. It protects the
 * boundary between a transport and a consumer: compatible checkpoints resume,
 * ordered events advance durably, duplicates are bounded, and gaps or queue
 * overflow require an explicit replacement snapshot.
 *
 * @module
 */

import type { SourceId } from "../contract/types.js";
import { type HonuaErrorCode, HonuaSdkError, mergeHonuaErrorContext } from "../core/error-envelope.js";
import type {
  RealtimeDeleteEvent,
  RealtimeDeltaEvent,
  RealtimeResumeCheckpoint,
  RealtimeSnapshotEvent,
  RealtimeUpsertEvent,
} from "./types.js";

export const REALTIME_DURABLE_CHECKPOINT_VERSION = 1 as const;

export type RealtimeSequencedEvent<TFeature = unknown> =
  | RealtimeSnapshotEvent<TFeature>
  | RealtimeUpsertEvent<TFeature>
  | RealtimeDeleteEvent
  | RealtimeDeltaEvent<TFeature>;

export interface RealtimeResumeContextV1 {
  readonly kind: "honua.realtime-resume-context";
  readonly version: 1;
  readonly sourceId: SourceId;
  /** Stable, credential-free identity of the accepted query or plan. */
  readonly queryFingerprint: string;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  /** Stable opaque ACL/scope identity. Never pass a bearer token. */
  readonly authorizationScopeFingerprint: string;
}

export interface RealtimeDurableCheckpointV1 {
  readonly kind: "honua.realtime-checkpoint";
  readonly version: typeof REALTIME_DURABLE_CHECKPOINT_VERSION;
  readonly context: RealtimeResumeContextV1;
  readonly resume: Readonly<RealtimeResumeCheckpoint> & { readonly sequence: number };
  readonly recentEventIds: readonly string[];
  readonly savedAt: string;
}

export type RealtimeCheckpointCompatibilityCode =
  | "compatible"
  | "invalid-checkpoint"
  | "source-changed"
  | "query-changed"
  | "source-version-changed"
  | "schema-version-changed"
  | "authorization-scope-changed";

export interface RealtimeCheckpointCompatibility {
  readonly compatible: boolean;
  readonly code: RealtimeCheckpointCompatibilityCode;
  readonly reason: string;
}

export type ResumableRealtimePhase =
  | "awaiting-snapshot"
  | "resuming"
  | "live"
  | "resnapshot-required"
  | "error"
  | "closed";

export type ResumableRealtimeReasonCode =
  | RealtimeCheckpointCompatibilityCode
  | "snapshot-required"
  | "replacement-snapshot-required"
  | "invalid-event"
  | "sequence-missing"
  | "checkpoint-conflict"
  | "sequence-gap"
  | "event-id-reused"
  | "buffer-overflow"
  | "consumer-failed"
  | "delivery-failed"
  | "checkpoint-load-failed"
  | "checkpoint-save-failed"
  | "cursor-expired"
  | "resume-unsupported"
  | "transport-gap"
  | "cancelled"
  | "closed";

export type RealtimeExternalResnapshotReason = "cursor-expired" | "resume-unsupported" | "transport-gap";

export interface ResumableRealtimeState {
  readonly phase: ResumableRealtimePhase;
  readonly reason?: ResumableRealtimeReasonCode;
  readonly detail?: string;
  readonly checkpoint?: RealtimeDurableCheckpointV1;
  readonly checkpointPersisted: boolean;
  readonly pendingEvents: number;
  readonly acceptedEventCount: number;
  readonly duplicateEventCount: number;
  readonly gapCount: number;
  readonly overflowCount: number;
}

export type ResumableRealtimeDeliveryStatus = "applied" | "duplicate" | "resnapshot-required" | "error" | "cancelled";

export interface ResumableRealtimeDelivery {
  readonly status: ResumableRealtimeDeliveryStatus;
  readonly reason?: ResumableRealtimeReasonCode;
  readonly checkpoint?: RealtimeDurableCheckpointV1;
}

export interface RealtimeCheckpointStore {
  load(context: RealtimeResumeContextV1, signal: AbortSignal): Promise<RealtimeDurableCheckpointV1 | undefined>;
  save(checkpoint: RealtimeDurableCheckpointV1, signal: AbortSignal): Promise<void>;
}

export interface CreateResumableRealtimeSubscriptionOptions<TFeature = unknown> {
  readonly context: RealtimeResumeContextV1;
  readonly apply: (event: RealtimeSequencedEvent<TFeature>, signal: AbortSignal) => void | Promise<void>;
  readonly checkpointStore?: RealtimeCheckpointStore;
  /** Takes precedence over `checkpointStore.load` when supplied. */
  readonly initialCheckpoint?: RealtimeDurableCheckpointV1;
  /** Includes the currently applying event. @default 64 */
  readonly maxPendingEvents?: number;
  /** Bounded event-id history persisted with each checkpoint. @default 256 */
  readonly maxRecentEventIds?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface ResumableRealtimeSubscription<TFeature = unknown> {
  readonly state: ResumableRealtimeState;
  enqueue(event: RealtimeSequencedEvent<TFeature>): Promise<ResumableRealtimeDelivery>;
  /** Project an adapter/server resume failure into an explicit snapshot transition. */
  requireResnapshot(reason: RealtimeExternalResnapshotReason, detail?: string): void;
  close(reason?: string): void;
}

/**
 * Public realtime failure with the original detailed reason on `.code` and a
 * stable common-envelope recovery class on `.sdkCode`. Classification metadata
 * does not reconnect a transport or request a replacement snapshot.
 */
export class HonuaRealtimeResumeError extends HonuaSdkError {
  public constructor(
    public readonly code: ResumableRealtimeReasonCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(realtimeResumeSdkCode(code), message, {
      ...options,
      context: mergeHonuaErrorContext({ reasonCode: realtimeResumeContextReason(code) }),
    });
    this.name = "HonuaRealtimeResumeError";
  }
}

const REALTIME_RESUME_ERROR_CODES = {
  compatible: "realtime.protocol.terminal",
  "invalid-checkpoint": "realtime.checkpoint.invalid",
  "source-changed": "realtime.checkpoint.invalid",
  "query-changed": "realtime.checkpoint.invalid",
  "source-version-changed": "realtime.checkpoint.invalid",
  "schema-version-changed": "realtime.checkpoint.invalid",
  "authorization-scope-changed": "realtime.checkpoint.invalid",
  "snapshot-required": "realtime.sequence.gap",
  "replacement-snapshot-required": "realtime.sequence.gap",
  "invalid-event": "realtime.protocol.terminal",
  "sequence-missing": "realtime.sequence.gap",
  "checkpoint-conflict": "realtime.checkpoint.invalid",
  "sequence-gap": "realtime.sequence.gap",
  "event-id-reused": "realtime.sequence.gap",
  "buffer-overflow": "realtime.sequence.gap",
  "consumer-failed": "realtime.protocol.terminal",
  "delivery-failed": "realtime.protocol.terminal",
  "checkpoint-load-failed": "realtime.protocol.terminal",
  "checkpoint-save-failed": "realtime.protocol.terminal",
  "cursor-expired": "realtime.transport.reconnectable",
  "resume-unsupported": "realtime.transport.reconnectable",
  "transport-gap": "realtime.transport.reconnectable",
  cancelled: "realtime.cancelled",
  closed: "realtime.cancelled",
} as const satisfies Record<ResumableRealtimeReasonCode, HonuaErrorCode>;

function realtimeResumeSdkCode(code: ResumableRealtimeReasonCode): HonuaErrorCode {
  return isRegisteredRealtimeResumeReason(code) ? REALTIME_RESUME_ERROR_CODES[code] : "realtime.protocol.terminal";
}

function realtimeResumeContextReason(code: ResumableRealtimeReasonCode): ResumableRealtimeReasonCode {
  return isRegisteredRealtimeResumeReason(code) ? code : "invalid-event";
}

function isRegisteredRealtimeResumeReason(code: unknown): code is ResumableRealtimeReasonCode {
  return typeof code === "string" && Object.hasOwn(REALTIME_RESUME_ERROR_CODES, code);
}

const DEFAULT_MAX_PENDING_EVENTS = 64;
const DEFAULT_MAX_RECENT_EVENT_IDS = 256;
const MAX_RECENT_EVENT_IDS = 4096;

interface PendingDelivery<TFeature> {
  readonly captured: CapturedRealtimeEvent<TFeature>;
  readonly resolve: (delivery: ResumableRealtimeDelivery) => void;
}

interface CapturedRealtimeEvent<TFeature> {
  readonly event: RealtimeSequencedEvent<TFeature>;
  readonly eventId?: string;
  readonly position: EventPosition;
  readonly replacementSnapshot: boolean;
  readonly recoverySnapshot: boolean;
}

interface EventCaptureFailure {
  readonly conflict: string;
  readonly reason?: "invalid-event" | "checkpoint-conflict";
}

interface EventPosition {
  readonly sequence?: number;
  readonly resume: RealtimeResumeCheckpoint;
  readonly conflict?: string;
}

/** Validate a checkpoint against the exact source/query/schema/ACL context. */
export function evaluateRealtimeCheckpoint(
  context: RealtimeResumeContextV1,
  checkpoint: RealtimeDurableCheckpointV1,
): RealtimeCheckpointCompatibility {
  if (!isCheckpointShape(checkpoint)) {
    return compatibility(false, "invalid-checkpoint", "Checkpoint shape or version is invalid.");
  }
  if (checkpoint.context.sourceId !== context.sourceId) {
    return compatibility(false, "source-changed", "Checkpoint source identity does not match the subscription.");
  }
  if (checkpoint.context.queryFingerprint !== context.queryFingerprint) {
    return compatibility(false, "query-changed", "Checkpoint query identity does not match the accepted query.");
  }
  if (checkpoint.context.sourceVersion !== context.sourceVersion) {
    return compatibility(false, "source-version-changed", "Checkpoint source version requires a new snapshot.");
  }
  if (checkpoint.context.schemaVersion !== context.schemaVersion) {
    return compatibility(false, "schema-version-changed", "Checkpoint schema version requires a new snapshot.");
  }
  if (checkpoint.context.authorizationScopeFingerprint !== context.authorizationScopeFingerprint) {
    return compatibility(
      false,
      "authorization-scope-changed",
      "Checkpoint authorization scope does not match the current grants.",
    );
  }
  return compatibility(true, "compatible", "Checkpoint is compatible with the subscription context.");
}

/**
 * Create a serial, bounded delivery gate. Loading a durable checkpoint is the
 * only asynchronous construction step; no transport is opened here.
 */
export async function createResumableRealtimeSubscription<TFeature = unknown>(
  options: CreateResumableRealtimeSubscriptionOptions<TFeature>,
): Promise<ResumableRealtimeSubscription<TFeature>> {
  const context = normalizeContext(options.context);
  const maxPendingEvents = positiveInteger(options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS, "maxPendingEvents");
  const maxRecentEventIds = positiveInteger(
    options.maxRecentEventIds ?? DEFAULT_MAX_RECENT_EVENT_IDS,
    "maxRecentEventIds",
  );
  if (maxRecentEventIds > MAX_RECENT_EVENT_IDS) {
    throw new HonuaRealtimeResumeError(
      "invalid-checkpoint",
      `maxRecentEventIds cannot exceed the ${MAX_RECENT_EVENT_IDS}-entry safety ceiling.`,
    );
  }
  const lifecycle = new AbortController();
  const externalAbort = () => lifecycle.abort(options.signal?.reason);
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener("abort", externalAbort, { once: true });

  let loadedCheckpoint = options.initialCheckpoint;
  if (!loadedCheckpoint && options.checkpointStore && !lifecycle.signal.aborted) {
    try {
      loadedCheckpoint = await options.checkpointStore.load(context, lifecycle.signal);
    } catch (cause) {
      if (lifecycle.signal.aborted) loadedCheckpoint = undefined;
      else {
        options.signal?.removeEventListener("abort", externalAbort);
        throw new HonuaRealtimeResumeError("checkpoint-load-failed", "Unable to load the realtime checkpoint.", {
          cause,
        });
      }
    }
  }

  const compatibilityResult = loadedCheckpoint ? evaluateRealtimeCheckpoint(context, loadedCheckpoint) : undefined;
  const initialCheckpoint =
    loadedCheckpoint && compatibilityResult?.compatible
      ? cloneCheckpoint(loadedCheckpoint, maxRecentEventIds)
      : undefined;
  let state = freezeState({
    phase: lifecycle.signal.aborted
      ? "closed"
      : compatibilityResult && !compatibilityResult.compatible
        ? "resnapshot-required"
        : initialCheckpoint
          ? "resuming"
          : "awaiting-snapshot",
    ...(lifecycle.signal.aborted
      ? { reason: "cancelled" as const, detail: "Subscription was cancelled before it started." }
      : compatibilityResult && !compatibilityResult.compatible
        ? { reason: compatibilityResult.code, detail: compatibilityResult.reason }
        : {}),
    ...(initialCheckpoint ? { checkpoint: initialCheckpoint } : {}),
    checkpointPersisted: initialCheckpoint !== undefined,
    pendingEvents: 0,
    acceptedEventCount: 0,
    duplicateEventCount: 0,
    gapCount: 0,
    overflowCount: 0,
  });
  const queue: PendingDelivery<TFeature>[] = [];
  let active: PendingDelivery<TFeature> | undefined;
  let activeAbort: AbortController | undefined;
  let generation = 0;

  const subscription: ResumableRealtimeSubscription<TFeature> = {
    get state() {
      return state;
    },
    enqueue(event) {
      if (state.phase === "closed") return Promise.resolve(delivery("cancelled", state.reason ?? "closed", state));
      if (state.phase === "error") return Promise.resolve(delivery("error", state.reason, state));

      const capture = captureRealtimeEvent<TFeature>(event);
      if ("conflict" in capture) {
        const reason = capture.reason ?? "invalid-event";
        transitionToResnapshot(reason, capture.conflict);
        return Promise.resolve(delivery("resnapshot-required", reason, state));
      }
      const replacementSnapshot = capture.replacementSnapshot;
      if (state.phase === "resnapshot-required" && !replacementSnapshot) {
        return Promise.resolve(delivery("resnapshot-required", state.reason, state));
      }
      const recoveringFromGap = state.phase === "resnapshot-required" && replacementSnapshot;
      if (recoveringFromGap) {
        invalidatePending("replacement-snapshot-required");
        setState({ phase: "awaiting-snapshot", reason: undefined, detail: undefined });
      }

      // A replacement snapshot is the sole recovery path. Let one recovery
      // item wait behind an abort-ignoring active consumer even when the data
      // queue is full; ordinary events remain strictly bounded.
      if (!recoveringFromGap && queue.length + (active ? 1 : 0) >= maxPendingEvents) {
        transitionToResnapshot(
          "buffer-overflow",
          `Pending realtime delivery exceeded the configured ${maxPendingEvents}-event bound.`,
          true,
        );
        return Promise.resolve(delivery("resnapshot-required", "buffer-overflow", state));
      }

      return new Promise<ResumableRealtimeDelivery>((resolve) => {
        queue.push({ captured: Object.freeze({ ...capture, recoverySnapshot: recoveringFromGap }), resolve });
        setState({ pendingEvents: queue.length + (active ? 1 : 0) });
        pump();
      });
    },
    requireResnapshot(reason, detail = "The transport requires a replacement snapshot before delivery can continue.") {
      if (state.phase === "closed" || state.phase === "error") return;
      transitionToResnapshot(reason, detail);
    },
    close(reason = "Subscription closed by caller.") {
      closeSubscription(reason, "closed", true);
    },
  };

  if (lifecycle.signal.aborted) {
    options.signal?.removeEventListener("abort", externalAbort);
    if (state.phase !== "closed") closeSubscription("Subscription signal was aborted.", "cancelled", false);
  } else {
    lifecycle.signal.addEventListener(
      "abort",
      () => closeSubscription("Subscription signal was aborted.", "cancelled", false),
      { once: true },
    );
  }
  return subscription;

  function pump(): void {
    if (active || state.phase === "closed" || state.phase === "error") return;
    const next = queue.shift();
    if (!next) {
      setState({ pendingEvents: 0 });
      return;
    }
    active = next;
    activeAbort = new AbortController();
    const operationGeneration = generation;
    setState({ pendingEvents: queue.length + 1 });
    void process(next.captured, activeAbort.signal, operationGeneration)
      .then(next.resolve, (cause) => {
        transitionToError("delivery-failed", errorMessage(cause));
        next.resolve(delivery("error", "delivery-failed", state));
      })
      .finally(() => {
        active = undefined;
        activeAbort = undefined;
        setState({ pendingEvents: queue.length });
        pump();
      });
  }

  async function process(
    captured: CapturedRealtimeEvent<TFeature>,
    signal: AbortSignal,
    operationGeneration: number,
  ): Promise<ResumableRealtimeDelivery> {
    if (signal.aborted || lifecycle.signal.aborted || operationGeneration !== generation) {
      return delivery("cancelled", "cancelled", state);
    }
    const { event, eventId, position, replacementSnapshot, recoverySnapshot } = captured;
    if (position.conflict) {
      transitionToResnapshot("checkpoint-conflict", position.conflict);
      return delivery("resnapshot-required", "checkpoint-conflict", state);
    }
    if (!isSequence(position.sequence)) {
      transitionToResnapshot(
        "sequence-missing",
        "Sequenced snapshot and delta events require a safe integer sequence.",
      );
      return delivery("resnapshot-required", "sequence-missing", state);
    }
    const previousSequence = state.checkpoint?.resume.sequence;
    if (!state.checkpoint && !replacementSnapshot) {
      transitionToResnapshot("snapshot-required", "A replacement snapshot is required before delta delivery.");
      return delivery("resnapshot-required", "snapshot-required", state);
    }
    if (event.type === "snapshot" && !replacementSnapshot && state.phase !== "live") {
      transitionToResnapshot("replacement-snapshot-required", "A merging snapshot cannot establish a resume baseline.");
      return delivery("resnapshot-required", "replacement-snapshot-required", state);
    }

    if (previousSequence !== undefined && position.sequence === previousSequence) {
      const conflict = sameSequenceCheckpointConflict(state.checkpoint?.resume, position.resume);
      if (conflict) {
        transitionToResnapshot("checkpoint-conflict", conflict);
        return delivery("resnapshot-required", "checkpoint-conflict", state);
      }
    }

    if (previousSequence !== undefined && !recoverySnapshot) {
      if (position.sequence <= previousSequence) {
        setState({ duplicateEventCount: state.duplicateEventCount + 1 });
        return delivery("duplicate", undefined, state);
      }
      if (
        !replacementSnapshot &&
        (previousSequence === Number.MAX_SAFE_INTEGER || position.sequence !== previousSequence + 1)
      ) {
        transitionToResnapshot(
          "sequence-gap",
          `Expected realtime sequence ${previousSequence + 1}, received ${position.sequence}.`,
        );
        return delivery("resnapshot-required", "sequence-gap", state);
      }
    }

    const recentIds = recoverySnapshot ? [] : (state.checkpoint?.recentEventIds ?? []);
    if (eventId && recentIds.includes(eventId)) {
      transitionToResnapshot("event-id-reused", `Event id "${eventId}" was reused at a new sequence.`);
      return delivery("resnapshot-required", "event-id-reused", state);
    }

    try {
      await options.apply(event, signal);
    } catch (cause) {
      if (signal.aborted || lifecycle.signal.aborted || operationGeneration !== generation) {
        return delivery("cancelled", "cancelled", state);
      }
      transitionToError("consumer-failed", errorMessage(cause));
      return delivery("error", "consumer-failed", state);
    }
    if (signal.aborted || lifecycle.signal.aborted || operationGeneration !== generation) {
      return delivery("cancelled", "cancelled", state);
    }

    const checkpoint = createCheckpoint(
      context,
      recoverySnapshot ? undefined : state.checkpoint,
      { ...position, sequence: position.sequence },
      eventId,
      maxRecentEventIds,
      options.now?.() ?? Date.now(),
    );
    setState({
      phase: "live",
      reason: undefined,
      detail: undefined,
      checkpoint,
      checkpointPersisted: false,
      acceptedEventCount: state.acceptedEventCount + 1,
    });
    if (options.checkpointStore) {
      try {
        await options.checkpointStore.save(checkpoint, signal);
      } catch (cause) {
        if (signal.aborted || lifecycle.signal.aborted || operationGeneration !== generation) {
          return delivery("cancelled", "cancelled", state);
        }
        transitionToError("checkpoint-save-failed", errorMessage(cause), false);
        return delivery("error", "checkpoint-save-failed", state);
      }
      if (signal.aborted || lifecycle.signal.aborted || operationGeneration !== generation) {
        return delivery("cancelled", "cancelled", state);
      }
      setState({ checkpointPersisted: true });
    }
    return delivery("applied", undefined, state);
  }

  function transitionToResnapshot(reason: ResumableRealtimeReasonCode, detail: string, overflow = false): void {
    generation += 1;
    activeAbort?.abort(detail);
    drainQueue("resnapshot-required", reason);
    setState({
      phase: "resnapshot-required",
      reason,
      detail,
      gapCount: state.gapCount + (reason === "sequence-gap" || reason === "transport-gap" ? 1 : 0),
      overflowCount: state.overflowCount + (overflow ? 1 : 0),
      pendingEvents: active ? 1 : 0,
    });
  }

  function invalidatePending(reason: ResumableRealtimeReasonCode): void {
    generation += 1;
    activeAbort?.abort(reason);
    drainQueue("resnapshot-required", reason);
  }

  function transitionToError(
    reason: "consumer-failed" | "delivery-failed" | "checkpoint-save-failed",
    detail: string,
    checkpointPersisted = state.checkpointPersisted,
  ): void {
    generation += 1;
    activeAbort?.abort(detail);
    drainQueue("error", reason);
    setState({
      phase: "error",
      reason,
      detail,
      checkpointPersisted,
      pendingEvents: active ? 1 : 0,
    });
  }

  function closeSubscription(reason: string, reasonCode: "cancelled" | "closed", abortLifecycle: boolean): void {
    if (state.phase === "closed") return;
    generation += 1;
    activeAbort?.abort(reason);
    options.signal?.removeEventListener("abort", externalAbort);
    drainQueue("cancelled", reasonCode);
    setState({ phase: "closed", reason: reasonCode, detail: reason, pendingEvents: active ? 1 : 0 });
    if (abortLifecycle && !lifecycle.signal.aborted) lifecycle.abort(reason);
  }

  function drainQueue(status: ResumableRealtimeDeliveryStatus, reason: ResumableRealtimeReasonCode): void {
    for (const pending of queue.splice(0)) pending.resolve(delivery(status, reason, state));
  }

  function setState(patch: Partial<ResumableRealtimeState>): void {
    state = freezeState({ ...state, ...patch });
  }
}

function normalizeContext(context: RealtimeResumeContextV1): RealtimeResumeContextV1 {
  if (!isResumeContextShape(context)) {
    throw new HonuaRealtimeResumeError("invalid-checkpoint", "Realtime resume context kind or version is invalid.");
  }
  return Object.freeze({
    kind: context.kind,
    version: context.version,
    sourceId: requiredText(String(context.sourceId), "sourceId"),
    queryFingerprint: requiredText(context.queryFingerprint, "queryFingerprint"),
    sourceVersion: requiredText(context.sourceVersion, "sourceVersion"),
    schemaVersion: requiredText(context.schemaVersion, "schemaVersion"),
    authorizationScopeFingerprint: requiredText(context.authorizationScopeFingerprint, "authorizationScopeFingerprint"),
  });
}

function createCheckpoint(
  context: RealtimeResumeContextV1,
  previous: RealtimeDurableCheckpointV1 | undefined,
  position: EventPosition & { readonly sequence: number },
  eventId: string | undefined,
  maxRecentEventIds: number,
  now: number,
): RealtimeDurableCheckpointV1 {
  const recentEventIds = eventId
    ? [...(previous?.recentEventIds ?? []), eventId].slice(-maxRecentEventIds)
    : [...(previous?.recentEventIds ?? [])];
  return freezeCheckpoint({
    kind: "honua.realtime-checkpoint",
    version: REALTIME_DURABLE_CHECKPOINT_VERSION,
    context,
    resume: Object.freeze({
      ...projectResumeCheckpoint(previous?.resume),
      ...projectResumeCheckpoint(position.resume),
      sequence: position.sequence,
    }),
    recentEventIds: Object.freeze(recentEventIds),
    savedAt: new Date(finiteNow(now)).toISOString(),
  });
}

function captureRealtimeEvent<TFeature>(input: unknown): CapturedRealtimeEvent<TFeature> | EventCaptureFailure {
  if (!isRecord(input)) return { conflict: "Realtime delivery must be an event object." };
  if (!isSequencedEventType(input.type)) {
    return { conflict: `Realtime event type "${String(input.type)}" is not a sequenced data event.` };
  }
  if (input.eventId !== undefined && typeof input.eventId !== "string") {
    return { conflict: "Realtime eventId must be a string when provided." };
  }
  for (const name of ["operationInstanceId", "correlationId", "auditId", "proposalId"] as const) {
    if (input[name] !== undefined && typeof input[name] !== "string") {
      return { conflict: `Realtime event ${name} must be a string when provided.` };
    }
  }
  if (input.checkpoint !== undefined && !isRecord(input.checkpoint)) {
    return { conflict: "Realtime event checkpoint must be an object when provided." };
  }
  if (input.receivedAt !== undefined && typeof input.receivedAt !== "number") {
    return { conflict: "Realtime event receivedAt must be a number when provided." };
  }

  const checkpoint = input.checkpoint ? Object.freeze(projectResumeCheckpoint(input.checkpoint)) : undefined;
  const base = {
    ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    ...(input.operationInstanceId !== undefined ? { operationInstanceId: input.operationInstanceId as string } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId as string } : {}),
    ...(input.auditId !== undefined ? { auditId: input.auditId as string } : {}),
    ...(input.proposalId !== undefined ? { proposalId: input.proposalId as string } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
    ...(input.watermark !== undefined ? { watermark: input.watermark as string } : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp as string } : {}),
    ...(input.deltaToken !== undefined ? { deltaToken: input.deltaToken as string } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence as number } : {}),
    ...(input.receivedAt !== undefined ? { receivedAt: input.receivedAt } : {}),
  };

  let event: RealtimeSequencedEvent<TFeature>;
  switch (input.type) {
    case "snapshot":
      if (!Array.isArray(input.features)) return { conflict: "Realtime snapshot features must be an array." };
      if (input.replace !== undefined && typeof input.replace !== "boolean") {
        return { conflict: "Realtime snapshot replace must be a boolean when provided." };
      }
      event = Object.freeze({
        ...base,
        type: "snapshot",
        features: Object.freeze(input.features.slice()) as RealtimeSnapshotEvent<TFeature>["features"],
        ...(input.replace !== undefined ? { replace: input.replace } : {}),
      });
      break;
    case "upsert":
      if (!isRecord(input.feature)) return { conflict: "Realtime upsert feature must be an object." };
      event = Object.freeze({
        ...base,
        type: "upsert",
        feature: input.feature as unknown as RealtimeUpsertEvent<TFeature>["feature"],
      });
      break;
    case "delete":
      if (!isFeatureId(input.id)) return { conflict: "Realtime delete id must be a string or number." };
      event = Object.freeze({
        ...base,
        type: "delete",
        id: input.id,
        ...(typeof input.sourceId === "string" ? { sourceId: input.sourceId } : {}),
        ...(typeof input.version === "number" ? { version: input.version } : {}),
        ...(typeof input.updatedAt === "string" ? { updatedAt: input.updatedAt } : {}),
        ...(typeof input.deletedAt === "number" ? { deletedAt: input.deletedAt } : {}),
      });
      break;
    case "delta":
      if (input.upserts !== undefined && !Array.isArray(input.upserts)) {
        return { conflict: "Realtime delta upserts must be an array when provided." };
      }
      if (input.deletes !== undefined && !Array.isArray(input.deletes)) {
        return { conflict: "Realtime delta deletes must be an array when provided." };
      }
      event = Object.freeze({
        ...base,
        type: "delta",
        ...(input.upserts !== undefined
          ? {
              upserts: Object.freeze(input.upserts.slice()) as RealtimeDeltaEvent<TFeature>["upserts"],
            }
          : {}),
        ...(input.deletes !== undefined
          ? {
              deletes: Object.freeze(input.deletes.slice()) as RealtimeDeltaEvent<TFeature>["deletes"],
            }
          : {}),
      });
      break;
  }

  const position = eventPosition(event);
  if (position.conflict) return { conflict: position.conflict, reason: "checkpoint-conflict" };
  return Object.freeze({
    event,
    ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    position,
    replacementSnapshot: event.type === "snapshot" && event.replace !== false,
    recoverySnapshot: false,
  });
}

function eventPosition<TFeature>(event: RealtimeSequencedEvent<TFeature>): EventPosition {
  const pairs: Array<readonly [keyof RealtimeResumeCheckpoint, unknown, unknown]> = [
    ["cursor", event.cursor, event.checkpoint?.cursor],
    ["watermark", event.watermark, event.checkpoint?.watermark],
    ["timestamp", event.timestamp, event.checkpoint?.timestamp],
    ["sequence", event.sequence, event.checkpoint?.sequence],
    ["deltaToken", event.deltaToken, event.checkpoint?.deltaToken],
  ];
  for (const [name, direct, nested] of pairs) {
    const expectedType = name === "sequence" ? "number" : "string";
    const directInvalid = name === "sequence" ? typeof direct !== "number" : typeof direct !== "string";
    if (direct !== undefined && directInvalid) {
      return { resume: {}, conflict: `Event ${name} must be a ${expectedType}.` };
    }
    const nestedInvalid = name === "sequence" ? typeof nested !== "number" : typeof nested !== "string";
    if (nested !== undefined && nestedInvalid) {
      return { resume: {}, conflict: `Nested checkpoint ${name} must be a ${expectedType}.` };
    }
    if (direct !== undefined && nested !== undefined && direct !== nested) {
      return { resume: {}, conflict: `Event ${name} conflicts with its nested checkpoint value.` };
    }
  }
  const sequence = event.sequence ?? event.checkpoint?.sequence;
  return {
    sequence,
    resume: Object.freeze({
      ...projectResumeCheckpoint(event.checkpoint),
      ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
      ...(event.watermark !== undefined ? { watermark: event.watermark } : {}),
      ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
      ...(event.deltaToken !== undefined ? { deltaToken: event.deltaToken } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
    }),
  };
}

function sameSequenceCheckpointConflict(
  previous: RealtimeResumeCheckpoint | undefined,
  incoming: RealtimeResumeCheckpoint,
): string | undefined {
  for (const name of ["cursor", "deltaToken"] as const) {
    const previousValue = previous?.[name];
    const incomingValue = incoming[name];
    if (previousValue !== undefined && incomingValue !== undefined && previousValue !== incomingValue) {
      return `Realtime sequence ${String(incoming.sequence)} reuses ${name} with a conflicting value.`;
    }
  }
  return undefined;
}

function projectResumeCheckpoint(value: unknown): RealtimeResumeCheckpoint {
  if (!isRecord(value)) return {};
  return {
    ...(value.cursor !== undefined ? { cursor: value.cursor as string } : {}),
    ...(value.watermark !== undefined ? { watermark: value.watermark as string } : {}),
    ...(value.timestamp !== undefined ? { timestamp: value.timestamp as string } : {}),
    ...(value.sequence !== undefined ? { sequence: value.sequence as number } : {}),
    ...(value.deltaToken !== undefined ? { deltaToken: value.deltaToken as string } : {}),
  };
}

function isSequencedEventType(value: unknown): value is RealtimeSequencedEvent["type"] {
  return value === "snapshot" || value === "upsert" || value === "delete" || value === "delta";
}

function isFeatureId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function cloneCheckpoint(
  checkpoint: RealtimeDurableCheckpointV1,
  maxRecentEventIds: number,
): RealtimeDurableCheckpointV1 {
  return freezeCheckpoint({
    kind: checkpoint.kind,
    version: checkpoint.version,
    context: normalizeContext(checkpoint.context),
    resume: Object.freeze(projectResumeCheckpoint(checkpoint.resume)) as RealtimeDurableCheckpointV1["resume"],
    recentEventIds: Object.freeze(checkpoint.recentEventIds.slice(-maxRecentEventIds)),
    savedAt: checkpoint.savedAt,
  });
}

function freezeCheckpoint(checkpoint: RealtimeDurableCheckpointV1): RealtimeDurableCheckpointV1 {
  return Object.freeze(checkpoint);
}

function freezeState(state: ResumableRealtimeState): ResumableRealtimeState {
  return Object.freeze(state);
}

function compatibility(
  compatibleValue: boolean,
  code: RealtimeCheckpointCompatibilityCode,
  reason: string,
): RealtimeCheckpointCompatibility {
  return Object.freeze({ compatible: compatibleValue, code, reason });
}

function delivery(
  status: ResumableRealtimeDeliveryStatus,
  reason: ResumableRealtimeReasonCode | undefined,
  state: ResumableRealtimeState,
): ResumableRealtimeDelivery {
  return Object.freeze({
    status,
    ...(reason ? { reason } : {}),
    ...(state.checkpoint ? { checkpoint: state.checkpoint } : {}),
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HonuaRealtimeResumeError("invalid-checkpoint", `${name} must be a safe integer greater than zero.`);
  }
  return value;
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new HonuaRealtimeResumeError("invalid-checkpoint", `${name} must be non-empty.`);
  return normalized;
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCheckpointShape(value: unknown): value is RealtimeDurableCheckpointV1 {
  if (!isRecord(value)) return false;
  if (value.kind !== "honua.realtime-checkpoint" || value.version !== REALTIME_DURABLE_CHECKPOINT_VERSION) return false;
  if (!isResumeContextShape(value.context) || !isRecord(value.resume) || !isSequence(value.resume.sequence))
    return false;
  for (const name of ["cursor", "watermark", "timestamp", "deltaToken"] as const) {
    if (value.resume[name] !== undefined && typeof value.resume[name] !== "string") return false;
  }
  if (
    !Array.isArray(value.recentEventIds) ||
    value.recentEventIds.length > MAX_RECENT_EVENT_IDS ||
    value.recentEventIds.some((entry) => typeof entry !== "string")
  )
    return false;
  return typeof value.savedAt === "string" && Number.isFinite(Date.parse(value.savedAt));
}

function isResumeContextShape(value: unknown): value is RealtimeResumeContextV1 {
  return (
    isRecord(value) &&
    value.kind === "honua.realtime-resume-context" &&
    value.version === 1 &&
    typeof value.sourceId === "string" &&
    typeof value.queryFingerprint === "string" &&
    typeof value.sourceVersion === "string" &&
    typeof value.schemaVersion === "string" &&
    typeof value.authorizationScopeFingerprint === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNow(value: number): number {
  if (!Number.isFinite(value))
    throw new HonuaRealtimeResumeError("invalid-checkpoint", "now() must return a finite time.");
  return value;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
