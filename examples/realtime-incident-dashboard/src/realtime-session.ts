import {
  HonuaRealtimeResumeError,
  createResumableRealtimeSubscription,
  realtimeSubscriptionKey,
} from "@honua/sdk-js/realtime";
import type {
  RealtimeConnectionStatus,
  RealtimeExternalResnapshotReason,
  RealtimeFeatureEvent,
  RealtimeFeatureStore,
  RealtimeFeatureTransport,
  RealtimeResumeContextV1,
  RealtimeSequencedEvent,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
  ResumableRealtimeDelivery,
  ResumableRealtimeReasonCode,
  ResumableRealtimeState,
} from "@honua/sdk-js/realtime";

export type IncidentRealtimeReceiptOutcome =
  | "applied"
  | "duplicate"
  | "reordered"
  | "resnapshot-required"
  | "replacement-snapshot-applied"
  | "cancelled"
  | "error";

export interface IncidentRealtimeReceipt {
  readonly outcome: IncidentRealtimeReceiptOutcome;
  readonly eventType?: RealtimeSequencedEvent["type"];
  readonly eventId?: string;
  readonly sequence?: number;
  readonly reason?: ResumableRealtimeReasonCode;
  readonly checkpointSequence?: number;
  readonly duplicateEventCount: number;
  readonly gapCount: number;
  readonly phase: ResumableRealtimeState["phase"];
}

export interface IncidentRealtimeSession {
  readonly gateState: ResumableRealtimeState;
  readonly lastReceipt: IncidentRealtimeReceipt | undefined;
  connect(): RealtimeSubscriptionHandle;
  close(): IncidentRealtimeReceipt;
}

export interface IncidentRealtimeContextOptions {
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly authorizationScopeFingerprint: string;
}

export interface CreateIncidentRealtimeSessionOptions<TFeature> {
  readonly store: RealtimeFeatureStore<TFeature>;
  readonly transport: RealtimeFeatureTransport<TFeature>;
  readonly request: RealtimeSubscriptionRequest;
  readonly context: RealtimeResumeContextV1;
  readonly now?: () => number;
  readonly onReceipt?: (receipt: IncidentRealtimeReceipt) => void;
}

export interface WaitForIncidentRealtimeStatusOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Wait for a control-plane acknowledgement to become observable on the data
 * stream. Fixture actions respond independently from SSE delivery, so callers
 * must not release queued mutations until the store has seen the status event
 * that changes write authority.
 */
export function waitForIncidentRealtimeStatus<TFeature>(
  store: RealtimeFeatureStore<TFeature>,
  expectedStatus: RealtimeConnectionStatus,
  options: WaitForIncidentRealtimeStatusOptions = {},
): Promise<void> {
  if (store.state.status === expectedStatus) return Promise.resolve();
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new TypeError("Incident realtime status timeout must be a positive safe integer."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      fail(new DOMException("Incident realtime status observation was aborted.", "AbortError"));
    };
    const timeout = setTimeout(() => {
      fail(new Error(`Timed out waiting for incident realtime status "${expectedStatus}".`));
    }, timeoutMs);

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = store.subscribe((state) => {
      if (state.status === expectedStatus) complete();
    });
    if (store.state.status === expectedStatus) complete();
  });
}

export function createIncidentRealtimeResumeContext(
  request: RealtimeSubscriptionRequest,
  options: IncidentRealtimeContextOptions,
): RealtimeResumeContextV1 {
  return {
    kind: "honua.realtime-resume-context",
    version: 1,
    sourceId: request.sourceId,
    queryFingerprint: realtimeSubscriptionKey(request),
    sourceVersion: options.sourceVersion,
    schemaVersion: options.schemaVersion,
    authorizationScopeFingerprint: options.authorizationScopeFingerprint,
  };
}

/**
 * Compose the public resumable-delivery gate with the public realtime store.
 * Transport reconnection remains transport-owned; this session only admits
 * ordered data and makes replacement-snapshot transitions explicit.
 */
export async function createIncidentRealtimeSession<TFeature>(
  options: CreateIncidentRealtimeSessionOptions<TFeature>,
): Promise<IncidentRealtimeSession> {
  const lifecycle = new AbortController();
  let handle: RealtimeSubscriptionHandle | undefined;
  let connected = false;
  let lastReceipt: IncidentRealtimeReceipt | undefined;

  const gate = await createResumableRealtimeSubscription<TFeature>({
    context: options.context,
    now: options.now,
    signal: lifecycle.signal,
    apply: (event) => {
      options.store.apply(event);
    },
  });

  function emitReceipt(receipt: IncidentRealtimeReceipt): IncidentRealtimeReceipt {
    lastReceipt = Object.freeze(receipt);
    options.onReceipt?.(lastReceipt);
    return lastReceipt;
  }

  function receipt(
    outcome: IncidentRealtimeReceiptOutcome,
    event?: RealtimeSequencedEvent<TFeature>,
    reason?: ResumableRealtimeReasonCode,
  ): IncidentRealtimeReceipt {
    const state = gate.state;
    return {
      outcome,
      ...(event ? { eventType: event.type } : {}),
      ...(event?.eventId ? { eventId: event.eventId } : {}),
      ...(event?.sequence === undefined ? {} : { sequence: event.sequence }),
      ...(reason ? { reason } : {}),
      ...(state.checkpoint ? { checkpointSequence: state.checkpoint.resume.sequence } : {}),
      duplicateEventCount: state.duplicateEventCount,
      gapCount: state.gapCount,
      phase: state.phase,
    };
  }

  function markResnapshotRequired(
    reason: RealtimeExternalResnapshotReason,
    detail: string,
    observedAt = options.now?.() ?? Date.now(),
  ): void {
    gate.requireResnapshot(reason, detail);
    options.store.apply({
      type: "status",
      status: "stale",
      staleSince: observedAt,
      reason,
      receivedAt: observedAt,
    });
    emitReceipt(receipt("resnapshot-required", undefined, reason));
  }

  function handleDelivery(
    event: RealtimeSequencedEvent<TFeature>,
    before: ResumableRealtimeState,
    delivery: ResumableRealtimeDelivery,
  ): void {
    if (delivery.status === "applied") {
      emitReceipt(receipt(before.phase === "resnapshot-required" ? "replacement-snapshot-applied" : "applied", event));
      return;
    }
    if (delivery.status === "duplicate") {
      const priorSequence = before.checkpoint?.resume.sequence;
      emitReceipt(
        receipt(
          event.sequence !== undefined && priorSequence !== undefined && event.sequence < priorSequence
            ? "reordered"
            : "duplicate",
          event,
        ),
      );
      return;
    }
    if (delivery.status === "resnapshot-required") {
      const receivedAt = event.receivedAt ?? options.now?.() ?? Date.now();
      options.store.apply({
        type: "status",
        status: "stale",
        staleSince: receivedAt,
        reason: delivery.reason ?? "replacement-snapshot-required",
        receivedAt,
      });
    }
    emitReceipt(
      receipt(
        delivery.status === "cancelled" ? "cancelled" : delivery.status === "error" ? "error" : "resnapshot-required",
        event,
        delivery.reason,
      ),
    );
  }

  function enqueue(event: RealtimeSequencedEvent<TFeature>): void {
    const before = gate.state;
    void gate.enqueue(event).then((delivery) => handleDelivery(event, before, delivery));
  }

  function handleEvent(event: RealtimeFeatureEvent<TFeature>): void {
    if (lifecycle.signal.aborted) return;
    if (isSequencedEvent(event)) {
      enqueue(event);
      return;
    }
    if (event.type === "error" && cursorExpired(event)) {
      options.store.apply(event);
      markResnapshotRequired(
        "cursor-expired",
        "The realtime cursor expired; a replacement snapshot is required.",
        event.receivedAt,
      );
      return;
    }
    if (gate.state.phase === "resnapshot-required" && (event.type === "heartbeat" || isLiveStatus(event))) {
      return;
    }
    if (event.type === "status" && event.status === "live" && gate.state.phase !== "live") {
      options.store.apply({
        ...event,
        status: "connecting",
        reason: "awaiting-authoritative-snapshot",
      });
      return;
    }
    options.store.apply(event);
  }

  function handleTransportError(error: unknown): void {
    if (lifecycle.signal.aborted) return;
    const resnapshotReason = transportResnapshotReason(error);
    if (resnapshotReason) {
      markResnapshotRequired(resnapshotReason, error instanceof Error ? error.message : String(error));
      return;
    }
    options.store.apply({ type: "error", error });
  }

  return {
    get gateState() {
      return gate.state;
    },
    get lastReceipt() {
      return lastReceipt;
    },
    connect() {
      if (connected) throw new Error("Incident realtime session is already connected.");
      if (lifecycle.signal.aborted) throw new Error("Incident realtime session is closed.");
      connected = true;
      options.store.apply({ type: "status", status: "connecting" });
      handle = options.transport.subscribe(
        { ...options.request, signal: lifecycle.signal },
        {
          next: handleEvent,
          error: handleTransportError,
          complete() {
            if (!lifecycle.signal.aborted) options.store.apply({ type: "status", status: "closed" });
          },
        },
      );
      return {
        close() {
          closeSession("Incident realtime connection closed by caller.");
        },
      };
    },
    close() {
      return closeSession("Incident realtime session disposed.");
    },
  };

  function closeSession(reason: string): IncidentRealtimeReceipt {
    if (lifecycle.signal.aborted && lastReceipt?.outcome === "cancelled") return lastReceipt;
    if (!lifecycle.signal.aborted) lifecycle.abort(reason);
    handle?.close();
    handle = undefined;
    gate.close(reason);
    options.store.apply({ type: "status", status: "closed", reason });
    return emitReceipt(receipt("cancelled", undefined, "cancelled"));
  }
}

function isSequencedEvent<TFeature>(event: RealtimeFeatureEvent<TFeature>): event is RealtimeSequencedEvent<TFeature> {
  return event.type === "snapshot" || event.type === "upsert" || event.type === "delete" || event.type === "delta";
}

function isLiveStatus<TFeature>(
  event: RealtimeFeatureEvent<TFeature>,
): event is Extract<RealtimeFeatureEvent<TFeature>, { readonly type: "status" }> {
  return event.type === "status" && event.status === "live";
}

function cursorExpired<TFeature>(event: Extract<RealtimeFeatureEvent<TFeature>, { readonly type: "error" }>): boolean {
  return normalizeReason(event.code) === "cursor-expired";
}

function transportResnapshotReason(error: unknown): RealtimeExternalResnapshotReason | undefined {
  if (!(error instanceof HonuaRealtimeResumeError)) return undefined;
  if (error.code === "cursor-expired" || error.code === "resume-unsupported" || error.code === "transport-gap") {
    return error.code;
  }
  return undefined;
}

function normalizeReason(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replaceAll("_", "-");
}
