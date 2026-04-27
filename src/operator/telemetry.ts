/**
 * Operator-stage telemetry. Mirrors the before/after/error collector
 * shape in `HonuaRuntimeTelemetry` (`src/runtime/runtime.ts`) so that an
 * embedder wiring one observer can feed both surfaces without inventing
 * a parallel pipeline.
 *
 * @module
 */

export type OperatorTelemetryKind =
  | "chat-turn"
  | "intent-draft"
  | "clarify"
  | "plan-load"
  | "plan-accept"
  | "execution-start"
  | "execution-terminal"
  | "map-load"
  | "map-refine"
  | "app-load"
  | "app-refine"
  | "approval-load"
  | "approval-confirm"
  | "approval-audit";

export interface OperatorTelemetrySpan {
  kind: OperatorTelemetryKind;
  intentId: string | undefined;
  startedAt: number;
  detail?: Record<string, unknown>;
}

export interface OperatorTelemetrySpanResult extends OperatorTelemetrySpan {
  finishedAt: number;
  durationMs: number;
  error?: unknown;
}

export interface OperatorTelemetry {
  before?: (span: OperatorTelemetrySpan) => void;
  after?: (span: OperatorTelemetrySpanResult) => void;
  error?: (span: OperatorTelemetrySpanResult) => void;
}
