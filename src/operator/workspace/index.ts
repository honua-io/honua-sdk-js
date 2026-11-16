/**
 * `@honua/app-platform/operator/workspace` — operator workspace state container.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */
export { OperatorShell } from "./workspace.js";
export type { OperatorShellOptions } from "./workspace.js";
export type {
  Unsubscribe,
  OperatorShellEvent,
  OperatorShellEventListener,
} from "./events.js";
export type {
  AnalysisIntent,
  AnalysisPlan,
  AppVersion,
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalState,
  ArtifactRef,
  BuilderIntent,
  BuilderPlan,
  ClarificationAnswer,
  ClarificationField,
  ClarificationFieldOption,
  ClarificationFieldType,
  ConversationTurn,
  DeploymentPlan,
  ExecutionResult,
  ExecutionResultKind,
  OperatorIntent,
  OperatorPlan,
  PlanStep,
  ProvenanceRecord,
  PublishingPlan,
  TurnRole,
} from "./types.js";
