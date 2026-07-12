import type { FeatureSelectionTarget, FilterClause } from "../exploration/index.js";
import type { SceneCameraState, SceneDetailState, SceneTimelineState } from "./types.js";

export const SCENE_STATE_SYNC_KIND = "honua.scene-state-sync" as const;
export const SCENE_STATE_SYNC_VERSION = "1.0" as const;

export const SCENE_STATE_SYNC_SLICES = [
  "camera",
  "selection",
  "filters",
  "time",
  "detail",
  "attribution",
  "realtime",
] as const;

export type SceneStateSyncSlice = (typeof SCENE_STATE_SYNC_SLICES)[number];
export type SceneStateSyncRenderer = "maplibre" | "cesium" | "custom";
export type SceneStateSyncFidelity = "exact" | "equivalent" | "unsupported";

export interface SceneStateSyncIdentity {
  readonly sourceId: string;
  readonly schemaVersion?: string;
  readonly sourceVersion?: string;
  readonly planId?: string;
  readonly planFingerprint?: `sha256:${string}`;
}

export interface SceneStateSyncOrigin {
  readonly applicationId: string;
  readonly portId: string;
  readonly renderer: SceneStateSyncRenderer;
}

export interface SceneStateSyncMapping {
  readonly inbound: SceneStateSyncFidelity;
  readonly outbound: SceneStateSyncFidelity;
  readonly code: string;
  readonly message: string;
}

export type SceneStateSyncMappings = Readonly<Record<SceneStateSyncSlice, SceneStateSyncMapping>>;

export interface SceneStateSyncRealtimeValue {
  readonly status: "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly observedAt?: string;
  readonly cursorPresent: boolean;
  readonly lagMs?: number;
}

export interface SceneStateSyncAttributionValue {
  /** Stable attribution identifiers; raw HTML, URLs, and credentials are excluded. */
  readonly ids: readonly string[];
}

export interface SceneStateSyncValueMap {
  readonly camera: SceneCameraState | undefined;
  readonly selection: readonly FeatureSelectionTarget[];
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly time: SceneTimelineState;
  readonly detail: SceneDetailState;
  readonly attribution: SceneStateSyncAttributionValue;
  readonly realtime: SceneStateSyncRealtimeValue;
}

export type SceneStateSyncInput = {
  readonly [Slice in SceneStateSyncSlice]: {
    readonly kind: typeof SCENE_STATE_SYNC_KIND;
    readonly version: typeof SCENE_STATE_SYNC_VERSION;
    readonly sequence: number;
    readonly emittedAt: string;
    readonly slice: Slice;
    readonly value: SceneStateSyncValueMap[Slice];
    readonly identity: SceneStateSyncIdentity;
    /** Revision being acknowledged after a renderer applied a delivery. */
    readonly causeRevision?: number;
  };
}[SceneStateSyncSlice];

export type SceneStateSyncEnvelope = {
  readonly [Slice in SceneStateSyncSlice]: {
    readonly kind: typeof SCENE_STATE_SYNC_KIND;
    readonly version: typeof SCENE_STATE_SYNC_VERSION;
    readonly revision: number;
    readonly acceptedAt: string;
    readonly emittedAt: string;
    readonly slice: Slice;
    readonly value: SceneStateSyncValueMap[Slice];
    readonly identity: SceneStateSyncIdentity;
    readonly origin: SceneStateSyncOrigin;
    readonly fidelity: SceneStateSyncMapping;
  };
}[SceneStateSyncSlice];

export interface SceneStateSyncDelivery {
  readonly envelope: SceneStateSyncEnvelope;
  readonly target: SceneStateSyncOrigin;
  readonly fidelity: SceneStateSyncMapping;
}

export interface SceneStateSyncPort {
  readonly id: string;
  readonly renderer: SceneStateSyncRenderer;
  readonly mappings: SceneStateSyncMappings;
  subscribe(listener: (event: SceneStateSyncInput) => void, signal: AbortSignal): () => void;
  apply(delivery: SceneStateSyncDelivery, signal: AbortSignal): void | Promise<void>;
}

export type SceneStateSyncDiagnosticCode =
  | "clock-failed"
  | "stale-update"
  | "loop-suppressed"
  | "duplicate-suppressed"
  | "coalesced"
  | "unsupported-origin"
  | "unsupported-target"
  | "apply-failed"
  | "port-detached";

export interface SceneStateSyncDiagnostic {
  readonly code: SceneStateSyncDiagnosticCode;
  readonly at: string;
  readonly applicationId: string;
  readonly portId: string;
  readonly slice?: SceneStateSyncSlice;
  readonly revision?: number;
  readonly message: string;
}

export interface SceneStateSyncSnapshot {
  readonly kind: typeof SCENE_STATE_SYNC_KIND;
  readonly version: typeof SCENE_STATE_SYNC_VERSION;
  readonly applicationId: string;
  readonly revision: number;
  readonly values: Readonly<Partial<{ readonly [Slice in SceneStateSyncSlice]: SceneStateSyncEnvelope }>>;
  readonly diagnostics: readonly SceneStateSyncDiagnostic[];
}

export type SceneStateSyncEvent =
  | { readonly type: "state"; readonly envelope: SceneStateSyncEnvelope; readonly snapshot: SceneStateSyncSnapshot }
  | { readonly type: "diagnostic"; readonly diagnostic: SceneStateSyncDiagnostic };

export type SceneStateSyncErrorCode =
  | "invalid-input"
  | "duplicate-port"
  | "unknown-port"
  | "attach-failed"
  | "disposed"
  | "dispose-failed";

export class HonuaSceneStateSyncError extends Error {
  public constructor(
    public readonly code: SceneStateSyncErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HonuaSceneStateSyncError";
  }
}

export interface CreateSceneStateSynchronizerOptions {
  readonly applicationId: string;
  readonly ports?: readonly SceneStateSyncPort[];
  /** Camera/time coalescing window. Defaults to 16 ms; zero uses a microtask. */
  readonly coalesceMs?: number;
  readonly maxPorts?: number;
  readonly maxDiagnostics?: number;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}

export interface SceneStateSynchronizer {
  readonly disposed: boolean;
  readonly portIds: readonly string[];
  readonly snapshot: SceneStateSyncSnapshot;
  attach(port: SceneStateSyncPort): void;
  attachAll(ports: readonly SceneStateSyncPort[]): void;
  detach(portId: string): void;
  subscribe(listener: (event: SceneStateSyncEvent) => void): () => void;
  flush(): Promise<void>;
  dispose(): void;
}

interface NormalizedPort {
  readonly id: string;
  readonly renderer: SceneStateSyncRenderer;
  readonly mappings: SceneStateSyncMappings;
  subscribe(listener: (event: SceneStateSyncInput) => void, signal: AbortSignal): () => void;
  apply(delivery: SceneStateSyncDelivery, signal: AbortSignal): void | Promise<void>;
}

interface Attachment {
  readonly port: NormalizedPort;
  readonly controller: AbortController;
  readonly generation: number;
  unsubscribe: () => void;
  active: boolean;
  lastSequence: number;
  lastDeliveredRevision: number;
  chain: Promise<void>;
}

interface PendingInput {
  readonly attachment: Attachment;
  readonly input: SceneStateSyncInput;
}

const DEFAULT_MAX_PORTS = 8;
const DEFAULT_MAX_DIAGNOSTICS = 128;
const HARD_MAX_PORTS = 64;
const HARD_MAX_DIAGNOSTICS = 2_048;
const MAX_SYNCHRONOUS_SUBSCRIBE_EVENTS = 32;
const MAX_SELECTION = 2_048;
const MAX_FILTERS = 128;
const MAX_ATTRIBUTIONS = 128;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_PROPERTIES = 256;
const MAX_FOREIGN_ARRAY = 2_048;
const MAX_FOREIGN_NODES = 16_384;
const MAX_FOREIGN_STRING = 1_048_576;
const MAX_FOREIGN_STRING_TOTAL = 4_194_304;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Create one isolated renderer-neutral state synchronization lifecycle. */
export function createSceneStateSynchronizer(options: CreateSceneStateSynchronizerOptions): SceneStateSynchronizer {
  const normalized = normalizeOptions(options);
  const attachments = new Map<string, Attachment>();
  const listeners = new Set<(event: SceneStateSyncEvent) => void>();
  const values: Partial<Record<SceneStateSyncSlice, SceneStateSyncEnvelope>> = {};
  const diagnostics: SceneStateSyncDiagnostic[] = [];
  const pending = new Map<string, PendingInput>();
  let revision = 0;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let microtaskScheduled = false;
  let disposed = false;
  let removeAbortListener: (() => void) | undefined;

  function now(): string {
    return canonicalTimestamp(normalized.now(), "clock");
  }

  function ensureLive(): void {
    if (disposed) throw new HonuaSceneStateSyncError("disposed", "Scene state synchronizer is disposed");
  }

  function snapshot(): SceneStateSyncSnapshot {
    return Object.freeze({
      kind: SCENE_STATE_SYNC_KIND,
      version: SCENE_STATE_SYNC_VERSION,
      applicationId: normalized.applicationId,
      revision,
      values: Object.freeze({ ...values }),
      diagnostics: Object.freeze([...diagnostics]),
    });
  }

  function emit(event: SceneStateSyncEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Observers cannot corrupt state or renderer ownership.
      }
    }
  }

  function diagnose(
    code: SceneStateSyncDiagnosticCode,
    portId: string,
    message: string,
    detail: { readonly slice?: SceneStateSyncSlice; readonly revision?: number } = {},
  ): void {
    let diagnosticAt: string;
    try {
      diagnosticAt = now();
    } catch {
      diagnosticAt = normalized.lastTimestamp();
      if (code !== "clock-failed") {
        recordDiagnostic(
          Object.freeze({
            code: "clock-failed",
            at: diagnosticAt,
            applicationId: normalized.applicationId,
            portId,
            message: "Configured clock failed; the triggering state was not committed.",
          }),
        );
      }
    }
    const diagnostic = Object.freeze({
      code,
      at: diagnosticAt,
      applicationId: normalized.applicationId,
      portId,
      ...(detail.slice === undefined ? {} : { slice: detail.slice }),
      ...(detail.revision === undefined ? {} : { revision: detail.revision }),
      message,
    });
    recordDiagnostic(diagnostic);
  }

  function recordDiagnostic(diagnostic: SceneStateSyncDiagnostic): void {
    diagnostics.push(diagnostic);
    if (diagnostics.length > normalized.maxDiagnostics)
      diagnostics.splice(0, diagnostics.length - normalized.maxDiagnostics);
    emit({ type: "diagnostic", diagnostic });
  }

  function receive(attachment: Attachment, foreign: SceneStateSyncInput): void {
    if (disposed || !attachment.active || attachments.get(attachment.port.id) !== attachment) return;
    let input: SceneStateSyncInput;
    try {
      input = normalizeInput(snapshotForeignData(foreign) as SceneStateSyncInput);
    } catch {
      diagnose("stale-update", attachment.port.id, "Renderer emitted an invalid state envelope.");
      return;
    }
    if (input.sequence <= attachment.lastSequence) {
      diagnose("stale-update", attachment.port.id, "Renderer sequence is stale or out of order.", {
        slice: input.slice,
      });
      return;
    }
    attachment.lastSequence = input.sequence;
    if (input.causeRevision !== undefined && input.causeRevision <= attachment.lastDeliveredRevision) {
      diagnose("loop-suppressed", attachment.port.id, "Renderer acknowledged an applied revision; echo suppressed.", {
        slice: input.slice,
        revision: input.causeRevision,
      });
      return;
    }
    const mapping = attachment.port.mappings[input.slice];
    if (mapping.inbound === "unsupported") {
      diagnose("unsupported-origin", attachment.port.id, mapping.message, { slice: input.slice });
      return;
    }
    if (input.slice === "camera" || input.slice === "time") {
      const key = `${attachment.port.id}\0${input.slice}`;
      if (pending.has(key)) {
        diagnose("coalesced", attachment.port.id, "High-frequency update replaced by a newer final state.", {
          slice: input.slice,
        });
      }
      pending.set(key, { attachment, input });
      scheduleFlush();
      return;
    }
    commit(attachment, input);
  }

  function scheduleFlush(): void {
    if (timer !== undefined || microtaskScheduled) return;
    if (normalized.coalesceMs === 0) {
      microtaskScheduled = true;
      queueMicrotask(() => {
        microtaskScheduled = false;
        if (!disposed) commitPending();
      });
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) commitPending();
    }, normalized.coalesceMs);
  }

  function commitPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const batch = [...pending.values()];
    pending.clear();
    for (const item of batch) {
      if (item.attachment.active && attachments.get(item.attachment.port.id) === item.attachment) {
        commit(item.attachment, item.input);
      }
    }
  }

  function commit(attachment: Attachment, input: SceneStateSyncInput): void {
    const previous = values[input.slice];
    const signature = canonicalSignature(input.value, input.identity);
    if (previous && canonicalSignature(previous.value, previous.identity) === signature) {
      diagnose("duplicate-suppressed", attachment.port.id, "Equivalent state is already current.", {
        slice: input.slice,
        revision: previous.revision,
      });
      return;
    }
    let acceptedAt: string;
    try {
      acceptedAt = now();
    } catch {
      diagnose("clock-failed", attachment.port.id, "Configured clock failed; state was not committed.", {
        slice: input.slice,
      });
      return;
    }
    const nextRevision = revision + 1;
    const envelope = Object.freeze({
      kind: SCENE_STATE_SYNC_KIND,
      version: SCENE_STATE_SYNC_VERSION,
      revision: nextRevision,
      acceptedAt,
      emittedAt: input.emittedAt,
      slice: input.slice,
      value: input.value,
      identity: input.identity,
      origin: Object.freeze({
        applicationId: normalized.applicationId,
        portId: attachment.port.id,
        renderer: attachment.port.renderer,
      }),
      fidelity: attachment.port.mappings[input.slice],
    }) as SceneStateSyncEnvelope;
    revision = nextRevision;
    values[input.slice] = envelope;
    const current = snapshot();
    emit({ type: "state", envelope, snapshot: current });
    for (const target of attachments.values()) {
      if (target !== attachment) deliver(target, envelope);
    }
  }

  function deliver(attachment: Attachment, envelope: SceneStateSyncEnvelope): void {
    if (!attachment.active) return;
    const fidelity = attachment.port.mappings[envelope.slice];
    if (fidelity.outbound === "unsupported") {
      diagnose("unsupported-target", attachment.port.id, fidelity.message, {
        slice: envelope.slice,
        revision: envelope.revision,
      });
      return;
    }
    attachment.lastDeliveredRevision = Math.max(attachment.lastDeliveredRevision, envelope.revision);
    const delivery = Object.freeze({
      envelope,
      target: Object.freeze({
        applicationId: normalized.applicationId,
        portId: attachment.port.id,
        renderer: attachment.port.renderer,
      }),
      fidelity,
    });
    const expectedGeneration = attachment.generation;
    attachment.chain = attachment.chain
      .then(async () => {
        if (
          disposed ||
          !attachment.active ||
          attachment.generation !== expectedGeneration ||
          attachments.get(attachment.port.id) !== attachment
        ) {
          return;
        }
        await attachment.port.apply(delivery, attachment.controller.signal);
      })
      .catch(() => {
        if (!disposed && attachment.active) {
          diagnose("apply-failed", attachment.port.id, "Renderer failed to apply synchronized state.", {
            slice: envelope.slice,
            revision: envelope.revision,
          });
        }
      });
  }

  function attach(portInput: SceneStateSyncPort): void {
    ensureLive();
    if (attachments.size >= normalized.maxPorts) {
      throw new HonuaSceneStateSyncError(
        "attach-failed",
        `Scene state synchronization is limited to ${normalized.maxPorts} ports`,
      );
    }
    const port = normalizePort(portInput);
    if (attachments.has(port.id)) {
      throw new HonuaSceneStateSyncError("duplicate-port", `Scene state port ${port.id} is already attached`);
    }
    const controller = new AbortController();
    const attachment: Attachment = {
      port,
      controller,
      generation: ++generation,
      unsubscribe: () => undefined,
      active: true,
      lastSequence: -1,
      lastDeliveredRevision: 0,
      chain: Promise.resolve(),
    };
    const synchronousEvents: SceneStateSyncInput[] = [];
    let subscribing = true;
    let subscribeFailure: HonuaSceneStateSyncError | undefined;
    try {
      const unsubscribe = port.subscribe((event) => {
        if (!subscribing) {
          receive(attachment, event);
          return;
        }
        if (synchronousEvents.length >= MAX_SYNCHRONOUS_SUBSCRIBE_EVENTS) {
          subscribeFailure ??= new HonuaSceneStateSyncError(
            "attach-failed",
            `Scene state port ${port.id} exceeded the synchronous subscription event limit`,
          );
          return;
        }
        try {
          synchronousEvents.push(snapshotForeignData(event) as SceneStateSyncInput);
        } catch (cause) {
          subscribeFailure ??= new HonuaSceneStateSyncError(
            "attach-failed",
            `Scene state port ${port.id} emitted invalid synchronous state`,
            { cause },
          );
        }
      }, controller.signal);
      if (typeof unsubscribe !== "function") throw new TypeError("port.subscribe must return an unsubscribe function");
      attachment.unsubscribe = once(unsubscribe);
      if (subscribeFailure) throw subscribeFailure;
      attachments.set(port.id, attachment);
      subscribing = false;
    } catch (cause) {
      subscribing = false;
      attachment.active = false;
      controller.abort();
      try {
        attachment.unsubscribe();
      } catch {
        // Preserve the attach failure.
      }
      throw new HonuaSceneStateSyncError("attach-failed", `Failed to attach scene state port ${port.id}`, { cause });
    }
    const replayValues = Object.values(values).sort((left, right) => left.revision - right.revision);
    for (const event of synchronousEvents) receive(attachment, event);
    for (const envelope of replayValues) {
      deliver(attachment, envelope);
    }
  }

  function detach(portIdInput: string): void {
    ensureLive();
    const portId = boundedId(portIdInput, "portId");
    const attachment = attachments.get(portId);
    if (!attachment) throw new HonuaSceneStateSyncError("unknown-port", `Scene state port ${portId} is not attached`);
    attachments.delete(portId);
    attachment.active = false;
    attachment.controller.abort();
    for (const [key, item] of pending) {
      if (item.attachment === attachment) pending.delete(key);
    }
    try {
      attachment.unsubscribe();
    } catch (cause) {
      diagnose("port-detached", portId, "Port detached, but listener cleanup reported a failure.");
      throw new HonuaSceneStateSyncError("dispose-failed", `Failed to detach scene state port ${portId}`, { cause });
    }
    diagnose("port-detached", portId, "Renderer port detached and pending updates were cancelled.");
  }

  function attachAll(ports: readonly SceneStateSyncPort[]): void {
    ensureLive();
    const capturedPorts = captureDenseArray<SceneStateSyncPort>(ports, HARD_MAX_PORTS, "ports");
    const attached: string[] = [];
    try {
      for (const port of capturedPorts) {
        const before = new Set(attachments.keys());
        attach(port);
        const id = [...attachments.keys()].find((candidate) => !before.has(candidate));
        if (id === undefined)
          throw new HonuaSceneStateSyncError("attach-failed", "Port attachment did not register a port");
        attached.push(id);
      }
    } catch (cause) {
      const cleanup: unknown[] = [];
      for (const id of attached.reverse()) {
        try {
          detach(id);
        } catch (error) {
          cleanup.push(error);
        }
      }
      throw new HonuaSceneStateSyncError("attach-failed", "Scene state port group attachment rolled back", {
        cause: cleanup.length === 0 ? cause : new AggregateError([cause, ...cleanup]),
      });
    }
  }

  function subscribe(listener: (event: SceneStateSyncEvent) => void): () => void {
    ensureLive();
    if (typeof listener !== "function")
      throw new HonuaSceneStateSyncError("invalid-input", "listener must be a function");
    listeners.add(listener);
    return once(() => listeners.delete(listener));
  }

  async function flush(): Promise<void> {
    ensureLive();
    commitPending();
    for (;;) {
      const current = [...attachments.values()];
      const chains = current.map((attachment) => attachment.chain);
      await Promise.all(chains);
      if (current.every((attachment, index) => attachment.chain === chains[index])) break;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending.clear();
    removeAbortListener?.();
    listeners.clear();
    const failures: unknown[] = [];
    for (const attachment of attachments.values()) {
      attachment.active = false;
      attachment.controller.abort();
      try {
        attachment.unsubscribe();
      } catch (cause) {
        failures.push(cause);
      }
    }
    attachments.clear();
    if (failures.length > 0) {
      throw new HonuaSceneStateSyncError(
        "dispose-failed",
        "Scene state synchronization disposed with cleanup failures",
        {
          cause: new AggregateError(failures),
        },
      );
    }
  }

  const synchronizer: SceneStateSynchronizer = {
    get disposed() {
      return disposed;
    },
    get portIds() {
      return Object.freeze([...attachments.keys()]);
    },
    get snapshot() {
      ensureLive();
      return snapshot();
    },
    attach,
    attachAll,
    detach,
    subscribe,
    flush,
    dispose,
  };

  try {
    if (normalized.signal) {
      const abort = (): void => {
        try {
          synchronizer.dispose();
        } catch {
          // Cancellation still transitions to disposed after cleanup attempts.
        }
      };
      removeAbortListener = normalized.signal.subscribe(abort);
      if (normalized.signal.isAborted()) abort();
    }
    if (!disposed && normalized.ports.length > 0) attachAll(normalized.ports);
  } catch (cause) {
    try {
      synchronizer.dispose();
    } catch {
      // Preserve the construction failure after best-effort transactional cleanup.
    }
    throw cause;
  }
  return synchronizer;
}

/** Explicit default mapping truth for a renderer; callers may narrow any slice. */
export function defaultSceneStateSyncMappings(renderer: SceneStateSyncRenderer): SceneStateSyncMappings {
  if (renderer !== "maplibre" && renderer !== "cesium" && renderer !== "custom")
    throw new HonuaSceneStateSyncError("invalid-input", "renderer is invalid");
  const exact = (code: string, message: string): SceneStateSyncMapping =>
    Object.freeze({ inbound: "exact", outbound: "exact", code, message });
  const equivalent = (code: string, message: string): SceneStateSyncMapping =>
    Object.freeze({ inbound: "equivalent", outbound: "equivalent", code, message });
  const unsupported = (slice: SceneStateSyncSlice): SceneStateSyncMapping =>
    Object.freeze({
      inbound: "unsupported",
      outbound: "unsupported",
      code: `custom-${slice}-unsupported`,
      message: `Custom renderer support for ${slice} must be declared explicitly.`,
    });
  if (renderer === "custom") {
    return Object.freeze(
      Object.fromEntries(
        SCENE_STATE_SYNC_SLICES.map((slice) => [slice, unsupported(slice)]),
      ) as unknown as SceneStateSyncMappings,
    );
  }
  const mappings: SceneStateSyncMappings = {
    camera: equivalent(
      renderer === "maplibre" ? "maplibre-2d-camera" : "cesium-3d-camera",
      renderer === "maplibre"
        ? "MapLibre center/zoom/pitch is equivalent but cannot preserve Cesium roll or globe horizon."
        : "Cesium globe camera is equivalent to the canonical camera and may include 3D orientation unavailable in 2D.",
    ),
    selection: exact("source-qualified-selection", "Source-qualified feature identity maps exactly."),
    filters: exact("protocol-neutral-filter", "Protocol-neutral filter clauses map exactly."),
    time:
      renderer === "maplibre"
        ? equivalent("maplibre-time", "MapLibre has no native clock; the adapter applies canonical application time.")
        : exact("cesium-clock", "Cesium clock maps to canonical application time."),
    detail: exact("source-qualified-detail", "Detail identity and bounded attributes map exactly."),
    attribution: exact("attribution-ids", "Credential-free attribution identifiers map exactly."),
    realtime: exact("realtime-status", "Freshness, status, cursor presence, and lag map exactly."),
  };
  return Object.freeze(mappings);
}

function normalizeOptions(options: CreateSceneStateSynchronizerOptions) {
  if (!isRecord(options)) throw new HonuaSceneStateSyncError("invalid-input", "options must be an object");
  const applicationId = boundedId(dataProperty(options, "applicationId"), "applicationId");
  const coalesceRaw = optionalDataProperty(options, "coalesceMs");
  const maxPortsRaw = optionalDataProperty(options, "maxPorts");
  const maxDiagnosticsRaw = optionalDataProperty(options, "maxDiagnostics");
  const portsRaw = optionalDataProperty(options, "ports");
  const nowRaw = optionalDataProperty(options, "now");
  const signalRaw = optionalDataProperty(options, "signal");
  const signal = signalRaw === undefined ? undefined : normalizeAbortSignal(signalRaw);
  const coalesceMs = coalesceRaw ?? 16;
  if (typeof coalesceMs !== "number" || !Number.isSafeInteger(coalesceMs) || coalesceMs < 0 || coalesceMs > 1_000)
    throw new HonuaSceneStateSyncError("invalid-input", "coalesceMs must be an integer between 0 and 1000");
  const maxPorts = boundedPositiveInteger(maxPortsRaw ?? DEFAULT_MAX_PORTS, "maxPorts", HARD_MAX_PORTS);
  const maxDiagnostics = boundedPositiveInteger(
    maxDiagnosticsRaw ?? DEFAULT_MAX_DIAGNOSTICS,
    "maxDiagnostics",
    HARD_MAX_DIAGNOSTICS,
  );
  if (nowRaw !== undefined && typeof nowRaw !== "function")
    throw new HonuaSceneStateSyncError("invalid-input", "now must be a function");
  const ports = portsRaw === undefined ? [] : captureDenseArray<SceneStateSyncPort>(portsRaw, HARD_MAX_PORTS, "ports");
  const foreignNow = nowRaw === undefined ? () => new Date().toISOString() : (nowRaw as () => string);
  let lastTimestamp: string;
  try {
    lastTimestamp = canonicalTimestamp(foreignNow.call(undefined), "clock");
  } catch (cause) {
    throw new HonuaSceneStateSyncError("invalid-input", "clock must return a canonical ISO timestamp", { cause });
  }
  const now = (): string => {
    lastTimestamp = canonicalTimestamp(foreignNow.call(undefined), "clock");
    return lastTimestamp;
  };
  return Object.freeze({
    applicationId,
    coalesceMs,
    maxPorts,
    maxDiagnostics,
    ports: Object.freeze(ports),
    now,
    lastTimestamp: () => lastTimestamp,
    signal,
  });
}

function normalizePort(foreign: SceneStateSyncPort): NormalizedPort {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "port must be an object");
  const id = boundedId(dataProperty(foreign, "id"), "port.id");
  const renderer = dataProperty(foreign, "renderer");
  if (renderer !== "maplibre" && renderer !== "cesium" && renderer !== "custom")
    throw new HonuaSceneStateSyncError("invalid-input", "port.renderer is invalid");
  const mappings = normalizeMappings(dataProperty(foreign, "mappings"));
  const subscribe = callback(foreign, "subscribe");
  const apply = callback(foreign, "apply");
  return Object.freeze({
    id,
    renderer,
    mappings,
    subscribe: subscribe as NormalizedPort["subscribe"],
    apply: apply as NormalizedPort["apply"],
  });
}

function normalizeMappings(foreign: unknown): SceneStateSyncMappings {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "port.mappings must be an object");
  const result = Object.create(null) as Record<SceneStateSyncSlice, SceneStateSyncMapping>;
  for (const slice of SCENE_STATE_SYNC_SLICES) {
    const value = dataProperty(foreign, slice);
    if (!isRecord(value)) throw new HonuaSceneStateSyncError("invalid-input", `mapping ${slice} must be an object`);
    const inbound = dataProperty(value, "inbound");
    const outbound = dataProperty(value, "outbound");
    if (!isFidelity(inbound) || !isFidelity(outbound))
      throw new HonuaSceneStateSyncError("invalid-input", `mapping ${slice} fidelity is invalid`);
    result[slice] = Object.freeze({
      inbound,
      outbound,
      code: boundedId(dataProperty(value, "code"), `mapping ${slice}.code`),
      message: boundedText(dataProperty(value, "message"), `mapping ${slice}.message`, 512),
    });
  }
  return Object.freeze(result);
}

function normalizeInput(foreign: SceneStateSyncInput): SceneStateSyncInput {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "state input must be an object");
  if (
    dataProperty(foreign, "kind") !== SCENE_STATE_SYNC_KIND ||
    dataProperty(foreign, "version") !== SCENE_STATE_SYNC_VERSION
  )
    throw new HonuaSceneStateSyncError("invalid-input", "state input discriminator is invalid");
  const slice = dataProperty(foreign, "slice");
  if (!SCENE_STATE_SYNC_SLICES.includes(slice as SceneStateSyncSlice))
    throw new HonuaSceneStateSyncError("invalid-input", "state input slice is invalid");
  const sequence = nonNegativeInteger(dataProperty(foreign, "sequence"), "sequence");
  const causeRaw = optionalDataProperty(foreign, "causeRevision");
  const causeRevision = causeRaw === undefined ? undefined : positiveInteger(causeRaw, "causeRevision");
  const identity = normalizeIdentity(dataProperty(foreign, "identity"));
  const value = normalizeValue(slice as SceneStateSyncSlice, dataProperty(foreign, "value"));
  return Object.freeze({
    kind: SCENE_STATE_SYNC_KIND,
    version: SCENE_STATE_SYNC_VERSION,
    sequence,
    emittedAt: canonicalTimestamp(dataProperty(foreign, "emittedAt"), "emittedAt"),
    slice,
    value,
    identity,
    ...(causeRevision === undefined ? {} : { causeRevision }),
  }) as SceneStateSyncInput;
}

function normalizeIdentity(foreign: unknown): SceneStateSyncIdentity {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "identity must be an object");
  const optional = (key: string): string | undefined => {
    const value = optionalDataProperty(foreign, key);
    return value === undefined ? undefined : boundedId(value, `identity.${key}`);
  };
  const fingerprint = optionalDataProperty(foreign, "planFingerprint");
  const schemaVersion = optional("schemaVersion");
  const sourceVersion = optional("sourceVersion");
  const planId = optional("planId");
  if (fingerprint !== undefined && (typeof fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(fingerprint)))
    throw new HonuaSceneStateSyncError("invalid-input", "identity.planFingerprint is invalid");
  return Object.freeze({
    sourceId: boundedId(dataProperty(foreign, "sourceId"), "identity.sourceId"),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(planId === undefined ? {} : { planId }),
    ...(fingerprint === undefined ? {} : { planFingerprint: fingerprint as `sha256:${string}` }),
  });
}

function normalizeValue(slice: SceneStateSyncSlice, foreign: unknown): SceneStateSyncValueMap[SceneStateSyncSlice] {
  switch (slice) {
    case "camera":
      if (foreign === undefined) return undefined;
      return normalizeCamera(foreign);
    case "selection":
      return normalizeSelection(foreign);
    case "filters":
      return normalizeFilters(foreign);
    case "time":
      return normalizeTime(foreign);
    case "detail":
      return normalizeDetail(foreign);
    case "attribution":
      return normalizeAttribution(foreign);
    case "realtime":
      return normalizeRealtime(foreign);
  }
}

function normalizeCamera(foreign: unknown): SceneCameraState {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "camera must be an object");
  const optionalNumber = (key: string): number | undefined => {
    const value = optionalDataProperty(foreign, key);
    return value === undefined ? undefined : finiteNumber(value, `camera.${key}`);
  };
  const longitude = finiteNumber(dataProperty(foreign, "longitude"), "camera.longitude");
  const latitude = finiteNumber(dataProperty(foreign, "latitude"), "camera.latitude");
  const height = finiteNumber(dataProperty(foreign, "height"), "camera.height");
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90 || height < 0)
    throw new HonuaSceneStateSyncError("invalid-input", "camera coordinates are outside supported bounds");
  const heading = optionalNumber("heading");
  const pitch = optionalNumber("pitch");
  const roll = optionalNumber("roll");
  return Object.freeze({
    longitude,
    latitude,
    height,
    ...(heading === undefined ? {} : { heading }),
    ...(pitch === undefined ? {} : { pitch }),
    ...(roll === undefined ? {} : { roll }),
  });
}

function normalizeSelection(foreign: unknown): readonly FeatureSelectionTarget[] {
  if (!Array.isArray(foreign) || foreign.length > MAX_SELECTION)
    throw new HonuaSceneStateSyncError("invalid-input", `selection must contain at most ${MAX_SELECTION} targets`);
  return Object.freeze(
    foreign.map((target, index) => {
      if (typeof target === "string") return boundedFeatureId(target, `selection[${index}]`);
      if (typeof target === "number") {
        if (!Number.isFinite(target))
          throw new HonuaSceneStateSyncError("invalid-input", `selection[${index}] is invalid`);
        return Object.is(target, -0) ? 0 : target;
      }
      if (!isRecord(target)) throw new HonuaSceneStateSyncError("invalid-input", `selection[${index}] is invalid`);
      const sourceLayer = optionalDataProperty(target, "sourceLayer");
      const id = dataProperty(target, "id");
      if (typeof id !== "string" && (typeof id !== "number" || !Number.isFinite(id)))
        throw new HonuaSceneStateSyncError("invalid-input", `selection[${index}].id is invalid`);
      return Object.freeze({
        sourceId: boundedId(dataProperty(target, "sourceId"), `selection[${index}].sourceId`),
        id: typeof id === "string" ? boundedFeatureId(id, `selection[${index}].id`) : Object.is(id, -0) ? 0 : id,
        ...(sourceLayer === undefined
          ? {}
          : { sourceLayer: boundedId(sourceLayer, `selection[${index}].sourceLayer`) }),
      });
    }),
  );
}

function normalizeFilters(foreign: unknown): Readonly<Record<string, FilterClause>> {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "filters must be an object");
  const result = Object.create(null) as Record<string, FilterClause>;
  let count = 0;
  for (const key in foreign) {
    if (count >= MAX_FILTERS) throw new HonuaSceneStateSyncError("invalid-input", `filters exceed ${MAX_FILTERS}`);
    count += 1;
    const clause = dataProperty(foreign, key);
    if (!isRecord(clause)) throw new HonuaSceneStateSyncError("invalid-input", `filter ${key} is invalid`);
    const appliesTo = optionalDataProperty(clause, "appliesTo");
    if (appliesTo !== undefined && (!Array.isArray(appliesTo) || appliesTo.length > 128))
      throw new HonuaSceneStateSyncError("invalid-input", `filter ${key}.appliesTo is invalid`);
    const value = optionalDataProperty(clause, "value");
    result[boundedId(key, "filter id")] = Object.freeze({
      field: boundedId(dataProperty(clause, "field"), `filter ${key}.field`),
      operator: normalizeFilterOperator(dataProperty(clause, "operator")),
      ...(value === undefined ? {} : { value: snapshotJson(value) }),
      ...(appliesTo === undefined
        ? {}
        : { appliesTo: Object.freeze(appliesTo.map((id) => boundedId(id, "source id"))) }),
    });
  }
  return Object.freeze(result);
}

function normalizeTime(foreign: unknown): SceneTimelineState {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "time must be an object");
  const iso = (key: string): string | undefined => {
    const value = optionalDataProperty(foreign, key);
    return value === undefined ? undefined : canonicalTimestamp(value, `time.${key}`);
  };
  const playing = optionalDataProperty(foreign, "playing");
  const progress = optionalDataProperty(foreign, "progress");
  if (playing !== undefined && typeof playing !== "boolean")
    throw new HonuaSceneStateSyncError("invalid-input", "time.playing is invalid");
  if (
    progress !== undefined &&
    (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 1)
  )
    throw new HonuaSceneStateSyncError("invalid-input", "time.progress is invalid");
  const currentTime = iso("currentTime");
  const startTime = iso("startTime");
  const endTime = iso("endTime");
  return Object.freeze({
    ...(currentTime === undefined ? {} : { currentTime }),
    ...(startTime === undefined ? {} : { startTime }),
    ...(endTime === undefined ? {} : { endTime }),
    ...(playing === undefined ? {} : { playing }),
    ...(progress === undefined ? {} : { progress }),
  });
}

function normalizeDetail(foreign: unknown): SceneDetailState {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "detail must be an object");
  const target = optionalDataProperty(foreign, "target");
  const attributes = optionalDataProperty(foreign, "attributes");
  const selection = target === undefined ? undefined : normalizeSelection([target])[0];
  const optionalId = (key: string): string | undefined => {
    const value = optionalDataProperty(foreign, key);
    return value === undefined ? undefined : boundedId(value, `detail.${key}`);
  };
  const featureId = optionalDataProperty(foreign, "featureId");
  if (
    featureId !== undefined &&
    typeof featureId !== "string" &&
    (typeof featureId !== "number" || !Number.isFinite(featureId))
  )
    throw new HonuaSceneStateSyncError("invalid-input", "detail.featureId is invalid");
  const status = optionalDataProperty(foreign, "status");
  if (status !== undefined && !["empty", "loading", "ready", "stale", "error"].includes(status as string))
    throw new HonuaSceneStateSyncError("invalid-input", "detail.status is invalid");
  const title = optionalDataProperty(foreign, "title");
  const sourceId = optionalId("sourceId");
  return Object.freeze({
    ...(selection === undefined ? {} : { target: selection }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(featureId === undefined
      ? {}
      : {
          featureId:
            typeof featureId === "string"
              ? boundedFeatureId(featureId, "detail.featureId")
              : Object.is(featureId, -0)
                ? 0
                : featureId,
        }),
    ...(title === undefined ? {} : { title: boundedText(title, "detail.title", 512) }),
    ...(status === undefined ? {} : { status: status as SceneDetailState["status"] }),
    ...(attributes === undefined ? {} : { attributes: snapshotJson(attributes) as Readonly<Record<string, unknown>> }),
  });
}

function normalizeAttribution(foreign: unknown): SceneStateSyncAttributionValue {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "attribution must be an object");
  const ids = dataProperty(foreign, "ids");
  if (!Array.isArray(ids) || ids.length > MAX_ATTRIBUTIONS)
    throw new HonuaSceneStateSyncError("invalid-input", `attribution ids exceed ${MAX_ATTRIBUTIONS}`);
  return Object.freeze({ ids: Object.freeze([...new Set(ids.map((id) => boundedId(id, "attribution id")))].sort()) });
}

function normalizeRealtime(foreign: unknown): SceneStateSyncRealtimeValue {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "realtime must be an object");
  const status = dataProperty(foreign, "status");
  const freshness = dataProperty(foreign, "freshness");
  const cursorPresent = dataProperty(foreign, "cursorPresent");
  if (
    !isRealtimeStatus(status) ||
    !["fresh", "stale", "unknown"].includes(freshness as string) ||
    typeof cursorPresent !== "boolean"
  )
    throw new HonuaSceneStateSyncError("invalid-input", "realtime state is invalid");
  const observedAt = optionalDataProperty(foreign, "observedAt");
  const lagMs = optionalDataProperty(foreign, "lagMs");
  if (lagMs !== undefined && (!Number.isSafeInteger(lagMs) || (lagMs as number) < 0))
    throw new HonuaSceneStateSyncError("invalid-input", "realtime.lagMs is invalid");
  return Object.freeze({
    status,
    freshness: freshness as SceneStateSyncRealtimeValue["freshness"],
    cursorPresent,
    ...(observedAt === undefined ? {} : { observedAt: canonicalTimestamp(observedAt, "realtime.observedAt") }),
    ...(lagMs === undefined ? {} : { lagMs: lagMs as number }),
  });
}

function snapshotJson(foreign: unknown): unknown {
  const budget = { nodes: 0 };
  const visit = (value: unknown, depth: number, ancestors: WeakSet<object>): unknown => {
    budget.nodes += 1;
    if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH)
      throw new HonuaSceneStateSyncError("invalid-input", "JSON value is too complex");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new HonuaSceneStateSyncError("invalid-input", "JSON numbers must be finite");
      return Object.is(value, -0) ? 0 : value;
    }
    if (!isRecord(value) && !Array.isArray(value))
      throw new HonuaSceneStateSyncError("invalid-input", "value is not JSON-compatible");
    if (ancestors.has(value as object)) throw new HonuaSceneStateSyncError("invalid-input", "JSON value is cyclic");
    ancestors.add(value as object);
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_PROPERTIES)
        throw new HonuaSceneStateSyncError("invalid-input", "JSON array is too wide");
      const result = value.map((item) => visit(item, depth + 1, ancestors));
      ancestors.delete(value);
      return Object.freeze(result);
    }
    const result = Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (const key in value) {
      if (count >= MAX_JSON_PROPERTIES) throw new HonuaSceneStateSyncError("invalid-input", "JSON object is too wide");
      count += 1;
      result[key] = visit(dataProperty(value, key), depth + 1, ancestors);
    }
    ancestors.delete(value);
    return Object.freeze(result);
  };
  return visit(foreign, 0, new WeakSet<object>());
}

function canonicalSignature(value: unknown, identity: SceneStateSyncIdentity): string {
  return stableStringify({ value, identity });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function snapshotForeignData(foreign: unknown): unknown {
  const budget = { nodes: 0, stringUnits: 0 };
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    budget.nodes += 1;
    if (budget.nodes > MAX_FOREIGN_NODES || depth > MAX_JSON_DEPTH)
      throw new HonuaSceneStateSyncError("invalid-input", "Renderer envelope is too complex");
    if (typeof value === "string") {
      budget.stringUnits += value.length;
      if (value.length > MAX_FOREIGN_STRING || budget.stringUnits > MAX_FOREIGN_STRING_TOTAL)
        throw new HonuaSceneStateSyncError("invalid-input", "Renderer envelope strings exceed the bounded limit");
      return value;
    }
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "object")
      throw new HonuaSceneStateSyncError("invalid-input", "Renderer envelope must contain data only");
    if (ancestors.has(value)) throw new HonuaSceneStateSyncError("invalid-input", "Renderer envelope is cyclic");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const items = captureDenseArray<unknown>(value, MAX_FOREIGN_ARRAY, "renderer envelope array");
        return Object.freeze(items.map((item) => visit(item, depth + 1)));
      }
      let prototype: object | null;
      let keys: (string | symbol)[];
      try {
        prototype = Object.getPrototypeOf(value);
        keys = Reflect.ownKeys(value);
      } catch (cause) {
        throw new HonuaSceneStateSyncError("invalid-input", "Renderer envelope object could not be captured", {
          cause,
        });
      }
      if (prototype !== Object.prototype && prototype !== null)
        throw new HonuaSceneStateSyncError("invalid-input", "Renderer envelope records must be plain objects");
      if (keys.length > MAX_JSON_PROPERTIES || keys.some((key) => typeof key === "symbol"))
        throw new HonuaSceneStateSyncError("invalid-input", "Renderer envelope object keys are invalid");
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of keys as string[]) result[key] = visit(dataProperty(value, key), depth + 1);
      return Object.freeze(result);
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(foreign, 0);
}

function captureDenseArray<T>(foreign: unknown, maximum: number, label: string): T[] {
  if (!Array.isArray(foreign)) throw new HonuaSceneStateSyncError("invalid-input", `${label} must be an array`);
  let keys: (string | symbol)[];
  let length: unknown;
  try {
    keys = Reflect.ownKeys(foreign);
    length = Reflect.getOwnPropertyDescriptor(foreign, "length")?.value;
  } catch (cause) {
    throw new HonuaSceneStateSyncError("invalid-input", `${label} could not be captured`, { cause });
  }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum)
    throw new HonuaSceneStateSyncError("invalid-input", `${label} exceeds its bounded length`);
  if (keys.some((key) => typeof key === "symbol"))
    throw new HonuaSceneStateSyncError("invalid-input", `${label} cannot contain symbol properties`);
  const allowed = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (keys.some((key) => !allowed.has(key as string)) || keys.length !== length + 1)
    throw new HonuaSceneStateSyncError("invalid-input", `${label} must be dense and contain only indexed data`);
  const result: T[] = [];
  for (let index = 0; index < length; index += 1) result.push(dataProperty(foreign, String(index)) as T);
  return result;
}

function dataProperty(input: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  } catch (cause) {
    throw new HonuaSceneStateSyncError("invalid-input", `${key} could not be captured`, { cause });
  }
  if (!descriptor || descriptor.get || descriptor.set)
    throw new HonuaSceneStateSyncError("invalid-input", `${key} must be a data property`);
  return descriptor.value;
}

function optionalDataProperty(input: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  } catch (cause) {
    throw new HonuaSceneStateSyncError("invalid-input", `${key} could not be captured`, { cause });
  }
  if (!descriptor) return undefined;
  if (descriptor.get || descriptor.set)
    throw new HonuaSceneStateSyncError("invalid-input", `${key} must be a data property`);
  return descriptor.value;
}

function callback(input: object, key: string): (...args: never[]) => unknown {
  const value = dataProperty(input, key);
  if (typeof value !== "function") throw new HonuaSceneStateSyncError("invalid-input", `${key} must be a function`);
  return value.bind(input);
}

function normalizeAbortSignal(foreign: unknown): {
  readonly isAborted: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
} {
  if (!isRecord(foreign)) throw new HonuaSceneStateSyncError("invalid-input", "signal must be an AbortSignal");
  let add: unknown;
  let remove: unknown;
  try {
    add = Reflect.get(foreign, "addEventListener");
    remove = Reflect.get(foreign, "removeEventListener");
  } catch (cause) {
    throw new HonuaSceneStateSyncError("invalid-input", "signal methods could not be captured", { cause });
  }
  if (typeof add !== "function" || typeof remove !== "function")
    throw new HonuaSceneStateSyncError("invalid-input", "signal must be an AbortSignal");
  const addEventListener = add.bind(foreign) as AbortSignal["addEventListener"];
  const removeEventListener = remove.bind(foreign) as AbortSignal["removeEventListener"];
  const isAborted = (): boolean => {
    let value: unknown;
    try {
      value = Reflect.get(foreign, "aborted");
    } catch (cause) {
      throw new HonuaSceneStateSyncError("invalid-input", "signal.aborted could not be read", { cause });
    }
    if (typeof value !== "boolean")
      throw new HonuaSceneStateSyncError("invalid-input", "signal.aborted must be boolean");
    return value;
  };
  isAborted();
  return Object.freeze({
    isAborted,
    subscribe(listener: () => void): () => void {
      try {
        addEventListener("abort", listener, { once: true });
      } catch (cause) {
        throw new HonuaSceneStateSyncError("invalid-input", "signal abort listener could not be attached", { cause });
      }
      return once(() => {
        try {
          removeEventListener("abort", listener);
        } catch {
          // Cancellation listener cleanup is best effort for foreign signals.
        }
      });
    },
  });
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !SAFE_ID.test(value))
    throw new HonuaSceneStateSyncError("invalid-input", `${label} must be a bounded credential-free identifier`);
  return value;
}

function boundedFeatureId(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    throw new HonuaSceneStateSyncError("invalid-input", `${label} must be a bounded feature identifier`);
  return value;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    throw new HonuaSceneStateSyncError("invalid-input", `${label} must be bounded text without control characters`);
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new HonuaSceneStateSyncError("invalid-input", `${label} must be a canonical ISO timestamp`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new HonuaSceneStateSyncError("invalid-input", `${label} must be finite`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new HonuaSceneStateSyncError("invalid-input", `${label} must be a positive safe integer`);
  return value as number;
}

function boundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  const normalized = positiveInteger(value, label);
  if (normalized > maximum) throw new HonuaSceneStateSyncError("invalid-input", `${label} must not exceed ${maximum}`);
  return normalized;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new HonuaSceneStateSyncError("invalid-input", `${label} must be a non-negative safe integer`);
  return value as number;
}

function normalizeFilterOperator(value: unknown): FilterClause["operator"] {
  const operators = [
    "=",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "in",
    "not-in",
    "between",
    "like",
    "is-null",
    "is-not-null",
  ] as const;
  if (!operators.includes(value as FilterClause["operator"]))
    throw new HonuaSceneStateSyncError("invalid-input", "filter operator is invalid");
  return value as FilterClause["operator"];
}

function isRealtimeStatus(value: unknown): value is SceneStateSyncRealtimeValue["status"] {
  return ["idle", "connecting", "connected", "reconnecting", "disconnected", "error"].includes(value as string);
}

function isFidelity(value: unknown): value is SceneStateSyncFidelity {
  return value === "exact" || value === "equivalent" || value === "unsupported";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
