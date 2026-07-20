/**
 * Bounded, resumable SSE and WebSocket transports for `@honua/sdk-js/realtime`
 * (issue #557), built on the #556 snapshot/delta/cursor/resume/plan-identity
 * contract.
 *
 * `resumable.ts` deliberately never reconnects a transport — that ownership
 * is explicitly deferred to this module (see
 * `docs/decisions/realtime-snapshot-delta-cursor-resume-plan-identity-contract.md`,
 * "the gate never reconnects a transport itself"). This module closes that
 * gap by wrapping any raw {@link RealtimeFeatureTransport} (the SSE adapter
 * in `sse.ts`, the WebSocket adapter in `websocket.ts`, or a custom one) with:
 *
 * - the bounded delivery gate from `resumable.ts` (`maxPendingEvents`,
 *   duplicate/gap detection, cross-scope checkpoint rejection);
 * - reconnect ownership with exponential-backoff-and-jitter retry, bounded by
 *   `reconnect.maxAttempts` — exhausting attempts fails closed rather than
 *   retrying forever;
 * - a heartbeat/liveness timeout that treats prolonged silence as a
 *   transport-detected gap;
 * - resume-vs-resnapshot selection driven entirely by the gate's own
 *   `phase`: a reconnect resumes from the last accepted checkpoint's cursor
 *   only while the gate considers it valid, and requests a fresh snapshot
 *   the moment the gate (or this module, via `requireResnapshot`) decides
 *   otherwise — REQ-003's "resume only with a valid scoped cursor";
 * - idempotent disposal that stops timers, the active connection, and the
 *   delivery gate exactly once, however disposal was triggered
 *   (caller `close()`, external `AbortSignal`, or an unrecoverable failure);
 * - redacted telemetry (`onTelemetry`) built on `contract.ts`'s
 *   `deriveRealtimeContractAuthority` / `redactRealtimeCheckpoint`, so a raw
 *   cursor, watermark, or delta-token never reaches a log or metrics sink.
 *
 * The result still satisfies `RealtimeFeatureTransport`, so it composes with
 * `createRealtimeFeatureStore` exactly like any other transport.
 *
 * @module
 */

import { deriveRealtimeContractAuthority, redactRealtimeCheckpoint } from "./contract.js";
import type { RealtimeContractAuthority, RedactedRealtimeCheckpointV1 } from "./contract.js";
import {
  HonuaRealtimeResumeError,
  type RealtimeCheckpointStore,
  type RealtimeDurableCheckpointV1,
  type RealtimeExternalResnapshotReason,
  type RealtimeResumeContextV1,
  type ResumableRealtimeSubscription,
  createResumableRealtimeSubscription,
} from "./resumable.js";
import { createRealtimeServerSentEventsTransport } from "./sse.js";
import type { RealtimeServerSentEventsTransportOptions } from "./sse.js";
import type {
  RealtimeFeatureEvent,
  RealtimeFeatureObserver,
  RealtimeFeatureTransport,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
} from "./types.js";
import { createRealtimeWebSocketTransport } from "./websocket.js";
import type { RealtimeWebSocketTransportOptions } from "./websocket.js";

export interface RealtimeReconnectPolicy {
  /** Consecutive reconnect attempts allowed before failing closed. `0` disables reconnect entirely. @default 8 */
  readonly maxAttempts?: number;
  /** Delay before the first reconnect attempt. @default 250 */
  readonly baseDelayMs?: number;
  /** Upper bound on the exponential backoff delay, before jitter. @default 30000 */
  readonly maxDelayMs?: number;
  /** How long a connection must stay live before a subsequent failure resets the attempt counter. @default 15000 */
  readonly resetAfterMs?: number;
}

export interface RealtimeResumableTransportTelemetry {
  readonly authority: RealtimeContractAuthority;
  readonly reconnectAttempt: number;
  readonly acceptedEventCount: number;
  readonly duplicateEventCount: number;
  readonly gapCount: number;
  readonly overflowCount: number;
  /** Never a raw cursor, watermark, or delta-token value. */
  readonly checkpoint?: RedactedRealtimeCheckpointV1;
}

export interface RealtimeResumableTransportOptions<TFeature = unknown> {
  readonly context: RealtimeResumeContextV1;
  readonly checkpointStore?: RealtimeCheckpointStore;
  /**
   * Seed resume position for the very first connection, validated the same
   * way a loaded `checkpointStore` checkpoint is (`evaluateRealtimeCheckpoint`).
   * This is the only supported way to seed a resume position: `subscribe()`'s
   * `request.cursor` / `resumeFrom` and similar fields are ignored by this
   * wrapper so a stale or unscoped caller-supplied position can never bypass
   * checkpoint compatibility validation.
   */
  readonly initialCheckpoint?: RealtimeDurableCheckpointV1;
  /** Includes the currently applying event. @default 64 */
  readonly maxPendingEvents?: number;
  /** Bounded event-id history persisted with each checkpoint. @default 256 */
  readonly maxRecentEventIds?: number;
  readonly reconnect?: RealtimeReconnectPolicy;
  /** No event (including heartbeats) within this window is treated as a transport-detected gap. Disabled when omitted. */
  readonly heartbeatTimeoutMs?: number;
  /** Forwarded to {@link deriveRealtimeContractAuthority} for telemetry. */
  readonly staleAfterMs?: number;
  readonly onTelemetry?: (telemetry: RealtimeResumableTransportTelemetry) => void;
  readonly now?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_RESET_AFTER_MS = 15_000;

const EXTERNAL_RESNAPSHOT_REASONS: ReadonlySet<string> = new Set([
  "cursor-expired",
  "resume-unsupported",
  "transport-gap",
] satisfies RealtimeExternalResnapshotReason[]);

interface NormalizedReconnectPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly resetAfterMs: number;
}

function normalizeReconnectPolicy(policy: RealtimeReconnectPolicy | undefined): NormalizedReconnectPolicy {
  return {
    maxAttempts: nonNegativeIntOr(policy?.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    baseDelayMs: nonNegativeIntOr(policy?.baseDelayMs, DEFAULT_BASE_DELAY_MS),
    maxDelayMs: nonNegativeIntOr(policy?.maxDelayMs, DEFAULT_MAX_DELAY_MS),
    resetAfterMs: nonNegativeIntOr(policy?.resetAfterMs, DEFAULT_RESET_AFTER_MS),
  };
}

function nonNegativeIntOr(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}

/**
 * Exponential backoff with jitter in the [0.5x, 1x] band for the given
 * zero-based reconnect attempt — the same shape as
 * `core/request-pipeline.ts`'s `resolveRetryDelayMs`, reimplemented locally
 * so `@honua/sdk-js/realtime` does not pull in the HTTP request pipeline's
 * error/type graph for one small helper. Exported so the schedule can be
 * asserted deterministically without driving a fake transport end-to-end.
 */
export function computeReconnectDelayMs(policy: RealtimeReconnectPolicy | undefined, attempt: number): number {
  const normalized = normalizeReconnectPolicy(policy);
  const exponential = normalized.baseDelayMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(normalized.maxDelayMs, exponential);
  return capped * (0.5 + Math.random() * 0.5);
}

/**
 * Wrap a raw {@link RealtimeFeatureTransport} with bounded, resumable
 * delivery: the #556 delivery gate, reconnect/backoff, heartbeat timeout,
 * and redacted telemetry. See the module doc for the full behavior.
 */
export function createResumableRealtimeTransport<TFeature = unknown>(
  transport: RealtimeFeatureTransport<TFeature>,
  options: RealtimeResumableTransportOptions<TFeature>,
): RealtimeFeatureTransport<TFeature> {
  const policy = normalizeReconnectPolicy(options.reconnect);
  return {
    capabilities: transport.capabilities,
    subscribe(request, observer): RealtimeSubscriptionHandle {
      if (request.signal?.aborted) {
        observer.complete();
        return { close: () => {} };
      }

      // Every field that could seed a resume position is dropped: this
      // wrapper always derives `resumeFrom` from the gate's own validated
      // checkpoint (see `connect()`), never from caller input, so a stale or
      // unscoped position can never reach the wire.
      const {
        cursor: _cursor,
        watermark: _watermark,
        timestamp: _timestamp,
        deltaToken: _deltaToken,
        resumeFrom: _resumeFrom,
        signal: _signal,
        ...baseIdentity
      } = request;

      const lifecycle = new AbortController();
      // `lifecycle.signal` is handed to `gate` and to every `transport.subscribe()`
      // call so a well-behaved transport (sse.ts, websocket.ts) tears itself down
      // too, but disposal here never depends on that: `disposeGracefully`/
      // `failClosed` below also close the active handle directly, so an external
      // abort is honored even against a transport double that ignores `signal`.
      const externalAbort = () => disposeGracefully("Subscription signal was aborted.");
      if (request.signal) request.signal.addEventListener("abort", externalAbort, { once: true });

      let gate: ResumableRealtimeSubscription<TFeature> | undefined;
      let activeHandle: RealtimeSubscriptionHandle | undefined;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let reconnectAttempt = 0;
      let connectedAt: number | undefined;
      let closed = false;
      let expectingTeardown = false;

      const currentNow = (): number => options.now?.() ?? Date.now();

      function emitTelemetry(): void {
        if (!options.onTelemetry || !gate) return;
        const state = gate.state;
        try {
          options.onTelemetry({
            authority: deriveRealtimeContractAuthority(state, {
              staleAfterMs: options.staleAfterMs,
              now: currentNow(),
            }),
            reconnectAttempt,
            acceptedEventCount: state.acceptedEventCount,
            duplicateEventCount: state.duplicateEventCount,
            gapCount: state.gapCount,
            overflowCount: state.overflowCount,
            ...(state.checkpoint ? { checkpoint: redactRealtimeCheckpoint(state.checkpoint) } : {}),
          });
        } catch {
          // Telemetry is diagnostic and must never affect delivery; a
          // throwing onTelemetry callback is the caller's bug, not a
          // reason to fail the subscription.
        }
      }

      function hasBeenStableSince(): boolean {
        return connectedAt !== undefined && currentNow() - connectedAt >= policy.resetAfterMs;
      }

      function clearHeartbeatTimer(): void {
        if (heartbeatTimer !== undefined) {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      }

      function clearReconnectTimer(): void {
        if (reconnectTimer !== undefined) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
      }

      function armHeartbeat(): void {
        if (options.heartbeatTimeoutMs === undefined) return;
        clearHeartbeatTimer();
        heartbeatTimer = setTimeout(onHeartbeatTimeout, options.heartbeatTimeoutMs);
      }

      function onHeartbeatTimeout(): void {
        heartbeatTimer = undefined;
        if (closed || !gate) return;
        gate.requireResnapshot(
          "transport-gap",
          `No realtime event observed within ${String(options.heartbeatTimeoutMs)}ms.`,
        );
        scheduleReconnect("heartbeat-timeout");
      }

      function teardownActiveHandle(): void {
        clearHeartbeatTimer();
        if (!activeHandle) return;
        const handle = activeHandle;
        activeHandle = undefined;
        expectingTeardown = true;
        try {
          handle.close();
        } finally {
          expectingTeardown = false;
        }
      }

      function isExternalResnapshotReason(code: string): code is RealtimeExternalResnapshotReason {
        return EXTERNAL_RESNAPSHOT_REASONS.has(code);
      }

      function handleTransportError(error: unknown): void {
        if (closed) return;
        const resumeError = error instanceof HonuaRealtimeResumeError ? error : undefined;
        if (!resumeError?.retryable) {
          failClosed(error);
          return;
        }
        if (isExternalResnapshotReason(resumeError.code)) {
          gate?.requireResnapshot(resumeError.code, resumeError.message);
        }
        scheduleReconnect(resumeError.message);
      }

      function scheduleReconnect(detail: string): void {
        if (closed || lifecycle.signal.aborted || !gate) return;
        // A burst of in-flight deliveries (e.g. several queued events that
        // each resolve `resnapshot-required`) can each call this before the
        // pending reconnect delay fires. Only the first is honored — a
        // reconnect is already scheduled, so later calls in the same burst
        // must be deduplicated into it rather than each arming their own
        // `setTimeout` (which would leak timers, double-count
        // `reconnectAttempt`, and open several concurrent connections when
        // they all fire).
        if (reconnectTimer !== undefined) return;
        teardownActiveHandle();
        if (reconnectAttempt >= policy.maxAttempts) {
          failClosed(
            new HonuaRealtimeResumeError(
              "delivery-failed",
              `Realtime transport reconnect attempts exhausted after ${String(reconnectAttempt)} tries (${detail}).`,
            ),
          );
          return;
        }
        const delay = computeReconnectDelayMs(options.reconnect, reconnectAttempt);
        reconnectAttempt += 1;
        emitTelemetry();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          void connect();
        }, delay);
      }

      async function connect(): Promise<void> {
        if (closed || lifecycle.signal.aborted || !gate) return;
        connectedAt = undefined;
        // Resume only while the gate still considers the last checkpoint
        // valid (REQ-003). Once the gate — or `requireResnapshot` above —
        // has moved to `resnapshot-required`, the checkpoint is left in
        // place for callers that read it, but this wrapper never sends it
        // back over the wire until a fresh snapshot is accepted.
        const requiresResnapshot = gate.state.phase === "resnapshot-required";
        const resumeFrom = requiresResnapshot ? undefined : gate.state.checkpoint?.resume;
        // The gate's sole recovery path out of `resnapshot-required` is a
        // `snapshot` event (`resumable.ts`'s `enqueue`: every other event is
        // rejected while that phase holds). A subscription originally opened
        // in pure `delta` mode never asks the transport for an initial
        // snapshot, so reconnecting still in `delta` mode after a
        // cursor-expired / transport-gap resnapshot would drop `resumeFrom`
        // but never receive the snapshot needed to leave `resnapshot-required`
        // — every subsequent delta is silently rejected and the caller loses
        // the gap's data (and everything after it) for good. Upgrade to
        // `snapshot-then-delta` so the reconnect requests a fresh snapshot
        // before deltas resume.
        const modeOverride =
          requiresResnapshot && baseIdentity.mode === "delta" ? ({ mode: "snapshot-then-delta" } as const) : {};
        const effectiveRequest: RealtimeSubscriptionRequest = {
          ...baseIdentity,
          ...modeOverride,
          ...(resumeFrom ? { resumeFrom } : {}),
          signal: lifecycle.signal,
        };
        try {
          activeHandle = transport.subscribe(effectiveRequest, innerObserver);
        } catch (cause) {
          handleTransportError(cause);
          return;
        }
        if (closed) {
          // The transport completed or errored synchronously inside
          // subscribe(), before returning its handle: disposal already ran
          // without it. Close it now so nothing leaks.
          activeHandle?.close();
          activeHandle = undefined;
          return;
        }
        emitTelemetry();
      }

      /** Stop timers, the active connection, and the gate exactly once, then report a clean end. Idempotent. */
      function disposeGracefully(reason: string): void {
        if (closed) return;
        closed = true;
        clearHeartbeatTimer();
        clearReconnectTimer();
        teardownActiveHandle();
        gate?.close(reason);
        if (request.signal) request.signal.removeEventListener("abort", externalAbort);
        if (!lifecycle.signal.aborted) lifecycle.abort(reason);
        emitTelemetry();
        observer.complete();
      }

      /** Stop timers, the active connection, and the gate exactly once, then report a terminal failure. Idempotent. */
      function failClosed(error: unknown): void {
        if (closed) return;
        closed = true;
        clearHeartbeatTimer();
        clearReconnectTimer();
        teardownActiveHandle();
        gate?.close(errorMessage(error));
        if (request.signal) request.signal.removeEventListener("abort", externalAbort);
        if (!lifecycle.signal.aborted) lifecycle.abort("realtime resumable transport failed closed");
        emitTelemetry();
        observer.error(error);
      }

      const innerObserver: RealtimeFeatureObserver<TFeature> = {
        next(event) {
          switch (event.type) {
            case "snapshot":
            case "upsert":
            case "delete":
            case "delta": {
              armHeartbeat();
              if (!gate) return;
              void gate.enqueue(event).then((result) => {
                if (closed) return;
                if (result.status === "applied" || result.status === "duplicate") {
                  reconnectAttempt = 0;
                } else if (result.status === "resnapshot-required") {
                  scheduleReconnect(result.reason ?? "resnapshot-required");
                } else if (result.status === "error") {
                  failClosed(
                    new HonuaRealtimeResumeError(
                      result.reason ?? "delivery-failed",
                      gate?.state.detail ?? "Realtime delivery failed.",
                    ),
                  );
                }
                emitTelemetry();
              });
              break;
            }
            case "heartbeat": {
              armHeartbeat();
              if (hasBeenStableSince()) reconnectAttempt = 0;
              observer.next(event);
              emitTelemetry();
              break;
            }
            case "status": {
              if (event.status === "live") connectedAt = currentNow();
              armHeartbeat();
              observer.next(event);
              break;
            }
            case "error": {
              observer.next(event);
              if (event.terminal) failClosed(event.error);
              else handleTransportError(event.error);
              break;
            }
          }
        },
        error(error) {
          handleTransportError(error);
        },
        complete() {
          if (expectingTeardown) return;
          disposeGracefully("Realtime transport completed.");
        },
      };

      void (async () => {
        try {
          gate = await createResumableRealtimeSubscription<TFeature>({
            context: options.context,
            apply: (applied) => observer.next(applied),
            checkpointStore: options.checkpointStore,
            initialCheckpoint: options.initialCheckpoint,
            maxPendingEvents: options.maxPendingEvents,
            maxRecentEventIds: options.maxRecentEventIds,
            now: options.now,
            signal: lifecycle.signal,
          });
        } catch (cause) {
          if (!closed) failClosed(cause);
          return;
        }
        if (closed || lifecycle.signal.aborted) return;
        await connect();
      })();

      return {
        close(): void {
          disposeGracefully("Subscription closed by caller.");
        },
      };
    },
  };
}

/**
 * Convenience factory combining {@link createRealtimeServerSentEventsTransport}
 * with {@link createResumableRealtimeTransport}.
 */
export function createResumableServerSentEventsTransport<TFeature = unknown>(
  sseOptions: RealtimeServerSentEventsTransportOptions<TFeature>,
  resumableOptions: RealtimeResumableTransportOptions<TFeature>,
): RealtimeFeatureTransport<TFeature> {
  return createResumableRealtimeTransport(
    createRealtimeServerSentEventsTransport<TFeature>(sseOptions),
    resumableOptions,
  );
}

/**
 * Convenience factory combining {@link createRealtimeWebSocketTransport}
 * with {@link createResumableRealtimeTransport}.
 */
export function createResumableWebSocketTransport<TFeature = unknown>(
  webSocketOptions: RealtimeWebSocketTransportOptions<TFeature>,
  resumableOptions: RealtimeResumableTransportOptions<TFeature>,
): RealtimeFeatureTransport<TFeature> {
  return createResumableRealtimeTransport(
    createRealtimeWebSocketTransport<TFeature>(webSocketOptions),
    resumableOptions,
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
