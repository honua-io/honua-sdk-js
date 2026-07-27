import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  OdataDeltaPollTelemetry,
  RealtimeCheckpointStore,
  RealtimeDurableCheckpointV1,
  RealtimeFeatureEvent,
  RealtimeFeatureObserver,
  RealtimeFeatureState,
  RealtimeFeatureTransport,
  RealtimeResumableTransportTelemetry,
  RealtimeSequencedEvent,
  RealtimeServerSentEventSource,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
  RealtimeWebSocket,
  RealtimeWebSocketCloseEvent,
  RedactedRealtimeCheckpointV1,
} from "@honua/sdk-js/realtime";

import type {
  RealtimeConformanceFault,
  RealtimeCrossTransportCorpusV1,
  RealtimeCrossTransportScenarioV1,
} from "./realtime-cross-transport-conformance.js";

type RealtimeSdk = typeof import("@honua/sdk-js/realtime");
type TransportName = "sse" | "websocket" | "odata";

interface Incident {
  readonly id: number;
  readonly status: string;
}

interface Position {
  readonly sequence: number;
  readonly cursor: string;
  readonly watermark: string;
  readonly deltaToken: string;
}

interface UpsertChange {
  readonly op: "upsert";
  readonly entity: Incident;
}

interface DeleteChange {
  readonly op: "delete";
  readonly id: number;
}

type Change = UpsertChange | DeleteChange;

export interface RunRealtimeCrossTransportMatrixOptions {
  readonly sdk: RealtimeSdk;
  readonly corpus: RealtimeCrossTransportCorpusV1;
  /** Optional deterministic shard used by focused tests; omitted evidence always executes the complete corpus. */
  readonly scenarioIds?: readonly string[];
  /** Advances fake timers in source tests. Omit for the installed-package lane. */
  readonly advanceTime?: (milliseconds: number) => Promise<void>;
  /** Advances exactly one scheduled timer so a reconnect cannot also consume the next polling cycle. */
  readonly advanceNextTimer?: () => Promise<void>;
  /** Reports fake-timer ownership after each scenario. Omit when the runtime has no timer inspector. */
  readonly activeTimerCount?: () => number;
}

export interface RealtimeScenarioTransportEvidence {
  readonly transport: TransportName;
  readonly result: "passed";
  readonly acceptedEventIds: readonly string[];
  readonly sequences: readonly number[];
  readonly acceptedEventCount: number;
  readonly records: readonly Incident[];
  readonly tombstones: readonly number[];
  readonly diagnostics: {
    readonly duplicateCount: number;
    readonly gapCount: number;
    readonly overflowCount: number;
    readonly resnapshotCount: number;
  };
  readonly checkpoint: {
    readonly authorizationScopeRejected: boolean;
    readonly authorizationScopeCode: string;
    readonly telemetrySamples: number;
    readonly redacted: boolean;
    readonly rawPositionPresent: boolean;
  };
  readonly lifecycle: {
    readonly termination: "complete" | "error";
    readonly completed: number;
    readonly errors: number;
    readonly resourcesActive: number;
    readonly socketsActive: number;
    readonly requestsActive: number;
    readonly callbacksActive: number;
    readonly checkpointsActive: number;
    readonly timersActive: number | null;
    readonly repeatedDisposal: boolean;
    readonly cancellation?: {
      readonly inFlightWorkObserved: true;
      readonly abortObserved: true;
      readonly hostileWorkReleased: true;
      readonly lateCallbacks: 0;
      readonly lateDataEvents: 0;
      readonly stateUnchanged: true;
    };
  };
  readonly freshness: {
    readonly mode: "push" | "poll";
    readonly pollCount: number;
    readonly pollIntervalMs: number | null;
    readonly serverEventTime: string;
    readonly receivedAt: number;
    readonly lagMs: number;
  };
  readonly connectionAttempts: number;
  readonly failureDiagnostics: readonly [];
}

export interface RealtimeScenarioEvidence {
  readonly id: string;
  readonly fault: RealtimeConformanceFault;
  readonly transports: readonly RealtimeScenarioTransportEvidence[];
}

export interface RealtimeCrossTransportMatrixEvidence {
  readonly format: "honua.realtime-cross-transport-evidence.v1";
  readonly schemaVersion: 1;
  readonly corpusVersion: 1;
  readonly coverage: readonly string[];
  readonly persistedReplay: {
    readonly sameScopeCompatible: boolean;
    readonly checkpointLoads: number;
    readonly connectionAttempts: number;
    readonly resumedSequence: number;
    readonly acceptedSequence: number;
    readonly cursorReplayed: boolean;
    readonly watermarkReplayed: boolean;
  };
  readonly scenarioCount: number;
  readonly transportCount: 3;
  readonly executionCount: number;
  readonly scenarios: readonly RealtimeScenarioEvidence[];
}

interface MatrixRecorder {
  readonly observer: RealtimeFeatureObserver<Incident>;
  readonly acceptedEvents: RealtimeSequencedEvent<Incident>[];
  readonly statuses: RealtimeFeatureEvent<Incident>[];
  readonly errors: unknown[];
  readonly waitForAccepted: (count: number) => Promise<void>;
  readonly waitForError: () => Promise<void>;
  readonly waitForCompletion: () => Promise<void>;
  readonly state: () => RealtimeFeatureState<Incident>;
  readonly completed: () => number;
}

interface RunArtifacts {
  readonly recorder: MatrixRecorder;
  readonly checkpoint: RealtimeDurableCheckpointV1;
  readonly telemetry: readonly RealtimeResumableTransportTelemetry[];
  readonly resourcesActive: number;
  readonly pollTelemetry: readonly OdataDeltaPollTelemetry[];
  readonly connectionAttempts: number;
  readonly resnapshotCount: number;
}

type CancellationEvidence = NonNullable<RealtimeScenarioTransportEvidence["lifecycle"]["cancellation"]>;

interface Waiter {
  readonly target: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

class CounterLatch {
  private value = 0;
  private failure: unknown;
  private readonly waiters = new Set<Waiter>();

  public increment(): void {
    this.set(this.value + 1);
  }

  public set(value: number): void {
    if (value <= this.value) return;
    this.value = value;
    for (const waiter of this.waiters) {
      if (this.value < waiter.target) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  public waitFor(target: number): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.value >= target) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiters.add({ target, resolve, reject });
    });
  }

  public fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters) waiter.reject(this.failure);
    this.waiters.clear();
  }
}

class InFlightCancellationProbe {
  private readonly checkpointEntered = new CounterLatch();
  private readonly checkpointFinished = new CounterLatch();
  private readonly requestEntered = new CounterLatch();
  private readonly requestFinished = new CounterLatch();
  private readonly releasePromise: Promise<void>;
  private releaseWork: (() => void) | undefined;
  private checkpointAbort = false;
  private requestAbort = false;
  private released = false;
  public checkpointsActive = 0;
  public requestsActive = 0;

  public constructor() {
    this.releasePromise = new Promise<void>((resolve) => {
      this.releaseWork = resolve;
    });
  }

  public holdCheckpoint(signal: AbortSignal | undefined): Promise<void> {
    return this.hold("checkpoint", signal);
  }

  public holdRequest(signal: AbortSignal | undefined): Promise<void> {
    return this.hold("request", signal);
  }

  public async waitUntilInFlight(includeRequest: boolean): Promise<void> {
    await this.checkpointEntered.waitFor(1);
    if (includeRequest) await this.requestEntered.waitFor(1);
    if (this.checkpointsActive !== 1 || (includeRequest && this.requestsActive !== 1)) {
      throw new Error("Cancellation fixture did not retain the expected in-flight owner.");
    }
  }

  public assertAborted(includeRequest: boolean): void {
    if (!this.checkpointAbort || (includeRequest && !this.requestAbort)) {
      throw new Error("Cancellation fixture did not observe abort on every in-flight owner.");
    }
  }

  public release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseWork?.();
    this.releaseWork = undefined;
  }

  public async waitUntilReleased(includeRequest: boolean): Promise<void> {
    await this.checkpointFinished.waitFor(1);
    if (includeRequest) await this.requestFinished.waitFor(1);
    if (this.checkpointsActive !== 0 || this.requestsActive !== 0) {
      throw new Error("Cancellation fixture retained work after hostile completion.");
    }
  }

  private async hold(kind: "checkpoint" | "request", signal: AbortSignal | undefined): Promise<void> {
    if (!signal) throw new Error(`Cancellation ${kind} owner did not receive an AbortSignal.`);
    const markAborted = () => {
      if (kind === "checkpoint") this.checkpointAbort = true;
      else this.requestAbort = true;
    };
    if (signal.aborted) markAborted();
    else signal.addEventListener("abort", markAborted, { once: true });
    if (kind === "checkpoint") {
      this.checkpointsActive += 1;
      this.checkpointEntered.increment();
    } else {
      this.requestsActive += 1;
      this.requestEntered.increment();
    }
    try {
      // Deliberately ignore abort until the harness releases this hostile work.
      await this.releasePromise;
    } finally {
      signal.removeEventListener("abort", markAborted);
      if (kind === "checkpoint") {
        this.checkpointsActive -= 1;
        this.checkpointFinished.increment();
      } else {
        this.requestsActive -= 1;
        this.requestFinished.increment();
      }
    }
  }
}

interface PredicateWaiter<T> {
  readonly predicate: (value: readonly T[]) => boolean;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

class EventCapture<T> {
  public readonly values: T[] = [];
  private failure: unknown;
  private readonly waiters = new Set<PredicateWaiter<T>>();

  public push(value: T): void {
    this.values.push(value);
    for (const waiter of this.waiters) {
      if (!waiter.predicate(this.values)) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  public waitFor(predicate: (value: readonly T[]) => boolean): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (predicate(this.values)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiters.add({ predicate, resolve, reject });
    });
  }

  public fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters) waiter.reject(this.failure);
    this.waiters.clear();
  }
}

class MatrixEventSource implements RealtimeServerSentEventSource {
  public readyState = 0;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public closeCount = 0;
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(type);
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.({ type: "open" } as Event);
  }

  public emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }

  public disconnect(): void {
    const listener = this.onerror;
    this.readyState = 2;
    listener?.({ type: "error" } as Event);
  }

  public close(): void {
    this.closeCount += 1;
    this.readyState = 2;
  }

  public get resourcesActive(): number {
    return this.socketsActive + this.callbacksActive;
  }

  public get socketsActive(): number {
    return Number(this.readyState !== 2);
  }

  public get callbacksActive(): number {
    return (
      this.listeners.size +
      Number(this.onopen !== null) +
      Number(this.onmessage !== null) +
      Number(this.onerror !== null)
    );
  }
}

class MatrixWebSocket implements RealtimeWebSocket {
  public readyState = 0;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: RealtimeWebSocketCloseEvent) => void) | null = null;
  public closeCount = 0;
  public readonly sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.({ type: "open" } as Event);
  }

  public emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }

  public disconnect(): void {
    const listener = this.onclose;
    this.readyState = 3;
    listener?.({ code: 1006, reason: "fixture transport gap", wasClean: false });
  }

  public close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }

  public get resourcesActive(): number {
    return this.socketsActive + this.callbacksActive;
  }

  public get socketsActive(): number {
    return Number(this.readyState !== 3);
  }

  public get callbacksActive(): number {
    return (
      Number(this.onopen !== null) +
      Number(this.onmessage !== null) +
      Number(this.onerror !== null) +
      Number(this.onclose !== null)
    );
  }
}

class AttemptPool<
  T extends {
    readonly resourcesActive: number;
    readonly socketsActive: number;
    readonly callbacksActive: number;
    readonly closeCount: number;
  },
> {
  public readonly attempts: Array<{ readonly url: string; readonly resource: T }> = [];
  private readonly progress = new CounterLatch();

  public add(url: string, resource: T): void {
    this.attempts.push({ url, resource });
    this.progress.set(this.attempts.length);
  }

  public async waitFor(count: number): Promise<T> {
    await this.progress.waitFor(count);
    const resource = this.attempts[count - 1]?.resource;
    if (!resource) throw new Error(`Realtime fixture did not create attempt ${String(count)}.`);
    return resource;
  }

  public get resourcesActive(): number {
    return this.attempts.reduce((count, attempt) => count + attempt.resource.resourcesActive, 0);
  }

  public get socketsActive(): number {
    return this.attempts.reduce((count, attempt) => count + attempt.resource.socketsActive, 0);
  }

  public get callbacksActive(): number {
    return this.attempts.reduce((count, attempt) => count + attempt.resource.callbacksActive, 0);
  }

  public get repeatedDisposalSafe(): boolean {
    return this.attempts.every((attempt) => attempt.resource.closeCount <= 1 && attempt.resource.resourcesActive === 0);
  }
}

export async function runRealtimeCrossTransportMatrix(
  options: RunRealtimeCrossTransportMatrixOptions,
): Promise<RealtimeCrossTransportMatrixEvidence> {
  assertMatrixCorpus(options.corpus);
  const persistedReplay = await runPersistedReplayProbe(options.sdk, options.corpus);
  const scenarios: RealtimeScenarioEvidence[] = [];
  const selected = options.scenarioIds
    ? options.corpus.scenarios.filter((scenario) => options.scenarioIds?.includes(scenario.id))
    : options.corpus.scenarios;
  if (selected.length === 0) throw new Error("Realtime conformance matrix selected no scenarios.");
  for (const scenario of selected) {
    const sse = await runStreamingScenario("sse", options, scenario);
    const websocket = await runStreamingScenario("websocket", options, scenario);
    const odata = await runOdataScenario(options, scenario);
    const transports = [sse, websocket, odata];
    assertScenarioParity(options.corpus, scenario, transports);
    scenarios.push({ id: scenario.id, fault: scenario.fault, transports });
  }
  return {
    format: "honua.realtime-cross-transport-evidence.v1",
    schemaVersion: 1,
    corpusVersion: 1,
    coverage: [...options.corpus.coverage],
    persistedReplay,
    scenarioCount: scenarios.length,
    transportCount: 3,
    executionCount: scenarios.length * 3,
    scenarios,
  };
}

async function runPersistedReplayProbe(
  sdk: RealtimeSdk,
  corpus: RealtimeCrossTransportCorpusV1,
): Promise<RealtimeCrossTransportMatrixEvidence["persistedReplay"]> {
  const attempts: Array<{
    readonly request: RealtimeSubscriptionRequest;
    readonly observer: RealtimeFeatureObserver<Incident>;
  }> = [];
  const attemptCount = new CounterLatch();
  const saveCount = new CounterLatch();
  let checkpointLoads = 0;
  let persisted: RealtimeDurableCheckpointV1 | undefined;
  const checkpointStore: RealtimeCheckpointStore = {
    load() {
      checkpointLoads += 1;
      return Promise.resolve(persisted);
    },
    save(checkpoint) {
      persisted = checkpoint;
      saveCount.increment();
      return Promise.resolve();
    },
  };
  const raw: RealtimeFeatureTransport<Incident> = {
    subscribe(request, observer) {
      attempts.push({ request, observer });
      attemptCount.set(attempts.length);
      return { close() {} };
    },
  };
  const wrapped = sdk.createResumableRealtimeTransport(raw, {
    context: corpus.context,
    checkpointStore,
    reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0, resetAfterMs: 0 },
    now: () => corpus.clock,
  });
  const firstAccepted = new CounterLatch();
  const firstHandle = wrapped.subscribe(corpus.request, {
    next(event) {
      if (isDataEvent(event)) firstAccepted.increment();
    },
    error(error) {
      firstAccepted.fail(error);
    },
    complete() {},
  });
  await attemptCount.waitFor(1);
  const replayCursor = "persisted-cursor-v1";
  attempts[0]?.observer.next({ ...corpusEvents(corpus).snapshot, cursor: replayCursor });
  await firstAccepted.waitFor(1);
  await saveCount.waitFor(1);
  const persistedBaseline = persisted;
  if (!persistedBaseline) throw new Error("Persisted replay probe did not save its baseline checkpoint.");
  firstHandle.close();

  const replayAccepted = new CounterLatch();
  const replayHandle = wrapped.subscribe(corpus.request, {
    next(event) {
      if (isDataEvent(event)) replayAccepted.increment();
    },
    error(error) {
      replayAccepted.fail(error);
    },
    complete() {},
  });
  await attemptCount.waitFor(2);
  const replayRequest = attempts[1]?.request;
  const resume = replayRequest?.resumeFrom;
  const compatibility = sdk.evaluateRealtimeCheckpoint(corpus.context, persistedBaseline);
  if (
    !compatibility.compatible ||
    resume?.sequence !== corpus.positions.snapshot.sequence ||
    resume.cursor !== replayCursor ||
    resume.watermark !== corpus.positions.snapshot.watermark ||
    resume.deltaToken !== corpus.positions.snapshot.deltaToken
  ) {
    throw new Error("Same-scope persisted replay did not reach the reconnect request unchanged.");
  }
  attempts[1]?.observer.next({ ...corpusEvents(corpus).delta, cursor: "persisted-cursor-v2" });
  await replayAccepted.waitFor(1);
  await saveCount.waitFor(2);
  replayHandle.close();
  if (
    persisted?.resume.sequence !== corpus.positions.delta.sequence ||
    persisted.resume.cursor !== "persisted-cursor-v2" ||
    persisted.resume.watermark !== corpus.positions.delta.watermark ||
    persisted.resume.deltaToken !== corpus.positions.delta.deltaToken
  ) {
    throw new Error("Same-scope persisted replay did not accept and persist the next sequence.");
  }
  return {
    sameScopeCompatible: compatibility.compatible,
    checkpointLoads,
    connectionAttempts: attempts.length,
    resumedSequence: resume.sequence,
    acceptedSequence: persisted.resume.sequence,
    cursorReplayed: resume.cursor === replayCursor,
    watermarkReplayed: resume.watermark === corpus.positions.snapshot.watermark,
  };
}

async function runStreamingScenario(
  transportName: "sse" | "websocket",
  options: RunRealtimeCrossTransportMatrixOptions,
  scenario: RealtimeCrossTransportScenarioV1,
): Promise<RealtimeScenarioTransportEvidence> {
  const { sdk, corpus } = options;
  const controller = new AbortController();
  const recorder = createRecorder(sdk, corpus);
  const telemetry = new EventCapture<RealtimeResumableTransportTelemetry>();
  const cancellation = scenario.fault === "cancel" ? new InFlightCancellationProbe() : undefined;
  const checkpoints = createCheckpointCapture(cancellation);
  const sseAttempts = new AttemptPool<MatrixEventSource>();
  const websocketAttempts = new AttemptPool<MatrixWebSocket>();
  const resumable = resumableOptions(corpus, scenario, checkpoints.store, (event) => telemetry.push(event));
  const transport =
    transportName === "sse"
      ? sdk.createResumableServerSentEventsTransport<Incident>(
          {
            url: "https://honua.example/realtime/incidents",
            eventSourceFactory(url) {
              const source = new MatrixEventSource();
              sseAttempts.add(url, source);
              return source;
            },
          },
          resumable,
        )
      : sdk.createResumableWebSocketTransport<Incident>(
          {
            url: "https://honua.example/realtime/incidents",
            webSocketFactory(url) {
              const socket = new MatrixWebSocket();
              websocketAttempts.add(url, socket);
              return socket;
            },
          },
          resumable,
        );
  const handle = transport.subscribe({ ...corpus.request, signal: controller.signal }, recorder.observer);
  const attempts = transportName === "sse" ? sseAttempts : websocketAttempts;
  let cancellationEvidence: CancellationEvidence | undefined;
  try {
    const first = await attempts.waitFor(1);
    first.open();
    cancellationEvidence = await driveStreamingScenario(
      first,
      attempts,
      handle,
      controller,
      recorder,
      telemetry,
      options,
      scenario,
      cancellation,
    );
  } finally {
    cancellation?.release();
    controller.abort("matrix scenario complete");
    handle.close();
    handle.close();
    await settle(options, 0);
  }
  const expectedTermination = scenario.termination;
  if (expectedTermination === "complete") await recorder.waitForCompletion();
  else await recorder.waitForError();
  const checkpoint = requireCheckpoint(transportName, checkpoints.checkpoints.at(-1));
  const resnapshotCount = attempts.attempts
    .slice(1)
    .filter((attempt) => !requestUrlHasResumePosition(attempt.url)).length;
  return buildEvidence({
    sdk,
    corpus,
    scenario,
    transport: transportName,
    recorder,
    checkpoint,
    checkpoints: checkpoints.checkpoints,
    telemetry: telemetry.values,
    resourcesActive: attempts.resourcesActive + checkpoints.active(),
    socketsActive: attempts.socketsActive,
    requestsActive: 0,
    callbacksActive: attempts.callbacksActive,
    checkpointsActive: checkpoints.active(),
    pollTelemetry: [],
    connectionAttempts: attempts.attempts.length,
    resnapshotCount,
    timersActive: options.activeTimerCount?.() ?? null,
    repeatedDisposal: attempts.repeatedDisposalSafe,
    cancellation: cancellationEvidence,
  });
}

async function driveStreamingScenario<T extends MatrixEventSource | MatrixWebSocket>(
  first: T,
  attempts: AttemptPool<T>,
  handle: RealtimeSubscriptionHandle,
  controller: AbortController,
  recorder: MatrixRecorder,
  telemetry: EventCapture<RealtimeResumableTransportTelemetry>,
  options: RunRealtimeCrossTransportMatrixOptions,
  scenario: RealtimeCrossTransportScenarioV1,
  cancellation: InFlightCancellationProbe | undefined,
): Promise<CancellationEvidence | undefined> {
  const events = corpusEvents(options.corpus);
  first.emit(events.snapshot);
  if (scenario.fault === "cancel") {
    if (!cancellation) throw new Error("Cancellation scenario is missing its in-flight probe.");
    await recorder.waitForAccepted(1);
    await cancellation.waitUntilInFlight(false);
    first.emit(events.delta);
    const beforeAbortAccepted = recorder.acceptedEvents.length;
    controller.abort("matrix cancellation");
    handle.close();
    handle.close();
    await recorder.waitForCompletion();
    cancellation.assertAborted(false);
    const beforeRelease = cancellationRecorderSnapshot(recorder);
    cancellation.release();
    await cancellation.waitUntilReleased(false);
    await settle(options, 0);
    assertNoLateCancellationEffects(beforeRelease, recorder);
    if (beforeAbortAccepted !== 1) throw new Error("Cancellation fixture accepted its queued delta before abort.");
    return completedCancellationEvidence();
  }
  await waitForCommitted(recorder, telemetry, 1);
  if (scenario.fault === "buffer-overflow") {
    first.emit(events.delta);
    first.emit(events.gap);
    await waitForTelemetry(telemetry, (event) => event.overflowCount >= 1);
    const recovery = await waitForReconnect(attempts, 2, options);
    recovery.open();
    recovery.emit(events.recoverySnapshot);
    await recorder.waitForAccepted(3);
    await waitForTelemetry(telemetry, (event) => event.acceptedEventCount >= 2);
    recovery.emit(events.recoveryDelta);
    await recorder.waitForAccepted(4);
    await waitForTelemetry(telemetry, (event) => event.acceptedEventCount >= 3);
    return undefined;
  }
  if (scenario.fault === "sequence-gap") {
    first.emit(events.gap);
    await waitForTelemetry(telemetry, (event) => event.gapCount >= 1);
    const recovery = await waitForReconnect(attempts, 2, options);
    recovery.open();
    recovery.emit(events.recoverySnapshot);
    await waitForCommitted(recorder, telemetry, 2);
    recovery.emit(events.recoveryDelta);
    await waitForCommitted(recorder, telemetry, 3);
    return undefined;
  }
  first.emit(events.delta);
  await waitForCommitted(recorder, telemetry, 2);
  switch (scenario.fault) {
    case "none":
      return undefined;
    case "duplicate-delta":
      first.emit(events.delta);
      await waitForTelemetry(telemetry, (event) => event.duplicateEventCount >= 1);
      return undefined;
    case "late-snapshot":
      first.emit(events.snapshot);
      await waitForTelemetry(telemetry, (event) => event.duplicateEventCount >= 1);
      return undefined;
    case "transport-gap": {
      first.disconnect();
      await waitForTelemetry(telemetry, (event) => event.gapCount >= 1);
      const recovery = await waitForReconnect(attempts, 2, options);
      recovery.open();
      recovery.emit(events.recoverySnapshot);
      await waitForCommitted(recorder, telemetry, 3);
      recovery.emit(events.recoveryDelta);
      await waitForCommitted(recorder, telemetry, 4);
      return undefined;
    }
    case "cursor-expired":
    case "resume-unsupported": {
      first.emit({
        type: "error",
        terminal: false,
        code: scenario.fault,
        error: { message: `${scenario.fault} fixture control` },
      });
      const recovery = await waitForReconnect(attempts, 2, options);
      recovery.open();
      recovery.emit(events.recoverySnapshot);
      await waitForCommitted(recorder, telemetry, 3);
      recovery.emit(events.recoveryDelta);
      await waitForCommitted(recorder, telemetry, 4);
      return undefined;
    }
    case "terminal-error":
      first.emit({
        type: "error",
        terminal: true,
        code: "invalid-event",
        error: { message: "terminal fixture control" },
      });
      await recorder.waitForError();
      return undefined;
  }
}

async function runOdataScenario(
  options: RunRealtimeCrossTransportMatrixOptions,
  scenario: RealtimeCrossTransportScenarioV1,
): Promise<RealtimeScenarioTransportEvidence> {
  const { sdk, corpus } = options;
  const controller = new AbortController();
  const recorder = createRecorder(sdk, corpus);
  const telemetry = new EventCapture<RealtimeResumableTransportTelemetry>();
  const cancellation = scenario.fault === "cancel" ? new InFlightCancellationProbe() : undefined;
  const checkpoints = createCheckpointCapture(cancellation);
  const pollTelemetry: OdataDeltaPollTelemetry[] = [];
  const calls: Array<{ readonly url: string; readonly signal?: AbortSignal }> = [];
  let activeRequests = 0;
  const responses = odataResponses(corpus, scenario);
  const raw = sdk.createOdataDeltaTransport<Incident>({
    url: "https://honua.example/odata/Incidents",
    pollIntervalMs: corpus.pollIntervalMs,
    entityId(entity) {
      if (typeof entity.Id !== "number") throw new Error("Fixture OData entity is missing Id.");
      return entity.Id;
    },
    toFeature(entity) {
      if (typeof entity.Id !== "number" || typeof entity.Status !== "string") {
        throw new Error("Fixture OData entity is missing Id or Status.");
      }
      return { id: entity.Id, status: entity.Status };
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal ?? undefined });
      const response = responses.shift();
      if (!response) throw new Error(`Unexpected OData request: ${String(input)}`);
      activeRequests += 1;
      try {
        if (cancellation && calls.length === 2) await cancellation.holdRequest(init?.signal ?? undefined);
        return fixtureResponse(response.status ?? 200, response.body);
      } finally {
        activeRequests -= 1;
      }
    }) as typeof fetch,
    onPoll(event) {
      pollTelemetry.push(event);
    },
    now: () => corpus.clock,
  });
  const injected = createOdataFaultTransport(raw, corpus, scenario);
  const transport = sdk.createResumableRealtimeTransport(
    injected.transport,
    resumableOptions(corpus, scenario, checkpoints.store, (event) => telemetry.push(event)),
  );
  const handle = transport.subscribe({ ...corpus.request, signal: controller.signal }, recorder.observer);
  let cancellationEvidence: CancellationEvidence | undefined;
  try {
    if (scenario.fault === "cancel") {
      if (!cancellation) throw new Error("Cancellation scenario is missing its in-flight probe.");
      await recorder.waitForAccepted(1);
      await cancellation.waitUntilInFlight(false);
      await advancePoll(options, corpus.pollIntervalMs);
      await cancellation.waitUntilInFlight(true);
      controller.abort("matrix cancellation");
      handle.close();
      handle.close();
      await recorder.waitForCompletion();
      cancellation.assertAborted(true);
      if (injected.callbacksActive !== 0) {
        throw new Error("OData cancellation retained its observer callback owner.");
      }
      const beforeRelease = cancellationRecorderSnapshot(recorder);
      cancellation.release();
      await cancellation.waitUntilReleased(true);
      await settle(options, 0);
      assertNoLateCancellationEffects(beforeRelease, recorder);
      cancellationEvidence = completedCancellationEvidence();
    } else if (scenario.fault === "buffer-overflow") {
      await waitForCommitted(recorder, telemetry, 1);
      await advancePoll(options, corpus.pollIntervalMs);
      await waitForTelemetry(telemetry, (event) => event.overflowCount >= 1);
      await waitForOdataAttempt(injected, 2, options);
      await recorder.waitForAccepted(3);
      await waitForTelemetry(telemetry, (event) => event.acceptedEventCount >= 2);
      await advancePoll(options, corpus.pollIntervalMs);
      await recorder.waitForAccepted(4);
      await waitForTelemetry(telemetry, (event) => event.acceptedEventCount >= 3);
    } else if (scenario.fault === "sequence-gap") {
      await waitForCommitted(recorder, telemetry, 1);
      await advancePoll(options, corpus.pollIntervalMs);
      await waitForTelemetry(telemetry, (event) => event.gapCount >= 1);
      await waitForOdataAttempt(injected, 2, options);
      await waitForCommitted(recorder, telemetry, 2);
      await advancePoll(options, corpus.pollIntervalMs);
      await waitForCommitted(recorder, telemetry, 3);
    } else {
      await waitForCommitted(recorder, telemetry, 1);
      await advancePoll(options, corpus.pollIntervalMs);
      await waitForCommitted(recorder, telemetry, 2);
      await driveOdataAfterBase(options, scenario, recorder, telemetry, injected);
    }
  } finally {
    cancellation?.release();
    controller.abort("matrix scenario complete");
    handle.close();
    handle.close();
    await settle(options, 0);
  }
  if (scenario.termination === "complete") await recorder.waitForCompletion();
  else await recorder.waitForError();
  const checkpoint = requireCheckpoint("odata", checkpoints.checkpoints.at(-1));
  const expiredResnapshots = recorder.statuses.filter(
    (event) => event.type === "status" && event.status === "reconnecting" && event.reason === "cursor-expired",
  ).length;
  const resnapshotCount = Math.max(injected.attempts - 1, expiredResnapshots);
  const requestsActive = activeRequests;
  const callbacksActive = injected.callbacksActive;
  const checkpointsActive = checkpoints.active();
  const resourcesActive = requestsActive + callbacksActive + checkpointsActive;
  return buildEvidence({
    sdk,
    corpus,
    scenario,
    transport: "odata",
    recorder,
    checkpoint,
    checkpoints: checkpoints.checkpoints,
    telemetry: telemetry.values,
    resourcesActive,
    socketsActive: 0,
    requestsActive,
    callbacksActive,
    checkpointsActive,
    pollTelemetry,
    connectionAttempts: injected.attempts,
    resnapshotCount,
    timersActive: options.activeTimerCount?.() ?? null,
    repeatedDisposal: injected.repeatedDisposalSafe,
    cancellation: cancellationEvidence,
  });
}

async function driveOdataAfterBase(
  options: RunRealtimeCrossTransportMatrixOptions,
  scenario: RealtimeCrossTransportScenarioV1,
  recorder: MatrixRecorder,
  telemetry: EventCapture<RealtimeResumableTransportTelemetry>,
  injected: ReturnType<typeof createOdataFaultTransport>,
): Promise<void> {
  switch (scenario.fault) {
    case "none":
      return;
    case "duplicate-delta":
    case "late-snapshot":
      await waitForTelemetry(telemetry, (event) => event.duplicateEventCount >= 1);
      return;
    case "sequence-gap":
      return;
    case "transport-gap":
      await advancePoll(options, options.corpus.pollIntervalMs);
      await waitForOdataAttempt(injected, 2, options);
      await waitForCommitted(recorder, telemetry, 3);
      await advancePoll(options, options.corpus.pollIntervalMs);
      await waitForCommitted(recorder, telemetry, 4);
      return;
    case "cursor-expired":
      await advancePoll(options, options.corpus.pollIntervalMs);
      await waitForCommitted(recorder, telemetry, 3);
      await advancePoll(options, options.corpus.pollIntervalMs);
      await waitForCommitted(recorder, telemetry, 4);
      return;
    case "resume-unsupported":
      injected.fail(new options.sdk.HonuaRealtimeResumeError("resume-unsupported", "fixture resume unsupported"));
      await waitForOdataAttempt(injected, 2, options);
      await waitForCommitted(recorder, telemetry, 3);
      await advancePoll(options, options.corpus.pollIntervalMs);
      await waitForCommitted(recorder, telemetry, 4);
      return;
    case "cancel":
      throw new Error("Cancellation must be driven while OData request and checkpoint work are in flight.");
    case "terminal-error":
      await advancePoll(options, options.corpus.pollIntervalMs);
      await recorder.waitForError();
      return;
    case "buffer-overflow":
      return;
  }
}

function createOdataFaultTransport(
  raw: RealtimeFeatureTransport<Incident>,
  corpus: RealtimeCrossTransportCorpusV1,
  scenario: RealtimeCrossTransportScenarioV1,
): {
  readonly transport: RealtimeFeatureTransport<Incident>;
  readonly attempts: number;
  readonly callbacksActive: number;
  readonly repeatedDisposalSafe: boolean;
  readonly waitForAttempts: (count: number) => Promise<void>;
  readonly fail: (error: unknown) => void;
} {
  const progress = new CounterLatch();
  const events = corpusEvents(corpus);
  let attempts = 0;
  let dataIndex = 0;
  let callbacksActive = 0;
  let currentObserver: RealtimeFeatureObserver<Incident> | undefined;
  let currentFailure: ((error: unknown) => void) | undefined;
  let firstSnapshot: RealtimeSequencedEvent<Incident> | undefined;
  const closeCounts: Array<{ count: number }> = [];
  const transport: RealtimeFeatureTransport<Incident> = {
    capabilities: raw.capabilities,
    subscribe(request, observer) {
      attempts += 1;
      progress.set(attempts);
      let ownerActive = true;
      callbacksActive += 1;
      currentObserver = observer;
      const clearOwner = () => {
        if (!ownerActive) return;
        ownerActive = false;
        callbacksActive -= 1;
        if (currentObserver === observer) {
          currentObserver = undefined;
          currentFailure = undefined;
        }
      };
      currentFailure = (error) => {
        clearOwner();
        observer.error(error);
      };
      let rawHandle: RealtimeSubscriptionHandle;
      try {
        rawHandle = raw.subscribe(request, {
          next(event) {
            if (!isDataEvent(event)) {
              observer.next(event);
              return;
            }
            const mapped = mapOdataEvent(event, dataIndex, scenario, events);
            dataIndex += 1;
            if (mapped.type === "snapshot" && !firstSnapshot) firstSnapshot = mapped;
            observer.next(mapped);
            if (scenario.fault === "buffer-overflow" && dataIndex === 2) {
              observer.next(events.gap);
            } else if (scenario.fault === "duplicate-delta" && dataIndex === 2) {
              observer.next(mapped);
            } else if (scenario.fault === "late-snapshot" && dataIndex === 2 && firstSnapshot) {
              observer.next(firstSnapshot);
            }
          },
          error(error) {
            clearOwner();
            observer.error(error);
          },
          complete() {
            clearOwner();
            observer.complete();
          },
        });
      } catch (error) {
        clearOwner();
        throw error;
      }
      const closeState = { count: 0 };
      closeCounts.push(closeState);
      return {
        close() {
          closeState.count += 1;
          if (closeState.count > 1) return;
          clearOwner();
          rawHandle.close();
        },
      };
    },
  };
  return {
    transport,
    get attempts() {
      return attempts;
    },
    get callbacksActive() {
      return callbacksActive;
    },
    get repeatedDisposalSafe() {
      return closeCounts.length > 0 && closeCounts.every(({ count }) => count <= 1) && callbacksActive === 0;
    },
    waitForAttempts: (count) => progress.waitFor(count),
    fail(error) {
      if (!currentObserver || !currentFailure) throw new Error("OData fault injector has no active observer.");
      currentFailure(error);
    },
  };
}

function mapOdataEvent(
  event: RealtimeSequencedEvent<Incident>,
  dataIndex: number,
  scenario: RealtimeCrossTransportScenarioV1,
  events: ReturnType<typeof corpusEvents>,
): RealtimeSequencedEvent<Incident> {
  if (scenario.fault === "buffer-overflow") {
    if (dataIndex === 0) return copyEventMetadata(event, events.snapshot);
    if (dataIndex === 1) return copyEventMetadata(event, events.delta);
    if (dataIndex === 2) return copyEventMetadata(event, events.recoverySnapshot);
    return copyEventMetadata(event, events.recoveryDelta);
  }
  if (scenario.fault === "sequence-gap") {
    if (dataIndex === 0) return copyEventMetadata(event, events.snapshot);
    if (dataIndex === 1) return copyEventMetadata(event, events.gap);
    if (dataIndex === 2) return copyEventMetadata(event, events.recoverySnapshot);
    return copyEventMetadata(event, events.recoveryDelta);
  }
  if (
    scenario.fault === "transport-gap" ||
    scenario.fault === "cursor-expired" ||
    scenario.fault === "resume-unsupported"
  ) {
    if (dataIndex === 0) return copyEventMetadata(event, events.snapshot);
    if (dataIndex === 1) return copyEventMetadata(event, events.delta);
    if (dataIndex === 2) return copyEventMetadata(event, events.recoverySnapshot);
    return copyEventMetadata(event, events.recoveryDelta);
  }
  return dataIndex === 0 ? copyEventMetadata(event, events.snapshot) : copyEventMetadata(event, events.delta);
}

function copyEventMetadata(
  event: RealtimeSequencedEvent<Incident>,
  metadata: RealtimeSequencedEvent<Incident>,
): RealtimeSequencedEvent<Incident> {
  return {
    ...event,
    eventId: metadata.eventId,
    sequence: metadata.sequence,
    deltaToken: metadata.deltaToken,
    timestamp: metadata.timestamp,
    receivedAt: metadata.receivedAt,
  };
}

function odataResponses(
  corpus: RealtimeCrossTransportCorpusV1,
  scenario: RealtimeCrossTransportScenarioV1,
): Array<{ readonly status?: number; readonly body?: unknown }> {
  const initial = odataSnapshot(corpus.initial, corpus.positions.snapshot);
  const delta = odataDelta(corpus.changes, corpus.positions.delta);
  const recoverySnapshot = odataSnapshot(corpus.recovery.snapshot, corpus.positions.recoverySnapshot);
  const recoveryDelta = odataDelta(corpus.recovery.changes, corpus.positions.recoveryDelta);
  switch (scenario.fault) {
    case "sequence-gap":
      return [initial, delta, recoverySnapshot, recoveryDelta];
    case "buffer-overflow":
      return [initial, delta, recoverySnapshot, recoveryDelta];
    case "transport-gap":
      return [
        initial,
        delta,
        { status: 503, body: { error: { message: "fixture disconnect" } } },
        recoverySnapshot,
        recoveryDelta,
      ];
    case "cursor-expired":
      return [
        initial,
        delta,
        { status: 410, body: { error: { message: "fixture cursor expired" } } },
        recoverySnapshot,
        recoveryDelta,
      ];
    case "resume-unsupported":
      return [initial, delta, recoverySnapshot, recoveryDelta];
    case "terminal-error":
      return [initial, delta, { status: 400, body: { error: { message: "fixture terminal failure" } } }];
    default:
      return [initial, delta];
  }
}

function odataSnapshot(
  entities: readonly Incident[],
  position: Position,
): { readonly body: { readonly value: unknown[]; readonly "@odata.deltaLink": string } } {
  return {
    body: {
      value: entities.map(odataEntity),
      "@odata.deltaLink": position.deltaToken,
    },
  };
}

function odataDelta(
  changes: readonly Change[],
  position: Position,
): { readonly body: { readonly value: unknown[]; readonly "@odata.deltaLink": string } } {
  return {
    body: {
      value: changes.map((change) =>
        change.op === "upsert"
          ? odataEntity(change.entity)
          : {
              Id: change.id,
              "@removed": { reason: "deleted" },
            },
      ),
      "@odata.deltaLink": position.deltaToken,
    },
  };
}

function createRecorder(sdk: RealtimeSdk, corpus: RealtimeCrossTransportCorpusV1): MatrixRecorder {
  let state = sdk.emptyRealtimeFeatureState<Incident>();
  let completed = 0;
  const accepted = new CounterLatch();
  const failures = new CounterLatch();
  const completions = new CounterLatch();
  const acceptedEvents: RealtimeSequencedEvent<Incident>[] = [];
  const statuses: RealtimeFeatureEvent<Incident>[] = [];
  const errors: unknown[] = [];
  const observer: RealtimeFeatureObserver<Incident> = {
    next(event) {
      if (!isDataEvent(event)) {
        statuses.push(event);
        return;
      }
      try {
        acceptedEvents.push(event);
        state = sdk.reduceRealtimeFeatureState(state, event, { now: () => corpus.clock });
        accepted.set(acceptedEvents.length);
      } catch (error) {
        errors.push(error);
        accepted.fail(error);
        failures.increment();
      }
    },
    error(error) {
      errors.push(error);
      accepted.fail(error);
      failures.increment();
    },
    complete() {
      completed += 1;
      completions.set(completed);
    },
  };
  return {
    observer,
    acceptedEvents,
    statuses,
    errors,
    waitForAccepted: (count) => accepted.waitFor(count),
    waitForError: () => failures.waitFor(1),
    waitForCompletion: () => completions.waitFor(1),
    state: () => state,
    completed: () => completed,
  };
}

function cancellationRecorderSnapshot(recorder: MatrixRecorder): unknown {
  return {
    acceptedEventIds: recorder.acceptedEvents.map((event) => event.eventId),
    statuses: [...recorder.statuses],
    errors: [...recorder.errors],
    completed: recorder.completed(),
    state: recorder.state(),
  };
}

function assertNoLateCancellationEffects(beforeRelease: unknown, recorder: MatrixRecorder): void {
  if (!isDeepStrictEqual(beforeRelease, cancellationRecorderSnapshot(recorder))) {
    throw new Error("Hostile in-flight completion delivered a late callback or mutated accepted state.");
  }
}

function completedCancellationEvidence(): CancellationEvidence {
  return {
    inFlightWorkObserved: true,
    abortObserved: true,
    hostileWorkReleased: true,
    lateCallbacks: 0,
    lateDataEvents: 0,
    stateUnchanged: true,
  };
}

function createCheckpointCapture(cancellation?: InFlightCancellationProbe): {
  readonly store: RealtimeCheckpointStore;
  readonly checkpoints: RealtimeDurableCheckpointV1[];
  readonly active: () => number;
} {
  const checkpoints: RealtimeDurableCheckpointV1[] = [];
  return {
    checkpoints,
    active: () => cancellation?.checkpointsActive ?? 0,
    store: {
      load: () => Promise.resolve(undefined),
      save(checkpoint, signal) {
        checkpoints.push(checkpoint);
        if (cancellation && checkpoints.length === 1) return cancellation.holdCheckpoint(signal);
        return Promise.resolve();
      },
    },
  };
}

function resumableOptions(
  corpus: RealtimeCrossTransportCorpusV1,
  scenario: RealtimeCrossTransportScenarioV1,
  checkpointStore: RealtimeCheckpointStore,
  onTelemetry: (event: RealtimeResumableTransportTelemetry) => void,
) {
  return {
    context: corpus.context,
    checkpointStore,
    maxPendingEvents: scenario.fault === "buffer-overflow" ? 1 : 16,
    reconnect: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, resetAfterMs: 0 },
    onTelemetry,
    now: () => corpus.clock,
  };
}

function buildEvidence(options: {
  readonly sdk: RealtimeSdk;
  readonly corpus: RealtimeCrossTransportCorpusV1;
  readonly scenario: RealtimeCrossTransportScenarioV1;
  readonly transport: TransportName;
  readonly recorder: MatrixRecorder;
  readonly checkpoint: RealtimeDurableCheckpointV1;
  readonly checkpoints: readonly RealtimeDurableCheckpointV1[];
  readonly telemetry: readonly RealtimeResumableTransportTelemetry[];
  readonly resourcesActive: number;
  readonly socketsActive: number;
  readonly requestsActive: number;
  readonly callbacksActive: number;
  readonly checkpointsActive: number;
  readonly pollTelemetry: readonly OdataDeltaPollTelemetry[];
  readonly connectionAttempts: number;
  readonly resnapshotCount: number;
  readonly timersActive: number | null;
  readonly repeatedDisposal: boolean;
  readonly cancellation?: CancellationEvidence;
}): RealtimeScenarioTransportEvidence {
  const latest = options.telemetry.at(-1);
  if (!latest) throw new Error(`${options.transport}/${options.scenario.id} produced no wrapper telemetry.`);
  const checkpointSamples = options.telemetry.flatMap((event) =>
    event.checkpoint === undefined ? [] : [event.checkpoint],
  );
  const rawPositionPresent = checkpointTelemetryContainsRawPosition(options.checkpoints, checkpointSamples);
  const scope = options.sdk.evaluateRealtimeCheckpoint(
    {
      ...options.corpus.context,
      authorizationScopeFingerprint: options.corpus.resumeScopeProbe.authorizationScopeFingerprint,
    },
    options.checkpoint,
  );
  const observedEvents = options.recorder.acceptedEvents;
  const latestAccepted = observedEvents.at(-1);
  if (!latestAccepted?.timestamp || latestAccepted.receivedAt === undefined) {
    throw new Error(`${options.transport}/${options.scenario.id} lost event timing evidence.`);
  }
  const lagMs = latestAccepted.receivedAt - Date.parse(latestAccepted.timestamp);
  return {
    transport: options.transport,
    result: "passed",
    acceptedEventIds: observedEvents.map((event) => event.eventId ?? `${event.type}:${String(event.sequence ?? -1)}`),
    sequences: observedEvents.map((event) => event.sequence ?? -1),
    acceptedEventCount: observedEvents.length,
    records: normalizedRecords(options.recorder.state()),
    tombstones: normalizedTombstones(options.recorder.state()),
    diagnostics: {
      duplicateCount: latest.duplicateEventCount,
      gapCount: latest.gapCount,
      overflowCount: latest.overflowCount,
      resnapshotCount: options.resnapshotCount,
    },
    checkpoint: {
      authorizationScopeRejected: !scope.compatible,
      authorizationScopeCode: scope.code,
      telemetrySamples: checkpointSamples.length,
      redacted:
        checkpointSamples.length > 0 &&
        checkpointSamples.every((checkpoint) => checkpointPositionIsRedacted(options.checkpoints, checkpoint)),
      rawPositionPresent,
    },
    lifecycle: {
      termination: options.scenario.termination,
      completed: options.recorder.completed(),
      errors: options.recorder.errors.length,
      resourcesActive: options.resourcesActive,
      socketsActive: options.socketsActive,
      requestsActive: options.requestsActive,
      callbacksActive: options.callbacksActive,
      checkpointsActive: options.checkpointsActive,
      timersActive: options.timersActive,
      repeatedDisposal: options.repeatedDisposal,
      ...(options.cancellation ? { cancellation: options.cancellation } : {}),
    },
    freshness: {
      mode: options.transport === "odata" ? "poll" : "push",
      pollCount: options.pollTelemetry.length,
      pollIntervalMs: options.transport === "odata" ? options.corpus.pollIntervalMs : null,
      serverEventTime: latestAccepted.timestamp,
      receivedAt: latestAccepted.receivedAt,
      lagMs,
    },
    connectionAttempts: options.connectionAttempts,
    failureDiagnostics: [],
  };
}

function assertScenarioParity(
  corpus: RealtimeCrossTransportCorpusV1,
  scenario: RealtimeCrossTransportScenarioV1,
  transports: readonly RealtimeScenarioTransportEvidence[],
): void {
  if (transports.length !== 3) throw new Error(`${scenario.id} did not execute all three transports.`);
  const expectedRecords =
    scenario.finalState === "recovered"
      ? corpus.expected.recoveredRecords
      : scenario.finalState === "initial"
        ? corpus.initial
        : corpus.expected.records;
  const expectedTombstones =
    scenario.finalState === "recovered"
      ? corpus.expected.recoveredTombstones
      : scenario.finalState === "initial"
        ? []
        : corpus.expected.tombstones;
  const baseline = comparableEvidence(transports[0]!);
  for (const transport of transports) {
    assertJson(
      `${scenario.id}/${transport.transport} accepted ids`,
      transport.acceptedEventIds,
      scenario.acceptedEventIds,
    );
    assertJson(`${scenario.id}/${transport.transport} sequences`, transport.sequences, scenario.sequences);
    assertJson(`${scenario.id}/${transport.transport} records`, transport.records, expectedRecords);
    assertJson(`${scenario.id}/${transport.transport} tombstones`, transport.tombstones, expectedTombstones);
    assertJson(`${scenario.id}/${transport.transport} diagnostics`, transport.diagnostics, {
      duplicateCount: scenario.duplicateCount,
      gapCount: scenario.gapCount,
      overflowCount: scenario.overflowCount,
      resnapshotCount: scenario.resnapshotCount,
    });
    if (transport.acceptedEventCount !== scenario.acceptedEventIds.length) {
      throw new Error(`${scenario.id}/${transport.transport} accepted event count drifted.`);
    }
    if (
      !transport.checkpoint.authorizationScopeRejected ||
      transport.checkpoint.authorizationScopeCode !== corpus.resumeScopeProbe.expectedCode ||
      transport.checkpoint.telemetrySamples < 1 ||
      !transport.checkpoint.redacted ||
      transport.checkpoint.rawPositionPresent
    ) {
      throw new Error(
        `${scenario.id}/${transport.transport} checkpoint evidence failed: ${JSON.stringify(transport.checkpoint)}.`,
      );
    }
    const expectedCompleted = scenario.termination === "complete" ? 1 : 0;
    const expectedErrors = scenario.termination === "error" ? 1 : 0;
    if (
      transport.lifecycle.completed !== expectedCompleted ||
      transport.lifecycle.errors !== expectedErrors ||
      transport.lifecycle.resourcesActive !== 0 ||
      transport.lifecycle.socketsActive !== 0 ||
      transport.lifecycle.requestsActive !== 0 ||
      transport.lifecycle.callbacksActive !== 0 ||
      transport.lifecycle.checkpointsActive !== 0 ||
      !transport.lifecycle.repeatedDisposal ||
      (transport.lifecycle.timersActive !== null && transport.lifecycle.timersActive !== 0)
    ) {
      throw new Error(
        `${scenario.id}/${transport.transport} lifecycle evidence failed: ${JSON.stringify(transport.lifecycle)}.`,
      );
    }
    if (
      scenario.fault === "cancel" &&
      (!transport.lifecycle.cancellation ||
        transport.lifecycle.cancellation.inFlightWorkObserved !== true ||
        transport.lifecycle.cancellation.abortObserved !== true ||
        transport.lifecycle.cancellation.hostileWorkReleased !== true ||
        transport.lifecycle.cancellation.lateCallbacks !== 0 ||
        transport.lifecycle.cancellation.lateDataEvents !== 0 ||
        transport.lifecycle.cancellation.stateUnchanged !== true)
    ) {
      throw new Error(
        `${scenario.id}/${transport.transport} in-flight cancellation evidence failed: ${JSON.stringify(
          transport.lifecycle.cancellation,
        )}.`,
      );
    }
    if (scenario.fault !== "cancel" && transport.lifecycle.cancellation !== undefined) {
      throw new Error(`${scenario.id}/${transport.transport} invented cancellation evidence.`);
    }
    if (transport.transport === "odata" && transport.freshness.mode !== "poll") {
      throw new Error(`${scenario.id}/odata overstated pull freshness as push.`);
    }
    if (transport.transport !== "odata" && transport.freshness.mode !== "push") {
      throw new Error(`${scenario.id}/${transport.transport} did not report push freshness.`);
    }
    if (
      transport.freshness.serverEventTime !== corpus.timing.serverEventTime ||
      transport.freshness.receivedAt !== corpus.timing.receivedAt ||
      transport.freshness.lagMs !== corpus.timing.lagMs ||
      transport.freshness.pollIntervalMs !== (transport.transport === "odata" ? corpus.pollIntervalMs : null)
    ) {
      throw new Error(
        `${scenario.id}/${transport.transport} conflated event time, receipt time, lag, or poll cadence.`,
      );
    }
    assertJson(`${scenario.id}/${transport.transport} normalized parity`, comparableEvidence(transport), baseline);
  }
}

function comparableEvidence(evidence: RealtimeScenarioTransportEvidence): unknown {
  return {
    acceptedEventIds: evidence.acceptedEventIds,
    sequences: evidence.sequences,
    acceptedEventCount: evidence.acceptedEventCount,
    records: evidence.records,
    tombstones: evidence.tombstones,
    diagnostics: evidence.diagnostics,
    checkpoint: {
      authorizationScopeRejected: evidence.checkpoint.authorizationScopeRejected,
      authorizationScopeCode: evidence.checkpoint.authorizationScopeCode,
      redacted: evidence.checkpoint.redacted,
      rawPositionPresent: evidence.checkpoint.rawPositionPresent,
    },
    lifecycle: {
      termination: evidence.lifecycle.termination,
      completed: evidence.lifecycle.completed,
      errors: evidence.lifecycle.errors,
      resourcesActive: evidence.lifecycle.resourcesActive,
      socketsActive: evidence.lifecycle.socketsActive,
      requestsActive: evidence.lifecycle.requestsActive,
      callbacksActive: evidence.lifecycle.callbacksActive,
      checkpointsActive: evidence.lifecycle.checkpointsActive,
      timersActive: evidence.lifecycle.timersActive,
      repeatedDisposal: evidence.lifecycle.repeatedDisposal,
      cancellation: evidence.lifecycle.cancellation ?? null,
    },
  };
}

function corpusEvents(corpus: RealtimeCrossTransportCorpusV1): {
  readonly snapshot: RealtimeSequencedEvent<Incident>;
  readonly delta: RealtimeSequencedEvent<Incident>;
  readonly gap: RealtimeSequencedEvent<Incident>;
  readonly recoverySnapshot: RealtimeSequencedEvent<Incident>;
  readonly recoveryDelta: RealtimeSequencedEvent<Incident>;
} {
  return {
    snapshot: snapshotEvent("snapshot-1", corpus.positions.snapshot, corpus.initial, corpus.timing),
    delta: deltaEvent("delta-2", corpus.positions.delta, corpus.changes, corpus.timing),
    gap: deltaEvent(
      "gap-4",
      corpus.positions.gap,
      [{ op: "upsert", entity: { id: 999, status: "must-not-apply" } }],
      corpus.timing,
    ),
    recoverySnapshot: snapshotEvent(
      "snapshot-100",
      corpus.positions.recoverySnapshot,
      corpus.recovery.snapshot,
      corpus.timing,
    ),
    recoveryDelta: deltaEvent("delta-101", corpus.positions.recoveryDelta, corpus.recovery.changes, corpus.timing),
  };
}

function snapshotEvent(
  eventId: string,
  position: Position,
  entities: readonly Incident[],
  timing: RealtimeCrossTransportCorpusV1["timing"],
): RealtimeSequencedEvent<Incident> {
  return {
    type: "snapshot",
    eventId,
    sequence: position.sequence,
    cursor: position.cursor,
    watermark: position.watermark,
    deltaToken: position.deltaToken,
    timestamp: timing.serverEventTime,
    receivedAt: timing.receivedAt,
    replace: true,
    features: entities.map((entity) => ({ id: entity.id, feature: entity })),
  };
}

function deltaEvent(
  eventId: string,
  position: Position,
  changes: readonly Change[],
  timing: RealtimeCrossTransportCorpusV1["timing"],
): RealtimeSequencedEvent<Incident> {
  return {
    type: "delta",
    eventId,
    sequence: position.sequence,
    cursor: position.cursor,
    watermark: position.watermark,
    deltaToken: position.deltaToken,
    timestamp: timing.serverEventTime,
    receivedAt: timing.receivedAt,
    upserts: changes
      .filter((change): change is UpsertChange => change.op === "upsert")
      .map((change) => ({ id: change.entity.id, feature: change.entity })),
    deletes: changes
      .filter((change): change is DeleteChange => change.op === "delete")
      .map((change) => ({ id: change.id })),
  };
}

async function waitForReconnect<
  T extends {
    readonly resourcesActive: number;
    readonly socketsActive: number;
    readonly callbacksActive: number;
    readonly closeCount: number;
  },
>(attempts: AttemptPool<T>, count: number, options: RunRealtimeCrossTransportMatrixOptions): Promise<T> {
  await settle(options, 0);
  return attempts.waitFor(count);
}

async function waitForOdataAttempt(
  injected: ReturnType<typeof createOdataFaultTransport>,
  count: number,
  options: RunRealtimeCrossTransportMatrixOptions,
): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  if (options.advanceNextTimer) await options.advanceNextTimer();
  else if (options.advanceTime) await options.advanceTime(1);
  await injected.waitForAttempts(count);
}

async function waitForTelemetry(
  telemetry: EventCapture<RealtimeResumableTransportTelemetry>,
  predicate: (event: RealtimeResumableTransportTelemetry) => boolean,
): Promise<void> {
  await telemetry.waitFor((events) => events.some(predicate));
}

async function waitForCommitted(
  recorder: MatrixRecorder,
  telemetry: EventCapture<RealtimeResumableTransportTelemetry>,
  count: number,
): Promise<void> {
  await recorder.waitForAccepted(count);
  await waitForTelemetry(telemetry, (event) => event.acceptedEventCount >= count);
}

async function advancePoll(options: RunRealtimeCrossTransportMatrixOptions, milliseconds: number): Promise<void> {
  if (options.advanceTime) await options.advanceTime(milliseconds);
}

async function settle(options: RunRealtimeCrossTransportMatrixOptions, milliseconds: number): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  if (options.advanceTime) await options.advanceTime(milliseconds);
}

function fixtureResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrlHasResumePosition(value: string): boolean {
  const url = new URL(value);
  return ["cursor", "watermark", "timestamp", "deltaToken", "sequence"].some((name) => url.searchParams.has(name));
}

const CHECKPOINT_POSITION_FIELDS = ["cursor", "watermark", "deltaToken"] as const;

function checkpointPositionIsRedacted(
  checkpoints: readonly RealtimeDurableCheckpointV1[],
  redacted: RedactedRealtimeCheckpointV1,
): boolean {
  return checkpoints.some(
    (checkpoint) =>
      checkpoint.savedAt === redacted.savedAt &&
      checkpoint.resume.sequence === redacted.resume.sequence &&
      isDeepStrictEqual(redacted, expectedRedactedCheckpoint(checkpoint)),
  );
}

function expectedRedactedCheckpoint(checkpoint: RealtimeDurableCheckpointV1): RedactedRealtimeCheckpointV1 {
  return {
    kind: checkpoint.kind,
    version: checkpoint.version,
    context: checkpoint.context,
    resume: {
      sequence: checkpoint.resume.sequence,
      ...(checkpoint.resume.cursor === undefined
        ? {}
        : { cursor: checkpointPositionDigest("cursor", checkpoint.resume.cursor) }),
      ...(checkpoint.resume.watermark === undefined
        ? {}
        : { watermark: checkpointPositionDigest("watermark", checkpoint.resume.watermark) }),
      ...(checkpoint.resume.timestamp === undefined ? {} : { timestamp: checkpoint.resume.timestamp }),
      ...(checkpoint.resume.deltaToken === undefined
        ? {}
        : { deltaToken: checkpointPositionDigest("deltaToken", checkpoint.resume.deltaToken) }),
    },
    recentEventIdCount: checkpoint.recentEventIds.length,
    savedAt: checkpoint.savedAt,
  };
}

function checkpointTelemetryContainsRawPosition(
  checkpoints: readonly RealtimeDurableCheckpointV1[],
  samples: readonly RedactedRealtimeCheckpointV1[],
): boolean {
  const rawPositions = new Set(
    checkpoints.flatMap((checkpoint) =>
      CHECKPOINT_POSITION_FIELDS.flatMap((field) => {
        const value = checkpoint.resume[field];
        return value === undefined ? [] : [value];
      }),
    ),
  );
  if (rawPositions.size === 0) return false;
  const visited = new WeakSet<object>();
  const containsRawPosition = (value: unknown): boolean => {
    if (typeof value === "string") return rawPositions.has(value);
    if (typeof value !== "object" || value === null || visited.has(value)) return false;
    visited.add(value);
    return Object.values(value).some(containsRawPosition);
  };
  return samples.some(containsRawPosition);
}

function checkpointPositionDigest(
  field: (typeof CHECKPOINT_POSITION_FIELDS)[number],
  value: string,
): `sha256:${string}` {
  const digest = createHash("sha256").update(`honua-realtime-checkpoint-redaction:v1:${field}:${value}`).digest("hex");
  return `sha256:${digest}`;
}

function requireCheckpoint(
  transport: TransportName,
  checkpoint: RealtimeDurableCheckpointV1 | undefined,
): RealtimeDurableCheckpointV1 {
  if (!checkpoint) throw new Error(`${transport} did not produce a durable checkpoint.`);
  return checkpoint;
}

function normalizedRecords(state: RealtimeFeatureState<Incident>): Incident[] {
  return Object.values(state.records)
    .map((record) => record.feature)
    .sort((left, right) => left.id - right.id);
}

function normalizedTombstones(state: RealtimeFeatureState<Incident>): number[] {
  return Object.values(state.tombstones)
    .map((tombstone) => Number(tombstone.id))
    .sort((left, right) => left - right);
}

function odataEntity(entity: Incident): { readonly Id: number; readonly Status: string } {
  return { Id: entity.id, Status: entity.status };
}

function isDataEvent(event: RealtimeFeatureEvent<Incident>): event is RealtimeSequencedEvent<Incident> {
  return event.type === "snapshot" || event.type === "upsert" || event.type === "delete" || event.type === "delta";
}

function assertMatrixCorpus(corpus: RealtimeCrossTransportCorpusV1): void {
  if (corpus.kind !== "honua.realtime-cross-transport-conformance" || corpus.version !== 1) {
    throw new Error("Unsupported realtime cross-transport conformance corpus.");
  }
  if (corpus.scenarios.length < 10) throw new Error("Realtime conformance matrix must retain all ten scenarios.");
  if (!corpus.coverage.includes("persisted-same-scope-replay")) {
    throw new Error("Realtime conformance matrix must retain same-scope persisted replay coverage.");
  }
  if (!corpus.coverage.includes("cursor-watermark-delta-token-redaction")) {
    throw new Error("Realtime conformance matrix must retain field-aware checkpoint-redaction coverage.");
  }
  if (
    Object.values(corpus.positions).some(
      (position) =>
        typeof position.cursor !== "string" ||
        position.cursor.length === 0 ||
        typeof position.watermark !== "string" ||
        position.watermark.length === 0 ||
        typeof position.deltaToken !== "string" ||
        position.deltaToken.length === 0,
    )
  ) {
    throw new Error("Realtime conformance positions must exercise cursor, watermark, and delta-token fields.");
  }
  if (
    Date.parse(corpus.timing.serverEventTime) + corpus.timing.lagMs !== corpus.timing.receivedAt ||
    corpus.timing.receivedAt !== corpus.clock
  ) {
    throw new Error("Realtime conformance timing dimensions drifted.");
  }
  const ids = new Set<string>();
  for (const scenario of corpus.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Realtime conformance scenario ${scenario.id} is duplicated.`);
    ids.add(scenario.id);
  }
}

function assertJson(label: string, actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label} mismatch.\nExpected: ${expectedJson}\nActual:   ${actualJson}`);
  }
}
