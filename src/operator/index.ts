/**
 * Operator-native component architecture. Exposes framework-neutral
 * controllers and workspace orchestration for chat, clarification, plan
 * review, execution, map/app preview, and approval surfaces.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export { OPERATOR_EXECUTION_OUTPUT_KEY } from "./client.js";
export type { ChatChunk, OperatorClient, OperatorClientApi } from "./client.js";

export {
  HonuaOperatorApprovalError,
  HonuaOperatorAppError,
  HonuaOperatorExecutionError,
  HonuaOperatorIntentError,
  HonuaOperatorMapError,
  HonuaOperatorPlanError,
  isHonuaOperatorError,
} from "./errors.js";
export type {
  HonuaOperatorError,
  HonuaOperatorErrorStage,
  HonuaOperatorExecutionFailureKind,
} from "./errors.js";

export type {
  OperatorTelemetry,
  OperatorTelemetryKind,
  OperatorTelemetrySpan,
  OperatorTelemetrySpanResult,
} from "./telemetry.js";

export * from "./controllers/index.js";
export * from "./workspace/index.js";
export * from "./theming/index.js";
export * from "./i18n/index.js";
