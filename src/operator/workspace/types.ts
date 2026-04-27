/**
 * Operator workspace types — typed mirrors of the server-owned operator
 * domain (intents, plans, execution results, approval decisions). The
 * shapes follow the mirror-not-duplicate posture used by
 * `src/runtime/map-package.ts`: structurally typed, additive fields
 * preserved through round-trip, no parallel validation logic.
 *
 * `AppPackage` is forward-declared as a stub until the canonical server
 * shape is delivered alongside the `HonuaClient` operator transport.
 *
 * @module
 */

import type { HonuaMapPackage } from "../../runtime/index.js";

// ── Conversation ─────────────────────────────────────────────

export type TurnRole = "user" | "agent" | "system";

export interface ConversationTurn {
  readonly turnId: string;
  readonly role: TurnRole;
  readonly content: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly intentDraft?: AnalysisIntent | BuilderIntent;
}

// ── Clarification ────────────────────────────────────────────

export type ClarificationFieldType = "text" | "select" | "dataset-ref" | "expression";

export interface ClarificationFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface ClarificationField {
  readonly id: string;
  readonly label: string;
  readonly type: ClarificationFieldType;
  readonly options?: ReadonlyArray<ClarificationFieldOption>;
  readonly required: boolean;
}

export interface ClarificationAnswer {
  readonly fieldId: string;
  readonly value: string;
}

// ── Intents ──────────────────────────────────────────────────

export interface AnalysisIntent {
  readonly id: string;
  readonly kind: "analysis";
  readonly request: string;
  readonly assumptionPolicy?: "strict" | "permissive";
  readonly clarifications?: ReadonlyArray<ClarificationField>;
  readonly [extra: string]: unknown;
}

export interface BuilderIntent {
  readonly id: string;
  readonly kind: "builder";
  readonly request: string;
  readonly clarifications?: ReadonlyArray<ClarificationField>;
  readonly [extra: string]: unknown;
}

export type OperatorIntent = AnalysisIntent | BuilderIntent;

// ── Plans ────────────────────────────────────────────────────

export interface PlanStep {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly inputs?: ReadonlyArray<string>;
  readonly outputs?: ReadonlyArray<string>;
  readonly requiresApproval?: boolean;
  readonly estimatedCostUsd?: number;
  readonly [extra: string]: unknown;
}

export interface AnalysisPlan {
  readonly id: string;
  readonly intentId: string;
  readonly kind: "analysis";
  readonly steps: ReadonlyArray<PlanStep>;
  readonly [extra: string]: unknown;
}

export interface PublishingPlan {
  readonly id: string;
  readonly intentId: string;
  readonly kind: "publishing";
  readonly steps: ReadonlyArray<PlanStep>;
  readonly [extra: string]: unknown;
}

export interface BuilderPlan {
  readonly id: string;
  readonly intentId: string;
  readonly kind: "builder";
  readonly steps: ReadonlyArray<PlanStep>;
  readonly [extra: string]: unknown;
}

export interface DeploymentPlan {
  readonly id: string;
  readonly intentId: string;
  readonly kind: "deployment";
  readonly steps: ReadonlyArray<PlanStep>;
  readonly [extra: string]: unknown;
}

export type OperatorPlan = AnalysisPlan | PublishingPlan | BuilderPlan | DeploymentPlan;

// ── Execution ────────────────────────────────────────────────

export interface ArtifactRef {
  readonly id: string;
  readonly kind: "map-package" | "app-package" | "file" | "artifact";
  readonly url?: string;
  readonly [extra: string]: unknown;
}

/**
 * Forward-declared stub. The canonical server shape replaces this when
 * the `HonuaClient` operator transport ticket lands. Until then in-repo
 * fixtures drive `BuilderWorkspaceController` and its tests.
 */
export interface AppPackage {
  readonly id: string;
  readonly version: string;
  readonly assets: ReadonlyArray<ArtifactRef>;
  readonly metadata?: unknown;
  readonly [extra: string]: unknown;
}

export interface ProvenanceRecord {
  readonly step: string;
  readonly tool?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly [extra: string]: unknown;
}

export type ExecutionResultKind = "analysis" | "publishing" | "builder" | "deployment";

export interface ExecutionResult {
  readonly kind: ExecutionResultKind;
  readonly summary?: string;
  readonly mapPackage?: HonuaMapPackage;
  readonly appPackage?: AppPackage;
  readonly artifacts?: ReadonlyArray<ArtifactRef>;
  readonly provenance?: ReadonlyArray<ProvenanceRecord>;
  readonly [extra: string]: unknown;
}

// ── Approval ─────────────────────────────────────────────────

export type ApprovalState = "not-required" | "pending" | "granted" | "deferred" | "denied";

export interface ApprovalAuditEntry {
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly reason?: string;
}

export interface ApprovalDecision {
  readonly operationId: string;
  readonly state: ApprovalState;
  readonly scope: string;
  readonly reasons: ReadonlyArray<string>;
  readonly requiredRoles: ReadonlyArray<string>;
  readonly audit: ReadonlyArray<ApprovalAuditEntry>;
}
