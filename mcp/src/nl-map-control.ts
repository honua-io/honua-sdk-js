import {
  type AgentApprovalUseConsumer,
  verifyAgentApproval,
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
import { type JsonValue, canonicalStringify, sha256, toJsonValue } from "@honua/sdk-js/query-planner";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { snapshotMcpJson } from "./stable-json.js";

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
const PUBLIC_ERROR_CODES = new Set([
  "aborted",
  "approval-expired",
  "approval-invalid",
  "approval-required",
  "authorization-scope-denied",
  "cancelled",
  "context-mismatch",
  "fixture-mismatch",
  "integrity-failed",
  "invalid-input",
  "invalid-options",
  "plan-invalid",
  "plan-required",
  "policy-denied",
  "refusal",
  "retries-exhausted",
  "signature-invalid",
  "unsafe-output",
]);

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
  public readonly code: "approval-required" | "authorization-scope-denied" | "invalid-input" | "unsafe-output";

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
      const signal = requestSignal(context);
      signal?.throwIfAborted();
      const request = snapshotMcpObject(input, "proposeMapPlan input");
      const instruction = request.instruction;
      if (typeof instruction !== "string" || instruction.trim().length === 0 || instruction.length > 16_384) {
        throw new HonuaNlMapMcpError("invalid-input", "proposeMapPlan requires a non-empty instruction");
      }
      const plan = parseMcpPlan(
        await control.propose(instruction, {
          ...(signal ? { signal } : {}),
        }),
      );
      signal?.throwIfAborted();
      assertMcpSafePlan(plan);
      return Object.freeze({ plan, approvalRequired: planRequiresMcpApproval(plan) });
    },
    async execute(
      input: { readonly plan: unknown; readonly approval?: unknown },
      context: NlMapControlMcpRequestContext = {},
    ) {
      const signal = requestSignal(context);
      signal?.throwIfAborted();
      const request = snapshotMcpObject(input, "executeMapPlan input");
      const plan = parseMcpPlan(request.plan);
      assertMcpSafePlan(plan);
      const approval = request.approval === undefined ? undefined : (request.approval as unknown as NlMapPlanApproval);
      if (approval === undefined && planRequiresMcpApproval(plan)) {
        throw new HonuaNlMapMcpError(
          "approval-required",
          "MCP source-scoped and effectful map plans require a signed approval envelope",
        );
      }

      if (approval !== undefined) {
        const authorizationTime = now();
        await verifyAgentApproval(
          approval.dryRun,
          approval.policy,
          approval.approval,
          approvalVerifier,
          approval.context,
          {
            now: authorizationTime,
            ...(signal ? { signal } : {}),
          },
        );
        signal?.throwIfAborted();
        assertApprovalPlanIdentity(plan, approval);

        const transportScopes = requestAuthorizationScopes(context);
        const grantedInput = resolveAuthorizationScopes
          ? await resolveAuthorizationScopes(transportScopes)
          : transportScopes;
        signal?.throwIfAborted();
        const grantedScopes = snapshotAuthorizationScopes(grantedInput, "resolved authorization scopes");
        assertAuthorizationScopes(approval, grantedScopes);

        for (let index = 0; index < plan.steps.length; index += 1) {
          signal?.throwIfAborted();
          const step = plan.steps[index];
          const approvedStep = approval.dryRun.plan.steps[index];
          const sourceId = authorizationSourceId(step, approvedStep.source.id);
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
              sourceId,
              queryPlan: approvedStep.queryPlan,
              fields: approvedStep.fields,
              parameters: toJsonValue((step.call as { readonly args?: Record<string, unknown> }).args ?? {}),
            },
            approvalUseConsumer,
            {
              now: authorizationTime,
              ...(signal ? { signal } : {}),
            },
          );
        }
      }

      signal?.throwIfAborted();
      const execution = await control.execute(plan, {
        ...(approval ? { approval } : {}),
        ...(signal ? { signal } : {}),
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
      description: `${executeDefinition.description} In the MCP host, source-scoped reads also require a signed approval so transport scopes can be matched to the exact source binding.`,
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

function snapshotMcpObject(
  input: unknown,
  label: string,
  code: HonuaNlMapMcpError["code"] = "invalid-input",
): Readonly<Record<string, JsonValue>> {
  try {
    const snapshot = snapshotMcpJson(input, label);
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new TypeError(`${label} must be an object`);
    }
    return snapshot as Readonly<Record<string, JsonValue>>;
  } catch {
    throw new HonuaNlMapMcpError(code, `${label} is not safe bounded JSON`);
  }
}

function requestSignal(context: NlMapControlMcpRequestContext): AbortSignal | undefined {
  const value = requestContextProperty(context, "signal");
  if (value === undefined) return undefined;
  try {
    if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  } catch {
    throw new HonuaNlMapMcpError("invalid-input", "MCP request context contains an invalid signal");
  }
  return value;
}

function requestAuthorizationScopes(context: NlMapControlMcpRequestContext): readonly string[] {
  const value = requestContextProperty(context, "transportAuthorizationScopes");
  return snapshotAuthorizationScopes(value ?? [], "transport authorization scopes");
}

function requestContextProperty(
  context: NlMapControlMcpRequestContext,
  key: keyof NlMapControlMcpRequestContext,
): unknown {
  try {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new TypeError("context must be an object");
    }
    const prototype = Object.getPrototypeOf(context);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("context must be plain");
    const descriptor = Reflect.getOwnPropertyDescriptor(context, key);
    if (!descriptor) return undefined;
    if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError("context property must be data");
    return descriptor.value;
  } catch {
    throw new HonuaNlMapMcpError("invalid-input", "MCP request context could not be read safely");
  }
}

function snapshotAuthorizationScopes(input: unknown, label: string): readonly string[] {
  let snapshot: JsonValue;
  try {
    snapshot = snapshotMcpJson(input, label);
  } catch {
    throw new HonuaNlMapMcpError("invalid-input", `${label} are not safe bounded JSON`);
  }
  if (
    !Array.isArray(snapshot) ||
    snapshot.length > 128 ||
    snapshot.some((scope) => typeof scope !== "string" || scope.length === 0 || hasControlCharacters(scope))
  ) {
    throw new HonuaNlMapMcpError("invalid-input", `${label} must be a bounded list of non-empty strings`);
  }
  return Object.freeze([...new Set(snapshot as readonly string[])].sort());
}

function parseMcpPlan(input: unknown): NlMapPlan {
  const plan = snapshotMcpObject(input, "NL map plan") as unknown as NlMapPlan;
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
    authorizationSourceId(step, approved.source.id);
  }
}

function authorizationSourceId(step: NlMapPlan["steps"][number], approvedSourceId: string): string {
  const sourceId = (step.call as { readonly args?: Readonly<Record<string, unknown>> }).args?.sourceId;
  if (sourceId !== undefined) {
    if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId !== approvedSourceId) {
      throw new HonuaNlMapMcpError(
        "invalid-input",
        "approval source binding does not match the supplied map operation",
      );
    }
    return sourceId;
  }
  return approvedSourceId;
}

function planRequiresMcpApproval(plan: NlMapPlan): boolean {
  return (
    !plan.readOnly ||
    plan.steps.some(
      (step) => (step.call as { readonly args?: Readonly<Record<string, unknown>> }).args?.sourceId !== undefined,
    )
  );
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
  assertMcpSafeJson(plan, "NL map plan");
}

function assertMcpSafeJson(value: unknown, label: string): void {
  let original: string;
  let redacted: string;
  try {
    original = canonicalStringify(toJsonValue(value));
    redacted = canonicalStringify(toJsonValue(redactForMcp(value)));
  } catch {
    throw new HonuaNlMapMcpError("invalid-input", `${label} is not safe canonical JSON`);
  }
  if (original !== redacted) {
    throw new HonuaNlMapMcpError(
      "unsafe-output",
      `${label} contains credential, cursor, or endpoint material that cannot cross the MCP boundary`,
    );
  }
}

function executionResponse(execution: NlMapPlanExecution): McpNlMapExecutionResponse {
  const sdkReceipt = execution.receipt;
  const unsignedReceipt = snapshotMcpObject(
    {
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
    },
    "MCP execution receipt",
    "unsafe-output",
  );
  assertMcpSafeJson(unsignedReceipt, "MCP execution receipt");
  const receiptDigest = sha256(canonicalStringify(toJsonValue(unsignedReceipt)));
  const receipt = snapshotMcpObject(
    {
      ...unsignedReceipt,
      id: `mcpreceipt_${receiptDigest.slice("sha256:".length, "sha256:".length + 16)}`,
      receiptDigest,
    },
    "MCP execution receipt",
    "unsafe-output",
  ) as unknown as McpNlMapReceipt;
  const response = snapshotMcpObject(
    {
      planId: execution.planId,
      planFingerprint: execution.planFingerprint,
      mode: execution.mode,
      outcome: execution.outcome,
      receipt,
    },
    "MCP execution response",
    "unsafe-output",
  ) as unknown as McpNlMapExecutionResponse;
  assertMcpSafeJson(response, "MCP execution response");
  return response;
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
  try {
    if (error && typeof error === "object") {
      const descriptor = Reflect.getOwnPropertyDescriptor(error, "code");
      const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof code === "string" && PUBLIC_ERROR_CODES.has(code)) return code;
    }
  } catch {
    return "execution-refused";
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
    case "context-mismatch":
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

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function redactText(value: string): string {
  return value
    .replace(URL_TEXT, "[REDACTED_URL]")
    .replace(CREDENTIAL_TEXT, "[REDACTED]")
    .replace(CURSOR_TEXT, "[REDACTED]");
}
