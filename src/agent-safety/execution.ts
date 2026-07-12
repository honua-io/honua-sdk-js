import { type JsonValue, canonicalStringify, sha256 } from "../query-planner/index.js";
import { issueAgentExecutionReceipt, verifyAgentStepAuthorization } from "./index.js";
import {
  AGENT_EXECUTION_AUDIT_KIND,
  AGENT_SAFETY_VERSION,
  type AgentExecutionCompletedAuditV1,
  type AgentExecutionReceiptV1,
  type AgentExecutionStartedAuditV1,
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
  validateHostCallbacks(options);
  const executionId = parseExecutionId(options.executionId);
  const startedAt = timestamp(options.now?.() ?? new Date().toISOString(), "$options.now(start)");
  const authorization = await verifyAgentStepAuthorization(
    options.dryRun,
    options.policy,
    options.approval,
    options.approvalVerifier,
    options.context,
    options.stepId,
    options.operation,
    options.useConsumer,
    { signal: options.signal, now: startedAt, maxClockSkewMs: options.maxClockSkewMs },
  );

  if (
    options.executor.tool !== authorization.operation.tool ||
    options.executor.effect !== authorization.operation.effect
  ) {
    throw new HonuaAgentExecutionError(
      "execution-failed",
      "the selected executor does not match the approved tool and effect",
      "authorization",
    );
  }

  const startedAudit = freeze({
    ...auditBinding(executionId, startedAt, authorization),
    phase: "started",
  } satisfies AgentExecutionStartedAuditV1);
  try {
    await options.auditSink.append(startedAudit, options.signal);
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
    checkAbort(options.signal);
    const raw = await options.executor.execute(authorization.operation, authorization.step.limits, options.signal);
    checkAbort(options.signal);
    if (!raw || typeof raw !== "object") throw new TypeError("executor result must be an object");
    const resultDescriptors = Object.getOwnPropertyDescriptors(raw);
    if (
      Object.keys(resultDescriptors).some((key) => key !== "rows" && key !== "value") ||
      !Object.hasOwn(resultDescriptors, "rows") ||
      !Object.hasOwn(resultDescriptors, "value") ||
      resultDescriptors.rows?.get ||
      resultDescriptors.rows?.set ||
      resultDescriptors.value?.get ||
      resultDescriptors.value?.set
    )
      throw new TypeError("executor result must contain only data properties rows and value");
    rows = safeCount(resultDescriptors.rows.value, "executor result rows");
    if (rows > authorization.step.limits.rows) throw new RangeError("executor result exceeds approved row limit");
    value = snapshotResult(resultDescriptors.value.value, authorization.step.limits.bytes);
    const canonical = canonicalStringify(value);
    bytes = new TextEncoder().encode(canonical).byteLength;
    if (bytes > authorization.step.limits.bytes) throw new RangeError("executor result exceeds approved byte limit");
    resultDigest = sha256(canonical);
  } catch {
    outcome = options.signal?.aborted ? "cancelled" : "failed";
    value = undefined;
    rows = 0;
    bytes = 0;
    resultDigest = undefined;
  }

  let completionClock: string;
  try {
    completionClock = timestamp(options.now?.() ?? new Date().toISOString(), "$options.now(completion)");
  } catch {
    const unreceiptedAudit = completedAudit(startedAudit, outcome, startedAt, rows, bytes, resultDigest);
    try {
      await options.auditSink.append(unreceiptedAudit);
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
    id: executionId,
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
      options.dryRun,
      options.policy,
      options.approval,
      options.approvalVerifier,
      options.context,
      evidence,
      options.useConsumer,
      options.receiptSigner,
      { now: completedAt, maxClockSkewMs: options.maxClockSkewMs },
    );
  } catch {
    const unreceiptedAudit = completedAudit(startedAudit, outcome, completedAt, rows, bytes, resultDigest);
    try {
      await options.auditSink.append(unreceiptedAudit);
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
    await options.auditSink.append(terminalAudit);
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
    planId: plan.id,
    actor: plan.actor,
    ...(plan.provider === undefined ? {} : { provider: plan.provider }),
    ...(plan.model === undefined ? {} : { model: plan.model }),
    stepId: step.id,
    tool: step.tool,
    effect: step.effect,
    sourceId: step.source.id,
    schemaVersion: step.source.schemaVersion,
    sourceVersion: step.source.sourceVersion,
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
  return freeze({
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

function validateHostCallbacks(options: ExecuteAgentPlanStepOptions): void {
  if (!options.executor || typeof options.executor.execute !== "function") invalid("executor.execute is required");
  if (typeof options.executor.tool !== "string" || typeof options.executor.effect !== "string")
    invalid("executor tool and effect are required");
  if (!options.auditSink || typeof options.auditSink.append !== "function") invalid("auditSink.append is required");
  if (options.now !== undefined && typeof options.now !== "function") invalid("now must be a function");
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
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
    throw new TypeError(`${path} must contain plain JSON values`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol"))
    throw new TypeError(`${path} must not contain symbol keys`);
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get || descriptor.set) throw new TypeError(`${path} must not contain accessors`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (
      value.length > MAX_RESULT_ENTRIES ||
      Object.keys(descriptors).some((key) => key !== "length" && !/^\d+$/.test(key))
    )
      throw new RangeError(`${path} exceeds the array limit or contains named properties`);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(descriptors, String(index))) throw new TypeError(`${path} must be dense`);
      result.push(snapshot(descriptors[String(index)]?.value, `${path}[${index}]`, budget, depth + 1, ancestors));
    }
    ancestors.delete(value);
    return result;
  }
  const keys = Object.keys(descriptors).sort();
  if (keys.length > MAX_RESULT_PROPERTIES) throw new RangeError(`${path} exceeds the property limit`);
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of keys) {
    budget.estimatedBytes += new TextEncoder().encode(key).byteLength;
    if (budget.estimatedBytes > budget.maxBytes) throw new RangeError("executor result exceeds approved byte limit");
    Object.defineProperty(result, key, {
      value: snapshot(descriptors[key]?.value, `${path}.${key}`, budget, depth + 1, ancestors),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(value);
  return result;
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
