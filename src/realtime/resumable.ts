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

export class HonuaRealtimeResumeError extends Error {
  public constructor(
    public readonly code: ResumableRealtimeReasonCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaRealtimeResumeError";
  }
}

const DEFAULT_MAX_PENDING_EVENTS = 64;
const DEFAULT_MAX_RECENT_EVENT_IDS = 256;

interface PendingDelivery<TFeature> {
  readonly event: RealtimeSequencedEvent<TFeature>;
  readonly resolve: (delivery: ResumableRealtimeDelivery) => void;
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

      const replacementSnapshot = event.type === "snapshot" && event.replace !== false;
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
        queue.push({ event, resolve });
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

  if (lifecycle.signal.aborted && state.phase !== "closed") {
    closeSubscription("Subscription signal was aborted.", "cancelled", false);
  } else
    lifecycle.signal.addEventListener(
      "abort",
      () => closeSubscription("Subscription signal was aborted.", "cancelled", false),
      { once: true },
    );
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
    void process(next.event, activeAbort.signal, operationGeneration)
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
    event: RealtimeSequencedEvent<TFeature>,
    signal: AbortSignal,
    operationGeneration: number,
  ): Promise<ResumableRealtimeDelivery> {
    if (signal.aborted || lifecycle.signal.aborted || operationGeneration !== generation) {
      return delivery("cancelled", "cancelled", state);
    }
    const position = eventPosition(event);
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
    if (event.eventId !== undefined && typeof event.eventId !== "string") {
      transitionToResnapshot("checkpoint-conflict", "Realtime eventId must be a string when provided.");
      return delivery("resnapshot-required", "checkpoint-conflict", state);
    }

    const replacementSnapshot = event.type === "snapshot" && event.replace !== false;
    const previousSequence = state.checkpoint?.resume.sequence;
    if (!state.checkpoint && !replacementSnapshot) {
      transitionToResnapshot("snapshot-required", "A replacement snapshot is required before delta delivery.");
      return delivery("resnapshot-required", "snapshot-required", state);
    }
    if (event.type === "snapshot" && !replacementSnapshot && state.phase !== "live") {
      transitionToResnapshot("replacement-snapshot-required", "A merging snapshot cannot establish a resume baseline.");
      return delivery("resnapshot-required", "replacement-snapshot-required", state);
    }

    if (!replacementSnapshot && previousSequence !== undefined) {
      if (position.sequence <= previousSequence) {
        setState({ duplicateEventCount: state.duplicateEventCount + 1 });
        return delivery("duplicate", undefined, state);
      }
      if (previousSequence === Number.MAX_SAFE_INTEGER || position.sequence !== previousSequence + 1) {
        transitionToResnapshot(
          "sequence-gap",
          `Expected realtime sequence ${previousSequence + 1}, received ${position.sequence}.`,
        );
        return delivery("resnapshot-required", "sequence-gap", state);
      }
    }

    const recentIds = replacementSnapshot ? [] : (state.checkpoint?.recentEventIds ?? []);
    if (event.eventId && recentIds.includes(event.eventId)) {
      transitionToResnapshot("event-id-reused", `Event id "${event.eventId}" was reused at a new sequence.`);
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
      replacementSnapshot ? undefined : state.checkpoint,
      { ...position, sequence: position.sequence },
      event.eventId,
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
    resume: Object.freeze({ ...(previous?.resume ?? {}), ...position.resume, sequence: position.sequence }),
    recentEventIds: Object.freeze(recentEventIds),
    savedAt: new Date(finiteNow(now)).toISOString(),
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
      ...(event.checkpoint ?? {}),
      ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
      ...(event.watermark !== undefined ? { watermark: event.watermark } : {}),
      ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
      ...(event.deltaToken !== undefined ? { deltaToken: event.deltaToken } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
    }),
  };
}

function cloneCheckpoint(
  checkpoint: RealtimeDurableCheckpointV1,
  maxRecentEventIds: number,
): RealtimeDurableCheckpointV1 {
  return freezeCheckpoint({
    kind: checkpoint.kind,
    version: checkpoint.version,
    context: normalizeContext(checkpoint.context),
    resume: Object.freeze({ ...checkpoint.resume }),
    recentEventIds: Object.freeze([...checkpoint.recentEventIds].slice(-maxRecentEventIds)),
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
  if (!Array.isArray(value.recentEventIds) || value.recentEventIds.some((entry) => typeof entry !== "string"))
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
