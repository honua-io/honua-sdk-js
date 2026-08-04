import { HonuaCapabilityNotSupportedError } from "@honua/sdk-js";
import type { Capability, Protocol } from "@honua/sdk-js";
import { explainHonuaCapabilityGap } from "@honua/sdk-js/agent-tools";
import { CAPABILITIES, PROTOCOLS } from "@honua/sdk-js/contract";
import { z } from "zod";
import { jsonText } from "../helpers.js";
import { FilterInputError } from "./filter.js";
import { SourceRefError } from "./source-ref.js";

/**
 * CAPABILITY HONESTY on the tool surface (#1005).
 *
 * The SDK's contract is that a capability gap throws
 * `HonuaCapabilityNotSupportedError` rather than returning empty data. That
 * guarantee is worthless if the MCP layer swallows the throw and hands the
 * model an empty feature list — the model would report "no features match"
 * for what is actually "this protocol cannot express that request".
 *
 * So every capability refusal becomes an explicit `isError` tool result
 * carrying a machine-actionable `code`, the refused capability/construct, the
 * protocol that refused it, and — for real capability identifiers — the same
 * explanation `honua_explain_capability_gap` would give, including what to do
 * instead. Degradations that DID produce an answer travel the other channel,
 * `Result.degraded`, and are reported alongside the data.
 */

/**
 * `kind` values come from the vendored geospatial-mcp `GeoprocessingError`
 * taxonomy — the standard forbids a parallel MCP-local error vocabulary, so a
 * capability refusal is an `ExecutionFailed` (a well-formed request the target
 * cannot run) and a bad argument is a `ValidationFailed`. The precise reason
 * travels in the envelope's machine-actionable `code` plus the typed fields.
 */
export type ToolErrorKind = "ValidationFailed" | "ExecutionFailed";

export interface ToolErrorViolation {
  readonly code: string;
  readonly message: string;
  readonly fieldPath?: string;
}

export interface ToolErrorPayload {
  readonly code: string;
  readonly error: {
    readonly kind: ToolErrorKind;
    readonly message: string;
    readonly capability?: string;
    readonly protocol?: string;
    readonly source?: string;
    readonly guidance?: string;
    readonly explanation?: unknown;
    readonly violations?: readonly ToolErrorViolation[];
  };
}

function isKnownCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

function isKnownProtocol(value: string): value is Protocol {
  return (PROTOCOLS as readonly string[]).includes(value);
}

/** Build the structured payload for a capability refusal. */
export function capabilityErrorPayload(error: HonuaCapabilityNotSupportedError): ToolErrorPayload {
  // Filter refusals name a construct (`filter.spatial.multiple`) rather than a
  // registry capability; only real capability identifiers can be explained
  // against the protocol capability registry.
  const explanation =
    isKnownCapability(error.capability) && (error.protocol === undefined || isKnownProtocol(error.protocol))
      ? explainHonuaCapabilityGap({
          capability: error.capability,
          ...(isKnownProtocol(error.protocol) ? { protocol: error.protocol } : {}),
          ...(error.sourceId ? { sourceId: error.sourceId } : {}),
        })
      : undefined;

  return {
    code: "capability_not_supported",
    error: {
      kind: "ExecutionFailed",
      message: error.message,
      capability: error.capability,
      protocol: error.protocol,
      ...(error.sourceId ? { source: error.sourceId } : {}),
      violations: [
        {
          code: "capability_not_supported",
          message: error.message,
          fieldPath: error.capability.startsWith("filter.") ? "filter" : "source",
        },
      ],
      guidance:
        explanation?.suggestedAction ??
        "This protocol cannot express the request exactly. Re-issue it against a source whose protocol advertises the capability, or restate the request within what this protocol supports — do not treat this as an empty result.",
      ...(explanation ? { explanation } : {}),
    },
  };
}

/** Build the structured payload for an invalid tool argument. */
export function validationErrorPayload(
  code: string,
  message: string,
  violations: readonly ToolErrorViolation[] = [{ code, message }],
): ToolErrorPayload {
  return {
    code,
    error: { kind: "ValidationFailed", message, violations },
  };
}

/**
 * Wrap a payload as an `isError` MCP tool result.
 *
 * The payload rides in both channels: `structuredContent` for clients (and the
 * certification error-shape contract) that branch on machine-readable fields,
 * and the text block for models that only read text.
 */
export function toolErrorResult(payload: ToolErrorPayload) {
  return {
    ...jsonText(payload),
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true as const,
  };
}

/** Map any thrown value onto a structured tool-error payload. */
export function toToolErrorPayload(error: unknown): ToolErrorPayload {
  if (error instanceof HonuaCapabilityNotSupportedError) {
    return capabilityErrorPayload(error);
  }
  if (error instanceof SourceRefError) {
    const code = error.code.toLowerCase();
    return validationErrorPayload(code, error.message, [{ code, message: error.message, fieldPath: "source" }]);
  }
  if (error instanceof FilterInputError) {
    const code = error.code.toLowerCase();
    return validationErrorPayload(code, error.message, [{ code, message: error.message, fieldPath: "filter" }]);
  }
  if (error instanceof z.ZodError) {
    return validationErrorPayload(
      "invalid_arguments",
      "Tool arguments failed validation.",
      error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        fieldPath: issue.path.join("."),
      })),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "tool_execution_failed",
    error: { kind: "ExecutionFailed", message, violations: [{ code: "tool_execution_failed", message }] },
  };
}

/**
 * Run a tool body, converting capability refusals and argument-validation
 * failures into structured `isError` results. Anything else is rethrown so a
 * genuine transport/server fault is not disguised as a data answer.
 */
export async function withCapabilityHonesty<T extends { content: unknown }>(
  run: () => Promise<T>,
): Promise<T | ReturnType<typeof toolErrorResult>> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof HonuaCapabilityNotSupportedError ||
      error instanceof SourceRefError ||
      error instanceof FilterInputError ||
      error instanceof z.ZodError
    ) {
      return toolErrorResult(toToolErrorPayload(error));
    }
    throw error;
  }
}
