/**
 * Operator workspace types — UI view models the operator controllers
 * and reference components consume. They are not the wire DTOs the
 * server emits; the canonical operator contract
 * (`honua-server/docs/archive/developer/AI_OPERATOR_CONTRACT.md`,
 * §AnalysisIntent, §ClarificationRequest, §ClarificationResponse,
 * §AnalysisPlan, §ExecutionJob) names different fields and uses
 * different shapes for the same semantic objects.
 *
 * The split is deliberate: controllers want form-friendly clarification
 * fields and a flat plan-step shape that the plan-review UI can
 * decorate, while the wire contract carries `planId`/`stepId`,
 * `dependsOn` adjacency, string-keyed `inputs` maps, and reason-coded
 * clarification questions. The `OperatorClient` implementation is
 * responsible for the bidirectional adapter at the transport boundary
 * (HTTP / MCP / gRPC); controllers in this module deliberately know
 * nothing about the wire framing.
 *
 * Adapter mapping responsibilities, by SDK type:
 *
 * - {@link ClarificationField} ↔ server `ClarificationQuestion`
 *   (`id` ↔ `questionId`, `label` ↔ `prompt`, `type` ↔ `kind`).
 * - {@link ClarificationAnswer} ↔ entries in the server's
 *   `ClarificationResponse.answers` map (`fieldId` is the
 *   `questionId`; `value` becomes a single-element string array on the
 *   wire — multi-select callers send the controller multiple
 *   `ClarificationAnswer` entries with the same `fieldId`).
 * - {@link PlanStep} ↔ server `PlanStep` (`id` ↔ `stepId`, `inputs`
 *   string array ↔ string-keyed `inputs` map, `outputs` string array
 *   ↔ server `outputs` artifact-kind enum, `dependsOn` is collapsed
 *   into the steps the controller orders).
 * - {@link AnalysisPlan} / {@link PublishingPlan} / {@link BuilderPlan} /
 *   {@link DeploymentPlan} ↔ server `AnalysisPlan` (`id` ↔ `planId`).
 *   Server-side `warnings[]` is preserved on the open `[extra: string]`
 *   index signature instead of being modelled at this layer.
 *
 * Shapes follow the mirror-not-duplicate posture used by
 * `src/runtime/map-package.ts`: structurally typed, additive fields
 * preserved through the open `[extra: string]: unknown` index signature,
 * no parallel validation logic.
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
