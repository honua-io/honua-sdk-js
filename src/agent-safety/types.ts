import type { JsonValue } from "../query-planner/index.js";

export const AGENT_PLAN_KIND = "honua.agent-plan" as const;
export const AGENT_DRY_RUN_KIND = "honua.agent-dry-run" as const;
export const AGENT_APPROVAL_KIND = "honua.agent-approval" as const;
export const AGENT_RECEIPT_KIND = "honua.agent-execution-receipt" as const;
export const AGENT_CONSUMPTION_KIND = "honua.agent-approval-consumption" as const;
export const AGENT_EXECUTION_AUDIT_KIND = "honua.agent-execution-audit" as const;
export const AGENT_SAFETY_VERSION = "1.0" as const;

export type AgentDigest = `sha256:${string}`;
export type AgentEffect = "read" | "render" | "mutation" | "publish" | "share" | "realtime" | "job";
export type AgentDataMode = "cached" | "offline" | "replayed" | "live";

export interface AgentCitationV1 {
  readonly uri: string;
  readonly digest?: AgentDigest;
}

export interface AgentProvenanceV1 {
  readonly dataMode: AgentDataMode;
  readonly observedAt: string;
  readonly attribution: string;
  readonly citations: readonly AgentCitationV1[];
}

export interface AgentSourceBindingV1 {
  readonly id: string;
  readonly schemaVersion: string;
  readonly sourceVersion: string;
  readonly authorizationScope: readonly string[];
  readonly provenance: AgentProvenanceV1;
}

export interface AgentQueryPlanBindingV1 {
  readonly id: string;
  readonly fingerprint: AgentDigest;
}

export interface AgentPlanStepV1 {
  readonly id: string;
  readonly tool: string;
  readonly effect: AgentEffect;
  readonly source: AgentSourceBindingV1;
  readonly queryPlan: AgentQueryPlanBindingV1;
  readonly parametersDigest: AgentDigest;
  /** Digest of the canonical parameters the host will pass to the operation. */
  readonly inputDigest: AgentDigest;
  readonly fields: readonly string[];
  readonly limits: {
    readonly rows: number;
    readonly bytes: number;
  };
}

export interface AgentOperationInputV1 {
  readonly tool: string;
  readonly effect: AgentEffect;
  readonly sourceId: string;
  readonly queryPlan: AgentQueryPlanBindingV1;
  readonly fields: readonly string[];
  readonly parameters: JsonValue;
}

export interface AgentStepAuthorizationV1 {
  readonly plan: AgentPlanV1;
  readonly step: AgentPlanStepV1;
  /** Frozen operation snapshot; executors must consume this value only. */
  readonly operation: AgentOperationInputV1;
  readonly planDigest: AgentDigest;
  readonly policyDigest: AgentDigest;
  readonly bindingsDigest: AgentDigest;
  readonly approvalDigest: AgentDigest;
  readonly inputDigest: AgentDigest;
  readonly useDigest: AgentDigest;
  readonly consumption: AgentApprovalConsumptionV1;
}

export interface AgentPlanV1 {
  readonly kind: typeof AGENT_PLAN_KIND;
  readonly version: typeof AGENT_SAFETY_VERSION;
  readonly id: string;
  readonly actor: string;
  readonly provider?: string;
  readonly model?: string;
  readonly steps: readonly AgentPlanStepV1[];
}

export interface AgentSourcePolicyV1 {
  readonly fields: readonly string[];
  readonly authorizationScope: readonly string[];
  readonly schemaVersions?: readonly string[];
  readonly sourceVersions?: readonly string[];
  readonly dataModes?: readonly AgentDataMode[];
  readonly maxProvenanceAgeMs?: number;
  /** Exact normalized HTTPS origins allowed for provenance citations. */
  readonly citationOrigins: readonly string[];
  /** Decoded, normalized absolute path prefixes allowed at those origins. */
  readonly citationResourcePrefixes: readonly string[];
}

export interface AgentPlanPolicyV1 {
  readonly allowedTools: readonly string[];
  readonly allowedEffects?: readonly AgentEffect[];
  readonly sources: Readonly<Record<string, AgentSourcePolicyV1>>;
  readonly maxSteps: number;
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxFieldsPerStep: number;
  readonly maxAuthorizationScopesPerSource: number;
  readonly maxCitationsPerSource: number;
  readonly maxOperationParameterBytes: number;
  readonly maxOperationParameterNodes: number;
  readonly maxOperationParameterDepth: number;
}

export interface AgentEffectBudgetV1 {
  readonly steps: number;
  readonly rows: number;
  readonly bytes: number;
  readonly byEffect: Readonly<Record<AgentEffect, number>>;
}

export interface AgentDryRunV1 {
  readonly kind: typeof AGENT_DRY_RUN_KIND;
  readonly version: typeof AGENT_SAFETY_VERSION;
  readonly evaluatedAt: string;
  readonly plan: AgentPlanV1;
  readonly planDigest: AgentDigest;
  readonly policyDigest: AgentDigest;
  readonly bindingsDigest: AgentDigest;
  readonly effectBudget: AgentEffectBudgetV1;
}

export interface AgentApprovalRequestV1 {
  readonly id: string;
  readonly approver: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly maxRows?: number;
  readonly maxBytes?: number;
  readonly stepLimits?: Readonly<Record<string, { readonly rows?: number; readonly bytes?: number }>>;
}

export interface AgentApprovedStepV1 {
  readonly id: string;
  readonly inputDigest: AgentDigest;
  readonly rows: number;
  readonly bytes: number;
}

export interface AgentApprovalV1 {
  readonly kind: typeof AGENT_APPROVAL_KIND;
  readonly version: typeof AGENT_SAFETY_VERSION;
  readonly id: string;
  readonly approver: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly evaluatedAt: string;
  readonly use: "single";
  readonly planDigest: AgentDigest;
  readonly policyDigest: AgentDigest;
  readonly bindingsDigest: AgentDigest;
  readonly approvedRows: number;
  readonly approvedBytes: number;
  readonly steps: readonly AgentApprovedStepV1[];
  readonly algorithm: string;
  readonly keyId: string;
  readonly envelopeDigest: AgentDigest;
  readonly signature: string;
}

export interface AgentApprovalUseConsumer {
  /** Atomically create an unforgeable record only for the first use. */
  consume(
    use: {
      readonly approvalDigest: AgentDigest;
      readonly stepId: string;
      readonly inputDigest: AgentDigest;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Verify that a record/token was minted by this host store and still binds. */
  verify(record: unknown, signal?: AbortSignal): Promise<boolean>;
}

export interface AgentApprovalConsumptionV1 {
  readonly kind: typeof AGENT_CONSUMPTION_KIND;
  readonly version: typeof AGENT_SAFETY_VERSION;
  readonly id: string;
  readonly nonce: string;
  readonly consumedAt: string;
  readonly approvalDigest: AgentDigest;
  readonly stepId: string;
  readonly inputDigest: AgentDigest;
  /** Opaque host-authenticated token; its format is store-owned. */
  readonly token: string;
}

export interface AgentExecutionContextV1 {
  readonly sources: Readonly<Record<string, AgentSourceBindingV1>>;
}

export interface AgentExecutionEvidenceV1 {
  readonly id: string;
  readonly stepId: string;
  readonly inputDigest: AgentDigest;
  readonly useDigest: AgentDigest;
  readonly consumption: AgentApprovalConsumptionV1;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly completedAt: string;
  readonly rows: number;
  readonly bytes: number;
  readonly resultDigest?: AgentDigest;
}

export interface AgentExecutionReceiptV1 {
  readonly kind: typeof AGENT_RECEIPT_KIND;
  readonly version: typeof AGENT_SAFETY_VERSION;
  readonly id: string;
  readonly stepId: string;
  readonly inputDigest: AgentDigest;
  readonly useDigest: AgentDigest;
  readonly consumption: AgentApprovalConsumptionV1;
  readonly outcome: AgentExecutionEvidenceV1["outcome"];
  readonly completedAt: string;
  readonly rows: number;
  readonly bytes: number;
  readonly resultDigest?: AgentDigest;
  readonly planDigest: AgentDigest;
  readonly policyDigest: AgentDigest;
  readonly bindingsDigest: AgentDigest;
  readonly approvalDigest: AgentDigest;
  readonly algorithm: string;
  readonly keyId: string;
  readonly receiptDigest: AgentDigest;
  readonly signature: string;
}

export interface AgentOperationExecutionResultV1 {
  /** Host-observed number of result rows or affected records. */
  readonly rows: number;
  /** JSON-compatible result returned to the caller and bound to the receipt. */
  readonly value: JsonValue;
}

export interface AgentOperationExecutorV1 {
  /** Exact registered tool name. Wildcard dispatch is intentionally unsupported. */
  readonly tool: string;
  readonly effect: AgentEffect;
  execute(
    operation: AgentOperationInputV1,
    limits: { readonly rows: number; readonly bytes: number },
    signal?: AbortSignal,
  ): Promise<AgentOperationExecutionResultV1>;
}

interface AgentExecutionAuditBaseV1 {
  readonly kind: typeof AGENT_EXECUTION_AUDIT_KIND;
  readonly version: typeof AGENT_SAFETY_VERSION;
  readonly executionId: string;
  readonly recordedAt: string;
  readonly planId: string;
  readonly actor: string;
  readonly provider?: string;
  readonly model?: string;
  readonly stepId: string;
  readonly tool: string;
  readonly effect: AgentEffect;
  readonly sourceId: string;
  readonly schemaVersion: string;
  readonly sourceVersion: string;
  readonly dataMode: AgentDataMode;
  readonly observedAt: string;
  readonly planDigest: AgentDigest;
  readonly policyDigest: AgentDigest;
  readonly bindingsDigest: AgentDigest;
  readonly approvalDigest: AgentDigest;
  readonly inputDigest: AgentDigest;
  readonly useDigest: AgentDigest;
}

export interface AgentExecutionStartedAuditV1 extends AgentExecutionAuditBaseV1 {
  readonly phase: "started";
}

export interface AgentExecutionCompletedAuditV1 extends AgentExecutionAuditBaseV1 {
  readonly phase: "completed";
  readonly outcome: AgentExecutionEvidenceV1["outcome"];
  readonly rows: number;
  readonly bytes: number;
  readonly resultDigest?: AgentDigest;
  /** Absent only when receipt issuance itself failed; that failure is explicit. */
  readonly receiptDigest?: AgentDigest;
}

export type AgentExecutionAuditV1 = AgentExecutionStartedAuditV1 | AgentExecutionCompletedAuditV1;

export interface AgentExecutionAuditSinkV1 {
  /** Resolve only after the event is durable. */
  append(event: AgentExecutionAuditV1, signal?: AbortSignal): Promise<void>;
}

export interface ExecuteAgentPlanStepOptions {
  readonly dryRun: unknown;
  readonly policy: unknown;
  readonly approval: unknown;
  readonly approvalVerifier: AgentEnvelopeVerifier;
  readonly context: unknown;
  readonly stepId: unknown;
  readonly operation: unknown;
  readonly useConsumer: AgentApprovalUseConsumer;
  readonly executor: AgentOperationExecutorV1;
  readonly auditSink: AgentExecutionAuditSinkV1;
  readonly receiptSigner: AgentEnvelopeSigner;
  /** Non-secret, host-generated correlation id. */
  readonly executionId: string;
  /** Injectable trusted clock. Called once for start and once for completion. */
  readonly now?: () => string;
  readonly signal?: AbortSignal;
  readonly maxClockSkewMs?: number;
}

export interface ExecutedAgentPlanStepV1 {
  readonly value: JsonValue;
  readonly receipt: AgentExecutionReceiptV1;
  readonly startedAudit: AgentExecutionStartedAuditV1;
  readonly completedAudit: AgentExecutionCompletedAuditV1;
}

export interface AgentEnvelopeSigner {
  readonly algorithm: string;
  readonly keyId: string;
  sign(canonicalPayload: string, signal?: AbortSignal): Promise<string>;
}

export interface AgentEnvelopeVerifier {
  readonly algorithm: string;
  readonly keyId: string;
  verify(canonicalPayload: string, signature: string, signal?: AbortSignal): Promise<boolean>;
}

export interface AgentSafetyOptions {
  readonly signal?: AbortSignal;
  readonly now?: string;
  readonly maxClockSkewMs?: number;
}

export type AgentSafetyErrorCode =
  | "aborted"
  | "invalid-input"
  | "policy-denied"
  | "integrity-failed"
  | "approval-expired"
  | "context-mismatch"
  | "signature-invalid"
  | "execution-failed"
  | "audit-failed"
  | "receipt-failed";

export class HonuaAgentSafetyError extends Error {
  public constructor(
    public readonly code: AgentSafetyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HonuaAgentSafetyError";
  }
}

export class HonuaAgentExecutionError extends HonuaAgentSafetyError {
  public constructor(
    code: Extract<AgentSafetyErrorCode, "aborted" | "execution-failed" | "audit-failed" | "receipt-failed">,
    message: string,
    public readonly phase: "authorization" | "start-audit" | "execution" | "receipt" | "terminal-audit",
    public readonly receipt?: AgentExecutionReceiptV1,
  ) {
    super(code, message);
    this.name = "HonuaAgentExecutionError";
  }
}

export type AgentCanonicalPayload = JsonValue;
