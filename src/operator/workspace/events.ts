/**
 * `WorkspaceEvent` — typed event union the `OperatorWorkspace` emits as
 * the cross-surface state machine advances. Embedders subscribe via
 * `OperatorWorkspace.on()` to hook intermediate transitions without
 * subclassing controllers.
 *
 * @module
 */

import type { HonuaMapPackage } from "../../runtime/index.js";
import type { HonuaOperatorError } from "../errors.js";
import type {
  AnalysisIntent,
  AnalysisPlan,
  AppPackage,
  ApprovalDecision,
  BuilderIntent,
  BuilderPlan,
  ConversationTurn,
  DeploymentPlan,
  ExecutionResult,
  PublishingPlan,
} from "./types.js";

export type WorkspaceEvent =
  | { kind: "turn-updated"; turn: ConversationTurn }
  | { kind: "intent-drafted"; intent: AnalysisIntent | BuilderIntent }
  | { kind: "clarification-needed"; intent: AnalysisIntent | BuilderIntent }
  | { kind: "clarification-answered"; intent: AnalysisIntent | BuilderIntent }
  | { kind: "plan-loaded"; plan: AnalysisPlan | PublishingPlan | BuilderPlan | DeploymentPlan }
  | { kind: "plan-accepted"; plan: AnalysisPlan | PublishingPlan | BuilderPlan | DeploymentPlan }
  | { kind: "execution-started"; executionId: string }
  | { kind: "execution-progress"; executionId: string; percent?: number; message?: string }
  | { kind: "execution-terminal"; executionId: string; result: ExecutionResult }
  | { kind: "execution-dismissed"; executionId: string }
  | { kind: "map-loaded"; pkg: HonuaMapPackage }
  | { kind: "map-refined"; pkg: HonuaMapPackage }
  | { kind: "app-loaded"; pkg: AppPackage }
  | { kind: "app-refined"; pkg: AppPackage }
  | { kind: "approval-required"; decision: ApprovalDecision }
  | { kind: "approval-resolved"; decision: ApprovalDecision }
  | { kind: "error"; error: HonuaOperatorError; recoverable: boolean };

export type WorkspaceEventListener = (event: WorkspaceEvent) => void;
export type Unsubscribe = () => void;
