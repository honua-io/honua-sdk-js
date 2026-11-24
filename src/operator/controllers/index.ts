/**
 * `@honua/app-platform/operator/controllers` — framework-neutral controllers behind the
 * operator-native component architecture.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */
export { ApprovalController } from "./approval.js";
export type { ApprovalControllerOptions, ApprovalEvent } from "./approval.js";

export { BuilderController } from "./builder-workspace.js";
export type {
  BuilderControllerOptions,
  BuilderEvent,
  PreviewHandle,
} from "./builder-workspace.js";

export { ChatController } from "./chat.js";
export type { ChatControllerOptions, ChatEvent, DecorateTurn } from "./chat.js";

export { ClarificationController } from "./clarification.js";
export type {
  ClarificationControllerOptions,
  ClarificationEvent,
  ClarificationState,
} from "./clarification.js";

export { ExecutionController } from "./execution.js";
export type { ExecutionControllerOptions, ExecutionEvent } from "./execution.js";

export { MapController } from "./map-workspace.js";
export type {
  MapFactory,
  MapFactoryResult,
  MapControllerOptions,
  MapEvent,
} from "./map-workspace.js";

export { PlanReviewController } from "./plan-review.js";
export type {
  DecorateStep,
  PlanReviewControllerOptions,
  PlanReviewEvent,
  PlanRevisionRequest,
} from "./plan-review.js";
