/**
 * `OperatorClient` — consumer-facing transport interface every operator
 * controller depends on. Authored in this module so controllers and
 * tests are not blocked on a downstream `HonuaClient` extension; the
 * shipping `HonuaClient` is expected to implement this interface
 * (mirroring how `#21` shipped runtime code against an interface its
 * server counterpart later filled in).
 *
 * The interface names operator methods only — wire framing
 * (HTTP/MCP/gRPC) is the implementer's choice.
 *
 * @module
 */

import type { IJobRun } from "../contract/index.js";
import type { HonuaMapPackage } from "../runtime/index.js";
import type {
  AnalysisIntent,
  AnalysisPlan,
  AppPackage,
  ApprovalDecision,
  BuilderIntent,
  BuilderPlan,
  ClarificationAnswer,
  DeploymentPlan,
  ExecutionResult,
  PublishingPlan,
} from "./workspace/types.js";

export interface ChatChunk {
  readonly turnId: string;
  readonly delta: string;
  readonly done: boolean;
  readonly intentDraft?: AnalysisIntent | BuilderIntent;
}

/**
 * Minimal operator transport surface. The full interface is consumed by
 * the controllers in `src/operator/controllers/`.
 */
export interface OperatorClientApi {
  chat(text: string, signal?: AbortSignal): AsyncIterable<ChatChunk>;
  clarify(
    intentId: string,
    answers: ReadonlyArray<ClarificationAnswer>,
    signal?: AbortSignal,
  ): Promise<AnalysisIntent | BuilderIntent>;
  getPlan(
    intentId: string,
    signal?: AbortSignal,
  ): Promise<AnalysisPlan | PublishingPlan | BuilderPlan | DeploymentPlan>;
  submitPlan(
    plan: AnalysisPlan | PublishingPlan | BuilderPlan | DeploymentPlan,
    signal?: AbortSignal,
  ): Promise<IJobRun<ExecutionResult>>;
  refineMap(intentId: string, prompt: string, signal?: AbortSignal): Promise<HonuaMapPackage>;
  refineApp(intentId: string, prompt: string, signal?: AbortSignal): Promise<AppPackage>;
  getApproval(operationId: string, signal?: AbortSignal): Promise<ApprovalDecision>;
  confirmApproval(operationId: string, signal?: AbortSignal): Promise<ApprovalDecision>;
}

/**
 * `HonuaClient` (or any caller-supplied client) must expose the operator
 * methods on a stable `operator` namespace. The operator surface is
 * isolated so that pre-operator embedders pay no cost and adapter
 * extensions do not collide with operator method names.
 */
export interface OperatorClient {
  readonly operator: OperatorClientApi;
}

/**
 * The fixed output key the server places the single execution result
 * under in `JobResult<ExecutionResult>.outputs`. Naming the key in one
 * place lets controllers read it without spreading wire-shape knowledge.
 * If the server contract renames the key, only this constant changes.
 */
export const OPERATOR_EXECUTION_OUTPUT_KEY = "result";
