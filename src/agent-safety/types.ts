import type { JsonValue } from "../query-planner/index.js";

export const AGENT_PLAN_KIND = "honua.agent-plan" as const;
export const AGENT_DRY_RUN_KIND = "honua.agent-dry-run" as const;
export const AGENT_APPROVAL_KIND = "honua.agent-approval" as const;
export const AGENT_RECEIPT_KIND = "honua.agent-execution-receipt" as const;
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
  readonly step: AgentPlanStepV1;
  /** Frozen operation snapshot; executors must consume this value only. */
  readonly operation: AgentOperationInputV1;
  readonly planDigest: AgentDigest;
  readonly approvalDigest: AgentDigest;
  readonly inputDigest: AgentDigest;
  readonly useDigest: AgentDigest;
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
}

export interface AgentPlanPolicyV1 {
  readonly allowedTools: readonly string[];
  readonly allowedEffects?: readonly AgentEffect[];
  readonly sources: Readonly<Record<string, AgentSourcePolicyV1>>;
  readonly maxSteps: number;
  readonly maxRows: number;
  readonly maxBytes: number;
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
  /** Atomically return true only for the first consumption of this key. */
  consume(
    use: {
      readonly approvalDigest: AgentDigest;
      readonly stepId: string;
      readonly inputDigest: AgentDigest;
    },
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface AgentExecutionContextV1 {
  readonly sources: Readonly<Record<string, AgentSourceBindingV1>>;
}

export interface AgentExecutionEvidenceV1 {
  readonly id: string;
  readonly stepId: string;
  readonly inputDigest: AgentDigest;
  readonly useDigest: AgentDigest;
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
}

export type AgentSafetyErrorCode =
  | "aborted"
  | "invalid-input"
  | "policy-denied"
  | "integrity-failed"
  | "approval-expired"
  | "context-mismatch"
  | "signature-invalid";

export class HonuaAgentSafetyError extends Error {
  public constructor(
    public readonly code: AgentSafetyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HonuaAgentSafetyError";
  }
}

export type AgentCanonicalPayload = JsonValue;
