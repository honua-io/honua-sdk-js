import { type JsonValue, canonicalStringify, sha256 } from "../query-planner/index.js";
import { issueAgentExecutionReceipt, snapshotAgentExecutionInputs, verifyAgentStepAuthorization } from "./index.js";
import {
  AGENT_EXECUTION_AUDIT_KIND,
  AGENT_SAFETY_VERSION,
  type AgentApprovalUseConsumer,
  type AgentEffect,
  type AgentEnvelopeSigner,
  type AgentEnvelopeVerifier,
  type AgentExecutionAuditSinkV1,
  type AgentExecutionCompletedAuditV1,
  type AgentExecutionReceiptV1,
  type AgentExecutionStartedAuditV1,
  type AgentOperationExecutorV1,
  type AgentStepAuthorizationV1,
  type ExecuteAgentPlanStepOptions,
  type ExecutedAgentPlanStepV1,
  HonuaAgentExecutionError,
  HonuaAgentSafetyError,
} from "./types.js";

const MAX_RESULT_NODES = 8_192;
const MAX_RESULT_DEPTH = 32;
const MAX_RESULT_PROPERTIES = 128;
const MAX_RESULT_ENTRIES = 1_024;
const MAX_EXECUTION_ID_LENGTH = 128;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Consume and execute one exact approved step with durable, secret-safe audit
 * events and a signed outcome receipt. Executors never receive caller-owned
 * plan or operation objects.
 */
export async function executeAgentPlanStep(options: ExecuteAgentPlanStepOptions): Promise<ExecutedAgentPlanStepV1> {
  const host = snapshotExecutionHost(options);
  const inputs = snapshotAgentExecutionInputs(host.dryRun, host.policy, host.approval, host.context, host.operation, {
    signal: host.signal,
  });
  if (host.executor.tool !== inputs.operation.tool || host.executor.effect !== inputs.operation.effect) {
    throw new HonuaAgentExecutionError(
      "execution-failed",
      "the selected executor does not match the approved tool and effect",
      "authorization",
    );
  }
  const startedAt = timestamp(host.now?.() ?? new Date().toISOString(), "$options.now(start)");
  const authorization = await verifyAgentStepAuthorization(
    inputs.dryRun,
    inputs.policy,
    inputs.approval,
    host.approvalVerifier,
    inputs.context,
    host.stepId,
    inputs.operation,
    host.useConsumer,
    { signal: host.signal, now: startedAt, maxClockSkewMs: host.maxClockSkewMs },
  );

  const startedAudit = freeze({
    ...auditBinding(host.executionId, startedAt, authorization),
    phase: "started",
  } satisfies AgentExecutionStartedAuditV1);
  try {
    await host.auditSink.append(startedAudit, host.signal);
  } catch {
    throw new HonuaAgentExecutionError(
      "audit-failed",
      "approved operation was not executed because the durable start audit failed",
      "start-audit",
    );
  }

  let value: JsonValue | undefined;
  let rows = 0;
  let bytes = 0;
  let resultDigest: `sha256:${string}` | undefined;
  let outcome: "succeeded" | "failed" | "cancelled" = "succeeded";
  try {
    checkAbort(host.signal);
    const raw = await host.executor.execute(authorization.operation, authorization.step.limits, host.signal);
    checkAbort(host.signal);
    if (!raw || typeof raw !== "object") throw new TypeError("executor result must be an object");
    const rowsValue = dataProperty(raw, "rows", "executor result");
    const resultValue = dataProperty(raw, "value", "executor result");
    rows = safeCount(rowsValue, "executor result rows");
    if (rows > authorization.step.limits.rows) throw new RangeError("executor result exceeds approved row limit");
    value = snapshotResult(resultValue, authorization.step.limits.bytes);
    const canonical = canonicalStringify(value);
    bytes = new TextEncoder().encode(canonical).byteLength;
    if (bytes > authorization.step.limits.bytes) throw new RangeError("executor result exceeds approved byte limit");
    resultDigest = sha256(canonical);
  } catch {
    outcome = host.signal?.aborted ? "cancelled" : "failed";
    value = undefined;
    rows = 0;
    bytes = 0;
    resultDigest = undefined;
  }

  let completionClock: string;
  try {
    completionClock = timestamp(host.now?.() ?? new Date().toISOString(), "$options.now(completion)");
  } catch {
    const unreceiptedAudit = completedAudit(startedAudit, outcome, startedAt, rows, bytes, resultDigest);
    try {
      await host.auditSink.append(unreceiptedAudit);
    } catch {
      // The typed receipt failure still reports that recovery evidence is absent.
    }
    throw new HonuaAgentExecutionError(
      "receipt-failed",
      "operation outcome could not be timed or signed; terminal audit was attempted",
      "receipt",
    );
  }
  const completedAt = Date.parse(completionClock) < Date.parse(startedAt) ? startedAt : completionClock;
  const evidence = freeze({
    id: host.executionId,
    stepId: authorization.step.id,
    inputDigest: authorization.inputDigest,
    useDigest: authorization.useDigest,
    consumption: authorization.consumption,
    outcome,
    completedAt,
    rows,
    bytes,
    ...(resultDigest === undefined ? {} : { resultDigest }),
  } as const);

  let receipt: AgentExecutionReceiptV1;
  try {
    receipt = await issueAgentExecutionReceipt(
      inputs.dryRun,
      inputs.policy,
      inputs.approval,
      host.approvalVerifier,
      inputs.context,
      evidence,
      host.useConsumer,
      host.receiptSigner,
      { now: completedAt, maxClockSkewMs: host.maxClockSkewMs },
    );
  } catch {
    const unreceiptedAudit = completedAudit(startedAudit, outcome, completedAt, rows, bytes, resultDigest);
    try {
      await host.auditSink.append(unreceiptedAudit);
    } catch {
      // The typed receipt failure still reports that recovery evidence is absent.
    }
    throw new HonuaAgentExecutionError(
      "receipt-failed",
      "operation outcome could not be signed; terminal audit was attempted",
      "receipt",
    );
  }

  const terminalAudit = completedAudit(
    startedAudit,
    outcome,
    completedAt,
    rows,
    bytes,
    resultDigest,
    receipt.receiptDigest,
  );
  try {
    await host.auditSink.append(terminalAudit);
  } catch {
    throw new HonuaAgentExecutionError(
      "audit-failed",
      "operation outcome was signed but the durable terminal audit failed",
      "terminal-audit",
      receipt,
    );
  }

  if (outcome !== "succeeded") {
    throw new HonuaAgentExecutionError(
      outcome === "cancelled" ? "aborted" : "execution-failed",
      outcome === "cancelled" ? "approved operation was cancelled" : "approved operation failed",
      "execution",
      receipt,
    );
  }
  // Successful receipt issuance requires a result digest, so value is present.
  return freeze({ value: value as JsonValue, receipt, startedAudit, completedAudit: terminalAudit });
}

function auditBinding(executionId: string, recordedAt: string, authorization: AgentStepAuthorizationV1) {
  const { plan, step } = authorization;
  return {
    kind: AGENT_EXECUTION_AUDIT_KIND,
    version: AGENT_SAFETY_VERSION,
    executionId,
    recordedAt,
    planIdDigest: digestAuditText(plan.id),
    actorDigest: digestAuditText(plan.actor),
    ...(plan.provider === undefined ? {} : { providerDigest: digestAuditText(plan.provider) }),
    ...(plan.model === undefined ? {} : { modelDigest: digestAuditText(plan.model) }),
    stepIdDigest: digestAuditText(step.id),
    toolDigest: digestAuditText(step.tool),
    effect: step.effect,
    sourceIdDigest: digestAuditText(step.source.id),
    schemaVersionDigest: digestAuditText(step.source.schemaVersion),
    sourceVersionDigest: digestAuditText(step.source.sourceVersion),
    dataMode: step.source.provenance.dataMode,
    observedAt: step.source.provenance.observedAt,
    planDigest: authorization.planDigest,
    policyDigest: authorization.policyDigest,
    bindingsDigest: authorization.bindingsDigest,
    approvalDigest: authorization.approvalDigest,
    inputDigest: authorization.inputDigest,
    useDigest: authorization.useDigest,
  } as const;
}

function completedAudit(
  started: AgentExecutionStartedAuditV1,
  outcome: "succeeded" | "failed" | "cancelled",
  recordedAt: string,
  rows: number,
  bytes: number,
  resultDigest?: `sha256:${string}`,
  receiptDigest?: `sha256:${string}`,
): AgentExecutionCompletedAuditV1 {
  const { phase: _phase, ...binding } = started;
  return Object.freeze({
    ...binding,
    recordedAt,
    phase: "completed",
    outcome,
    rows,
    bytes,
    ...(resultDigest === undefined ? {} : { resultDigest }),
    ...(receiptDigest === undefined ? {} : { receiptDigest }),
  });
}

interface ExecutionHostSnapshot {
  readonly dryRun: unknown;
  readonly policy: unknown;
  readonly approval: unknown;
  readonly context: unknown;
  readonly stepId: unknown;
  readonly operation: unknown;
  readonly approvalVerifier: AgentEnvelopeVerifier;
  readonly useConsumer: AgentApprovalUseConsumer;
  readonly executor: AgentOperationExecutorV1;
  readonly auditSink: AgentExecutionAuditSinkV1;
  readonly receiptSigner: AgentEnvelopeSigner;
  readonly executionId: string;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
  readonly maxClockSkewMs?: number;
}

function snapshotExecutionHost(options: ExecuteAgentPlanStepOptions): ExecutionHostSnapshot {
  if (!options || typeof options !== "object" || Array.isArray(options)) invalid("execution options must be an object");
  const nowInput = optionalDataProperty(options, "now", "$options");
  if (nowInput !== undefined && typeof nowInput !== "function") invalid("$options.now must be a function");
  const signal = optionalDataProperty(options, "signal", "$options") as AbortSignal | undefined;
  const skew = optionalDataProperty(options, "maxClockSkewMs", "$options") as number | undefined;
  return Object.freeze({
    dryRun: dataProperty(options, "dryRun", "$options"),
    policy: dataProperty(options, "policy", "$options"),
    approval: dataProperty(options, "approval", "$options"),
    context: dataProperty(options, "context", "$options"),
    stepId: dataProperty(options, "stepId", "$options"),
    operation: dataProperty(options, "operation", "$options"),
    approvalVerifier: snapshotVerifier(dataProperty(options, "approvalVerifier", "$options")),
    useConsumer: snapshotUseConsumer(dataProperty(options, "useConsumer", "$options")),
    executor: snapshotExecutor(dataProperty(options, "executor", "$options")),
    auditSink: snapshotAuditSink(dataProperty(options, "auditSink", "$options")),
    receiptSigner: snapshotSigner(dataProperty(options, "receiptSigner", "$options")),
    executionId: parseExecutionId(dataProperty(options, "executionId", "$options")),
    ...(nowInput === undefined ? {} : { now: (nowInput as () => string).bind(options) }),
    ...(signal === undefined ? {} : { signal }),
    ...(skew === undefined ? {} : { maxClockSkewMs: skew }),
  });
}

function snapshotExecutor(input: unknown): AgentOperationExecutorV1 {
  assertCallbackOwner(input, "$executor");
  const tool = boundedHostText(dataProperty(input, "tool", "$executor"), "$executor.tool");
  const effect = dataProperty(input, "effect", "$executor");
  if (!(["read", "render", "mutation", "publish", "share", "realtime", "job"] as const).includes(effect as never))
    invalid("$executor.effect is invalid");
  return freeze({
    tool,
    effect: effect as AgentEffect,
    execute: boundCallback(input, "execute", "$executor") as AgentOperationExecutorV1["execute"],
  });
}

function snapshotAuditSink(input: unknown): AgentExecutionAuditSinkV1 {
  assertCallbackOwner(input, "$auditSink");
  return freeze({ append: boundCallback(input, "append", "$auditSink") as AgentExecutionAuditSinkV1["append"] });
}

function snapshotUseConsumer(input: unknown): AgentApprovalUseConsumer {
  assertCallbackOwner(input, "$useConsumer");
  return freeze({
    consume: boundCallback(input, "consume", "$useConsumer") as AgentApprovalUseConsumer["consume"],
    verify: boundCallback(input, "verify", "$useConsumer") as AgentApprovalUseConsumer["verify"],
  });
}

function snapshotVerifier(input: unknown): AgentEnvelopeVerifier {
  assertCallbackOwner(input, "$approvalVerifier");
  return freeze({
    algorithm: boundedHostText(dataProperty(input, "algorithm", "$approvalVerifier"), "$approvalVerifier.algorithm"),
    keyId: boundedHostText(dataProperty(input, "keyId", "$approvalVerifier"), "$approvalVerifier.keyId"),
    verify: boundCallback(input, "verify", "$approvalVerifier") as AgentEnvelopeVerifier["verify"],
  });
}

function snapshotSigner(input: unknown): AgentEnvelopeSigner {
  assertCallbackOwner(input, "$receiptSigner");
  return freeze({
    algorithm: boundedHostText(dataProperty(input, "algorithm", "$receiptSigner"), "$receiptSigner.algorithm"),
    keyId: boundedHostText(dataProperty(input, "keyId", "$receiptSigner"), "$receiptSigner.keyId"),
    sign: boundCallback(input, "sign", "$receiptSigner") as AgentEnvelopeSigner["sign"],
  });
}

function assertCallbackOwner(input: unknown, path: string): asserts input is object {
  if (!input || (typeof input !== "object" && typeof input !== "function")) invalid(`${path} must be an object`);
}

function boundCallback(input: object, key: string, path: string): (...args: never[]) => unknown {
  const callback = dataProperty(input, key, path);
  if (typeof callback !== "function") invalid(`${path}.${key} must be a function`);
  return callback.bind(input);
}

function boundedHostText(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 256 || hasControlCharacters(input))
    invalid(`${path} must be a bounded string without control characters`);
  return input;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function dataProperty(input: object, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  } catch {
    invalid(`${path}.${key} could not be safely captured`);
  }
  if (!descriptor) invalid(`${path}.${key} is required`);
  if (descriptor.get || descriptor.set) invalid(`${path}.${key} must not be an accessor`);
  return descriptor.value;
}

function optionalDataProperty(input: object, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  } catch {
    invalid(`${path}.${key} could not be safely captured`);
  }
  if (!descriptor) return undefined;
  if (descriptor.get || descriptor.set) invalid(`${path}.${key} must not be an accessor`);
  return descriptor.value;
}

function parseExecutionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EXECUTION_ID_LENGTH ||
    !EXECUTION_ID.test(value)
  )
    invalid("executionId must be a bounded, non-secret identifier");
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    invalid(`${path} must be a canonical ISO-8601 timestamp`);
  return value;
}

function safeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a safe integer`);
  return value as number;
}

function snapshotResult(input: unknown, maxBytes: number): JsonValue {
  const budget = { nodes: 0, estimatedBytes: 0, maxBytes };
  return freeze(snapshot(input, "$result", budget, 0, new WeakSet<object>()));
}

function snapshot(
  value: unknown,
  path: string,
  budget: { nodes: number; estimatedBytes: number; readonly maxBytes: number },
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_RESULT_NODES || depth > MAX_RESULT_DEPTH)
    throw new RangeError("executor result is too complex");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    budget.estimatedBytes += new TextEncoder().encode(value).byteLength;
    if (budget.estimatedBytes > budget.maxBytes) throw new RangeError("executor result exceeds approved byte limit");
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} is not JSON-compatible`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
  let prototype: object | null;
  try {
    prototype = Reflect.getPrototypeOf(value);
  } catch {
    throw new TypeError(`${path} could not be safely inspected`);
  }
  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${path} must contain plain JSON values`);
  ancestors.add(value);
  if (isArray) {
    const length = safeCount(dataProperty(value, "length", path), `${path} length`);
    if (length > MAX_RESULT_ENTRIES) throw new RangeError(`${path} exceeds the array limit`);
    const result: JsonValue[] = [];
    for (let index = 0; index < length; index++) {
      const entry = dataProperty(value, String(index), path);
      result.push(snapshot(entry, `${path}[${index}]`, budget, depth + 1, ancestors));
    }
    ancestors.delete(value);
    return result;
  }
  const entries: Array<readonly [string, unknown]> = [];
  try {
    for (const key in value) {
      if (entries.length >= MAX_RESULT_PROPERTIES) throw new RangeError(`${path} exceeds the property limit`);
      entries.push([key, dataProperty(value, key, path)] as const);
    }
  } catch (error) {
    if (error instanceof HonuaAgentSafetyError || error instanceof RangeError || error instanceof TypeError)
      throw error;
    throw new TypeError(`${path} could not be safely inspected`);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const [key, entry] of entries) {
    budget.estimatedBytes += new TextEncoder().encode(key).byteLength;
    if (budget.estimatedBytes > budget.maxBytes) throw new RangeError("executor result exceeds approved byte limit");
    Object.defineProperty(result, key, {
      value: snapshot(entry, `${path}.${key}`, budget, depth + 1, ancestors),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(value);
  return result;
}

function digestAuditText(value: string): `sha256:${string}` {
  return sha256(canonicalStringify(value));
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HonuaAgentSafetyError("aborted", "agent execution was aborted");
}

function invalid(message: string): never {
  throw new HonuaAgentSafetyError("invalid-input", message);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
