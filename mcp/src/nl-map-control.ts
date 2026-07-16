import {
  type AgentApprovalUseConsumer,
  type AgentEnvelopeVerifier,
  verifyAgentStepAuthorization,
} from "@honua/sdk-js/agent-safety";
import {
  type CreateNlMapControlOptions,
  NL_MAP_CONTROL_TOOL_DEFINITIONS,
  NL_MAP_CONTROL_VERSION,
  NL_MAP_PLAN_KIND,
  type NlMapControl,
  type NlMapPlan,
  type NlMapPlanApproval,
  type NlMapPlanExecution,
  agentEffectForNlEffect,
  createNlMapControl,
  hashNlMapPlan,
} from "@honua/sdk-js/nl-map-control";
import { canonicalStringify, sha256, toJsonValue } from "@honua/sdk-js/query-planner";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const MCP_NL_MAP_RECEIPT_KIND = "honua.mcp-nl-map-receipt" as const;
const PLAN_ID = /^nlplan_[0-9a-f]{16}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "cursor",
  "endpoint",
  "password",
  "refreshtoken",
  "resumetoken",
  "secret",
  "signedurl",
  "token",
  "url",
  "uri",
  "watermark",
]);
const CREDENTIAL_TEXT =
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/giu;
const CURSOR_TEXT = /\b(?:cursor|resume[_ -]?token|watermark)\s*[:=]\s*[^\s,;]+/giu;
const URL_TEXT = /https?:\/\/[^\s"'<>]+/giu;

export interface NlMapControlMcpRequestContext {
  readonly signal?: AbortSignal;
  /** Scopes authenticated by the MCP transport. Caller arguments never populate this field. */
  readonly transportAuthorizationScopes?: readonly string[];
}

export interface CreateNlMapControlMcpHostOptions {
  /** The identical controller configuration used by the in-app NL surface. */
  readonly control: CreateNlMapControlOptions;
  /** Atomic, host-authenticated approval-use store. Required for every approved MCP execution. */
  readonly approvalUseConsumer: AgentApprovalUseConsumer;
  /**
   * Resolve trusted scopes for transports without MCP `authInfo` (for example an
   * embedded stdio host). The input contains transport-authenticated scopes only.
   */
  readonly resolveAuthorizationScopes?: (
    transportScopes: readonly string[],
  ) => readonly string[] | Promise<readonly string[]>;
}

export interface McpNlMapPlanResponse {
  readonly plan: NlMapPlan;
  readonly approvalRequired: boolean;
}

export interface McpNlMapReceipt {
  readonly kind: typeof MCP_NL_MAP_RECEIPT_KIND;
  readonly version: typeof NL_MAP_CONTROL_VERSION;
  readonly id: string;
  readonly planId: string;
  readonly planFingerprint: `sha256:${string}`;
  readonly mode: NlMapPlanExecution["mode"];
  readonly outcome: NlMapPlanExecution["outcome"];
  readonly approvalDigest?: `sha256:${string}`;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly steps: NlMapPlanExecution["receipt"]["steps"];
  /** Digest of the SDK receipt retained by the host. Its raw instruction is never returned over MCP. */
  readonly sdkReceiptDigest: `sha256:${string}`;
  readonly receiptDigest: `sha256:${string}`;
}

export interface McpNlMapExecutionResponse {
  readonly planId: string;
  readonly planFingerprint: `sha256:${string}`;
  readonly mode: NlMapPlanExecution["mode"];
  readonly outcome: NlMapPlanExecution["outcome"];
  readonly receipt: McpNlMapReceipt;
}

export interface NlMapControlMcpHost {
  readonly control: NlMapControl;
  propose(
    input: { readonly instruction: string },
    context?: NlMapControlMcpRequestContext,
  ): Promise<McpNlMapPlanResponse>;
  execute(
    input: { readonly plan: unknown; readonly approval?: unknown },
    context?: NlMapControlMcpRequestContext,
  ): Promise<McpNlMapExecutionResponse>;
}

class HonuaNlMapMcpError extends Error {
  public readonly code: "authorization-scope-denied" | "invalid-input" | "unsafe-output";

  public constructor(code: HonuaNlMapMcpError["code"], message: string) {
    super(message);
    this.name = "HonuaNlMapMcpError";
    this.code = code;
  }
}

/**
 * Bind the experimental NL map controller to the MCP trust boundary.
 *
 * The host pre-authorizes and atomically consumes every approved step before
 * delegating to `createNlMapControl`. This preserves the SDK's exact plan and
 * signature checks while preventing approval replay through a second transport
 * call. No caller-provided credential or cursor is included in MCP output.
 */
export function createNlMapControlMcpHost(options: CreateNlMapControlMcpHostOptions): NlMapControlMcpHost {
  if (!options?.control?.approvalVerifier) {
    throw new TypeError("NL map MCP hosting requires control.approvalVerifier");
  }
  if (!options.approvalUseConsumer) {
    throw new TypeError("NL map MCP hosting requires an atomic approvalUseConsumer");
  }
  const control = createNlMapControl(options.control);
  const approvalVerifier = options.control.approvalVerifier;
  const approvalUseConsumer = options.approvalUseConsumer;
  const resolveAuthorizationScopes = options.resolveAuthorizationScopes;
  const configuredNow = options.control.policy?.now;
  const now = (): string => configuredNow?.() ?? new Date().toISOString();

  return Object.freeze({
    control,
    async propose(input: { readonly instruction: string }, context: NlMapControlMcpRequestContext = {}) {
      context.signal?.throwIfAborted();
      if (typeof input?.instruction !== "string" || input.instruction.trim().length === 0) {
        throw new HonuaNlMapMcpError("invalid-input", "proposeMapPlan requires a non-empty instruction");
      }
      const plan = await control.propose(input.instruction, {
        ...(context.signal ? { signal: context.signal } : {}),
      });
      assertMcpSafePlan(plan);
      return Object.freeze({ plan, approvalRequired: !plan.readOnly });
    },
    async execute(
      input: { readonly plan: unknown; readonly approval?: unknown },
      context: NlMapControlMcpRequestContext = {},
    ) {
      const plan = parseMcpPlan(input?.plan);
      assertMcpSafePlan(plan);
      const approval = input?.approval === undefined ? undefined : (input.approval as NlMapPlanApproval);

      if (approval !== undefined) {
        assertApprovalPlanIdentity(plan, approval);
        const transportScopes = [...(context.transportAuthorizationScopes ?? [])];
        const grantedScopes = resolveAuthorizationScopes
          ? await resolveAuthorizationScopes(transportScopes)
          : transportScopes;
        assertAuthorizationScopes(approval, grantedScopes);
        const authorizationTime = now();
        for (let index = 0; index < plan.steps.length; index += 1) {
          context.signal?.throwIfAborted();
          const step = plan.steps[index];
          const approvedStep = approval.dryRun.plan.steps[index];
          await verifyAgentStepAuthorization(
            approval.dryRun,
            approval.policy,
            approval.approval,
            approvalVerifier,
            approval.context,
            step.id,
            {
              tool: step.tool,
              effect: agentEffectForNlEffect(step.effect),
              sourceId: approvedStep.source.id,
              queryPlan: approvedStep.queryPlan,
              fields: approvedStep.fields,
              parameters: toJsonValue((step.call as { readonly args?: Record<string, unknown> }).args ?? {}),
            },
            approvalUseConsumer,
            {
              now: authorizationTime,
              ...(context.signal ? { signal: context.signal } : {}),
            },
          );
        }
      }

      context.signal?.throwIfAborted();
      const execution = await control.execute(plan, {
        ...(approval ? { approval } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return executionResponse(execution);
    },
  });
}

const proposeSchema = z
  .object({
    instruction: z.string().trim().min(1).max(16_384),
  })
  .strict();

const executeSchema = z
  .object({
    plan: z.record(z.string(), z.unknown()),
    approval: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Register `proposeMapPlan` and `executeMapPlan` on a real MCP server. */
export function registerNlMapControlMcpTools(server: McpServer, host: NlMapControlMcpHost): void {
  const proposeDefinition = NL_MAP_CONTROL_TOOL_DEFINITIONS[0];
  const executeDefinition = NL_MAP_CONTROL_TOOL_DEFINITIONS[1];

  server.registerTool(
    proposeDefinition.name,
    {
      title: proposeDefinition.title,
      description: proposeDefinition.description,
      inputSchema: proposeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        return successResult(
          await host.propose(args, {
            signal: extra.signal,
            transportAuthorizationScopes: extra.authInfo?.scopes ?? [],
          }),
        );
      } catch (error) {
        return errorResult(error, extra.signal);
      }
    },
  );

  server.registerTool(
    executeDefinition.name,
    {
      title: executeDefinition.title,
      description: executeDefinition.description,
      inputSchema: executeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        return successResult(
          await host.execute(
            { plan: args.plan, ...(args.approval === undefined ? {} : { approval: args.approval }) },
            {
              signal: extra.signal,
              transportAuthorizationScopes: extra.authInfo?.scopes ?? [],
            },
          ),
        );
      } catch (error) {
        return errorResult(error, extra.signal);
      }
    },
  );
}

function parseMcpPlan(input: unknown): NlMapPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HonuaNlMapMcpError("invalid-input", "executeMapPlan requires a proposed plan");
  }
  const plan = input as NlMapPlan;
  if (
    plan.kind !== NL_MAP_PLAN_KIND ||
    plan.version !== NL_MAP_CONTROL_VERSION ||
    typeof plan.id !== "string" ||
    !PLAN_ID.test(plan.id) ||
    typeof plan.fingerprint !== "string" ||
    !DIGEST.test(plan.fingerprint) ||
    !Array.isArray(plan.steps) ||
    plan.steps.length === 0
  ) {
    throw new HonuaNlMapMcpError("invalid-input", "executeMapPlan requires a valid NL map plan identity");
  }
  let fingerprint: `sha256:${string}`;
  try {
    fingerprint = hashNlMapPlan(plan);
  } catch {
    throw new HonuaNlMapMcpError("invalid-input", "executeMapPlan plan content is not canonical JSON");
  }
  const expectedId = `nlplan_${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`;
  if (fingerprint !== plan.fingerprint || plan.id !== expectedId) {
    throw new HonuaNlMapMcpError("invalid-input", "executeMapPlan plan identity does not match its content");
  }
  return plan;
}

function assertApprovalPlanIdentity(plan: NlMapPlan, approval: NlMapPlanApproval): void {
  if (
    !approval ||
    typeof approval !== "object" ||
    !approval.dryRun ||
    approval.dryRun.plan.id !== plan.id ||
    approval.dryRun.plan.steps.length !== plan.steps.length
  ) {
    throw new HonuaNlMapMcpError("invalid-input", "approval does not bind to the supplied plan identity");
  }
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    const approved = approval.dryRun.plan.steps[index];
    if (
      approved.id !== step.id ||
      approved.tool !== step.tool ||
      approved.effect !== agentEffectForNlEffect(step.effect) ||
      approved.queryPlan.fingerprint !== plan.fingerprint
    ) {
      throw new HonuaNlMapMcpError("invalid-input", "approval step identity does not match the supplied plan");
    }
  }
}

function assertAuthorizationScopes(approval: NlMapPlanApproval, grantedInput: readonly string[]): void {
  const granted = new Set(grantedInput);
  const required = new Set(approval.dryRun.plan.steps.flatMap((step) => [...step.source.authorizationScope]));
  for (const scope of required) {
    if (!granted.has(scope)) {
      throw new HonuaNlMapMcpError(
        "authorization-scope-denied",
        "MCP transport authorization does not cover the approved map operation",
      );
    }
  }
}

function assertMcpSafePlan(plan: NlMapPlan): void {
  let original: string;
  let redacted: string;
  try {
    original = canonicalStringify(toJsonValue(plan));
    redacted = canonicalStringify(toJsonValue(redactForMcp(plan)));
  } catch {
    throw new HonuaNlMapMcpError("invalid-input", "NL map plan is not safe canonical JSON");
  }
  if (original !== redacted) {
    throw new HonuaNlMapMcpError(
      "unsafe-output",
      "NL map plan contains credential, cursor, or endpoint material that cannot cross the MCP boundary",
    );
  }
}

function executionResponse(execution: NlMapPlanExecution): McpNlMapExecutionResponse {
  const sdkReceipt = execution.receipt;
  const unsignedReceipt = {
    kind: MCP_NL_MAP_RECEIPT_KIND,
    version: NL_MAP_CONTROL_VERSION,
    planId: execution.planId,
    planFingerprint: execution.planFingerprint,
    mode: execution.mode,
    outcome: execution.outcome,
    ...(sdkReceipt.approvalDigest ? { approvalDigest: sdkReceipt.approvalDigest } : {}),
    startedAt: sdkReceipt.startedAt,
    completedAt: sdkReceipt.completedAt,
    steps: sdkReceipt.steps,
    sdkReceiptDigest: sdkReceipt.receiptDigest,
  };
  const receiptDigest = sha256(canonicalStringify(toJsonValue(unsignedReceipt)));
  const receipt: McpNlMapReceipt = Object.freeze({
    ...unsignedReceipt,
    id: `mcpreceipt_${receiptDigest.slice("sha256:".length, "sha256:".length + 16)}`,
    receiptDigest,
  });
  return Object.freeze({
    planId: execution.planId,
    planFingerprint: execution.planFingerprint,
    mode: execution.mode,
    outcome: execution.outcome,
    receipt,
  });
}

function successResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function errorResult(error: unknown, signal: AbortSignal): CallToolResult {
  const code = signal.aborted ? "cancelled" : safeErrorCode(error);
  const message = safeErrorMessage(code);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  };
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : "execution-refused";
  }
  return "execution-refused";
}

function safeErrorMessage(code: string): string {
  switch (code) {
    case "cancelled":
    case "aborted":
      return "The map-plan request was cancelled before execution.";
    case "authorization-scope-denied":
      return "The authenticated MCP scopes do not authorize this map plan.";
    case "approval-required":
      return "This map plan requires a signed approval envelope.";
    case "approval-expired":
      return "The map-plan approval has expired.";
    case "policy-denied":
      return "The map-plan approval was denied or has already been used.";
    case "signature-invalid":
    case "integrity-failed":
    case "approval-invalid":
      return "The map-plan approval could not be verified.";
    case "plan-invalid":
    case "plan-required":
    case "invalid-input":
      return "The supplied map plan or approval is invalid.";
    case "unsafe-output":
      return "The plan was refused because its output would expose sensitive material.";
    default:
      return "The map-plan request was refused safely.";
  }
}

function redactForMcp(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEYS.has(normalizeKey(key))) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactForMcp(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, redactForMcp(child, name)]));
  }
  return value;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function redactText(value: string): string {
  return value
    .replace(URL_TEXT, "[REDACTED_URL]")
    .replace(CREDENTIAL_TEXT, "[REDACTED]")
    .replace(CURSOR_TEXT, "[REDACTED]");
}
