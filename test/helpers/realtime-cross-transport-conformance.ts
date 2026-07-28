import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  OdataDeltaPollTelemetry,
  RealtimeCheckpointStore,
  RealtimeDurableCheckpointV1,
  RealtimeFeatureEvent,
  RealtimeFeatureObserver,
  RealtimeFeatureState,
  RealtimeResumableTransportTelemetry,
  RealtimeResumeContextV1,
  RealtimeSequencedEvent,
  RealtimeServerSentEventSource,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
  RealtimeWebSocket,
  RealtimeWebSocketCloseEvent,
  RedactedRealtimeCheckpointV1,
  ResumableRealtimeSubscription,
} from "@honua/sdk-js/realtime";

type RealtimeSdk = typeof import("@honua/sdk-js/realtime");
type TransportName = "sse" | "websocket" | "odata";
type CheckpointTelemetrySource = "resumable-wrapper" | "contract-redaction";
export type RealtimeConformanceFault =
  | "none"
  | "duplicate-delta"
  | "late-snapshot"
  | "sequence-gap"
  | "transport-gap"
  | "buffer-overflow"
  | "cursor-expired"
  | "resume-unsupported"
  | "cancel"
  | "terminal-error";

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

export interface RealtimeCrossTransportCorpusV1 {
  readonly kind: "honua.realtime-cross-transport-conformance";
  readonly version: 1;
  readonly baseContract: {
    readonly kind: "honua.realtime-contract-fixtures";
    readonly version: 1;
    readonly fixture: "snapshot-delta-cursor-resume-contract.v1.json";
  };
  readonly scenario: string;
  readonly coverage: readonly string[];
  readonly clock: number;
  readonly pollIntervalMs: number;
  readonly timing: {
    readonly serverEventTime: string;
    readonly receivedAt: number;
    readonly lagMs: number;
  };
  readonly request: RealtimeSubscriptionRequest;
  readonly context: RealtimeResumeContextV1;
  readonly positions: {
    readonly snapshot: Position;
    readonly delta: Position;
    readonly gap: Position;
    readonly recoverySnapshot: Position;
    readonly recoveryDelta: Position;
  };
  readonly initial: readonly Incident[];
  readonly changes: readonly Change[];
  readonly resumeScopeProbe: {
    readonly authorizationScopeFingerprint: string;
    readonly expectedCode: string;
  };
  readonly recovery: {
    readonly snapshot: readonly Incident[];
    readonly changes: readonly Change[];
  };
  readonly expected: {
    readonly eventTypes: readonly string[];
    readonly acceptedEventCount: number;
    readonly records: readonly Incident[];
    readonly tombstones: readonly number[];
    readonly recoveredRecords: readonly Incident[];
    readonly recoveredTombstones: readonly number[];
  };
  readonly scenarios: readonly RealtimeCrossTransportScenarioV1[];
}

export interface RealtimeCrossTransportScenarioV1 {
  readonly id: string;
  readonly fault: RealtimeConformanceFault;
  readonly acceptedEventIds: readonly string[];
  readonly sequences: readonly number[];
  readonly finalState: "initial" | "base" | "recovered";
  readonly duplicateCount: number;
  readonly gapCount: number;
  readonly overflowCount: number;
  readonly resnapshotCount: number;
  readonly termination: "complete" | "error";
}

export interface RealtimeTransportConformanceEvidence {
  readonly transport: TransportName;
  readonly kind: string;
  readonly eventTypes: readonly string[];
  readonly sequences: readonly number[];
  readonly acceptedEventCount: number;
  readonly records: readonly Incident[];
  readonly tombstones: readonly number[];
  readonly resumeScopeProbe: {
    readonly compatible: boolean;
    readonly code: string;
  };
  readonly checkpointTelemetry: {
    readonly source: CheckpointTelemetrySource;
    readonly samples: number;
    readonly redacted: boolean;
    readonly rawPositionPresent: boolean;
  };
  readonly lifecycle: {
    readonly completed: number;
    readonly errors: number;
    readonly resourcesActive: number;
  };
  readonly freshness: {
    readonly mode: "push" | "poll";
    readonly pollCount: number;
  };
}

export interface RealtimeCrossTransportConformanceEvidence {
  readonly format: "honua.realtime-cross-transport-s1-evidence.v1";
  readonly corpusVersion: 1;
  readonly scenario: string;
  readonly coverage: readonly string[];
  readonly transports: readonly RealtimeTransportConformanceEvidence[];
}

export interface RunRealtimeCrossTransportConformanceOptions {
  readonly sdk: RealtimeSdk;
  readonly corpus: RealtimeCrossTransportCorpusV1;
  /**
   * Lets Vitest advance fake timers without putting timer knowledge in the
   * corpus. Packed-package execution omits this and observes the real
   * one-millisecond fixture cadence through emitted events, never a sleep.
   */
  readonly advanceOdataPoll?: (intervalMs: number) => Promise<void>;
}

interface Recorder {
  readonly observer: RealtimeFeatureObserver<Incident>;
  readonly errors: unknown[];
  readonly statuses: RealtimeFeatureEvent<Incident>[];
  readonly acceptedEvents: RealtimeSequencedEvent<Incident>[];
  readonly waitForDataEvents: (count: number) => Promise<void>;
  readonly drain: () => Promise<void>;
  readonly snapshotState: () => RealtimeFeatureState<Incident>;
  readonly completed: () => number;
  readonly checkpoint: () => RealtimeDurableCheckpointV1 | undefined;
  readonly acceptedEventCount: () => number;
}

interface AdapterRun {
  readonly transport: TransportName;
  readonly kind: string;
  readonly recorder: Recorder;
  readonly rawCheckpoint: RealtimeDurableCheckpointV1;
  readonly rawCheckpoints: readonly RealtimeDurableCheckpointV1[];
  readonly acceptedEventCount: number;
  readonly checkpointTelemetrySource: CheckpointTelemetrySource;
  readonly checkpointTelemetrySamples: readonly RedactedRealtimeCheckpointV1[];
  readonly resourcesActive: number;
  readonly pollTelemetry: readonly OdataDeltaPollTelemetry[];
}

interface ProgressWaiter {
  readonly target: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

class ProgressLatch {
  private value = 0;
  private failure: unknown;
  private completed = false;
  private readonly waiters = new Set<ProgressWaiter>();

  public advance(): void {
    this.advanceTo(this.value + 1);
  }

  public advanceTo(value: number): void {
    if (value <= this.value) return;
    this.value = value;
    for (const waiter of this.waiters) {
      if (this.value < waiter.target) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  public fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters) waiter.reject(this.failure);
    this.waiters.clear();
  }

  public complete(error: Error): boolean {
    this.completed = true;
    if (this.waiters.size === 0) return false;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    return true;
  }

  public waitFor(target: number): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.value >= target) return Promise.resolve();
    if (this.completed) {
      return Promise.reject(
        new Error(`Realtime adapter completed after ${String(this.value)} data events; expected ${String(target)}.`),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.add({ target, resolve, reject });
    });
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

class FixtureEventSource implements RealtimeServerSentEventSource {
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

  public emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  public close(): void {
    this.closeCount += 1;
    this.readyState = 2;
  }

  public get resourcesActive(): number {
    return (
      this.listeners.size +
      Number(this.onopen !== null) +
      Number(this.onmessage !== null) +
      Number(this.onerror !== null) +
      Number(this.readyState !== 2)
    );
  }
}

class FixtureWebSocket implements RealtimeWebSocket {
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

  public emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  public close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }

  public get resourcesActive(): number {
    return (
      Number(this.onopen !== null) +
      Number(this.onmessage !== null) +
      Number(this.onerror !== null) +
      Number(this.onclose !== null) +
      Number(this.readyState !== 3)
    );
  }
}

export async function runRealtimeCrossTransportConformance(
  options: RunRealtimeCrossTransportConformanceOptions,
): Promise<RealtimeCrossTransportConformanceEvidence> {
  assertCorpus(options.corpus);
  const events = corpusEvents(options.corpus);
  const settled = await Promise.allSettled([
    runSse(options.sdk, options.corpus, events),
    runWebSocket(options.sdk, options.corpus, events),
    runOdata(options.sdk, options.corpus, options.advanceOdataPoll),
  ]);
  const runs: AdapterRun[] = [];
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    runs.push(result.value);
  }
  const transports = runs.map((run) => evidenceForRun(options.sdk, options.corpus, run));
  assertConformance(options.corpus, transports);
  return {
    format: "honua.realtime-cross-transport-s1-evidence.v1",
    corpusVersion: 1,
    scenario: options.corpus.scenario,
    coverage: [...options.corpus.coverage],
    transports,
  };
}

async function runSse(
  sdk: RealtimeSdk,
  corpus: RealtimeCrossTransportCorpusV1,
  events: readonly RealtimeSequencedEvent<Incident>[],
): Promise<AdapterRun> {
  const controller = new AbortController();
  const source = new FixtureEventSource();
  const created = deferred<{ readonly url: string }>();
  const checkpoints = createCheckpointCapture();
  const telemetry = createTelemetryCapture();
  const recorder = createDirectRecorder(sdk, corpus, (error) => {
    created.reject(error);
    checkpoints.fail(error);
    telemetry.fail(error);
  });
  const transport = sdk.createResumableServerSentEventsTransport<Incident>(
    {
      url: "https://honua.example/realtime/incidents",
      eventSourceFactory(url) {
        created.resolve({ url });
        return source;
      },
    },
    resumableOptions(corpus, checkpoints.store, telemetry.record),
  );
  let handle: RealtimeSubscriptionHandle | undefined;
  try {
    handle = transport.subscribe({ ...corpus.request, signal: controller.signal }, recorder.observer);
    const connection = await created.promise;
    assertRequestUrl(connection.url, corpus);
    source.open();
    for (const event of events) source.emit(event);
    await Promise.all([
      recorder.waitForDataEvents(events.length),
      checkpoints.waitFor(events.length),
      telemetry.waitForAccepted(events.length),
    ]);
  } finally {
    if (handle) await dispose(controller, handle, recorder);
  }
  if (source.closeCount !== 1) throw new Error(`SSE close count was ${String(source.closeCount)}, expected 1.`);
  const checkpoint = requireCheckpoint("sse", checkpoints.checkpoints.at(-1));
  return {
    transport: "sse",
    kind: transport.capabilities?.kind ?? "missing",
    recorder,
    rawCheckpoint: checkpoint,
    rawCheckpoints: checkpoints.checkpoints,
    acceptedEventCount: telemetry.acceptedEventCount(),
    checkpointTelemetrySource: "resumable-wrapper",
    checkpointTelemetrySamples: telemetry.checkpoints(),
    resourcesActive: source.resourcesActive,
    pollTelemetry: [],
  };
}

async function runWebSocket(
  sdk: RealtimeSdk,
  corpus: RealtimeCrossTransportCorpusV1,
  events: readonly RealtimeSequencedEvent<Incident>[],
): Promise<AdapterRun> {
  const controller = new AbortController();
  const socket = new FixtureWebSocket();
  const created = deferred<{ readonly url: string }>();
  const checkpoints = createCheckpointCapture();
  const telemetry = createTelemetryCapture();
  const recorder = createDirectRecorder(sdk, corpus, (error) => {
    created.reject(error);
    checkpoints.fail(error);
    telemetry.fail(error);
  });
  const transport = sdk.createResumableWebSocketTransport<Incident>(
    {
      url: "https://honua.example/realtime/incidents",
      webSocketFactory(url) {
        created.resolve({ url });
        return socket;
      },
    },
    resumableOptions(corpus, checkpoints.store, telemetry.record),
  );
  let handle: RealtimeSubscriptionHandle | undefined;
  try {
    handle = transport.subscribe({ ...corpus.request, signal: controller.signal }, recorder.observer);
    const connection = await created.promise;
    assertRequestUrl(connection.url, corpus);
    socket.open();
    for (const event of events) socket.emit(event);
    await Promise.all([
      recorder.waitForDataEvents(events.length),
      checkpoints.waitFor(events.length),
      telemetry.waitForAccepted(events.length),
    ]);
  } finally {
    if (handle) await dispose(controller, handle, recorder);
  }
  if (socket.closeCount !== 1) {
    throw new Error(`WebSocket close count was ${String(socket.closeCount)}, expected 1.`);
  }
  const checkpoint = requireCheckpoint("websocket", checkpoints.checkpoints.at(-1));
  return {
    transport: "websocket",
    kind: transport.capabilities?.kind ?? "missing",
    recorder,
    rawCheckpoint: checkpoint,
    rawCheckpoints: checkpoints.checkpoints,
    acceptedEventCount: telemetry.acceptedEventCount(),
    checkpointTelemetrySource: "resumable-wrapper",
    checkpointTelemetrySamples: telemetry.checkpoints(),
    resourcesActive: socket.resourcesActive,
    pollTelemetry: [],
  };
}

async function runOdata(
  sdk: RealtimeSdk,
  corpus: RealtimeCrossTransportCorpusV1,
  advanceOdataPoll: ((intervalMs: number) => Promise<void>) | undefined,
): Promise<AdapterRun> {
  const controller = new AbortController();
  const recorder = await createContractRecorder(sdk, corpus, controller.signal);
  const calls: Array<{ readonly url: string; readonly signal?: AbortSignal }> = [];
  const responses = [
    {
      value: corpus.initial.map(odataEntity),
      "@odata.deltaLink": corpus.positions.snapshot.deltaToken,
    },
    {
      value: corpus.changes.map((change) =>
        change.op === "upsert"
          ? odataEntity(change.entity)
          : {
              Id: change.id,
              "@removed": { reason: "deleted" },
            },
      ),
      "@odata.deltaLink": corpus.positions.delta.deltaToken,
    },
  ];
  const pollTelemetry: OdataDeltaPollTelemetry[] = [];
  const transport = sdk.createOdataDeltaTransport<Incident>({
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
      return fixtureResponse(response);
    }) as typeof fetch,
    onPoll(event) {
      pollTelemetry.push(event);
    },
    now: () => corpus.clock,
  });
  let handle: RealtimeSubscriptionHandle | undefined;
  try {
    handle = transport.subscribe({ ...corpus.request, signal: controller.signal }, recorder.observer);
    await recorder.waitForDataEvents(1);
    if (advanceOdataPoll) await advanceOdataPoll(corpus.pollIntervalMs);
    await recorder.waitForDataEvents(2);
  } finally {
    if (handle) await dispose(controller, handle, recorder);
  }
  if (calls.length !== 2) throw new Error(`OData request count was ${String(calls.length)}, expected 2.`);
  const activeSignals = calls.filter((call) => call.signal && !call.signal.aborted).length;
  const checkpoint = requireCheckpoint("odata", recorder.checkpoint());
  return {
    transport: "odata",
    kind: transport.capabilities?.kind ?? "missing",
    recorder,
    rawCheckpoint: checkpoint,
    rawCheckpoints: [checkpoint],
    acceptedEventCount: recorder.acceptedEventCount(),
    checkpointTelemetrySource: "contract-redaction",
    checkpointTelemetrySamples: [sdk.redactRealtimeCheckpoint(checkpoint)],
    resourcesActive: activeSignals,
    pollTelemetry,
  };
}

function resumableOptions(
  corpus: RealtimeCrossTransportCorpusV1,
  checkpointStore: RealtimeCheckpointStore,
  onTelemetry: (event: RealtimeResumableTransportTelemetry) => void,
) {
  return {
    context: corpus.context,
    checkpointStore,
    reconnect: { maxAttempts: 0 },
    onTelemetry,
    now: () => corpus.clock,
  };
}

function createDirectRecorder(
  sdk: RealtimeSdk,
  corpus: RealtimeCrossTransportCorpusV1,
  onFailure: (error: unknown) => void,
): Recorder {
  let state = sdk.emptyRealtimeFeatureState<Incident>();
  let completed = 0;
  const progress = new ProgressLatch();
  const errors: unknown[] = [];
  const statuses: RealtimeFeatureEvent<Incident>[] = [];
  const acceptedEvents: RealtimeSequencedEvent<Incident>[] = [];

  function fail(error: unknown): void {
    if (errors.length === 0) errors.push(error);
    progress.fail(error);
    onFailure(error);
  }

  const observer: RealtimeFeatureObserver<Incident> = {
    next(event) {
      if (!isDataEvent(event)) {
        statuses.push(event);
        return;
      }
      try {
        acceptedEvents.push(event);
        state = sdk.reduceRealtimeFeatureState(state, event, { now: () => corpus.clock });
        progress.advance();
      } catch (error) {
        fail(error);
      }
    },
    error(error) {
      fail(error);
    },
    complete() {
      completed += 1;
      const completion = new Error(
        `Realtime adapter completed after ${String(acceptedEvents.length)} accepted data events.`,
      );
      if (progress.complete(completion)) onFailure(completion);
    },
  };
  return {
    observer,
    errors,
    statuses,
    acceptedEvents,
    waitForDataEvents: (count) => progress.waitFor(count),
    drain: () => Promise.resolve(),
    snapshotState: () => state,
    completed: () => completed,
    checkpoint: () => undefined,
    acceptedEventCount: () => acceptedEvents.length,
  };
}

async function createContractRecorder(
  sdk: RealtimeSdk,
  corpus: RealtimeCrossTransportCorpusV1,
  signal: AbortSignal,
): Promise<Recorder> {
  let state = sdk.emptyRealtimeFeatureState<Incident>();
  let completed = 0;
  let pending = Promise.resolve();
  const progress = new ProgressLatch();
  const errors: unknown[] = [];
  const statuses: RealtimeFeatureEvent<Incident>[] = [];
  const acceptedEvents: RealtimeSequencedEvent<Incident>[] = [];
  const gate = await sdk.createResumableRealtimeSubscription<Incident>({
    context: corpus.context,
    signal,
    now: () => corpus.clock,
    apply(event) {
      acceptedEvents.push(event);
      state = sdk.reduceRealtimeFeatureState(state, event, { now: () => corpus.clock });
    },
  });

  function fail(error: unknown): void {
    if (errors.length === 0) errors.push(error);
    progress.fail(error);
  }

  const observer: RealtimeFeatureObserver<Incident> = {
    next(event) {
      if (!isDataEvent(event)) {
        statuses.push(event);
        return;
      }
      pending = pending
        .then(async () => {
          const delivery = await gate.enqueue(event);
          if (delivery.status !== "applied" && delivery.status !== "duplicate") {
            throw new Error(
              `Common realtime contract rejected OData delivery as ${delivery.status} (${delivery.reason ?? "no reason"}).`,
            );
          }
          progress.advance();
        })
        .catch((error: unknown) => {
          fail(error);
        });
    },
    error(error) {
      fail(error);
    },
    complete() {
      completed += 1;
      progress.complete(
        new Error(`OData adapter completed after ${String(acceptedEvents.length)} accepted data events.`),
      );
    },
  };
  return {
    observer,
    errors,
    statuses,
    acceptedEvents,
    waitForDataEvents: async (count) => {
      await progress.waitFor(count);
      await pending;
    },
    drain: () => pending,
    snapshotState: () => state,
    completed: () => completed,
    checkpoint: () => gate.state.checkpoint,
    acceptedEventCount: () => gate.state.acceptedEventCount,
  };
}

function createCheckpointCapture(): {
  readonly store: RealtimeCheckpointStore;
  readonly checkpoints: RealtimeDurableCheckpointV1[];
  readonly waitFor: (count: number) => Promise<void>;
  readonly fail: (error: unknown) => void;
} {
  const checkpoints: RealtimeDurableCheckpointV1[] = [];
  const progress = new ProgressLatch();
  return {
    checkpoints,
    store: {
      load: () => Promise.resolve(undefined),
      save(checkpoint) {
        checkpoints.push(checkpoint);
        progress.advance();
        return Promise.resolve();
      },
    },
    waitFor: (count) => progress.waitFor(count),
    fail: (error) => progress.fail(error),
  };
}

function createTelemetryCapture(): {
  readonly record: (event: RealtimeResumableTransportTelemetry) => void;
  readonly waitForAccepted: (count: number) => Promise<void>;
  readonly fail: (error: unknown) => void;
  readonly acceptedEventCount: () => number;
  readonly checkpoints: () => RedactedRealtimeCheckpointV1[];
} {
  const events: RealtimeResumableTransportTelemetry[] = [];
  const progress = new ProgressLatch();
  return {
    record(event) {
      events.push(event);
      progress.advanceTo(event.acceptedEventCount);
    },
    waitForAccepted: (count) => progress.waitFor(count),
    fail: (error) => progress.fail(error),
    acceptedEventCount: () => events.reduce((maximum, event) => Math.max(maximum, event.acceptedEventCount), 0),
    checkpoints: () => events.flatMap((event) => (event.checkpoint === undefined ? [] : [event.checkpoint])),
  };
}

async function dispose(
  controller: AbortController,
  handle: RealtimeSubscriptionHandle,
  recorder: Recorder,
): Promise<void> {
  controller.abort("fixture complete");
  handle.close();
  handle.close();
  await recorder.drain();
}

function evidenceForRun(
  sdk: RealtimeSdk,
  corpus: RealtimeCrossTransportCorpusV1,
  run: AdapterRun,
): RealtimeTransportConformanceEvidence {
  const state = run.recorder.snapshotState();
  const scopeProbe = sdk.evaluateRealtimeCheckpoint(
    {
      ...corpus.context,
      authorizationScopeFingerprint: corpus.resumeScopeProbe.authorizationScopeFingerprint,
    },
    run.rawCheckpoint,
  );
  const rawPositionPresent = checkpointTelemetryContainsRawPosition(run.rawCheckpoints, run.checkpointTelemetrySamples);
  const redacted =
    run.checkpointTelemetrySamples.length > 0 &&
    run.checkpointTelemetrySamples.every((checkpoint) => checkpointPositionIsRedacted(run.rawCheckpoints, checkpoint));
  return {
    transport: run.transport,
    kind: run.kind,
    eventTypes: run.recorder.acceptedEvents.map((event) => event.type),
    sequences: run.recorder.acceptedEvents.map((event) => event.sequence ?? -1),
    acceptedEventCount: run.acceptedEventCount,
    records: normalizedRecords(state),
    tombstones: normalizedTombstones(state),
    resumeScopeProbe: {
      compatible: scopeProbe.compatible,
      code: scopeProbe.code,
    },
    checkpointTelemetry: {
      source: run.checkpointTelemetrySource,
      samples: run.checkpointTelemetrySamples.length,
      redacted,
      rawPositionPresent,
    },
    lifecycle: {
      completed: run.recorder.completed(),
      errors: run.recorder.errors.length,
      resourcesActive: run.resourcesActive,
    },
    freshness: {
      mode: run.transport === "odata" ? "poll" : "push",
      pollCount: run.pollTelemetry.length,
    },
  };
}

function assertConformance(
  corpus: RealtimeCrossTransportCorpusV1,
  evidence: readonly RealtimeTransportConformanceEvidence[],
): void {
  if (evidence.length !== 3) throw new Error(`Expected three transports, received ${String(evidence.length)}.`);
  const expectedKinds: Record<TransportName, string> = {
    sse: "sse",
    websocket: "websocket",
    odata: "polling",
  };
  const baseline = comparableEvidence(evidence[0]!);
  for (const transport of evidence) {
    if (transport.kind !== expectedKinds[transport.transport]) {
      throw new Error(`${transport.transport} reported transport kind "${transport.kind}".`);
    }
    assertJson(`${transport.transport} expected event types`, transport.eventTypes, corpus.expected.eventTypes);
    assertJson(`${transport.transport} expected sequences`, transport.sequences, [
      corpus.positions.snapshot.sequence,
      corpus.positions.delta.sequence,
    ]);
    if (transport.acceptedEventCount !== corpus.expected.acceptedEventCount) {
      throw new Error(
        `${transport.transport} accepted ${String(transport.acceptedEventCount)} events; expected ${String(corpus.expected.acceptedEventCount)}.`,
      );
    }
    assertJson(`${transport.transport} expected records`, transport.records, corpus.expected.records);
    assertJson(`${transport.transport} expected tombstones`, transport.tombstones, corpus.expected.tombstones);
    if (
      transport.resumeScopeProbe.compatible ||
      transport.resumeScopeProbe.code !== corpus.resumeScopeProbe.expectedCode
    ) {
      throw new Error(`${transport.transport} accepted an authorization-mismatched checkpoint.`);
    }
    if (
      transport.checkpointTelemetry.samples < 1 ||
      !transport.checkpointTelemetry.redacted ||
      transport.checkpointTelemetry.rawPositionPresent
    ) {
      throw new Error(
        `${transport.transport} checkpoint telemetry was not actually redacted: ${JSON.stringify(transport.checkpointTelemetry)}.`,
      );
    }
    if (
      transport.lifecycle.completed !== 1 ||
      transport.lifecycle.errors !== 0 ||
      transport.lifecycle.resourcesActive !== 0
    ) {
      throw new Error(`${transport.transport} did not dispose cleanly: ${JSON.stringify(transport.lifecycle)}.`);
    }
    assertJson(`${transport.transport} normalized result`, comparableEvidence(transport), baseline);
  }
  const streaming = evidence.filter((transport) => transport.transport !== "odata");
  if (streaming.some((transport) => transport.checkpointTelemetry.source !== "resumable-wrapper")) {
    throw new Error("Streaming conformance did not use shipped resumable-wrapper telemetry.");
  }
  const odata = evidence.find((transport) => transport.transport === "odata");
  if (
    !odata ||
    odata.freshness.mode !== "poll" ||
    odata.freshness.pollCount !== 2 ||
    odata.checkpointTelemetry.source !== "contract-redaction"
  ) {
    throw new Error("OData conformance did not retain truthful polling and common-contract evidence.");
  }
}

function comparableEvidence(evidence: RealtimeTransportConformanceEvidence): unknown {
  return {
    eventTypes: evidence.eventTypes,
    sequences: evidence.sequences,
    acceptedEventCount: evidence.acceptedEventCount,
    records: evidence.records,
    tombstones: evidence.tombstones,
    resumeScopeProbe: evidence.resumeScopeProbe,
    checkpointTelemetry: {
      redacted: evidence.checkpointTelemetry.redacted,
      rawPositionPresent: evidence.checkpointTelemetry.rawPositionPresent,
    },
    lifecycle: evidence.lifecycle,
  };
}

function corpusEvents(corpus: RealtimeCrossTransportCorpusV1): readonly RealtimeSequencedEvent<Incident>[] {
  const upserts = corpus.changes
    .filter((change): change is UpsertChange => change.op === "upsert")
    .map((change) => ({ id: change.entity.id, feature: change.entity }));
  const deletes = corpus.changes
    .filter((change): change is DeleteChange => change.op === "delete")
    .map((change) => ({ id: change.id }));
  return [
    {
      type: "snapshot",
      sequence: corpus.positions.snapshot.sequence,
      cursor: corpus.positions.snapshot.cursor,
      watermark: corpus.positions.snapshot.watermark,
      deltaToken: corpus.positions.snapshot.deltaToken,
      receivedAt: corpus.clock,
      replace: true,
      features: corpus.initial.map((entity) => ({ id: entity.id, feature: entity })),
    },
    {
      type: "delta",
      sequence: corpus.positions.delta.sequence,
      cursor: corpus.positions.delta.cursor,
      watermark: corpus.positions.delta.watermark,
      deltaToken: corpus.positions.delta.deltaToken,
      receivedAt: corpus.clock,
      upserts,
      deletes,
    },
  ];
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

function odataEntity(entity: Incident): { readonly Id: number; readonly Status: string } {
  return { Id: entity.id, Status: entity.status };
}

function fixtureResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as Response;
}

function isDataEvent(event: RealtimeFeatureEvent<Incident>): event is RealtimeSequencedEvent<Incident> {
  return event.type === "snapshot" || event.type === "upsert" || event.type === "delete" || event.type === "delta";
}

function assertRequestUrl(urlValue: string, corpus: RealtimeCrossTransportCorpusV1): void {
  const url = new URL(urlValue);
  if (url.searchParams.get("sourceId") !== String(corpus.request.sourceId)) {
    throw new Error(`Transport request did not preserve sourceId: ${urlValue}`);
  }
  if (url.searchParams.get("mode") !== corpus.request.mode) {
    throw new Error(`Transport request did not preserve subscription mode: ${urlValue}`);
  }
}

function assertCorpus(corpus: RealtimeCrossTransportCorpusV1): void {
  if (corpus.kind !== "honua.realtime-cross-transport-conformance" || corpus.version !== 1) {
    throw new Error("Unsupported realtime cross-transport conformance corpus.");
  }
  if (
    corpus.baseContract.kind !== "honua.realtime-contract-fixtures" ||
    corpus.baseContract.version !== 1 ||
    corpus.baseContract.fixture !== "snapshot-delta-cursor-resume-contract.v1.json"
  ) {
    throw new Error("Realtime cross-transport corpus does not bind the shared v1 realtime contract fixture.");
  }
  if (!Number.isSafeInteger(corpus.pollIntervalMs) || corpus.pollIntervalMs < 1) {
    throw new Error("Realtime conformance pollIntervalMs must be a positive safe integer.");
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
    !Number.isSafeInteger(corpus.timing.receivedAt) ||
    !Number.isSafeInteger(corpus.timing.lagMs) ||
    Date.parse(corpus.timing.serverEventTime) + corpus.timing.lagMs !== corpus.timing.receivedAt
  ) {
    throw new Error("Realtime conformance server time, receipt time, and lag must remain separate and consistent.");
  }
  for (const required of [
    "snapshot",
    "create",
    "update",
    "delete",
    "transport-duplicate",
    "reorder",
    "sequence-gap",
    "slow-consumer-backpressure",
    "forced-disconnect",
    "cursor-expiry",
    "explicit-resnapshot",
    "persisted-same-scope-replay",
    "cursor-watermark-delta-token-redaction",
    "cancellation",
    "terminal-repeated-disposal",
  ]) {
    if (!corpus.coverage.includes(required)) throw new Error(`Realtime conformance corpus is missing ${required}.`);
  }
  const scenarioFaults = new Set(corpus.scenarios.map((scenario) => scenario.fault));
  for (const fault of [
    "duplicate-delta",
    "late-snapshot",
    "sequence-gap",
    "transport-gap",
    "buffer-overflow",
    "cursor-expired",
    "resume-unsupported",
    "cancel",
    "terminal-error",
  ] satisfies RealtimeConformanceFault[]) {
    if (!scenarioFaults.has(fault)) throw new Error(`Realtime conformance corpus is missing the ${fault} scenario.`);
  }
  const initialIds = new Set(corpus.initial.map((entity) => entity.id));
  const upserts = corpus.changes.filter((change): change is UpsertChange => change.op === "upsert");
  if (!upserts.some((change) => !initialIds.has(change.entity.id))) {
    throw new Error("Realtime conformance corpus does not contain a create.");
  }
  if (!upserts.some((change) => initialIds.has(change.entity.id))) {
    throw new Error("Realtime conformance corpus does not contain an update.");
  }
  if (!corpus.changes.some((change) => change.op === "delete")) {
    throw new Error("Realtime conformance corpus does not contain a delete.");
  }
  const signatures = upserts.map((change) => JSON.stringify(change.entity));
  if (new Set(signatures).size === signatures.length) {
    throw new Error("Realtime conformance corpus does not contain a duplicate entity row.");
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(error) {
      rejectPromise?.(error);
    },
  };
}

function assertJson(label: string, actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label} mismatch.\nExpected: ${expectedJson}\nActual:   ${actualJson}`);
  }
}
