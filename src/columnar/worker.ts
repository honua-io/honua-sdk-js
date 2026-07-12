import { createColumnarBatch, inspectColumnarBatch, leaseColumnarBatch } from "./transfer.js";
import {
  COLUMNAR_BATCH_KIND,
  COLUMNAR_BATCH_VERSION,
  type ColumnarBatchLimits,
  type ColumnarBatchMetrics,
  type ColumnarBatchV1,
  HonuaColumnarTransferError,
} from "./types.js";

export const COLUMNAR_WORKER_PROTOCOL_VERSION = "1.0" as const;
export const COLUMNAR_WORKER_REQUEST_KIND = "honua.columnar-worker.request" as const;
export const COLUMNAR_WORKER_CANCEL_KIND = "honua.columnar-worker.cancel" as const;
export const COLUMNAR_WORKER_PROGRESS_KIND = "honua.columnar-worker.progress" as const;
export const COLUMNAR_WORKER_RESULT_KIND = "honua.columnar-worker.result" as const;
export const COLUMNAR_WORKER_ERROR_KIND = "honua.columnar-worker.error" as const;

const DEFAULT_MAX_PENDING_REQUESTS = 16;
const MAX_IDENTIFIER_LENGTH = 256;

export type ColumnarWorkerSessionState = "idle" | "running" | "disposed";
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
  readonly options: ExecuteColumnarWorkerOperationOptions;
  readonly resolve: (result: ColumnarWorkerExecutionResult) => void;
  readonly reject: (error: HonuaColumnarWorkerError) => void;
  abortListener?: () => void;
  inputMetrics?: ColumnarBatchMetrics;
  lastProgress: number;
  settled: boolean;
}

/**
 * Create a lazy, serial worker session. Only one transferred request is active;
 * queued batches stay caller-owned until dispatch. Cancelling active work
 * retires the transport so a non-cooperative operation cannot escape bounds.
 */
export function createColumnarWorkerSession(options: CreateColumnarWorkerSessionOptions): ColumnarWorkerSession {
  if (typeof options !== "object" || options === null) {
    throw new HonuaColumnarWorkerError("invalid-request", "Worker session options must be an object");
  }
  let createWorker: ColumnarWorkerFactory;
  let rawMaxPendingRequests: number | undefined;
  try {
    createWorker = options.createWorker;
    rawMaxPendingRequests = options.maxPendingRequests;
  } catch (cause) {
    throw new HonuaColumnarWorkerError("invalid-request", "Worker session options could not be read", { cause });
  }
  if (typeof createWorker !== "function") {
    throw new HonuaColumnarWorkerError("invalid-request", "createWorker must be a function");
  }
  const maxPendingRequests = positiveInteger(
    rawMaxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
    "maxPendingRequests",
  );
  const queue: PendingExecution[] = [];
  let active: PendingExecution | undefined;
  let transport: ColumnarWorkerTransport | undefined;
  let workerPromise: Promise<ColumnarWorkerTransport> | undefined;
  let workerGeneration = 0;
  let disposed = false;
  let nextRequest = 0;

  const onMessage = (event: ColumnarWorkerMessageEvent): void => {
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
      retireTransport();
      return;
    }
    failActive(failure("worker-failed", event.message?.trim() || "Columnar worker failed", active, event.error), true);
  };

  function retireTransport(): void {
    workerGeneration += 1;
    const current = transport;
    transport = undefined;
    workerPromise = undefined;
    if (!current) return;
    current.removeEventListener("message", onMessage);
    current.removeEventListener("error", onError);
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
          validateTransport(created);
          if (disposed || generation !== workerGeneration) {
            created.dispose();
            throw new HonuaColumnarWorkerError(
              disposed ? "disposed" : "worker-failed",
              disposed
                ? "Columnar worker session is disposed"
                : "Columnar worker was retired before creation completed",
            );
          }
          transport = created;
          created.addEventListener("message", onMessage);
          created.addEventListener("error", onError);
          return created;
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
    if (disposed || active || queue.length === 0) return;
    const item = queue.shift();
    if (!item || item.settled) return void dispatch();
    if (item.options.signal?.aborted) {
      settle(item);
      item.reject(failure("aborted", "Columnar worker request was aborted before dispatch", item));
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
      }, item.options);
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
    try {
      transport?.postMessage(
        Object.freeze({
          kind: COLUMNAR_WORKER_CANCEL_KIND,
          version: COLUMNAR_WORKER_PROTOCOL_VERSION,
          requestId: item.requestId,
        } satisfies ColumnarWorkerCancelV1),
        [],
      );
    } catch {
      // Retirement below is the authoritative cancellation boundary.
    }
    failActive(failure("aborted", "Columnar worker request was aborted", item), true);
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
      let normalizedOptions: ExecuteColumnarWorkerOperationOptions;
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
      if (normalizedOptions.signal?.aborted) {
        return Promise.reject(
          new HonuaColumnarWorkerError("aborted", "Columnar worker request was aborted before enqueue", {
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
      const requestId = `columnar-${++nextRequest}`;
      return new Promise<ColumnarWorkerExecutionResult>((resolve, reject) => {
        const item: PendingExecution = {
          requestId,
          operation: normalizedOperation,
          batch: normalizedBatch,
          options: normalizedOptions,
          resolve,
          reject,
          lastProgress: 0,
          settled: false,
        };
        if (normalizedOptions.signal) {
          const listener = (): void => cancel(item);
          normalizedOptions.signal.addEventListener("abort", listener, { once: true });
          item.abortListener = () => {
            try {
              normalizedOptions.signal?.removeEventListener("abort", listener);
            } catch {
              // A foreign signal cannot prevent request settlement.
            }
          };
        }
        queue.push(item);
        void dispatch();
      });
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
  validateTransport(options.transport);
  let operations: Readonly<Record<string, ColumnarWorkerOperation>>;
  try {
    operations = normalizeOperations(options.operations);
  } catch (cause) {
    if (cause instanceof HonuaColumnarWorkerError) throw cause;
    throw new HonuaColumnarWorkerError("invalid-request", "Worker operations are invalid", { cause });
  }
  const maxActiveRequests = positiveInteger(options.maxActiveRequests ?? 1, "maxActiveRequests");
  const active = new Map<string, AbortController>();
  let disposed = false;

  const sendError = (requestId: string, code: ColumnarWorkerErrorV1["code"], message: string): void => {
    if (disposed) return;
    options.transport.postMessage(
      Object.freeze({
        kind: COLUMNAR_WORKER_ERROR_KIND,
        version: COLUMNAR_WORKER_PROTOCOL_VERSION,
        requestId,
        code,
        message,
      } satisfies ColumnarWorkerErrorV1),
      [],
    );
  };

  const run = async (foreign: unknown): Promise<void> => {
    let request: ColumnarWorkerRequestV1;
    try {
      request = normalizeWorkerRequest(foreign, options.batchLimits);
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
          options.transport.postMessage(
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
      const batch = normalizeBatchEnvelope(output, "operation result batch", options.batchLimits);
      const lease = leaseColumnarBatch(batch, options.batchLimits);
      await lease.transfer((transferMessage, transfer) => {
        options.transport.postMessage(
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
    if (isCancel(event.data)) {
      active.get(event.data.requestId)?.abort();
      return;
    }
    void run(event.data);
  };
  const onError = (): void => {
    for (const controller of active.values()) controller.abort();
  };
  options.transport.addEventListener("message", onMessage);
  options.transport.addEventListener("error", onError);

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
      options.transport.removeEventListener("message", onMessage);
      options.transport.removeEventListener("error", onError);
      for (const controller of active.values()) controller.abort();
      active.clear();
      options.transport.dispose();
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

function normalizeExecutionOptions(
  foreign: ExecuteColumnarWorkerOperationOptions,
): ExecuteColumnarWorkerOperationOptions {
  if (typeof foreign !== "object" || foreign === null) {
    throw new HonuaColumnarWorkerError("invalid-request", "Worker execution options must be an object");
  }
  const signal = foreign.signal;
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

function validateTransport(value: unknown): asserts value is ColumnarWorkerTransport {
  const transport = record(value, "worker transport");
  for (const method of ["postMessage", "addEventListener", "removeEventListener", "dispose"] as const) {
    if (typeof transport[method] !== "function")
      throw new HonuaColumnarWorkerError("worker-failed", `Worker transport.${method} must be a function`);
  }
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
