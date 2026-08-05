/**
 * Deterministic safety boundary for JSON-compatible agent plans.
 *
 * This module never invokes a model, tool, source, renderer, or job. Dry runs
 * are side-effect free. Cryptographic operations and the atomic single-use
 * replay store are delegated to host-provided callbacks so key custody and
 * persistence stay outside the SDK.
 *
 * This entrypoint is part of the SDK's stable tier: symbols reachable from
 * `@honua/sdk-js/agent-safety` are covered by the semver contract (see
 * `docs/decisions/agent-surface-stabilization.md` and
 * `docs/agent-safety-threat-model.md`).
 *
 * @packageDocumentation
 */

import { type JsonValue, canonicalStringify, sha256, toJsonValue } from "../query-planner/index.js";
import {
  AGENT_APPROVAL_KIND,
  AGENT_CONSUMPTION_KIND,
  AGENT_DRY_RUN_KIND,
  AGENT_PLAN_KIND,
  AGENT_RECEIPT_KIND,
  AGENT_SAFETY_VERSION,
  type AgentApprovalConsumptionV1,
  type AgentApprovalRequestV1,
  type AgentApprovalUseConsumer,
  type AgentApprovalV1,
  type AgentDigest,
  type AgentDryRunV1,
  type AgentEffect,
  type AgentEffectBudgetV1,
  type AgentEnvelopeSigner,
  type AgentEnvelopeVerifier,
  type AgentExecutionContextV1,
  type AgentExecutionEvidenceV1,
  type AgentExecutionInputSnapshotV1,
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
  AGENT_CONSUMPTION_KIND,
  AGENT_EXECUTION_AUDIT_KIND,
  AGENT_DRY_RUN_KIND,
  AGENT_PLAN_KIND,
  AGENT_RECEIPT_KIND,
  AGENT_SAFETY_EVIDENCE_KIND,
  AGENT_SAFETY_VERSION,
  HonuaAgentSafetyError,
  HonuaAgentExecutionError,
} from "./types.js";
export { deriveAgentSafetyEvidence, verifyAgentSafetyEvidence } from "./evidence.js";
export type { DeriveAgentSafetyEvidenceOptions } from "./evidence.js";
export { executeAgentPlanStep } from "./execution.js";
export type {
  AgentApprovalRequestV1,
  AgentApprovalConsumptionV1,
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
  AgentExecutionInputSnapshotV1,
  AgentExecutionAuditSinkV1,
  AgentExecutionAuditV1,
  AgentExecutionCompletedAuditV1,
  AgentExecutionEvidenceV1,
  AgentExecutionReceiptV1,
  AgentExecutionStartedAuditV1,
  AgentPlanPolicyV1,
  AgentPlanStepV1,
  AgentPlanV1,
  AgentOperationInputV1,
  AgentOperationExecutionResultV1,
  AgentOperationExecutorV1,
  AgentProvenanceV1,
  AgentQueryPlanBindingV1,
  AgentSafetyErrorCode,
  AgentSafetyEvidenceProvenanceV1,
  AgentSafetyEvidenceV1,
  AgentSafetyUnavailableFact,
  AgentSafetyOptions,
  AgentSourceBindingV1,
  AgentSourcePolicyV1,
  AgentStepAuthorizationV1,
  ExecuteAgentPlanStepOptions,
  ExecutedAgentPlanStepV1,
} from "./types.js";

const EFFECTS = ["read", "render", "mutation", "publish", "share", "realtime", "job"] as const;
const DATA_MODES = ["cached", "offline", "replayed", "live"] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const AGENT_SAFETY_HARD_LIMITS = deepFreeze({
  steps: 128,
  sources: 128,
  fieldsPerStep: 512,
  authorizationScopesPerSource: 128,
  citationsPerSource: 64,
  listEntries: 1_024,
  parameterNodes: 8_192,
  parameterDepth: 32,
  parameterBytes: 1_048_576,
  objectProperties: 128,
  stringBytes: 65_536,
} as const);

/**
 * Validate and snapshot a JSON-compatible plan, returning an immutable dry run.
 * JavaScript Proxies are not valid input because reflection traps are executable.
 */
export function dryRunAgentPlan(input: unknown, policyInput: unknown, options: AgentSafetyOptions = {}): AgentDryRunV1 {
  checkAbort(options.signal);
  const policy = parsePolicy(policyInput);
  const evaluatedAt = parseIso(options.now ?? new Date().toISOString(), "$options.now");
  return buildDryRun(input, policy, evaluatedAt, options.signal);
}

function buildDryRun(
  input: unknown,
  policy: AgentPlanPolicyV1,
  evaluatedAt: string,
  signal?: AbortSignal,
): AgentDryRunV1 {
  // Authority is already snapshotted and frozen before proposal inspection.
  const plan = parsePlan(input);
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
  checkAbort(signal);
  return deepFreeze(dryRun);
}

/** Canonical identity for the exact parameters a host proposes to execute. */
export function digestAgentOperationInput(input: unknown): AgentDigest {
  return parseOperationInput(input).inputDigest;
}

/** Snapshot all foreign data reused across approved execution awaits. */
export function snapshotAgentExecutionInputs(
  dryRunInput: unknown,
  policyInput: unknown,
  approvalInput: unknown,
  contextInput: unknown,
  operationInput: unknown,
  options: AgentSafetyOptions = {},
): AgentExecutionInputSnapshotV1 {
  checkAbort(options.signal);
  const policy = parsePolicy(policyInput);
  const dryRun = revalidateDryRunWithPolicy(dryRunInput, policy, options);
  const approval = parseApproval(approvalInput);
  const context = validateContext(dryRun, contextInput);
  const operation = parseOperationInput(operationInput, policy).input;
  checkAbort(options.signal);
  return deepFreeze({ dryRun, policy, approval, context, operation });
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
  const { dryRun, policy } = revalidateDryRun(dryRunInput, policyInput, options);
  const stepId = text(stepIdInput, "$stepId");
  const step = dryRun.plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) fail("policy-denied", `step ${stepId} is not in the approved plan`);
  const operation = parseOperationInput(operationInput, policy);
  const inputDigest = operation.inputDigest;
  if (inputDigest !== step.inputDigest) {
    fail("integrity-failed", `operation input does not match approved step ${stepId}`);
  }
  if (!useConsumer || typeof useConsumer.consume !== "function" || typeof useConsumer.verify !== "function")
    invalid("useConsumer must provide consume and verify functions");
  const approval = await verifyAgentApprovalWithPolicy(dryRun, policy, approvalInput, verifier, contextInput, options);
  const approvedStep = approval.steps.find((candidate) => candidate.id === stepId);
  if (!approvedStep) fail("integrity-failed", `approval is missing step ${stepId}`);
  checkAbort(options.signal);
  const consumedInput = await useConsumer.consume(
    { approvalDigest: approval.envelopeDigest, stepId, inputDigest },
    options.signal,
  );
  checkAbort(options.signal);
  if (consumedInput === undefined || consumedInput === null || consumedInput === false)
    fail("policy-denied", `approval use for step ${stepId} was already consumed`);
  const consumption = parseConsumption(consumedInput);
  validateConsumptionBinding(consumption, approval, stepId, inputDigest, options.now, options.maxClockSkewMs);
  checkAbort(options.signal);
  if ((await useConsumer.verify(consumption, options.signal)) !== true)
    fail("signature-invalid", "approval consumption record was not authenticated by the host store");
  checkAbort(options.signal);
  const useDigest = digest(consumption);
  return deepFreeze({
    plan: dryRun.plan,
    step: { ...step, limits: { rows: approvedStep.rows, bytes: approvedStep.bytes } },
    operation: operation.input,
    planDigest: dryRun.planDigest,
    policyDigest: dryRun.policyDigest,
    bindingsDigest: dryRun.bindingsDigest,
    approvalDigest: approval.envelopeDigest,
    inputDigest,
    useDigest,
    consumption,
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
  const { dryRun, policy } = revalidateDryRun(dryRunInput, policyInput, options);
  const clock = trustedClock(options, "$approval");
  validatePolicy(dryRun.plan, policy, clock.now);
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
  if (Date.parse(request.issuedAt) > clock.time + clock.skewMs)
    fail("invalid-input", "approval issuedAt is beyond the trusted clock skew");
  if (Date.parse(request.expiresAt) <= clock.time - clock.skewMs)
    fail("approval-expired", "approval is expired at signing time");
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
  const { dryRun, policy } = revalidateDryRun(dryRunInput, policyInput, options);
  return verifyAgentApprovalWithPolicy(dryRun, policy, approvalInput, verifier, contextInput, options);
}

async function verifyAgentApprovalWithPolicy(
  dryRun: AgentDryRunV1,
  policy: AgentPlanPolicyV1,
  approvalInput: unknown,
  verifier: AgentEnvelopeVerifier,
  contextInput: unknown,
  options: AgentSafetyOptions,
): Promise<AgentApprovalV1> {
  const prepared = prepareAgentApprovalVerification(dryRun, policy, approvalInput, verifier, contextInput, options);
  await verifyPreparedApproval(prepared, verifier, options.signal);
  return prepared.approval;
}

interface PreparedApprovalVerification {
  readonly approval: AgentApprovalV1;
  readonly payload: string;
}

function prepareAgentApprovalVerification(
  dryRun: AgentDryRunV1,
  policy: AgentPlanPolicyV1,
  approvalInput: unknown,
  verifier: AgentEnvelopeVerifier,
  contextInput: unknown,
  options: AgentSafetyOptions,
): PreparedApprovalVerification {
  const approval = parseApproval(approvalInput);
  assertApprovalBinding(dryRun, approval, options.now, options.maxClockSkewMs);
  // Re-run time-sensitive policy checks at authorization time. Integrity was
  // evaluated at dry-run time; freshness is an execution-time property.
  validatePolicy(dryRun.plan, policy, options.now);
  validateContext(dryRun, contextInput);
  const identity = parseVerifierIdentity(verifier);
  if (approval.algorithm !== identity.algorithm || approval.keyId !== identity.keyId) {
    fail("signature-invalid", "approval signer identity does not match the configured verifier");
  }
  const payload = canonical(unsignedApproval(approval));
  if (approval.envelopeDigest !== sha256(payload)) fail("integrity-failed", "approval envelope digest mismatch");
  return { approval, payload };
}

async function verifyPreparedApproval(
  prepared: PreparedApprovalVerification,
  verifier: AgentEnvelopeVerifier,
  signal: AbortSignal | undefined,
): Promise<void> {
  checkAbort(signal);
  const { approval, payload } = prepared;
  if ((await verifier.verify(payload, approval.signature, signal)) !== true) {
    fail("signature-invalid", "approval signature verification failed");
  }
  checkAbort(signal);
}

/** Create signed outcome evidence without invoking the approved operation. */
export async function issueAgentExecutionReceipt(
  dryRunInput: unknown,
  policyInput: unknown,
  approvalInput: unknown,
  approvalVerifier: AgentEnvelopeVerifier,
  contextInput: unknown,
  evidenceInput: unknown,
  useVerifier: Pick<AgentApprovalUseConsumer, "verify">,
  receiptSigner: AgentEnvelopeSigner,
  options: AgentSafetyOptions = {},
): Promise<AgentExecutionReceiptV1> {
  checkAbort(options.signal);
  const evidence = parseEvidence(evidenceInput);
  const receiptClock = parseIso(options.now ?? new Date().toISOString(), "$options.now");
  if (Date.parse(evidence.completedAt) > Date.parse(receiptClock)) {
    fail("invalid-input", "receipt completedAt must not be in the future");
  }
  const { dryRun, policy } = revalidateDryRun(dryRunInput, policyInput, options);
  const approval = await verifyAgentApprovalWithPolicy(dryRun, policy, approvalInput, approvalVerifier, contextInput, {
    ...options,
    now: evidence.completedAt,
  });
  validateReceiptOperation(evidence, dryRun, approval);
  await verifyConsumptionRecord(useVerifier, evidence.consumption, options.signal);
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
  useVerifier: Pick<AgentApprovalUseConsumer, "verify">,
  receiptVerifier: AgentEnvelopeVerifier,
  options: AgentSafetyOptions = {},
): Promise<AgentExecutionReceiptV1> {
  checkAbort(options.signal);
  const receipt = parseReceipt(receiptInput);
  const receiptClock = parseIso(options.now ?? new Date().toISOString(), "$options.now");
  if (Date.parse(receipt.completedAt) > Date.parse(receiptClock)) {
    fail("invalid-input", "receipt completedAt must not be in the future");
  }
  const { dryRun, policy } = revalidateDryRun(dryRunInput, policyInput, options);
  const preparedApproval = prepareAgentApprovalVerification(
    dryRun,
    policy,
    approvalInput,
    approvalVerifier,
    contextInput,
    {
      ...options,
      now: receipt.completedAt,
    },
  );
  const { approval } = preparedApproval;
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
  await verifyPreparedApproval(preparedApproval, approvalVerifier, options.signal);
  await verifyConsumptionRecord(useVerifier, receipt.consumption, options.signal);
  return receipt;
}

function validateReceiptOperation(
  evidence: Pick<
    AgentExecutionEvidenceV1,
    "stepId" | "inputDigest" | "useDigest" | "consumption" | "completedAt" | "rows" | "bytes"
  >,
  dryRun: AgentDryRunV1,
  approval: AgentApprovalV1,
): void {
  const step = dryRun.plan.steps.find((candidate) => candidate.id === evidence.stepId);
  const approved = approval.steps.find((candidate) => candidate.id === evidence.stepId);
  if (!step || !approved || evidence.inputDigest !== step.inputDigest || evidence.inputDigest !== approved.inputDigest)
    fail("integrity-failed", `receipt operation binding mismatch for ${evidence.stepId}`);
  validateConsumptionBinding(
    evidence.consumption,
    approval,
    evidence.stepId,
    evidence.inputDigest,
    evidence.consumption.consumedAt,
  );
  const expectedUseDigest = digest(evidence.consumption);
  if (evidence.useDigest !== expectedUseDigest) fail("integrity-failed", "receipt approval-use digest mismatch");
  if (Date.parse(evidence.consumption.consumedAt) > Date.parse(evidence.completedAt))
    fail("invalid-input", "receipt completion predates approval consumption");
  if (evidence.rows > approved.rows || evidence.bytes > approved.bytes)
    fail("policy-denied", `receipt exceeds the approved budget for step ${evidence.stepId}`);
}

async function verifyConsumptionRecord(
  verifier: Pick<AgentApprovalUseConsumer, "verify">,
  consumption: AgentApprovalConsumptionV1,
  signal?: AbortSignal,
): Promise<void> {
  if (!verifier || typeof verifier.verify !== "function") invalid("consumption verifier must provide verify");
  checkAbort(signal);
  if ((await verifier.verify(consumption, signal)) !== true)
    fail("signature-invalid", "approval consumption record was not authenticated by the host store");
  checkAbort(signal);
}

function revalidateDryRun(
  input: unknown,
  policyInput: unknown,
  options: AgentSafetyOptions,
): { readonly dryRun: AgentDryRunV1; readonly policy: AgentPlanPolicyV1 } {
  const policy = parsePolicy(policyInput);
  return { dryRun: revalidateDryRunWithPolicy(input, policy, options), policy };
}

function revalidateDryRunWithPolicy(
  input: unknown,
  policy: AgentPlanPolicyV1,
  options: AgentSafetyOptions,
): AgentDryRunV1 {
  const allowed = [
    "kind",
    "version",
    "evaluatedAt",
    "plan",
    "planDigest",
    "policyDigest",
    "bindingsDigest",
    "effectBudget",
  ] as const;
  const outer = object(input, "$dryRun", allowed);
  Object.defineProperty(outer, "plan", {
    value: parsePlan(outer.plan),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const record = object(snapshotEnvelope(outer, "$dryRun"), "$dryRun", allowed);
  literal(record.kind, AGENT_DRY_RUN_KIND, "$dryRun.kind");
  literal(record.version, AGENT_SAFETY_VERSION, "$dryRun.version");
  const evaluatedAt = parseIso(record.evaluatedAt, "$dryRun.evaluatedAt");
  const expected = buildDryRun(record.plan, policy, evaluatedAt, options.signal);
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
    if (step.fields.length > policy.maxFieldsPerStep)
      fail("policy-denied", `fields for ${step.source.id} exceed the policy count limit`);
    if (step.source.authorizationScope.length > policy.maxAuthorizationScopesPerSource)
      fail("policy-denied", `authorization scopes for ${step.source.id} exceed the policy count limit`);
    if (step.source.provenance.citations.length > policy.maxCitationsPerSource)
      fail("policy-denied", `citations for ${step.source.id} exceed the policy count limit`);
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
    for (const citation of step.source.provenance.citations) {
      const url = new URL(citation.uri);
      const resourcePath = normalizeResourcePath(url.pathname, `citation for ${step.source.id}`);
      if (!sourcePolicy.citationOrigins.includes(url.origin))
        fail("policy-denied", `citation origin for ${step.source.id} is not allowed`);
      if (!sourcePolicy.citationResourcePrefixes.some((prefix) => resourcePathIsWithin(resourcePath, prefix)))
        fail("policy-denied", `citation resource for ${step.source.id} is not allowed`);
    }
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

function resourcePathIsWithin(path: string, prefix: string): boolean {
  return path === prefix || prefix === "/" || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function validateContext(dryRun: AgentDryRunV1, input: unknown): AgentExecutionContextV1 {
  const outer = object(input, "$context", ["sources"]);
  const normalized = snapshotEnvelope(outer, "$context");
  const record = object(normalized, "$context", ["sources"]);
  const sourcesInput = object(record.sources, "$context.sources", undefined, AGENT_SAFETY_HARD_LIMITS.sources);
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

function assertApprovalBinding(
  dryRun: AgentDryRunV1,
  approval: AgentApprovalV1,
  now?: string,
  maxClockSkewMs = 0,
): void {
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
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0 || maxClockSkewMs > 300_000)
    invalid("$options.maxClockSkewMs is outside the supported range");
  const clock = parseIso(now ?? new Date().toISOString(), "$options.now");
  if (Date.parse(clock) >= Date.parse(approval.expiresAt) + maxClockSkewMs)
    fail("approval-expired", "approval has expired");
  if (Date.parse(clock) < Date.parse(approval.issuedAt) - maxClockSkewMs)
    fail("invalid-input", "approval is not yet valid");
}

function parsePlan(input: unknown): AgentPlanV1 {
  const outer = object(input, "$plan", ["kind", "version", "id", "actor", "provider", "model", "steps"]);
  Object.defineProperty(outer, "steps", {
    value: array(outer.steps, "$plan.steps", AGENT_SAFETY_HARD_LIMITS.steps),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const normalized = snapshotJson(
    outer,
    "$plan",
    new WeakSet<object>(),
    createJsonBudget(
      AGENT_SAFETY_HARD_LIMITS.parameterNodes,
      AGENT_SAFETY_HARD_LIMITS.parameterDepth,
      AGENT_SAFETY_HARD_LIMITS.parameterBytes,
    ),
    0,
  );
  return parsePlanSnapshot(normalized);
}

function parsePlanSnapshot(input: unknown): AgentPlanV1 {
  const record = object(input, "$plan", ["kind", "version", "id", "actor", "provider", "model", "steps"]);
  literal(record.kind, AGENT_PLAN_KIND, "$plan.kind");
  literal(record.version, AGENT_SAFETY_VERSION, "$plan.version");
  const steps = array(record.steps, "$plan.steps", AGENT_SAFETY_HARD_LIMITS.steps).map((entry, index) =>
    parseStep(entry, `$plan.steps[${index}]`),
  );
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
  const fields = stringList(record.fields, `${path}.fields`, false, AGENT_SAFETY_HARD_LIMITS.fieldsPerStep);
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

function parseOperationInput(
  input: unknown,
  limits: Pick<
    AgentPlanPolicyV1,
    "maxOperationParameterBytes" | "maxOperationParameterNodes" | "maxOperationParameterDepth"
  > = {
    maxOperationParameterBytes: AGENT_SAFETY_HARD_LIMITS.parameterBytes,
    maxOperationParameterNodes: AGENT_SAFETY_HARD_LIMITS.parameterNodes,
    maxOperationParameterDepth: AGENT_SAFETY_HARD_LIMITS.parameterDepth,
  },
): {
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
    fields: stringList(record.fields, "$operation.fields", false, AGENT_SAFETY_HARD_LIMITS.fieldsPerStep),
    parameters: snapshotJson(
      record.parameters,
      "$operation.parameters",
      new WeakSet<object>(),
      createJsonBudget(
        limits.maxOperationParameterNodes,
        limits.maxOperationParameterDepth,
        limits.maxOperationParameterBytes,
      ),
      0,
    ),
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
    authorizationScope: stringList(
      record.authorizationScope,
      `${path}.authorizationScope`,
      true,
      AGENT_SAFETY_HARD_LIMITS.authorizationScopesPerSource,
    ),
    provenance: parseProvenance(record.provenance, `${path}.provenance`),
  });
}

function parseProvenance(input: unknown, path: string): AgentProvenanceV1 {
  const record = object(input, path, ["dataMode", "observedAt", "attribution", "citations"]);
  const citations = array(record.citations, `${path}.citations`, AGENT_SAFETY_HARD_LIMITS.citationsPerSource).map(
    (entry, index) => {
      const citation = object(entry, `${path}.citations[${index}]`, ["uri", "digest"]);
      const uri = citationUri(citation.uri, `${path}.citations[${index}].uri`);
      return deepFreeze({
        uri,
        ...(citation.digest === undefined
          ? {}
          : { digest: parseDigest(citation.digest, `${path}.citations[${index}].digest`) }),
      });
    },
  );
  if (citations.length === 0) invalid(`${path}.citations must not be empty`);
  return deepFreeze({
    dataMode: oneOf(record.dataMode, DATA_MODES, `${path}.dataMode`),
    observedAt: parseIso(record.observedAt, `${path}.observedAt`),
    attribution: text(record.attribution, `${path}.attribution`),
    citations,
  });
}

function parsePolicy(input: unknown): AgentPlanPolicyV1 {
  const outer = object(input, "$policy", [
    "allowedTools",
    "allowedEffects",
    "sources",
    "maxSteps",
    "maxRows",
    "maxBytes",
    "maxFieldsPerStep",
    "maxAuthorizationScopesPerSource",
    "maxCitationsPerSource",
    "maxOperationParameterBytes",
    "maxOperationParameterNodes",
    "maxOperationParameterDepth",
  ]);
  const normalized = snapshotJson(
    outer,
    "$policy",
    new WeakSet<object>(),
    createJsonBudget(
      AGENT_SAFETY_HARD_LIMITS.parameterNodes,
      AGENT_SAFETY_HARD_LIMITS.parameterDepth,
      AGENT_SAFETY_HARD_LIMITS.parameterBytes,
    ),
    0,
  );
  return parsePolicySnapshot(normalized);
}

function parsePolicySnapshot(input: unknown): AgentPlanPolicyV1 {
  const record = object(input, "$policy", [
    "allowedTools",
    "allowedEffects",
    "sources",
    "maxSteps",
    "maxRows",
    "maxBytes",
    "maxFieldsPerStep",
    "maxAuthorizationScopesPerSource",
    "maxCitationsPerSource",
    "maxOperationParameterBytes",
    "maxOperationParameterNodes",
    "maxOperationParameterDepth",
  ]);
  const sourcesInput = object(record.sources, "$policy.sources", undefined, AGENT_SAFETY_HARD_LIMITS.sources);
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
    maxSteps: boundedInteger(record.maxSteps, "$policy.maxSteps", 1, AGENT_SAFETY_HARD_LIMITS.steps),
    maxRows: integer(record.maxRows, "$policy.maxRows", 0),
    maxBytes: integer(record.maxBytes, "$policy.maxBytes", 0),
    maxFieldsPerStep: boundedInteger(
      record.maxFieldsPerStep,
      "$policy.maxFieldsPerStep",
      0,
      AGENT_SAFETY_HARD_LIMITS.fieldsPerStep,
    ),
    maxAuthorizationScopesPerSource: boundedInteger(
      record.maxAuthorizationScopesPerSource,
      "$policy.maxAuthorizationScopesPerSource",
      1,
      AGENT_SAFETY_HARD_LIMITS.authorizationScopesPerSource,
    ),
    maxCitationsPerSource: boundedInteger(
      record.maxCitationsPerSource,
      "$policy.maxCitationsPerSource",
      1,
      AGENT_SAFETY_HARD_LIMITS.citationsPerSource,
    ),
    maxOperationParameterBytes: boundedInteger(
      record.maxOperationParameterBytes,
      "$policy.maxOperationParameterBytes",
      1,
      AGENT_SAFETY_HARD_LIMITS.parameterBytes,
    ),
    maxOperationParameterNodes: boundedInteger(
      record.maxOperationParameterNodes,
      "$policy.maxOperationParameterNodes",
      1,
      AGENT_SAFETY_HARD_LIMITS.parameterNodes,
    ),
    maxOperationParameterDepth: boundedInteger(
      record.maxOperationParameterDepth,
      "$policy.maxOperationParameterDepth",
      1,
      AGENT_SAFETY_HARD_LIMITS.parameterDepth,
    ),
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
    "citationOrigins",
    "citationResourcePrefixes",
  ]);
  return deepFreeze({
    fields: stringList(record.fields, `${path}.fields`, false, AGENT_SAFETY_HARD_LIMITS.fieldsPerStep),
    authorizationScope: stringList(
      record.authorizationScope,
      `${path}.authorizationScope`,
      true,
      AGENT_SAFETY_HARD_LIMITS.authorizationScopesPerSource,
    ),
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
    citationOrigins: deepFreeze(
      stringList(record.citationOrigins, `${path}.citationOrigins`, true, AGENT_SAFETY_HARD_LIMITS.citationsPerSource)
        .map((origin, index) => normalizeCitationOrigin(origin, `${path}.citationOrigins[${index}]`))
        .sort(),
    ),
    citationResourcePrefixes: deepFreeze(
      stringList(
        record.citationResourcePrefixes,
        `${path}.citationResourcePrefixes`,
        true,
        AGENT_SAFETY_HARD_LIMITS.citationsPerSource,
      )
        .map((prefix, index) => normalizeResourcePath(prefix, `${path}.citationResourcePrefixes[${index}]`))
        .sort(),
    ),
  });
}

function parseApprovalRequest(input: unknown): AgentApprovalRequestV1 {
  const allowed = ["id", "approver", "issuedAt", "expiresAt", "maxRows", "maxBytes", "stepLimits"] as const;
  const outer = object(input, "$request", allowed);
  return parseApprovalRequestSnapshot(snapshotEnvelope(outer, "$request"));
}

function parseApprovalRequestSnapshot(input: unknown): AgentApprovalRequestV1 {
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
  const allowed = [
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
  ] as const;
  const outer = object(input, "$approval", allowed);
  Object.defineProperty(outer, "steps", {
    value: array(outer.steps, "$approval.steps", AGENT_SAFETY_HARD_LIMITS.steps),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return parseApprovalSnapshot(snapshotEnvelope(outer, "$approval"));
}

function parseApprovalSnapshot(input: unknown): AgentApprovalV1 {
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
  const steps = array(record.steps, "$approval.steps", AGENT_SAFETY_HARD_LIMITS.steps).map((input, index) => {
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
  const allowed = [
    "id",
    "stepId",
    "inputDigest",
    "useDigest",
    "consumption",
    "outcome",
    "completedAt",
    "rows",
    "bytes",
    "resultDigest",
  ] as const;
  const outer = object(input, "$evidence", allowed);
  return parseEvidenceSnapshot(snapshotEnvelope(outer, "$evidence"));
}

function parseEvidenceSnapshot(input: unknown): AgentExecutionEvidenceV1 {
  const record = object(input, "$evidence", [
    "id",
    "stepId",
    "inputDigest",
    "useDigest",
    "consumption",
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
    consumption: parseConsumption(record.consumption),
    outcome: oneOf(record.outcome, ["succeeded", "failed", "cancelled"] as const, "$evidence.outcome"),
    completedAt: parseIso(record.completedAt, "$evidence.completedAt"),
    rows: integer(record.rows, "$evidence.rows", 0),
    bytes: integer(record.bytes, "$evidence.bytes", 0),
    ...(record.resultDigest === undefined
      ? {}
      : { resultDigest: parseDigest(record.resultDigest, "$evidence.resultDigest") }),
  });
}

function parseConsumption(input: unknown): AgentApprovalConsumptionV1 {
  const allowed = [
    "kind",
    "version",
    "id",
    "nonce",
    "consumedAt",
    "approvalDigest",
    "stepId",
    "inputDigest",
    "token",
  ] as const;
  const outer = object(input, "$consumption", allowed);
  const record = object(snapshotEnvelope(outer, "$consumption"), "$consumption", allowed);
  literal(record.kind, AGENT_CONSUMPTION_KIND, "$consumption.kind");
  literal(record.version, AGENT_SAFETY_VERSION, "$consumption.version");
  return deepFreeze({
    kind: AGENT_CONSUMPTION_KIND,
    version: AGENT_SAFETY_VERSION,
    id: text(record.id, "$consumption.id"),
    nonce: text(record.nonce, "$consumption.nonce"),
    consumedAt: parseIso(record.consumedAt, "$consumption.consumedAt"),
    approvalDigest: parseDigest(record.approvalDigest, "$consumption.approvalDigest"),
    stepId: text(record.stepId, "$consumption.stepId"),
    inputDigest: parseDigest(record.inputDigest, "$consumption.inputDigest"),
    token: parseSignature(record.token),
  });
}

function validateConsumptionBinding(
  consumption: AgentApprovalConsumptionV1,
  approval: AgentApprovalV1,
  stepId: string,
  inputDigest: AgentDigest,
  now?: string,
  maxClockSkewMs = 0,
): void {
  if (
    consumption.approvalDigest !== approval.envelopeDigest ||
    consumption.stepId !== stepId ||
    consumption.inputDigest !== inputDigest
  )
    fail("integrity-failed", "approval consumption record binding mismatch");
  const clock = parseIso(now ?? new Date().toISOString(), "$options.now");
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0 || maxClockSkewMs > 300_000)
    invalid("$options.maxClockSkewMs is outside the supported range");
  const consumedAt = Date.parse(consumption.consumedAt);
  if (consumedAt < Date.parse(approval.issuedAt) - maxClockSkewMs)
    fail("invalid-input", "approval consumption predates approval issuance");
  if (consumedAt >= Date.parse(approval.expiresAt))
    fail("approval-expired", "approval consumption occurred after expiry");
  if (consumedAt > Date.parse(clock) + maxClockSkewMs)
    fail("invalid-input", "approval consumption is beyond the trusted clock skew");
}

function parseReceipt(input: unknown): AgentExecutionReceiptV1 {
  const allowed = [
    "kind",
    "version",
    "id",
    "stepId",
    "inputDigest",
    "useDigest",
    "consumption",
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
  ] as const;
  const outer = object(input, "$receipt", allowed);
  const record = object(snapshotEnvelope(outer, "$receipt"), "$receipt", allowed);
  literal(record.kind, AGENT_RECEIPT_KIND, "$receipt.kind");
  literal(record.version, AGENT_SAFETY_VERSION, "$receipt.version");
  const evidence = parseEvidence({
    id: record.id,
    stepId: record.stepId,
    inputDigest: record.inputDigest,
    useDigest: record.useDigest,
    consumption: record.consumption,
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
  return deepFreeze([...bindings.values()].sort((a, b) => compareCodeUnits(a.id, b.id)));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseSignerIdentity(value: AgentEnvelopeSigner): { readonly algorithm: string; readonly keyId: string } {
  if (!value || typeof value.sign !== "function") invalid("signer.sign must be a function");
  return { algorithm: text(value.algorithm, "$signer.algorithm"), keyId: text(value.keyId, "$signer.keyId") };
}

function parseVerifierIdentity(value: AgentEnvelopeVerifier): { readonly algorithm: string; readonly keyId: string } {
  if (!value || typeof value.verify !== "function") invalid("verifier.verify must be a function");
  return { algorithm: text(value.algorithm, "$verifier.algorithm"), keyId: text(value.keyId, "$verifier.keyId") };
}

function object(
  input: unknown,
  path: string,
  allowed?: readonly string[],
  maxProperties: number = allowed?.length ?? AGENT_SAFETY_HARD_LIMITS.objectProperties,
): Record<string, unknown> {
  return reflect(path, () => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) invalid(`${path} must be a plain object`);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be a plain object`);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (const key in input) {
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      if (!descriptor) continue;
      if (allowed && !allowed.includes(key)) invalid(`${path}.${key} is not supported`);
      count += 1;
      if (count > maxProperties) invalid(`${path} exceeds the ${maxProperties} property limit`);
      if (descriptor.get || descriptor.set) invalid(`${path}.${key} must not be an accessor`);
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return snapshot;
  });
}

function array(
  input: unknown,
  path: string,
  maxLength: number = AGENT_SAFETY_HARD_LIMITS.listEntries,
): readonly unknown[] {
  return reflect(path, () => {
    if (!Array.isArray(input)) invalid(`${path} must be an array`);
    if (Object.getPrototypeOf(input) !== Array.prototype) invalid(`${path} must be a plain array`);
    const lengthValue: unknown = Reflect.getOwnPropertyDescriptor(input, "length")?.value;
    if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) invalid(`${path} has an invalid length`);
    const length = lengthValue as number;
    if (length > maxLength) invalid(`${path} exceeds the ${maxLength} entry limit`);
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Reflect.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor) invalid(`${path} must not be sparse`);
      if (descriptor.get || descriptor.set) invalid(`${path}[${index}] must not be an accessor`);
      snapshot.push(descriptor.value);
    }
    return snapshot;
  });
}

function text(input: unknown, path: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > AGENT_SAFETY_HARD_LIMITS.stringBytes ||
    utf8Bytes(input) > AGENT_SAFETY_HARD_LIMITS.stringBytes ||
    hasControlCharacters(input)
  )
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

function trustedClock(
  options: AgentSafetyOptions,
  path: string,
): { readonly now: string; readonly time: number; readonly skewMs: number } {
  if (options.now === undefined) invalid(`${path} requires an explicit trusted now timestamp`);
  const now = parseIso(options.now, `${path}.now`);
  const skewMs = options.maxClockSkewMs ?? 0;
  if (!Number.isSafeInteger(skewMs) || skewMs < 0 || skewMs > 300_000)
    invalid(`${path}.maxClockSkewMs must be a safe integer between 0 and 300000`);
  return { now, time: Date.parse(now), skewMs };
}

function integer(input: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum)
    invalid(`${path} must be a safe integer >= ${minimum}`);
  return input as number;
}

function boundedInteger(input: unknown, path: string, minimum: number, maximum: number): number {
  const value = integer(input, path, minimum);
  if (value > maximum) invalid(`${path} must be <= ${maximum}`);
  return value;
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
  const resourcePath = normalizeResourcePath(url.pathname, `${path}.pathname`);
  return `${url.origin}${encodeResourcePath(resourcePath)}`;
}

function normalizeCitationOrigin(input: unknown, path: string): string {
  const value = text(input, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(`${path} must be an absolute HTTPS origin`);
  }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    invalid(`${path} must be a credential-free HTTPS origin`);
  if (url.pathname !== "/") invalid(`${path} must not include a resource path`);
  return url.origin;
}

function normalizeResourcePath(input: unknown, path: string): string {
  let value = text(input, path);
  if (!value.startsWith("/")) invalid(`${path} must be an absolute resource path`);
  for (let pass = 0; pass < 3; pass++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      invalid(`${path} contains invalid percent encoding`);
    }
    if (decoded === value) break;
    value = decoded;
  }
  if (/%[0-9a-f]{2}/i.test(value)) invalid(`${path} is excessively percent encoded`);
  if (value.includes("\\") || value.includes("?") || value.includes("#") || hasControlCharacters(value))
    invalid(`${path} contains unsafe path characters`);
  const segments = value.normalize("NFC").split("/");
  if (segments.some((segment) => segment === "." || segment === ".."))
    invalid(`${path} must not contain traversal segments`);
  return segments.join("/");
}

function encodeResourcePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function stringList(
  input: unknown,
  path: string,
  nonEmpty: boolean,
  maxLength: number = AGENT_SAFETY_HARD_LIMITS.listEntries,
): readonly string[] {
  const values = array(input, path, maxLength).map((entry, index) => text(entry, `${path}[${index}]`));
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function reflect<T>(path: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HonuaAgentSafetyError) throw error;
    invalid(`${path} could not be safely normalized`);
  }
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
    return canonicalStringify(
      toJsonValue(
        snapshotJson(
          value,
          "$payload",
          new WeakSet<object>(),
          createJsonBudget(
            AGENT_SAFETY_HARD_LIMITS.parameterNodes,
            AGENT_SAFETY_HARD_LIMITS.parameterDepth,
            AGENT_SAFETY_HARD_LIMITS.parameterBytes,
          ),
          0,
        ),
      ),
    );
  } catch (error) {
    invalid(error instanceof Error ? error.message : "value is not canonical JSON");
  }
}

function snapshotEnvelope(input: unknown, path: string): JsonValue {
  return snapshotJson(
    input,
    path,
    new WeakSet<object>(),
    createJsonBudget(
      AGENT_SAFETY_HARD_LIMITS.parameterNodes,
      AGENT_SAFETY_HARD_LIMITS.parameterDepth,
      AGENT_SAFETY_HARD_LIMITS.parameterBytes,
    ),
    0,
  );
}

interface JsonBudget {
  nodes: number;
  bytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
}

function createJsonBudget(maxNodes: number, maxDepth: number, maxBytes: number): JsonBudget {
  return { nodes: 0, bytes: 0, maxNodes, maxDepth, maxBytes };
}

function snapshotJson(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  budget: JsonBudget,
  depth: number,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) invalid(`${path} exceeds the ${budget.maxNodes} node limit`);
  if (depth > budget.maxDepth) invalid(`${path} exceeds the ${budget.maxDepth} depth limit`);
  budget.bytes = safeAdd(budget.bytes, 8, "JSON UTF-8 budget");
  if (budget.bytes > budget.maxBytes) invalid(`${path} exceeds the ${budget.maxBytes} byte limit`);
  if (typeof value === "string") {
    budget.bytes = safeAdd(budget.bytes, utf8Bytes(value), "JSON UTF-8 budget");
    if (budget.bytes > budget.maxBytes) invalid(`${path} exceeds the ${budget.maxBytes} byte limit`);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must contain only finite numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") invalid(`${path} contains unsupported ${typeof value}`);
  if (ancestors.has(value)) invalid(`${path} must not contain cycles`);
  ancestors.add(value);
  if (reflect(path, () => Array.isArray(value))) {
    const remainingNodes = Math.max(0, budget.maxNodes - budget.nodes);
    const result = array(value, path, Math.min(remainingNodes, AGENT_SAFETY_HARD_LIMITS.listEntries)).map(
      (entry, index) => snapshotJson(entry, `${path}[${index}]`, ancestors, budget, depth + 1),
    );
    ancestors.delete(value);
    return result;
  }
  const record = object(
    value,
    path,
    undefined,
    Math.min(Math.max(0, budget.maxNodes - budget.nodes), AGENT_SAFETY_HARD_LIMITS.objectProperties),
  );
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(record).sort()) {
    budget.bytes = safeAdd(budget.bytes, utf8Bytes(key), "JSON UTF-8 budget");
    if (budget.bytes > budget.maxBytes) invalid(`${path} exceeds the ${budget.maxBytes} byte limit`);
    const entry = record[key];
    if (entry === undefined) invalid(`${path}.${key} must not be undefined`);
    Object.defineProperty(result, key, {
      value: snapshotJson(entry, `${path}.${key}`, ancestors, budget, depth + 1),
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
