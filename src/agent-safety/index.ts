/**
 * Deterministic safety boundary for JSON-compatible agent plans.
 *
 * This module never invokes a model, tool, source, renderer, or job. Dry runs
 * are side-effect free. Cryptographic operations and the atomic single-use
 * replay store are delegated to host-provided callbacks so key custody and
 * persistence stay outside the SDK.
 *
 * @experimental
 * @packageDocumentation
 */

import { type JsonValue, canonicalStringify, sha256, toJsonValue } from "../query-planner/index.js";
import {
  AGENT_APPROVAL_KIND,
  AGENT_DRY_RUN_KIND,
  AGENT_PLAN_KIND,
  AGENT_RECEIPT_KIND,
  AGENT_SAFETY_VERSION,
  type AgentApprovalRequestV1,
  type AgentApprovalUseConsumer,
  type AgentApprovalV1,
  type AgentDataMode,
  type AgentDigest,
  type AgentDryRunV1,
  type AgentEffect,
  type AgentEffectBudgetV1,
  type AgentEnvelopeSigner,
  type AgentEnvelopeVerifier,
  type AgentExecutionContextV1,
  type AgentExecutionEvidenceV1,
  type AgentExecutionReceiptV1,
  type AgentOperationInputV1,
  type AgentPlanPolicyV1,
  type AgentPlanStepV1,
  type AgentPlanV1,
  type AgentProvenanceV1,
  type AgentSafetyOptions,
  type AgentSourceBindingV1,
  type AgentSourcePolicyV1,
  type AgentStepAuthorizationV1,
  HonuaAgentSafetyError,
} from "./types.js";

export {
  AGENT_APPROVAL_KIND,
  AGENT_DRY_RUN_KIND,
  AGENT_PLAN_KIND,
  AGENT_RECEIPT_KIND,
  AGENT_SAFETY_VERSION,
  HonuaAgentSafetyError,
} from "./types.js";
export type {
  AgentApprovalRequestV1,
  AgentApprovalUseConsumer,
  AgentApprovalV1,
  AgentApprovedStepV1,
  AgentCitationV1,
  AgentDataMode,
  AgentDigest,
  AgentDryRunV1,
  AgentEffect,
  AgentEffectBudgetV1,
  AgentEnvelopeSigner,
  AgentEnvelopeVerifier,
  AgentExecutionContextV1,
  AgentExecutionEvidenceV1,
  AgentExecutionReceiptV1,
  AgentPlanPolicyV1,
  AgentPlanStepV1,
  AgentPlanV1,
  AgentOperationInputV1,
  AgentProvenanceV1,
  AgentQueryPlanBindingV1,
  AgentSafetyErrorCode,
  AgentSafetyOptions,
  AgentSourceBindingV1,
  AgentSourcePolicyV1,
  AgentStepAuthorizationV1,
} from "./types.js";

const EFFECTS = ["read", "render", "mutation", "publish", "share", "realtime", "job"] as const;
const DATA_MODES = ["cached", "offline", "replayed", "live"] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SENSITIVE_QUERY_KEY = /(?:token|key|signature|credential|password|secret|auth)/i;

/**
 * Validate and snapshot a JSON-compatible plan, returning an immutable dry run.
 * JavaScript Proxies are not valid input because reflection traps are executable.
 */
export function dryRunAgentPlan(input: unknown, policyInput: unknown, options: AgentSafetyOptions = {}): AgentDryRunV1 {
  checkAbort(options.signal);
  const policy = parsePolicy(policyInput);
  // Snapshot and freeze authority before inspecting the untrusted proposal.
  const plan = parsePlan(input);
  const evaluatedAt = parseIso(options.now ?? new Date().toISOString(), "$options.now");
  const effectBudget = validatePolicy(plan, policy, evaluatedAt);
  const bindings = uniqueBindings(plan.steps);
  const dryRun = {
    kind: AGENT_DRY_RUN_KIND,
    version: AGENT_SAFETY_VERSION,
    evaluatedAt,
    plan,
    planDigest: digest(plan),
    policyDigest: digest(policy),
    bindingsDigest: digest(bindings),
    effectBudget,
  } satisfies AgentDryRunV1;
  checkAbort(options.signal);
  return deepFreeze(dryRun);
}

/** Canonical identity for the exact parameters a host proposes to execute. */
export function digestAgentOperationInput(input: unknown): AgentDigest {
  return parseOperationInput(input).inputDigest;
}

/**
 * Verify approval and return the exact step only when the proposed operation
 * parameters match the digest reviewed in the plan.
 */
export async function verifyAgentStepAuthorization(
  dryRunInput: unknown,
  policyInput: unknown,
  approvalInput: unknown,
  verifier: AgentEnvelopeVerifier,
  contextInput: unknown,
  stepIdInput: unknown,
  operationInput: unknown,
  useConsumer: AgentApprovalUseConsumer,
  options: AgentSafetyOptions = {},
): Promise<AgentStepAuthorizationV1> {
  const dryRun = revalidateDryRun(dryRunInput, policyInput, options);
  const approval = await verifyAgentApproval(dryRun, policyInput, approvalInput, verifier, contextInput, options);
  const stepId = text(stepIdInput, "$stepId");
  const step = dryRun.plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) fail("policy-denied", `step ${stepId} is not in the approved plan`);
  const operation = parseOperationInput(operationInput);
  const inputDigest = operation.inputDigest;
  if (inputDigest !== step.inputDigest) {
    fail("integrity-failed", `operation input does not match approved step ${stepId}`);
  }
  checkAbort(options.signal);
  if (!useConsumer || typeof useConsumer.consume !== "function") invalid("useConsumer.consume must be a function");
  checkAbort(options.signal);
  const consumed = await useConsumer.consume(
    { approvalDigest: approval.envelopeDigest, stepId, inputDigest },
    options.signal,
  );
  checkAbort(options.signal);
  if (consumed !== true) fail("policy-denied", `approval use for step ${stepId} was already consumed`);
  const approvedStep = approval.steps.find((candidate) => candidate.id === stepId);
  if (!approvedStep) fail("integrity-failed", `approval is missing step ${stepId}`);
  const useDigest = digest({ approvalDigest: approval.envelopeDigest, stepId, inputDigest });
  return deepFreeze({
    step: { ...step, limits: { rows: approvedStep.rows, bytes: approvedStep.bytes } },
    operation: operation.input,
    planDigest: dryRun.planDigest,
    approvalDigest: approval.envelopeDigest,
    inputDigest,
    useDigest,
  });
}

/** Sign an exact validated plan and a budget that may narrow, never widen, it. */
export async function issueAgentApproval(
  dryRunInput: unknown,
  policyInput: unknown,
  requestInput: unknown,
  signer: AgentEnvelopeSigner,
  options: AgentSafetyOptions = {},
): Promise<AgentApprovalV1> {
  checkAbort(options.signal);
  const dryRun = revalidateDryRun(dryRunInput, policyInput, options);
  const request = parseApprovalRequest(requestInput);
  if (dryRun.plan.steps.length > 1 && (request.maxRows !== undefined || request.maxBytes !== undefined))
    fail("invalid-input", "multi-step approval narrowing requires explicit stepLimits");
  const requestedStepIds = new Set(Object.keys(request.stepLimits ?? {}));
  const approvedSteps = dryRun.plan.steps.map((step) => {
    requestedStepIds.delete(step.id);
    const requested = request.stepLimits?.[step.id];
    const rows = requested?.rows ?? (dryRun.plan.steps.length === 1 ? request.maxRows : undefined) ?? step.limits.rows;
    const bytes =
      requested?.bytes ?? (dryRun.plan.steps.length === 1 ? request.maxBytes : undefined) ?? step.limits.bytes;
    if (rows > step.limits.rows || bytes > step.limits.bytes)
      fail("policy-denied", `approval limits must not widen step ${step.id}`);
    return deepFreeze({ id: step.id, inputDigest: step.inputDigest, rows, bytes });
  });
  if (requestedStepIds.size > 0) invalid(`stepLimits contains unknown step ${[...requestedStepIds][0]}`);
  const approvedRows = approvedSteps.reduce((total, step) => safeAdd(total, step.rows, "approved row budget"), 0);
  const approvedBytes = approvedSteps.reduce((total, step) => safeAdd(total, step.bytes, "approved byte budget"), 0);
  if (Date.parse(request.expiresAt) <= Date.parse(request.issuedAt)) {
    fail("invalid-input", "approval expiresAt must be later than issuedAt");
  }
  if (Date.parse(request.issuedAt) < Date.parse(dryRun.evaluatedAt)) {
    fail("invalid-input", "approval issuedAt must not predate dry-run evaluation");
  }
  const identity = parseSignerIdentity(signer);
  const unsigned = {
    kind: AGENT_APPROVAL_KIND,
    version: AGENT_SAFETY_VERSION,
    id: request.id,
    approver: request.approver,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    evaluatedAt: dryRun.evaluatedAt,
    use: "single" as const,
    planDigest: dryRun.planDigest,
    policyDigest: dryRun.policyDigest,
    bindingsDigest: dryRun.bindingsDigest,
    approvedRows,
    approvedBytes,
    steps: approvedSteps,
    ...identity,
  } as const;
  const payload = canonical(unsigned);
  checkAbort(options.signal);
  const signature = await signer.sign(payload, options.signal);
  checkAbort(options.signal);
  const envelope = {
    ...unsigned,
    envelopeDigest: sha256(payload),
    signature: parseSignature(signature),
  } satisfies AgentApprovalV1;
  return deepFreeze(envelope);
}

/**
 * Verify approval integrity, signature, expiry, exact policy, and live source
 * context before a host chooses to perform any effect.
 */
export async function verifyAgentApproval(
  dryRunInput: unknown,
  policyInput: unknown,
  approvalInput: unknown,
  verifier: AgentEnvelopeVerifier,
  contextInput: unknown,
  options: AgentSafetyOptions = {},
): Promise<AgentApprovalV1> {
  checkAbort(options.signal);
  const dryRun = revalidateDryRun(dryRunInput, policyInput, options);
  const approval = parseApproval(approvalInput);
  assertApprovalBinding(dryRun, approval, options.now);
  // Re-run time-sensitive policy checks at authorization time. Integrity was
  // evaluated at dry-run time; freshness is an execution-time property.
  validatePolicy(dryRun.plan, parsePolicy(policyInput), options.now);
  validateContext(dryRun, contextInput);
  const identity = parseVerifierIdentity(verifier);
  if (approval.algorithm !== identity.algorithm || approval.keyId !== identity.keyId) {
    fail("signature-invalid", "approval signer identity does not match the configured verifier");
  }
  const payload = canonical(unsignedApproval(approval));
  if (approval.envelopeDigest !== sha256(payload)) fail("integrity-failed", "approval envelope digest mismatch");
  checkAbort(options.signal);
  if ((await verifier.verify(payload, approval.signature, options.signal)) !== true) {
    fail("signature-invalid", "approval signature verification failed");
  }
  checkAbort(options.signal);
  return approval;
}

/** Create signed outcome evidence without invoking the approved operation. */
export async function issueAgentExecutionReceipt(
  dryRunInput: unknown,
  policyInput: unknown,
  approvalInput: unknown,
  approvalVerifier: AgentEnvelopeVerifier,
  contextInput: unknown,
  evidenceInput: unknown,
  receiptSigner: AgentEnvelopeSigner,
  options: AgentSafetyOptions = {},
): Promise<AgentExecutionReceiptV1> {
  checkAbort(options.signal);
  const evidence = parseEvidence(evidenceInput);
  const receiptClock = parseIso(options.now ?? new Date().toISOString(), "$options.now");
  if (Date.parse(evidence.completedAt) > Date.parse(receiptClock)) {
    fail("invalid-input", "receipt completedAt must not be in the future");
  }
  const dryRun = revalidateDryRun(dryRunInput, policyInput, options);
  const approval = await verifyAgentApproval(dryRun, policyInput, approvalInput, approvalVerifier, contextInput, {
    ...options,
    now: evidence.completedAt,
  });
  validateReceiptOperation(evidence, dryRun, approval);
  if (evidence.outcome === "succeeded" && !evidence.resultDigest) {
    fail("invalid-input", "successful execution evidence requires resultDigest");
  }
  if (Date.parse(evidence.completedAt) < Date.parse(approval.issuedAt)) {
    fail("invalid-input", "receipt completedAt must not predate approval issuance");
  }
  if (Date.parse(evidence.completedAt) >= Date.parse(approval.expiresAt)) {
    fail("approval-expired", "execution evidence completed after approval expiry");
  }
  const identity = parseSignerIdentity(receiptSigner);
  const unsigned = {
    kind: AGENT_RECEIPT_KIND,
    version: AGENT_SAFETY_VERSION,
    ...evidence,
    planDigest: dryRun.planDigest,
    policyDigest: dryRun.policyDigest,
    bindingsDigest: dryRun.bindingsDigest,
    approvalDigest: approval.envelopeDigest,
    ...identity,
  } as const;
  const payload = canonical(unsigned);
  checkAbort(options.signal);
  const signature = await receiptSigner.sign(payload, options.signal);
  checkAbort(options.signal);
  return deepFreeze({ ...unsigned, receiptDigest: sha256(payload), signature: parseSignature(signature) });
}

/** Deterministically verify a receipt and both signatures against current context. */
export async function verifyAgentExecutionReceipt(
  dryRunInput: unknown,
  policyInput: unknown,
  approvalInput: unknown,
  approvalVerifier: AgentEnvelopeVerifier,
  contextInput: unknown,
  receiptInput: unknown,
  receiptVerifier: AgentEnvelopeVerifier,
  options: AgentSafetyOptions = {},
): Promise<AgentExecutionReceiptV1> {
  checkAbort(options.signal);
  const receipt = parseReceipt(receiptInput);
  const receiptClock = parseIso(options.now ?? new Date().toISOString(), "$options.now");
  if (Date.parse(receipt.completedAt) > Date.parse(receiptClock)) {
    fail("invalid-input", "receipt completedAt must not be in the future");
  }
  const dryRun = revalidateDryRun(dryRunInput, policyInput, options);
  const approval = await verifyAgentApproval(dryRun, policyInput, approvalInput, approvalVerifier, contextInput, {
    ...options,
    now: receipt.completedAt,
  });
  if (
    receipt.planDigest !== dryRun.planDigest ||
    receipt.policyDigest !== dryRun.policyDigest ||
    receipt.bindingsDigest !== dryRun.bindingsDigest ||
    receipt.approvalDigest !== approval.envelopeDigest
  ) {
    fail("integrity-failed", "receipt is not bound to the supplied plan, policy, context, and approval");
  }
  validateReceiptOperation(receipt, dryRun, approval);
  if (receipt.outcome === "succeeded" && !receipt.resultDigest) {
    fail("invalid-input", "successful receipt requires resultDigest");
  }
  const identity = parseVerifierIdentity(receiptVerifier);
  if (receipt.algorithm !== identity.algorithm || receipt.keyId !== identity.keyId) {
    fail("signature-invalid", "receipt signer identity does not match the configured verifier");
  }
  const payload = canonical(unsignedReceipt(receipt));
  if (receipt.receiptDigest !== sha256(payload)) fail("integrity-failed", "receipt digest mismatch");
  checkAbort(options.signal);
  if ((await receiptVerifier.verify(payload, receipt.signature, options.signal)) !== true) {
    fail("signature-invalid", "receipt signature verification failed");
  }
  checkAbort(options.signal);
  return receipt;
}

function validateReceiptOperation(
  evidence: Pick<AgentExecutionEvidenceV1, "stepId" | "inputDigest" | "useDigest" | "rows" | "bytes">,
  dryRun: AgentDryRunV1,
  approval: AgentApprovalV1,
): void {
  const step = dryRun.plan.steps.find((candidate) => candidate.id === evidence.stepId);
  const approved = approval.steps.find((candidate) => candidate.id === evidence.stepId);
  if (!step || !approved || evidence.inputDigest !== step.inputDigest || evidence.inputDigest !== approved.inputDigest)
    fail("integrity-failed", `receipt operation binding mismatch for ${evidence.stepId}`);
  const expectedUseDigest = digest({
    approvalDigest: approval.envelopeDigest,
    stepId: evidence.stepId,
    inputDigest: evidence.inputDigest,
  });
  if (evidence.useDigest !== expectedUseDigest) fail("integrity-failed", "receipt approval-use digest mismatch");
  if (evidence.rows > approved.rows || evidence.bytes > approved.bytes)
    fail("policy-denied", `receipt exceeds the approved budget for step ${evidence.stepId}`);
}

function revalidateDryRun(input: unknown, policy: unknown, options: AgentSafetyOptions): AgentDryRunV1 {
  const record = object(input, "$dryRun", [
    "kind",
    "version",
    "evaluatedAt",
    "plan",
    "planDigest",
    "policyDigest",
    "bindingsDigest",
    "effectBudget",
  ]);
  literal(record.kind, AGENT_DRY_RUN_KIND, "$dryRun.kind");
  literal(record.version, AGENT_SAFETY_VERSION, "$dryRun.version");
  const evaluatedAt = parseIso(record.evaluatedAt, "$dryRun.evaluatedAt");
  const expected = dryRunAgentPlan(record.plan, policy, { ...options, now: evaluatedAt });
  if (
    record.planDigest !== expected.planDigest ||
    record.policyDigest !== expected.policyDigest ||
    record.bindingsDigest !== expected.bindingsDigest ||
    record.evaluatedAt !== expected.evaluatedAt ||
    digest(record.effectBudget) !== digest(expected.effectBudget)
  ) {
    fail("integrity-failed", "dry-run digest or effect budget mismatch");
  }
  return expected;
}

function validatePolicy(plan: AgentPlanV1, policy: AgentPlanPolicyV1, now?: string): AgentEffectBudgetV1 {
  if (plan.steps.length > policy.maxSteps) fail("policy-denied", "plan exceeds the maximum step count");
  const allowedEffects = new Set(policy.allowedEffects ?? ["read"]);
  const tools = new Set(policy.allowedTools);
  const byEffect = Object.fromEntries(EFFECTS.map((effect) => [effect, 0])) as Record<AgentEffect, number>;
  let rows = 0;
  let bytes = 0;
  for (const step of plan.steps) {
    if (!tools.has(step.tool)) fail("policy-denied", `tool ${step.tool} is not allowed`);
    if (!allowedEffects.has(step.effect)) fail("policy-denied", `effect ${step.effect} is not allowed`);
    const sourcePolicy = policy.sources[step.source.id];
    if (!sourcePolicy) fail("policy-denied", `source ${step.source.id} is not allowed`);
    assertSubset(step.fields, sourcePolicy.fields, `fields for ${step.source.id}`);
    assertSubset(
      step.source.authorizationScope,
      sourcePolicy.authorizationScope,
      `authorization scope for ${step.source.id}`,
    );
    if (sourcePolicy.schemaVersions && !sourcePolicy.schemaVersions.includes(step.source.schemaVersion))
      fail("policy-denied", `schema version for ${step.source.id} is not allowed`);
    if (sourcePolicy.sourceVersions && !sourcePolicy.sourceVersions.includes(step.source.sourceVersion))
      fail("policy-denied", `source version for ${step.source.id} is not allowed`);
    if (sourcePolicy.dataModes && !sourcePolicy.dataModes.includes(step.source.provenance.dataMode))
      fail("policy-denied", `data mode for ${step.source.id} is not allowed`);
    if (sourcePolicy.maxProvenanceAgeMs !== undefined) {
      const reference = parseIso(now ?? new Date().toISOString(), "$options.now");
      const age = Date.parse(reference) - Date.parse(step.source.provenance.observedAt);
      if (age < 0 || age > sourcePolicy.maxProvenanceAgeMs)
        fail("policy-denied", `provenance freshness for ${step.source.id} is outside policy`);
    }
    rows = safeAdd(rows, step.limits.rows, "row budget");
    bytes = safeAdd(bytes, step.limits.bytes, "byte budget");
    byEffect[step.effect] += 1;
  }
  if (rows > policy.maxRows || bytes > policy.maxBytes)
    fail("policy-denied", "plan exceeds the total row or byte budget");
  return deepFreeze({ steps: plan.steps.length, rows, bytes, byEffect });
}

function validateContext(dryRun: AgentDryRunV1, input: unknown): AgentExecutionContextV1 {
  const record = object(input, "$context", ["sources"]);
  const sourcesInput = object(record.sources, "$context.sources");
  const sources: Record<string, AgentSourceBindingV1> = {};
  const expected = uniqueBindings(dryRun.plan.steps);
  if (Object.keys(sourcesInput).length !== expected.length)
    fail("context-mismatch", "current source set differs from plan");
  for (const binding of expected) {
    const current = parseSourceBinding(sourcesInput[binding.id], `$context.sources.${binding.id}`);
    if (digest(current) !== digest(binding)) fail("context-mismatch", `source context changed for ${binding.id}`);
    sources[binding.id] = current;
  }
  return deepFreeze({ sources });
}

function assertApprovalBinding(dryRun: AgentDryRunV1, approval: AgentApprovalV1, now?: string): void {
  if (
    approval.planDigest !== dryRun.planDigest ||
    approval.policyDigest !== dryRun.policyDigest ||
    approval.bindingsDigest !== dryRun.bindingsDigest
  )
    fail("integrity-failed", "approval is not bound to the supplied dry run");
  if (approval.evaluatedAt !== dryRun.evaluatedAt)
    fail("integrity-failed", "approval is not bound to the dry-run evaluation time");
  if (approval.steps.length !== dryRun.plan.steps.length)
    fail("integrity-failed", "approval step set differs from the dry run");
  let approvedRows = 0;
  let approvedBytes = 0;
  for (const planStep of dryRun.plan.steps) {
    const approved = approval.steps.find((step) => step.id === planStep.id);
    if (!approved || approved.inputDigest !== planStep.inputDigest)
      fail("integrity-failed", `approval step binding mismatch for ${planStep.id}`);
    if (approved.rows > planStep.limits.rows || approved.bytes > planStep.limits.bytes)
      fail("policy-denied", `approval widens step ${planStep.id}`);
    approvedRows = safeAdd(approvedRows, approved.rows, "approved row budget");
    approvedBytes = safeAdd(approvedBytes, approved.bytes, "approved byte budget");
  }
  if (approvedRows !== approval.approvedRows || approvedBytes !== approval.approvedBytes)
    fail("integrity-failed", "approval aggregate budget does not match its step budgets");
  const clock = parseIso(now ?? new Date().toISOString(), "$options.now");
  if (Date.parse(clock) >= Date.parse(approval.expiresAt)) fail("approval-expired", "approval has expired");
  if (Date.parse(clock) < Date.parse(approval.issuedAt)) fail("invalid-input", "approval is not yet valid");
}

function parsePlan(input: unknown): AgentPlanV1 {
  const record = object(input, "$plan", ["kind", "version", "id", "actor", "provider", "model", "steps"]);
  literal(record.kind, AGENT_PLAN_KIND, "$plan.kind");
  literal(record.version, AGENT_SAFETY_VERSION, "$plan.version");
  const steps = array(record.steps, "$plan.steps").map((entry, index) => parseStep(entry, `$plan.steps[${index}]`));
  if (steps.length === 0) invalid("$plan.steps must not be empty");
  unique(
    steps.map((step) => step.id),
    "$plan.steps ids",
  );
  return deepFreeze({
    kind: AGENT_PLAN_KIND,
    version: AGENT_SAFETY_VERSION,
    id: text(record.id, "$plan.id"),
    actor: text(record.actor, "$plan.actor"),
    ...(record.provider === undefined ? {} : { provider: text(record.provider, "$plan.provider") }),
    ...(record.model === undefined ? {} : { model: text(record.model, "$plan.model") }),
    steps,
  });
}

function parseStep(input: unknown, path: string): AgentPlanStepV1 {
  const record = object(input, path, [
    "id",
    "tool",
    "effect",
    "source",
    "queryPlan",
    "parametersDigest",
    "inputDigest",
    "fields",
    "limits",
  ]);
  const queryPlan = object(record.queryPlan, `${path}.queryPlan`, ["id", "fingerprint"]);
  const limits = object(record.limits, `${path}.limits`, ["rows", "bytes"]);
  const fields = stringList(record.fields, `${path}.fields`, false);
  const tool = text(record.tool, `${path}.tool`);
  const effect = oneOf(record.effect, EFFECTS, `${path}.effect`);
  const source = parseSourceBinding(record.source, `${path}.source`);
  const parsedQueryPlan = {
    id: text(queryPlan.id, `${path}.queryPlan.id`),
    fingerprint: parseDigest(queryPlan.fingerprint, `${path}.queryPlan.fingerprint`),
  } as const;
  const parametersDigest = parseDigest(record.parametersDigest, `${path}.parametersDigest`);
  const expectedInputDigest = operationIdentityDigest({
    tool,
    effect,
    sourceId: source.id,
    queryPlan: parsedQueryPlan,
    fields,
    parametersDigest,
  });
  const inputDigest = parseDigest(record.inputDigest, `${path}.inputDigest`);
  if (inputDigest !== expectedInputDigest) invalid(`${path}.inputDigest does not match the visible operation identity`);
  return deepFreeze({
    id: text(record.id, `${path}.id`),
    tool,
    effect,
    source,
    queryPlan: parsedQueryPlan,
    parametersDigest,
    inputDigest,
    fields,
    limits: {
      rows: integer(record.limits === undefined ? undefined : limits.rows, `${path}.limits.rows`, 0),
      bytes: integer(record.limits === undefined ? undefined : limits.bytes, `${path}.limits.bytes`, 0),
    },
  });
}

function parseOperationInput(input: unknown): {
  readonly input: AgentOperationInputV1;
  readonly inputDigest: AgentDigest;
} {
  const record = object(input, "$operation", ["tool", "effect", "sourceId", "queryPlan", "fields", "parameters"]);
  const queryPlan = object(record.queryPlan, "$operation.queryPlan", ["id", "fingerprint"]);
  const parsed = deepFreeze({
    tool: text(record.tool, "$operation.tool"),
    effect: oneOf(record.effect, EFFECTS, "$operation.effect"),
    sourceId: text(record.sourceId, "$operation.sourceId"),
    queryPlan: {
      id: text(queryPlan.id, "$operation.queryPlan.id"),
      fingerprint: parseDigest(queryPlan.fingerprint, "$operation.queryPlan.fingerprint"),
    },
    fields: stringList(record.fields, "$operation.fields", false),
    parameters: snapshotJson(record.parameters, "$operation.parameters", new WeakSet<object>()),
  } satisfies AgentOperationInputV1);
  const parametersDigest = digest(parsed.parameters);
  return deepFreeze({
    input: parsed,
    inputDigest: operationIdentityDigest({
      tool: parsed.tool,
      effect: parsed.effect,
      sourceId: parsed.sourceId,
      queryPlan: parsed.queryPlan,
      fields: parsed.fields,
      parametersDigest,
    }),
  });
}

function operationIdentityDigest(input: {
  readonly tool: string;
  readonly effect: AgentEffect;
  readonly sourceId: string;
  readonly queryPlan: { readonly id: string; readonly fingerprint: AgentDigest };
  readonly fields: readonly string[];
  readonly parametersDigest: AgentDigest;
}): AgentDigest {
  return digest(input);
}

function parseSourceBinding(input: unknown, path: string): AgentSourceBindingV1 {
  const record = object(input, path, ["id", "schemaVersion", "sourceVersion", "authorizationScope", "provenance"]);
  return deepFreeze({
    id: text(record.id, `${path}.id`),
    schemaVersion: text(record.schemaVersion, `${path}.schemaVersion`),
    sourceVersion: text(record.sourceVersion, `${path}.sourceVersion`),
    authorizationScope: stringList(record.authorizationScope, `${path}.authorizationScope`, true),
    provenance: parseProvenance(record.provenance, `${path}.provenance`),
  });
}

function parseProvenance(input: unknown, path: string): AgentProvenanceV1 {
  const record = object(input, path, ["dataMode", "observedAt", "attribution", "citations"]);
  const citations = array(record.citations, `${path}.citations`).map((entry, index) => {
    const citation = object(entry, `${path}.citations[${index}]`, ["uri", "digest"]);
    const uri = citationUri(citation.uri, `${path}.citations[${index}].uri`);
    return deepFreeze({
      uri,
      ...(citation.digest === undefined
        ? {}
        : { digest: parseDigest(citation.digest, `${path}.citations[${index}].digest`) }),
    });
  });
  if (citations.length === 0) invalid(`${path}.citations must not be empty`);
  return deepFreeze({
    dataMode: oneOf(record.dataMode, DATA_MODES, `${path}.dataMode`),
    observedAt: parseIso(record.observedAt, `${path}.observedAt`),
    attribution: text(record.attribution, `${path}.attribution`),
    citations,
  });
}

function parsePolicy(input: unknown): AgentPlanPolicyV1 {
  const record = object(input, "$policy", [
    "allowedTools",
    "allowedEffects",
    "sources",
    "maxSteps",
    "maxRows",
    "maxBytes",
  ]);
  const sourcesInput = object(record.sources, "$policy.sources");
  const sources: Record<string, AgentSourcePolicyV1> = {};
  for (const id of Object.keys(sourcesInput).sort())
    sources[id] = parseSourcePolicy(sourcesInput[id], `$policy.sources.${id}`);
  if (Object.keys(sources).length === 0) invalid("$policy.sources must not be empty");
  return deepFreeze({
    allowedTools: stringList(record.allowedTools, "$policy.allowedTools", true),
    ...(record.allowedEffects === undefined
      ? {}
      : { allowedEffects: enumList(record.allowedEffects, EFFECTS, "$policy.allowedEffects") }),
    sources,
    maxSteps: integer(record.maxSteps, "$policy.maxSteps", 1),
    maxRows: integer(record.maxRows, "$policy.maxRows", 0),
    maxBytes: integer(record.maxBytes, "$policy.maxBytes", 0),
  });
}

function parseSourcePolicy(input: unknown, path: string): AgentSourcePolicyV1 {
  const record = object(input, path, [
    "fields",
    "authorizationScope",
    "schemaVersions",
    "sourceVersions",
    "dataModes",
    "maxProvenanceAgeMs",
  ]);
  return deepFreeze({
    fields: stringList(record.fields, `${path}.fields`, false),
    authorizationScope: stringList(record.authorizationScope, `${path}.authorizationScope`, true),
    ...(record.schemaVersions === undefined
      ? {}
      : { schemaVersions: stringList(record.schemaVersions, `${path}.schemaVersions`, true) }),
    ...(record.sourceVersions === undefined
      ? {}
      : { sourceVersions: stringList(record.sourceVersions, `${path}.sourceVersions`, true) }),
    ...(record.dataModes === undefined
      ? {}
      : { dataModes: enumList(record.dataModes, DATA_MODES, `${path}.dataModes`) }),
    ...(record.maxProvenanceAgeMs === undefined
      ? {}
      : { maxProvenanceAgeMs: integer(record.maxProvenanceAgeMs, `${path}.maxProvenanceAgeMs`, 0) }),
  });
}

function parseApprovalRequest(input: unknown): AgentApprovalRequestV1 {
  const record = object(input, "$request", [
    "id",
    "approver",
    "issuedAt",
    "expiresAt",
    "maxRows",
    "maxBytes",
    "stepLimits",
  ]);
  let stepLimits: Readonly<Record<string, { readonly rows?: number; readonly bytes?: number }>> | undefined;
  if (record.stepLimits !== undefined) {
    const limitsInput = object(record.stepLimits, "$request.stepLimits");
    const limits: Record<string, { readonly rows?: number; readonly bytes?: number }> = {};
    for (const id of Object.keys(limitsInput).sort()) {
      const entry = object(limitsInput[id], `$request.stepLimits.${id}`, ["rows", "bytes"]);
      limits[id] = deepFreeze({
        ...(entry.rows === undefined ? {} : { rows: integer(entry.rows, `$request.stepLimits.${id}.rows`, 0) }),
        ...(entry.bytes === undefined ? {} : { bytes: integer(entry.bytes, `$request.stepLimits.${id}.bytes`, 0) }),
      });
    }
    stepLimits = deepFreeze(limits);
  }
  return deepFreeze({
    id: text(record.id, "$request.id"),
    approver: text(record.approver, "$request.approver"),
    issuedAt: parseIso(record.issuedAt, "$request.issuedAt"),
    expiresAt: parseIso(record.expiresAt, "$request.expiresAt"),
    ...(record.maxRows === undefined ? {} : { maxRows: integer(record.maxRows, "$request.maxRows", 0) }),
    ...(record.maxBytes === undefined ? {} : { maxBytes: integer(record.maxBytes, "$request.maxBytes", 0) }),
    ...(stepLimits === undefined ? {} : { stepLimits }),
  });
}

function parseApproval(input: unknown): AgentApprovalV1 {
  const record = object(input, "$approval", [
    "kind",
    "version",
    "id",
    "approver",
    "issuedAt",
    "expiresAt",
    "evaluatedAt",
    "use",
    "planDigest",
    "policyDigest",
    "bindingsDigest",
    "approvedRows",
    "approvedBytes",
    "steps",
    "algorithm",
    "keyId",
    "envelopeDigest",
    "signature",
  ]);
  literal(record.kind, AGENT_APPROVAL_KIND, "$approval.kind");
  literal(record.version, AGENT_SAFETY_VERSION, "$approval.version");
  literal(record.use, "single", "$approval.use");
  const steps = array(record.steps, "$approval.steps").map((input, index) => {
    const step = object(input, `$approval.steps[${index}]`, ["id", "inputDigest", "rows", "bytes"]);
    return deepFreeze({
      id: text(step.id, `$approval.steps[${index}].id`),
      inputDigest: parseDigest(step.inputDigest, `$approval.steps[${index}].inputDigest`),
      rows: integer(step.rows, `$approval.steps[${index}].rows`, 0),
      bytes: integer(step.bytes, `$approval.steps[${index}].bytes`, 0),
    });
  });
  unique(
    steps.map((step) => step.id),
    "$approval.steps ids",
  );
  return deepFreeze({
    kind: AGENT_APPROVAL_KIND,
    version: AGENT_SAFETY_VERSION,
    id: text(record.id, "$approval.id"),
    approver: text(record.approver, "$approval.approver"),
    issuedAt: parseIso(record.issuedAt, "$approval.issuedAt"),
    expiresAt: parseIso(record.expiresAt, "$approval.expiresAt"),
    evaluatedAt: parseIso(record.evaluatedAt, "$approval.evaluatedAt"),
    use: "single",
    planDigest: parseDigest(record.planDigest, "$approval.planDigest"),
    policyDigest: parseDigest(record.policyDigest, "$approval.policyDigest"),
    bindingsDigest: parseDigest(record.bindingsDigest, "$approval.bindingsDigest"),
    approvedRows: integer(record.approvedRows, "$approval.approvedRows", 0),
    approvedBytes: integer(record.approvedBytes, "$approval.approvedBytes", 0),
    steps,
    algorithm: text(record.algorithm, "$approval.algorithm"),
    keyId: text(record.keyId, "$approval.keyId"),
    envelopeDigest: parseDigest(record.envelopeDigest, "$approval.envelopeDigest"),
    signature: parseSignature(record.signature),
  });
}

function parseEvidence(input: unknown): AgentExecutionEvidenceV1 {
  const record = object(input, "$evidence", [
    "id",
    "stepId",
    "inputDigest",
    "useDigest",
    "outcome",
    "completedAt",
    "rows",
    "bytes",
    "resultDigest",
  ]);
  return deepFreeze({
    id: text(record.id, "$evidence.id"),
    stepId: text(record.stepId, "$evidence.stepId"),
    inputDigest: parseDigest(record.inputDigest, "$evidence.inputDigest"),
    useDigest: parseDigest(record.useDigest, "$evidence.useDigest"),
    outcome: oneOf(record.outcome, ["succeeded", "failed", "cancelled"] as const, "$evidence.outcome"),
    completedAt: parseIso(record.completedAt, "$evidence.completedAt"),
    rows: integer(record.rows, "$evidence.rows", 0),
    bytes: integer(record.bytes, "$evidence.bytes", 0),
    ...(record.resultDigest === undefined
      ? {}
      : { resultDigest: parseDigest(record.resultDigest, "$evidence.resultDigest") }),
  });
}

function parseReceipt(input: unknown): AgentExecutionReceiptV1 {
  const record = object(input, "$receipt", [
    "kind",
    "version",
    "id",
    "stepId",
    "inputDigest",
    "useDigest",
    "outcome",
    "completedAt",
    "rows",
    "bytes",
    "resultDigest",
    "planDigest",
    "policyDigest",
    "bindingsDigest",
    "approvalDigest",
    "algorithm",
    "keyId",
    "receiptDigest",
    "signature",
  ]);
  literal(record.kind, AGENT_RECEIPT_KIND, "$receipt.kind");
  literal(record.version, AGENT_SAFETY_VERSION, "$receipt.version");
  const evidence = parseEvidence({
    id: record.id,
    stepId: record.stepId,
    inputDigest: record.inputDigest,
    useDigest: record.useDigest,
    outcome: record.outcome,
    completedAt: record.completedAt,
    rows: record.rows,
    bytes: record.bytes,
    ...(record.resultDigest === undefined ? {} : { resultDigest: record.resultDigest }),
  });
  return deepFreeze({
    kind: AGENT_RECEIPT_KIND,
    version: AGENT_SAFETY_VERSION,
    ...evidence,
    planDigest: parseDigest(record.planDigest, "$receipt.planDigest"),
    policyDigest: parseDigest(record.policyDigest, "$receipt.policyDigest"),
    bindingsDigest: parseDigest(record.bindingsDigest, "$receipt.bindingsDigest"),
    approvalDigest: parseDigest(record.approvalDigest, "$receipt.approvalDigest"),
    algorithm: text(record.algorithm, "$receipt.algorithm"),
    keyId: text(record.keyId, "$receipt.keyId"),
    receiptDigest: parseDigest(record.receiptDigest, "$receipt.receiptDigest"),
    signature: parseSignature(record.signature),
  });
}

function unsignedApproval(value: AgentApprovalV1): Omit<AgentApprovalV1, "envelopeDigest" | "signature"> {
  const { envelopeDigest: _digest, signature: _signature, ...unsigned } = value;
  return unsigned;
}

function unsignedReceipt(value: AgentExecutionReceiptV1): Omit<AgentExecutionReceiptV1, "receiptDigest" | "signature"> {
  const { receiptDigest: _digest, signature: _signature, ...unsigned } = value;
  return unsigned;
}

function uniqueBindings(steps: readonly AgentPlanStepV1[]): readonly AgentSourceBindingV1[] {
  const bindings = new Map<string, AgentSourceBindingV1>();
  for (const step of steps) {
    const prior = bindings.get(step.source.id);
    if (prior && digest(prior) !== digest(step.source)) invalid(`source ${step.source.id} has conflicting bindings`);
    bindings.set(step.source.id, step.source);
  }
  return deepFreeze([...bindings.values()].sort((a, b) => a.id.localeCompare(b.id)));
}

function parseSignerIdentity(value: AgentEnvelopeSigner): { readonly algorithm: string; readonly keyId: string } {
  if (!value || typeof value.sign !== "function") invalid("signer.sign must be a function");
  return { algorithm: text(value.algorithm, "$signer.algorithm"), keyId: text(value.keyId, "$signer.keyId") };
}

function parseVerifierIdentity(value: AgentEnvelopeVerifier): { readonly algorithm: string; readonly keyId: string } {
  if (!value || typeof value.verify !== "function") invalid("verifier.verify must be a function");
  return { algorithm: text(value.algorithm, "$verifier.algorithm"), keyId: text(value.keyId, "$verifier.keyId") };
}

function object(input: unknown, path: string, allowed?: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid(`${path} must be a plain object`);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be a plain object`);
  if (Object.getOwnPropertySymbols(input).length > 0) invalid(`${path} must not contain symbol properties`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) invalid(`${path}.${key} must not be an accessor`);
    if (allowed && !allowed.includes(key)) invalid(`${path}.${key} is not supported`);
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function array(input: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(input)) invalid(`${path} must be an array`);
  if (Object.getPrototypeOf(input) !== Array.prototype) invalid(`${path} must be a plain array`);
  if (Object.getOwnPropertySymbols(input).length > 0) invalid(`${path} must not contain symbol properties`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const lengthValue: unknown = Reflect.getOwnPropertyDescriptor(input, "length")?.value;
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) invalid(`${path} has an invalid length`);
  const length = lengthValue as number;
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) invalid(`${path} must not be sparse`);
    if (descriptor.get || descriptor.set) invalid(`${path}[${index}] must not be an accessor`);
    snapshot.push(descriptor.value);
  }
  for (const key of Object.keys(descriptors)) {
    if (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) invalid(`${path}.${key} is not supported`);
  }
  return snapshot;
}

function text(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 1_024 || hasControlCharacters(input))
    invalid(`${path} must be a non-empty bounded string without control characters`);
  return input;
}

function parseIso(input: unknown, path: string): string {
  const value = text(input, path);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    invalid(`${path} must be a canonical ISO-8601 timestamp`);
  return value;
}

function integer(input: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum)
    invalid(`${path} must be a safe integer >= ${minimum}`);
  return input as number;
}

function parseDigest(input: unknown, path: string): AgentDigest {
  if (typeof input !== "string" || !DIGEST.test(input)) invalid(`${path} must be a lowercase SHA-256 digest`);
  return input as AgentDigest;
}

function parseSignature(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 16_384 || hasControlCharacters(input))
    invalid("signature must be a non-empty bounded string without control characters");
  return input;
}

function citationUri(input: unknown, path: string): string {
  const value = text(input, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(`${path} must be an absolute URL`);
  }
  if (!url || url.protocol !== "https:" || url.username || url.password)
    invalid(`${path} must be a credential-free HTTPS URL`);
  if (url.search || url.hash) invalid(`${path} must not contain query parameters or fragments`);
  if (SENSITIVE_QUERY_KEY.test(url.pathname)) invalid(`${path} path appears to contain credential material`);
  return value;
}

function stringList(input: unknown, path: string, nonEmpty: boolean): readonly string[] {
  const values = array(input, path).map((entry, index) => text(entry, `${path}[${index}]`));
  if (nonEmpty && values.length === 0) invalid(`${path} must not be empty`);
  unique(values, path);
  return deepFreeze([...values].sort());
}

function enumList<T extends string>(input: unknown, allowed: readonly T[], path: string): readonly T[] {
  const values = array(input, path).map((entry, index) => oneOf(entry, allowed, `${path}[${index}]`));
  if (values.length === 0) invalid(`${path} must not be empty`);
  unique(values, path);
  return deepFreeze([...values].sort());
}

function oneOf<T extends string>(input: unknown, allowed: readonly T[], path: string): T {
  if (typeof input !== "string" || !allowed.includes(input as T))
    invalid(`${path} must be one of: ${allowed.join(", ")}`);
  return input as T;
}

function literal<T extends string>(input: unknown, expected: T, path: string): T {
  if (input !== expected) invalid(`${path} must equal ${expected}`);
  return expected;
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(`${path} must not contain duplicates`);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertSubset(actual: readonly string[], allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (actual.some((value) => !allowedSet.has(value))) fail("policy-denied", `${label} exceeds the allowlist`);
}

function safeAdd(total: number, value: number, label: string): number {
  const next = total + value;
  if (!Number.isSafeInteger(next)) invalid(`${label} exceeds the safe integer range`);
  return next;
}

function canonical(value: unknown): string {
  try {
    return canonicalStringify(toJsonValue(snapshotJson(value, "$payload", new WeakSet<object>())));
  } catch (error) {
    invalid(error instanceof Error ? error.message : "value is not canonical JSON");
  }
}

function snapshotJson(value: unknown, path: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must contain only finite numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") invalid(`${path} contains unsupported ${typeof value}`);
  if (ancestors.has(value)) invalid(`${path} must not contain cycles`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const result = array(value, path).map((entry, index) => snapshotJson(entry, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return result;
  }
  const record = object(value, path);
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) invalid(`${path}.${key} must not be undefined`);
    Object.defineProperty(result, key, {
      value: snapshotJson(entry, `${path}.${key}`, ancestors),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(value);
  return result;
}

function digest(value: unknown): AgentDigest {
  return sha256(canonical(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) fail("aborted", "agent safety operation was aborted");
}

function invalid(message: string): never {
  return fail("invalid-input", message);
}
function fail(code: ConstructorParameters<typeof HonuaAgentSafetyError>[0], message: string): never {
  throw new HonuaAgentSafetyError(code, message);
}
