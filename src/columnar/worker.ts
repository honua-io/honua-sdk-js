import { type ColumnarTelemetry, beginColumnarSpan } from "./telemetry.js";
import { createColumnarBatch, inspectColumnarBatch, leaseColumnarBatch } from "./transfer.js";
import {
  COLUMNAR_BATCH_KIND,
  COLUMNAR_BATCH_VERSION,
  type ColumnarBatchLimits,
  type ColumnarBatchMetrics,
  type ColumnarBatchV1,
  type ColumnarTransferOptions,
  HonuaColumnarTransferError,
} from "./types.js";

export const COLUMNAR_WORKER_PROTOCOL_VERSION = "1.0" as const;
export const COLUMNAR_WORKER_REQUEST_KIND = "honua.columnar-worker.request" as const;
export const COLUMNAR_WORKER_CANCEL_KIND = "honua.columnar-worker.cancel" as const;
export const COLUMNAR_WORKER_PROGRESS_KIND = "honua.columnar-worker.progress" as const;
export const COLUMNAR_WORKER_RESULT_KIND = "honua.columnar-worker.result" as const;
export const COLUMNAR_WORKER_ERROR_KIND = "honua.columnar-worker.error" as const;

const DEFAULT_MAX_PENDING_REQUESTS = 16;
const DEFAULT_CANCEL_ACKNOWLEDGEMENT_MS = 50;
const MAX_IDENTIFIER_LENGTH = 256;

export type ColumnarWorkerSessionState = "idle" | "running" | "disposed";
/**
 * Cross-request ordering contract for one session. `none` treats every request
 * as independent; `strict` requires one ordered batch stream.
 */
export type ColumnarWorkerStreamOrdering = "none" | "strict";
export type ColumnarWorkerErrorCode =
  | "invalid-request"
  | "invalid-response"
  | "unknown-operation"
  | "queue-full"
  | "aborted"
  | "operation-failed"
  | "worker-failed"
  | "disposed";

export class HonuaColumnarWorkerError extends Error {
  public constructor(
    public readonly code: ColumnarWorkerErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly requestId?: string; readonly operation?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HonuaColumnarWorkerError";
    this.requestId = options.requestId;
    this.operation = options.operation;
  }

  public readonly requestId: string | undefined;
  public readonly operation: string | undefined;
}

export interface ColumnarWorkerMessageEvent {
  readonly data: unknown;
}

export interface ColumnarWorkerFaultEvent {
  readonly error?: unknown;
  readonly message?: string;
}

/**
 * Minimal transport seam implemented by a browser Worker, MessagePort adapter,
 * or an application-owned worker wrapper. The factory owns CSP URL policy.
 */
export interface ColumnarWorkerTransport {
  postMessage(message: unknown, transfer: readonly ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (event: ColumnarWorkerMessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ColumnarWorkerFaultEvent) => void): void;
  removeEventListener(type: "message", listener: (event: ColumnarWorkerMessageEvent) => void): void;
  removeEventListener(type: "error", listener: (event: ColumnarWorkerFaultEvent) => void): void;
  /** Must terminate or close the underlying worker/port. Idempotence is required. */
  dispose(): void;
}

export type ColumnarWorkerFactory = () => ColumnarWorkerTransport | Promise<ColumnarWorkerTransport>;

export interface ColumnarWorkerRequestV1 {
  readonly kind: typeof COLUMNAR_WORKER_REQUEST_KIND;
  readonly version: typeof COLUMNAR_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: string;
  readonly batch: ColumnarBatchV1;
  readonly metrics: ColumnarBatchMetrics;
}

export interface ColumnarWorkerCancelV1 {
  readonly kind: typeof COLUMNAR_WORKER_CANCEL_KIND;
  readonly version: typeof COLUMNAR_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
}

export interface ColumnarWorkerProgressV1 {
  readonly kind: typeof COLUMNAR_WORKER_PROGRESS_KIND;
  readonly version: typeof COLUMNAR_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly fraction: number;
  readonly stage?: string;
}

export interface ColumnarWorkerResultV1 {
  readonly kind: typeof COLUMNAR_WORKER_RESULT_KIND;
  readonly version: typeof COLUMNAR_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly batch: ColumnarBatchV1;
  readonly metrics: ColumnarBatchMetrics;
}

export interface ColumnarWorkerErrorV1 {
  readonly kind: typeof COLUMNAR_WORKER_ERROR_KIND;
  readonly version: typeof COLUMNAR_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly code: "invalid-request" | "unknown-operation" | "aborted" | "operation-failed";
  readonly message: string;
}

export interface ColumnarWorkerExecutionProgress {
  readonly requestId: string;
  readonly fraction: number;
  readonly stage?: string;
}

export interface ColumnarWorkerExecutionResult {
  readonly requestId: string;
  readonly operation: string;
  readonly batch: ColumnarBatchV1;
  readonly inputMetrics: ColumnarBatchMetrics;
  readonly outputMetrics: ColumnarBatchMetrics;
}

export interface ExecuteColumnarWorkerOperationOptions extends ColumnarBatchLimits {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ColumnarWorkerExecutionProgress) => void;
}

export interface CreateColumnarWorkerSessionOptions {
  readonly createWorker: ColumnarWorkerFactory;
  /** Includes the active request. Defaults to 16; there is no unbounded mode. */
  readonly maxPendingRequests?: number;
  /**
   * Cross-request ordering contract. Defaults to `none`, which accepts every
   * request independently. `strict` declares that this session carries one
   * ordered batch stream and rejects a non-increasing `sequence` or a
   * non-contiguous `rowOffset` before the batch is transferred.
   */
  readonly streamOrdering?: ColumnarWorkerStreamOrdering;
  /**
   * Milliseconds a cancelled in-flight request may take to be acknowledged by
   * the worker before the transport is retired. Defaults to 50. A cooperative
   * operation that observes its signal acknowledges well inside the window and
   * keeps the worker warm; a non-cooperative one is retired at the deadline.
   */
  readonly cancelAcknowledgementMs?: number;
  /**
   * Optional observer for this session. Off by default. Every `execute` emits
   * one `columnar-worker-operation` span spanning enqueue through settlement,
   * and the ownership handoff it performs emits its own `columnar-transfer`
   * span, both bound to the input batch's identity.
   */
  readonly telemetry?: ColumnarTelemetry;
}

export interface ColumnarWorkerSession {
  readonly state: ColumnarWorkerSessionState;
  readonly pendingRequests: number;
  execute(
    operation: string,
    batch: ColumnarBatchV1,
    options?: ExecuteColumnarWorkerOperationOptions,
  ): Promise<ColumnarWorkerExecutionResult>;
  dispose(): void;
}

export interface ColumnarWorkerOperationContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  reportProgress(fraction: number, stage?: string): void;
}

export type ColumnarWorkerOperation = (
  batch: ColumnarBatchV1,
  context: ColumnarWorkerOperationContext,
) => ColumnarBatchV1 | Promise<ColumnarBatchV1>;

export interface StartColumnarWorkerHostOptions {
  readonly transport: ColumnarWorkerTransport;
  readonly operations: Readonly<Record<string, ColumnarWorkerOperation>>;
  readonly batchLimits?: ColumnarBatchLimits;
  /** Defensive ceiling for direct protocol callers. Defaults to one. */
  readonly maxActiveRequests?: number;
}

export interface ColumnarWorkerHost {
  readonly activeRequests: number;
  readonly disposed: boolean;
  dispose(): void;
}

interface PendingExecution {
  readonly requestId: string;
  readonly operation: string;
  readonly batch: ColumnarBatchV1;
  readonly options: NormalizedExecutionOptions;
  readonly resolve: (result: ColumnarWorkerExecutionResult) => void;
  readonly reject: (error: HonuaColumnarWorkerError) => void;
  abortListener?: () => void;
  inputMetrics?: ColumnarBatchMetrics;
  lastProgress: number;
  settled: boolean;
  /** True once the request message has been handed to the transport. */
  posted: boolean;
}

/** A cancelled request whose worker acknowledgement is still outstanding. */
interface PendingCancellation {
  readonly requestId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** The last batch accepted into a `strict` ordered stream. */
interface StreamCursor {
  readonly sequence: number;
  readonly rowOffset: number | undefined;
  readonly rowCount: number;
}

interface NormalizedAbortSignal {
  isAborted(): boolean;
  subscribe(listener: () => void): () => void;
}

interface NormalizedExecutionOptions extends ColumnarBatchLimits {
  readonly signal?: NormalizedAbortSignal;
  readonly onProgress?: (progress: ColumnarWorkerExecutionProgress) => void;
}

/**
 * Create a lazy, serial worker session. Only one transferred request is active;
 * queued batches stay caller-owned until dispatch. Cancelling active work
 * settles the caller immediately and gives the worker a bounded window to
 * acknowledge the cancellation; a worker that misses the window is retired so a
 * non-cooperative operation cannot escape bounds.
 */
export function createColumnarWorkerSession(options: CreateColumnarWorkerSessionOptions): ColumnarWorkerSession {
  if (typeof options !== "object" || options === null) {
    throw new HonuaColumnarWorkerError("invalid-request", "Worker session options must be an object");
  }
  let createWorker: ColumnarWorkerFactory;
  let rawMaxPendingRequests: number | undefined;
  let rawStreamOrdering: ColumnarWorkerStreamOrdering | undefined;
  let rawCancelAcknowledgementMs: number | undefined;
  let telemetry: ColumnarTelemetry | undefined;
  try {
    createWorker = options.createWorker;
    rawMaxPendingRequests = options.maxPendingRequests;
    rawStreamOrdering = options.streamOrdering;
    rawCancelAcknowledgementMs = options.cancelAcknowledgementMs;
    telemetry = options.telemetry;
  } catch (cause) {
    throw new HonuaColumnarWorkerError("invalid-request", "Worker session options could not be read", { cause });
  }
  if (typeof createWorker !== "function") {
    throw new HonuaColumnarWorkerError("invalid-request", "createWorker must be a function");
  }
  if (telemetry !== undefined && (typeof telemetry !== "object" || telemetry === null)) {
    throw new HonuaColumnarWorkerError("invalid-request", "telemetry must be an object");
  }
  const maxPendingRequests = positiveInteger(
    rawMaxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
    "maxPendingRequests",
  );
  const streamOrdering = normalizeStreamOrdering(rawStreamOrdering);
  const cancelAcknowledgementMs = nonNegativeInteger(
    rawCancelAcknowledgementMs ?? DEFAULT_CANCEL_ACKNOWLEDGEMENT_MS,
    "cancelAcknowledgementMs",
  );
  const queue: PendingExecution[] = [];
  let active: PendingExecution | undefined;
  let pendingCancel: PendingCancellation | undefined;
  let streamCursor: StreamCursor | undefined;
  let transport: ColumnarWorkerTransport | undefined;
  let workerPromise: Promise<ColumnarWorkerTransport> | undefined;
  let workerGeneration = 0;
  let disposed = false;
  let nextRequest = 0;

  const onMessage = (event: ColumnarWorkerMessageEvent): void => {
    if (pendingCancel && !active) {
      acknowledgeCancellation(event);
      return;
    }
    if (!active || active.settled) return;
    let message: ColumnarWorkerProgressV1 | ColumnarWorkerResultV1 | ColumnarWorkerErrorV1;
    try {
      message = normalizeWorkerResponse(event.data, active.requestId);
    } catch (cause) {
      failActive(failure("invalid-response", "Worker returned an invalid protocol message", active, cause), true);
      return;
    }
    if (message.requestId !== active.requestId) return;
    if (message.kind === COLUMNAR_WORKER_PROGRESS_KIND) {
      if (message.fraction < active.lastProgress) {
        failActive(failure("invalid-response", "Worker progress must be monotonic", active), true);
        return;
      }
      active.lastProgress = message.fraction;
      try {
        active.options.onProgress?.(
          Object.freeze({
            requestId: active.requestId,
            fraction: message.fraction,
            ...(message.stage === undefined ? {} : { stage: message.stage }),
          }),
        );
      } catch {
        // Progress observers cannot corrupt worker ownership or settlement.
      }
      return;
    }
    if (message.kind === COLUMNAR_WORKER_ERROR_KIND) {
      failActive(failure(message.code, message.message, active));
      return;
    }
    const current = active;
    try {
      const batch = normalizeBatchEnvelope(message.batch, "worker result batch", current.options);
      const outputMetrics = inspectColumnarBatch(batch, current.options);
      assertMetrics(message.metrics, outputMetrics, "result");
      settle(current);
      current.resolve(
        Object.freeze({
          requestId: current.requestId,
          operation: current.operation,
          batch,
          inputMetrics: current.inputMetrics as ColumnarBatchMetrics,
          outputMetrics,
        }),
      );
      active = undefined;
      void dispatch();
    } catch (cause) {
      failActive(failure("invalid-response", "Worker returned an invalid columnar result", current, cause), true);
    }
  };

  const onError = (event: ColumnarWorkerFaultEvent): void => {
    if (!active) {
      // A fault during the cancellation window ends the quarantine, so queued
      // work must resume on a replacement transport.
      retireTransport();
      void dispatch();
      return;
    }
    let message = "Columnar worker failed";
    let cause: unknown;
    try {
      message = event.message?.trim() || message;
      cause = event.error;
    } catch {
      // A hostile fault event cannot prevent deterministic settlement.
    }
    failActive(failure("worker-failed", message, active, cause), true);
  };

  function clearPendingCancel(): void {
    if (!pendingCancel) return;
    clearTimeout(pendingCancel.timer);
    pendingCancel = undefined;
  }

  /**
   * A cancelled request keeps the transport quarantined until the worker
   * reports a terminal outcome for it. Any terminal message proves the worker
   * is back under session control, so the warm transport is reused. A result
   * that raced the cancellation is discarded together with the buffers it
   * transferred: the caller has already been settled with `aborted`.
   */
  function acknowledgeCancellation(event: ColumnarWorkerMessageEvent): void {
    const expected = pendingCancel;
    if (!expected) return;
    let message: ColumnarWorkerProgressV1 | ColumnarWorkerResultV1 | ColumnarWorkerErrorV1;
    try {
      message = normalizeWorkerResponse(event.data, expected.requestId);
    } catch {
      retireTransport();
      void dispatch();
      return;
    }
    if (message.requestId !== expected.requestId) return;
    if (message.kind === COLUMNAR_WORKER_PROGRESS_KIND) return;
    clearPendingCancel();
    void dispatch();
  }

  function retireTransport(): void {
    clearPendingCancel();
    workerGeneration += 1;
    const current = transport;
    transport = undefined;
    workerPromise = undefined;
    if (!current) return;
    try {
      current.removeEventListener("message", onMessage);
    } catch {
      // Continue best-effort retirement.
    }
    try {
      current.removeEventListener("error", onError);
    } catch {
      // Continue best-effort retirement.
    }
    try {
      current.dispose();
    } catch {
      // A transport fault is already represented by the failed request.
    }
  }

  function settle(item: PendingExecution): void {
    if (item.settled) return;
    item.settled = true;
    item.abortListener?.();
  }

  function failActive(error: HonuaColumnarWorkerError, retire = false): void {
    const current = active;
    if (!current) return;
    settle(current);
    current.reject(error);
    active = undefined;
    if (retire) retireTransport();
    void dispatch();
  }

  async function getTransport(): Promise<ColumnarWorkerTransport> {
    if (transport) return transport;
    if (!workerPromise) {
      const generation = workerGeneration;
      workerPromise = Promise.resolve()
        .then(createWorker)
        .then((created) => {
          const createdTransport = snapshotTransport(created);
          if (disposed || generation !== workerGeneration) {
            createdTransport.dispose();
            throw new HonuaColumnarWorkerError(
              disposed ? "disposed" : "worker-failed",
              disposed
                ? "Columnar worker session is disposed"
                : "Columnar worker was retired before creation completed",
            );
          }
          transport = createdTransport;
          createdTransport.addEventListener("message", onMessage);
          createdTransport.addEventListener("error", onError);
          return createdTransport;
        })
        .catch((cause) => {
          if (generation === workerGeneration) workerPromise = undefined;
          if (cause instanceof HonuaColumnarWorkerError) throw cause;
          throw new HonuaColumnarWorkerError("worker-failed", "Columnar worker creation failed", { cause });
        });
    }
    return workerPromise;
  }

  async function dispatch(): Promise<void> {
    if (disposed || active || pendingCancel || queue.length === 0) return;
    const item = queue.shift();
    if (!item || item.settled) return void dispatch();
    try {
      if (item.options.signal?.isAborted()) {
        settle(item);
        item.reject(failure("aborted", "Columnar worker request was aborted before dispatch", item));
        return void dispatch();
      }
    } catch (cause) {
      settle(item);
      item.reject(failure("invalid-request", "Columnar worker signal failed before dispatch", item, cause));
      return void dispatch();
    }
    active = item;
    try {
      const currentTransport = await getTransport();
      if (disposed || active !== item || item.settled) return;
      const lease = leaseColumnarBatch(item.batch, item.options);
      item.inputMetrics = inspectColumnarBatch(item.batch, item.options);
      await lease.transfer((transferMessage, transfer) => {
        const request: ColumnarWorkerRequestV1 = Object.freeze({
          kind: COLUMNAR_WORKER_REQUEST_KIND,
          version: COLUMNAR_WORKER_PROTOCOL_VERSION,
          requestId: item.requestId,
          operation: item.operation,
          batch: transferMessage.batch,
          metrics: transferMessage.metrics,
        });
        currentTransport.postMessage(request, transfer);
        item.posted = true;
      }, transferOptions(item.options));
      lease.dispose();
    } catch (cause) {
      if (active === item) {
        const inputFailure = cause instanceof HonuaColumnarTransferError && cause.code !== "transport-failed";
        failActive(
          failure(
            inputFailure ? "invalid-request" : "worker-failed",
            inputFailure ? "Columnar worker input batch is invalid" : "Columnar worker dispatch failed",
            item,
            cause,
          ),
          !inputFailure,
        );
      }
    }
  }

  /** Limits for the dispatch handoff, plus this session's observer when it has one. */
  function transferOptions(execution: ColumnarBatchLimits): ColumnarTransferOptions {
    const limits = columnarLimits(execution);
    return telemetry === undefined ? limits : Object.freeze({ ...limits, telemetry });
  }

  function cancel(item: PendingExecution): void {
    if (item.settled) return;
    const queuedIndex = queue.indexOf(item);
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1);
      settle(item);
      item.reject(failure("aborted", "Columnar worker request was aborted before dispatch", item));
      return;
    }
    if (active !== item) return;
    const currentTransport = transport;
    settle(item);
    active = undefined;
    item.reject(failure("aborted", "Columnar worker request was aborted", item));
    if (!currentTransport || !item.posted) {
      // The worker never received this request, so its transport is unaffected
      // and the in-flight dispatch cannot post a cancelled request.
      void dispatch();
      return;
    }
    try {
      currentTransport.postMessage(
        Object.freeze({
          kind: COLUMNAR_WORKER_CANCEL_KIND,
          version: COLUMNAR_WORKER_PROTOCOL_VERSION,
          requestId: item.requestId,
        } satisfies ColumnarWorkerCancelV1),
        [],
      );
    } catch {
      // A transport that cannot carry the cancel message cannot be trusted to
      // stop the operation, so retirement remains the cancellation boundary.
      retireTransport();
      void dispatch();
      return;
    }
    const timer = setTimeout(() => {
      pendingCancel = undefined;
      retireTransport();
      void dispatch();
    }, cancelAcknowledgementMs);
    (timer as { unref?: () => void }).unref?.();
    pendingCancel = Object.freeze({ requestId: item.requestId, timer });
  }

  return {
    get state() {
      if (disposed) return "disposed";
      return active ? "running" : "idle";
    },
    get pendingRequests() {
      return queue.length + (active ? 1 : 0);
    },
    execute(operation, batch, executeOptions = {}) {
      if (disposed)
        return Promise.reject(new HonuaColumnarWorkerError("disposed", "Columnar worker session is disposed"));
      const normalizedOperation = identifier(operation, "operation");
      let normalizedOptions: NormalizedExecutionOptions;
      try {
        normalizedOptions = normalizeExecutionOptions(executeOptions);
      } catch (cause) {
        return Promise.reject(
          cause instanceof HonuaColumnarWorkerError
            ? cause
            : new HonuaColumnarWorkerError("invalid-request", "Columnar worker options are invalid", { cause }),
        );
      }
      if (queue.length + (active ? 1 : 0) >= maxPendingRequests) {
        return Promise.reject(
          new HonuaColumnarWorkerError(
            "queue-full",
            `Columnar worker queue is limited to ${maxPendingRequests} requests`,
            { operation: normalizedOperation },
          ),
        );
      }
      try {
        if (normalizedOptions.signal?.isAborted()) {
          return Promise.reject(
            new HonuaColumnarWorkerError("aborted", "Columnar worker request was aborted before enqueue", {
              operation: normalizedOperation,
            }),
          );
        }
      } catch (cause) {
        return Promise.reject(
          new HonuaColumnarWorkerError("invalid-request", "Columnar worker signal could not be read", {
            cause,
            operation: normalizedOperation,
          }),
        );
      }
      let normalizedBatch: ColumnarBatchV1;
      try {
        normalizedBatch = normalizeBatchEnvelope(batch, "worker input batch", normalizedOptions);
      } catch (cause) {
        return Promise.reject(
          new HonuaColumnarWorkerError("invalid-request", "Columnar worker input batch is invalid", {
            cause,
            operation: normalizedOperation,
          }),
        );
      }
      if (streamOrdering === "strict") {
        const drift = streamDrift(streamCursor, normalizedBatch);
        if (drift !== undefined) {
          return Promise.reject(
            new HonuaColumnarWorkerError("invalid-request", drift, { operation: normalizedOperation }),
          );
        }
      }
      const requestId = `columnar-${++nextRequest}`;
      // Started here rather than at the top of `execute`: everything above
      // refuses the request before it becomes work, and only a normalized batch
      // can bind the span to an identity.
      const span = telemetry
        ? beginColumnarSpan(telemetry, "columnar-worker-operation", normalizedBatch.identity, {
            requestId,
            operation: normalizedOperation,
            batchId: normalizedBatch.id,
          })
        : undefined;
      const settlement = new Promise<ColumnarWorkerExecutionResult>((resolve, reject) => {
        const item: PendingExecution = {
          requestId,
          operation: normalizedOperation,
          batch: normalizedBatch,
          options: normalizedOptions,
          resolve,
          reject,
          lastProgress: 0,
          settled: false,
          posted: false,
        };
        if (normalizedOptions.signal) {
          let ready = false;
          let abortedDuringSetup = false;
          const listener = (): void => {
            if (ready) cancel(item);
            else abortedDuringSetup = true;
          };
          try {
            item.abortListener = normalizedOptions.signal.subscribe(listener);
            abortedDuringSetup ||= normalizedOptions.signal.isAborted();
          } catch (cause) {
            settle(item);
            reject(failure("invalid-request", "Columnar worker signal subscription failed", item, cause));
            return;
          }
          if (abortedDuringSetup) {
            settle(item);
            reject(failure("aborted", "Columnar worker request was aborted before enqueue", item));
            return;
          }
          ready = true;
        }
        // The stream cursor advances on acceptance, not completion, because a
        // queue holds several batches before any of them settle.
        if (streamOrdering === "strict") {
          streamCursor = Object.freeze({
            sequence: normalizedBatch.sequence,
            rowOffset: normalizedBatch.rowOffset,
            rowCount: normalizedBatch.rowCount,
          });
        }
        queue.push(item);
        try {
          if (normalizedOptions.signal?.isAborted()) cancel(item);
        } catch (cause) {
          const queuedIndex = queue.indexOf(item);
          if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
          settle(item);
          reject(failure("invalid-request", "Columnar worker signal failed after enqueue", item, cause));
          return;
        }
        void dispatch();
      });
      if (span === undefined) return settlement;
      return settlement.then(
        (result) => {
          span.finish({ inputMetrics: result.inputMetrics, outputMetrics: result.outputMetrics });
          return result;
        },
        (error: unknown) => {
          span.fail(error, error instanceof HonuaColumnarWorkerError ? { code: error.code } : undefined);
          throw error;
        },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) {
        const current = active;
        settle(current);
        current.reject(failure("disposed", "Columnar worker session was disposed", current));
        active = undefined;
      }
      for (const item of queue.splice(0)) {
        settle(item);
        item.reject(failure("disposed", "Columnar worker session was disposed", item));
      }
      retireTransport();
    },
  };
}

/** Register worker-local operations on a transport without importing a worker runtime. */
export function startColumnarWorkerHost(options: StartColumnarWorkerHostOptions): ColumnarWorkerHost {
  if (typeof options !== "object" || options === null) {
    throw new HonuaColumnarWorkerError("invalid-request", "Worker host options are required");
  }
  let foreignTransport: ColumnarWorkerTransport;
  let foreignOperations: Readonly<Record<string, ColumnarWorkerOperation>>;
  let foreignBatchLimits: ColumnarBatchLimits | undefined;
  let foreignMaxActiveRequests: number | undefined;
  try {
    foreignTransport = options.transport;
    foreignOperations = options.operations;
    foreignBatchLimits = options.batchLimits;
    foreignMaxActiveRequests = options.maxActiveRequests;
  } catch (cause) {
    throw new HonuaColumnarWorkerError("invalid-request", "Worker host options could not be read", { cause });
  }
  const transport = snapshotTransport(foreignTransport);
  const batchLimits = snapshotColumnarLimits(foreignBatchLimits);
  let operations: Readonly<Record<string, ColumnarWorkerOperation>>;
  try {
    operations = normalizeOperations(foreignOperations);
  } catch (cause) {
    if (cause instanceof HonuaColumnarWorkerError) throw cause;
    throw new HonuaColumnarWorkerError("invalid-request", "Worker operations are invalid", { cause });
  }
  const maxActiveRequests = positiveInteger(foreignMaxActiveRequests ?? 1, "maxActiveRequests");
  const active = new Map<string, AbortController>();
  let disposed = false;

  const sendError = (requestId: string, code: ColumnarWorkerErrorV1["code"], message: string): void => {
    if (disposed) return;
    try {
      transport.postMessage(
        Object.freeze({
          kind: COLUMNAR_WORKER_ERROR_KIND,
          version: COLUMNAR_WORKER_PROTOCOL_VERSION,
          requestId,
          code,
          message,
        } satisfies ColumnarWorkerErrorV1),
        [],
      );
    } catch {
      // Delivery failure is terminal for this response but never unhandled.
    }
  };

  const run = async (foreign: unknown): Promise<void> => {
    let request: ColumnarWorkerRequestV1;
    try {
      request = normalizeWorkerRequest(foreign, batchLimits);
    } catch (cause) {
      const requestId = safeRequestId(foreign) ?? "invalid-request";
      sendError(requestId, "invalid-request", messageFrom(cause, "Invalid columnar worker request"));
      return;
    }
    if (active.has(request.requestId)) {
      sendError(request.requestId, "invalid-request", "Duplicate active request id");
      return;
    }
    if (active.size >= maxActiveRequests) {
      sendError(request.requestId, "invalid-request", `Worker host is limited to ${maxActiveRequests} active requests`);
      return;
    }
    const operation = operations[request.operation];
    if (!operation) {
      sendError(request.requestId, "unknown-operation", `Unknown columnar worker operation: ${request.operation}`);
      return;
    }
    const controller = new AbortController();
    active.set(request.requestId, controller);
    let progress = 0;
    try {
      const output = await operation(request.batch, {
        requestId: request.requestId,
        signal: controller.signal,
        reportProgress(fraction, stage) {
          if (disposed || controller.signal.aborted) return;
          const normalized = progressFraction(fraction);
          if (normalized < progress) {
            throw new HonuaColumnarWorkerError("operation-failed", "Operation progress must be monotonic");
          }
          progress = normalized;
          transport.postMessage(
            Object.freeze({
              kind: COLUMNAR_WORKER_PROGRESS_KIND,
              version: COLUMNAR_WORKER_PROTOCOL_VERSION,
              requestId: request.requestId,
              fraction: normalized,
              ...(stage === undefined ? {} : { stage: identifier(stage, "progress stage") }),
            } satisfies ColumnarWorkerProgressV1),
            [],
          );
        },
      });
      if (controller.signal.aborted || disposed) {
        sendError(request.requestId, "aborted", "Columnar worker operation was aborted");
        return;
      }
      const batch = normalizeBatchEnvelope(output, "operation result batch", batchLimits);
      const lease = leaseColumnarBatch(batch, batchLimits);
      await lease.transfer((transferMessage, transfer) => {
        transport.postMessage(
          Object.freeze({
            kind: COLUMNAR_WORKER_RESULT_KIND,
            version: COLUMNAR_WORKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            batch: transferMessage.batch,
            metrics: transferMessage.metrics,
          } satisfies ColumnarWorkerResultV1),
          transfer,
        );
      });
      lease.dispose();
    } catch (cause) {
      if (controller.signal.aborted) sendError(request.requestId, "aborted", "Columnar worker operation was aborted");
      else sendError(request.requestId, "operation-failed", "Columnar worker operation failed");
    } finally {
      active.delete(request.requestId);
    }
  };

  const onMessage = (event: ColumnarWorkerMessageEvent): void => {
    if (disposed) return;
    let data: unknown;
    try {
      data = event.data;
    } catch {
      return;
    }
    if (isCancel(data)) {
      active.get(data.requestId)?.abort();
      return;
    }
    void run(data).catch(() => {
      // The host contains unexpected protocol-handler failures.
    });
  };
  const onError = (): void => {
    for (const controller of active.values()) controller.abort();
  };
  try {
    transport.addEventListener("message", onMessage);
    transport.addEventListener("error", onError);
  } catch (cause) {
    try {
      transport.removeEventListener("message", onMessage);
    } catch {
      // Continue registration rollback.
    }
    try {
      transport.removeEventListener("error", onError);
    } catch {
      // Continue registration rollback.
    }
    try {
      transport.dispose();
    } catch {
      // The registration failure remains the primary cause.
    }
    throw new HonuaColumnarWorkerError("worker-failed", "Worker host listener registration failed", { cause });
  }

  return {
    get activeRequests() {
      return active.size;
    },
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      try {
        transport.removeEventListener("message", onMessage);
      } catch (cause) {
        failures.push(cause);
      }
      try {
        transport.removeEventListener("error", onError);
      } catch (cause) {
        failures.push(cause);
      }
      for (const controller of active.values()) controller.abort();
      active.clear();
      try {
        transport.dispose();
      } catch (cause) {
        failures.push(cause);
      }
      if (failures.length > 0) {
        throw new HonuaColumnarWorkerError("worker-failed", "Worker host disposal completed with transport failures", {
          cause: new AggregateError(failures),
        });
      }
    },
  };
}

function normalizeWorkerRequest(foreign: unknown, limits: ColumnarBatchLimits = {}): ColumnarWorkerRequestV1 {
  const value = record(foreign, "worker request");
  if (value.kind !== COLUMNAR_WORKER_REQUEST_KIND || value.version !== COLUMNAR_WORKER_PROTOCOL_VERSION) {
    throw new HonuaColumnarWorkerError(
      "invalid-request",
      `Worker request must be ${COLUMNAR_WORKER_REQUEST_KIND}@${COLUMNAR_WORKER_PROTOCOL_VERSION}`,
    );
  }
  const requestId = identifier(value.requestId, "requestId");
  const operation = identifier(value.operation, "operation");
  const batch = normalizeBatchEnvelope(value.batch, "worker request batch", limits);
  const metrics = inspectColumnarBatch(batch, limits);
  assertMetrics(value.metrics, metrics, "request");
  return Object.freeze({
    kind: COLUMNAR_WORKER_REQUEST_KIND,
    version: COLUMNAR_WORKER_PROTOCOL_VERSION,
    requestId,
    operation,
    batch,
    metrics,
  });
}

function normalizeWorkerResponse(
  foreign: unknown,
  expectedRequestId: string,
): ColumnarWorkerProgressV1 | ColumnarWorkerResultV1 | ColumnarWorkerErrorV1 {
  const value = record(foreign, "worker response");
  if (value.version !== COLUMNAR_WORKER_PROTOCOL_VERSION) {
    throw new HonuaColumnarWorkerError("invalid-response", "Worker response protocol version is not supported");
  }
  const requestId = identifier(value.requestId, "requestId");
  if (requestId !== expectedRequestId) {
    // Valid late/duplicate messages are ignored by the caller; malformed ones fail closed.
    if (
      ![COLUMNAR_WORKER_PROGRESS_KIND, COLUMNAR_WORKER_RESULT_KIND, COLUMNAR_WORKER_ERROR_KIND].includes(
        value.kind as never,
      )
    ) {
      throw new HonuaColumnarWorkerError("invalid-response", "Worker response kind is not supported");
    }
    return Object.freeze({
      kind: COLUMNAR_WORKER_PROGRESS_KIND,
      version: COLUMNAR_WORKER_PROTOCOL_VERSION,
      requestId,
      fraction: 0,
    });
  }
  if (value.kind === COLUMNAR_WORKER_PROGRESS_KIND) {
    const fraction = progressFraction(value.fraction);
    const stage = value.stage === undefined ? undefined : identifier(value.stage, "progress stage");
    return Object.freeze({
      kind: value.kind,
      version: COLUMNAR_WORKER_PROTOCOL_VERSION,
      requestId,
      fraction,
      ...(stage === undefined ? {} : { stage }),
    });
  }
  if (value.kind === COLUMNAR_WORKER_ERROR_KIND) {
    const code = value.code;
    if (!(["invalid-request", "unknown-operation", "aborted", "operation-failed"] as const).includes(code as never)) {
      throw new HonuaColumnarWorkerError("invalid-response", "Worker error code is not supported");
    }
    return Object.freeze({
      kind: value.kind,
      version: COLUMNAR_WORKER_PROTOCOL_VERSION,
      requestId,
      code: code as ColumnarWorkerErrorV1["code"],
      message: messageText(value.message, "error message"),
    });
  }
  if (value.kind === COLUMNAR_WORKER_RESULT_KIND) {
    return Object.freeze({
      kind: value.kind,
      version: COLUMNAR_WORKER_PROTOCOL_VERSION,
      requestId,
      batch: value.batch as ColumnarBatchV1,
      metrics: value.metrics as ColumnarBatchMetrics,
    });
  }
  throw new HonuaColumnarWorkerError("invalid-response", "Worker response kind is not supported");
}

function isCancel(foreign: unknown): foreign is ColumnarWorkerCancelV1 {
  try {
    if (typeof foreign !== "object" || foreign === null) return false;
    const value = foreign as Partial<ColumnarWorkerCancelV1>;
    return (
      value.kind === COLUMNAR_WORKER_CANCEL_KIND &&
      value.version === COLUMNAR_WORKER_PROTOCOL_VERSION &&
      typeof value.requestId === "string"
    );
  } catch {
    return false;
  }
}

function normalizeOperations(
  foreign: Readonly<Record<string, ColumnarWorkerOperation>>,
): Readonly<Record<string, ColumnarWorkerOperation>> {
  const value = record(foreign, "operations");
  const result = Object.create(null) as Record<string, ColumnarWorkerOperation>;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 64)
    throw new HonuaColumnarWorkerError("invalid-request", "operations must contain between 1 and 64 entries");
  for (const key of keys) {
    const name = identifier(key, "operation name");
    const operation = value[key];
    if (typeof operation !== "function")
      throw new HonuaColumnarWorkerError("invalid-request", `Operation ${name} must be a function`);
    result[name] = operation as ColumnarWorkerOperation;
  }
  return Object.freeze(result);
}

function normalizeBatchEnvelope(foreign: unknown, label: string, limits: ColumnarBatchLimits = {}): ColumnarBatchV1 {
  const value = record(foreign, label);
  if (value.kind !== COLUMNAR_BATCH_KIND || value.version !== COLUMNAR_BATCH_VERSION) {
    throw new HonuaColumnarWorkerError(
      "invalid-request",
      `${label} must be ${COLUMNAR_BATCH_KIND}@${COLUMNAR_BATCH_VERSION}`,
    );
  }
  return createColumnarBatch(value as unknown as ColumnarBatchV1, limits);
}

function normalizeExecutionOptions(foreign: ExecuteColumnarWorkerOperationOptions): NormalizedExecutionOptions {
  if (typeof foreign !== "object" || foreign === null) {
    throw new HonuaColumnarWorkerError("invalid-request", "Worker execution options must be an object");
  }
  const foreignSignal = foreign.signal;
  const onProgress = foreign.onProgress;
  const maxRows = foreign.maxRows;
  const maxBackingBytes = foreign.maxBackingBytes;
  const maxSchemaNodes = foreign.maxSchemaNodes;
  const maxMetadataEntries = foreign.maxMetadataEntries;
  const maxBufferViews = foreign.maxBufferViews;
  const maxStringBytes = foreign.maxStringBytes;
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new HonuaColumnarWorkerError("invalid-request", "onProgress must be a function");
  }
  const signal = foreignSignal === undefined ? undefined : normalizeAbortSignal(foreignSignal);
  return Object.freeze({
    ...(signal === undefined ? {} : { signal }),
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(maxRows === undefined ? {} : { maxRows }),
    ...(maxBackingBytes === undefined ? {} : { maxBackingBytes }),
    ...(maxSchemaNodes === undefined ? {} : { maxSchemaNodes }),
    ...(maxMetadataEntries === undefined ? {} : { maxMetadataEntries }),
    ...(maxBufferViews === undefined ? {} : { maxBufferViews }),
    ...(maxStringBytes === undefined ? {} : { maxStringBytes }),
  });
}

function normalizeAbortSignal(foreign: AbortSignal): NormalizedAbortSignal {
  if (typeof foreign !== "object" || foreign === null) {
    throw new HonuaColumnarWorkerError("invalid-request", "signal must be an AbortSignal-like object");
  }
  let add: AbortSignal["addEventListener"];
  let remove: AbortSignal["removeEventListener"];
  try {
    add = foreign.addEventListener;
    remove = foreign.removeEventListener;
  } catch (cause) {
    throw new HonuaColumnarWorkerError("invalid-request", "signal methods could not be read", { cause });
  }
  if (typeof add !== "function" || typeof remove !== "function") {
    throw new HonuaColumnarWorkerError("invalid-request", "signal must provide event listener methods");
  }
  return Object.freeze({
    isAborted(): boolean {
      let aborted: unknown;
      try {
        aborted = foreign.aborted;
      } catch (cause) {
        throw new HonuaColumnarWorkerError("invalid-request", "signal.aborted could not be read", { cause });
      }
      if (typeof aborted !== "boolean") {
        throw new HonuaColumnarWorkerError("invalid-request", "signal.aborted must be a boolean");
      }
      return aborted;
    },
    subscribe(listener: () => void): () => void {
      try {
        add.call(foreign, "abort", listener, { once: true });
      } catch (cause) {
        throw new HonuaColumnarWorkerError("invalid-request", "signal abort listener could not be installed", {
          cause,
        });
      }
      return () => {
        try {
          remove.call(foreign, "abort", listener);
        } catch {
          // A foreign signal cannot prevent request settlement.
        }
      };
    },
  });
}

function columnarLimits(options: ColumnarBatchLimits): ColumnarBatchLimits {
  return Object.freeze({
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    ...(options.maxBackingBytes === undefined ? {} : { maxBackingBytes: options.maxBackingBytes }),
    ...(options.maxSchemaNodes === undefined ? {} : { maxSchemaNodes: options.maxSchemaNodes }),
    ...(options.maxMetadataEntries === undefined ? {} : { maxMetadataEntries: options.maxMetadataEntries }),
    ...(options.maxBufferViews === undefined ? {} : { maxBufferViews: options.maxBufferViews }),
    ...(options.maxStringBytes === undefined ? {} : { maxStringBytes: options.maxStringBytes }),
  });
}

function snapshotColumnarLimits(foreign: ColumnarBatchLimits | undefined): ColumnarBatchLimits {
  if (foreign === undefined) return Object.freeze({});
  if (typeof foreign !== "object" || foreign === null) {
    throw new HonuaColumnarWorkerError("invalid-request", "batchLimits must be an object");
  }
  try {
    return columnarLimits({
      maxRows: foreign.maxRows,
      maxBackingBytes: foreign.maxBackingBytes,
      maxSchemaNodes: foreign.maxSchemaNodes,
      maxMetadataEntries: foreign.maxMetadataEntries,
      maxBufferViews: foreign.maxBufferViews,
      maxStringBytes: foreign.maxStringBytes,
    });
  } catch (cause) {
    throw new HonuaColumnarWorkerError("invalid-request", "batchLimits could not be read", { cause });
  }
}

function snapshotTransport(value: unknown): ColumnarWorkerTransport {
  const transport = record(value, "worker transport");
  let postMessage: unknown;
  let addEventListener: unknown;
  let removeEventListener: unknown;
  let dispose: unknown;
  try {
    postMessage = transport.postMessage;
    addEventListener = transport.addEventListener;
    removeEventListener = transport.removeEventListener;
    dispose = transport.dispose;
  } catch (cause) {
    throw new HonuaColumnarWorkerError("worker-failed", "Worker transport methods could not be read", { cause });
  }
  if (
    typeof postMessage !== "function" ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function" ||
    typeof dispose !== "function"
  ) {
    throw new HonuaColumnarWorkerError("worker-failed", "Worker transport methods must be functions");
  }
  return Object.freeze({
    postMessage(message: unknown, transfer: readonly ArrayBuffer[]) {
      Reflect.apply(postMessage, value, [message, transfer]);
    },
    addEventListener(
      type: "message" | "error",
      listener: ((event: ColumnarWorkerMessageEvent) => void) | ((event: ColumnarWorkerFaultEvent) => void),
    ) {
      Reflect.apply(addEventListener, value, [type, listener]);
    },
    removeEventListener(
      type: "message" | "error",
      listener: ((event: ColumnarWorkerMessageEvent) => void) | ((event: ColumnarWorkerFaultEvent) => void),
    ) {
      Reflect.apply(removeEventListener, value, [type, listener]);
    },
    dispose() {
      Reflect.apply(dispose, value, []);
    },
  });
}

function assertMetrics(foreign: unknown, expected: ColumnarBatchMetrics, label: string): void {
  const value = record(foreign, `${label} metrics`);
  for (const key of [
    "rows",
    "logicalBytes",
    "backingBytes",
    "transferBytes",
    "copiedBytes",
    "bufferViews",
    "backingBuffers",
  ] as const) {
    if (value[key] !== expected[key])
      throw new HonuaColumnarWorkerError("invalid-response", `${label} metrics.${key} does not match the batch`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HonuaColumnarWorkerError("invalid-request", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim()
  ) {
    throw new HonuaColumnarWorkerError(
      "invalid-request",
      `${label} must be a non-empty trimmed string of at most ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
  return value;
}

function messageText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value !== value.trim()) {
    throw new HonuaColumnarWorkerError(
      "invalid-request",
      `${label} must be a non-empty trimmed string of at most 512 characters`,
    );
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new HonuaColumnarWorkerError("invalid-request", `${label} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new HonuaColumnarWorkerError("invalid-request", `${label} must be a non-negative safe integer`);
  return value;
}

function normalizeStreamOrdering(value: ColumnarWorkerStreamOrdering | undefined): ColumnarWorkerStreamOrdering {
  if (value === undefined) return "none";
  if (value !== "none" && value !== "strict")
    throw new HonuaColumnarWorkerError("invalid-request", "streamOrdering must be none or strict");
  return value;
}

/**
 * Describe how a batch drifts from a `strict` ordered stream, or `undefined`
 * when it continues the stream. Drift is a caller contract violation, so it is
 * reported before the batch is transferred and the caller keeps its buffers.
 */
function streamDrift(cursor: StreamCursor | undefined, batch: ColumnarBatchV1): string | undefined {
  if (!cursor) return undefined;
  if (batch.sequence <= cursor.sequence) {
    return `Columnar stream sequence must increase; received ${batch.sequence} after ${cursor.sequence}`;
  }
  const previous = cursor.rowOffset;
  const next = batch.rowOffset;
  if ((previous === undefined) !== (next === undefined)) {
    return "Columnar stream rowOffset must be declared by every batch or by none";
  }
  if (previous !== undefined && next !== undefined && next !== previous + cursor.rowCount) {
    return `Columnar stream rowOffset must be contiguous; expected ${previous + cursor.rowCount} but received ${next}`;
  }
  return undefined;
}

function progressFraction(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new HonuaColumnarWorkerError("invalid-request", "progress fraction must be between 0 and 1");
  return value;
}

function safeRequestId(foreign: unknown): string | undefined {
  if (typeof foreign !== "object" || foreign === null) return undefined;
  try {
    const value = (foreign as { readonly requestId?: unknown }).requestId;
    return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH ? value : undefined;
  } catch {
    return undefined;
  }
}

function messageFrom(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message.slice(0, 512);
  return fallback;
}

function failure(
  code: ColumnarWorkerErrorCode,
  message: string,
  item: PendingExecution,
  cause?: unknown,
): HonuaColumnarWorkerError {
  return new HonuaColumnarWorkerError(code, message, { cause, requestId: item.requestId, operation: item.operation });
}
