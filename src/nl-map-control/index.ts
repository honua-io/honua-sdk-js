/**
 * Natural-language map control: compile NL instructions into serializable,
 * inspectable plans over the agent-tools surface, and execute reviewed plans
 * only.
 *
 * The layer is plan-first per the north-star ADR: `propose()` turns an
 * instruction into a typed {@link NlMapPlan} (query-planner IR for data
 * operations plus ordered agent-tool invocations for map operations) and never
 * executes anything. `execute()` is the only execution path and accepts plans
 * only — never raw natural language. Read-only plans may auto-execute under
 * policy; anything mutating or viewport-changing requires a signed
 * agent-safety approval envelope. Every execution emits a receipt.
 *
 * The LLM transport is a caller-provided callback; this module depends on no
 * model-vendor SDK. Recorded request/response exchanges replay
 * deterministically through {@link createRecordedNlLlm}.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver
 *   contract — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

import {
  AGENT_PLAN_KIND,
  AGENT_SAFETY_VERSION,
  type AgentApprovalV1,
  type AgentDryRunV1,
  type AgentEffect,
  type AgentEnvelopeSigner,
  type AgentEnvelopeVerifier,
  type AgentExecutionContextV1,
  type AgentPlanPolicyV1,
  type AgentPlanStepV1,
  type AgentPlanV1,
  type AgentSourceBindingV1,
  digestAgentOperationInput,
  dryRunAgentPlan,
  issueAgentApproval,
  verifyAgentApproval,
} from "../agent-safety/index.js";
import {
  HONUA_AGENT_TOOL_DEFINITIONS,
  HONUA_AGENT_TOOL_NAMES,
  type HonuaAgentAuditEvent,
  type HonuaAgentContextOptions,
  type HonuaAgentJsonSchema,
  type HonuaAgentRuntime,
  type HonuaAgentSourceSummary,
  type HonuaAgentToolCall,
  type HonuaAgentToolDefinition,
  type HonuaAgentToolDefinitionLike,
  type HonuaAgentToolName,
  type HonuaAgentToolResult,
  type HonuaAgentToolStatus,
  type HonuaMcpCompatibleToolDefinition,
  type HonuaOpenAiToolDefinition,
  createHonuaAgentSystemPrompt,
  executeHonuaAgentTool,
  explainHonuaCapabilityGap,
  toHonuaMcpToolDefinitions,
  toHonuaOpenAiToolDefinitions,
} from "../agent-tools/index.js";
import type { Capability, Query } from "../contract/index.js";
import {
  type CanonicalQuery,
  type JsonValue,
  canonicalStringify,
  canonicalizeQuery,
  sha256,
  toJsonValue,
} from "../query-planner/index.js";

// ── Plan contract ─────────────────────────────────────────────────────────

export const NL_MAP_PLAN_KIND = "honua.nl-map-plan" as const;
export const NL_MAP_PLAN_RECEIPT_KIND = "honua.nl-map-plan-receipt" as const;
export const NL_MAP_CONTROL_VERSION = "1.0" as const;
export const DEFAULT_NL_MAP_CONTROL_MAX_SELF_CORRECTIONS = 2;
export const DEFAULT_NL_MAP_CONTROL_MAX_PLAN_STEPS = 16;

/**
 * Effect classification of one plan step, derived from the agent-tools
 * definition: `read` tools stay `read`, `setViewport` is `viewport`, and the
 * remaining action tools are `mutation`. Anything other than `read` requires
 * an agent-safety approval envelope before execution.
 */
export type NlMapPlanEffect = "read" | "viewport" | "mutation";

const NL_TOOL_EFFECTS: Readonly<Record<HonuaAgentToolName, NlMapPlanEffect>> = {
  inspectMap: "read",
  listSources: "read",
  listCapabilities: "read",
  setViewport: "viewport",
  addLayer: "mutation",
  setVisibility: "mutation",
  setFilter: "mutation",
  selectFeature: "mutation",
  summarizeSelection: "read",
  runWidgetQuery: "read",
  explainCapabilityGap: "read",
  setLayerStyle: "mutation",
  addWidget: "mutation",
  removeWidget: "mutation",
  bindInteraction: "mutation",
  removeInteraction: "mutation",
};

/** Maps an NL plan effect onto the agent-safety effect vocabulary. */
export function agentEffectForNlEffect(effect: NlMapPlanEffect): AgentEffect {
  switch (effect) {
    case "read":
      return "read";
    case "viewport":
      return "render";
    case "mutation":
      return "mutation";
  }
}

export interface NlMapPlanStep {
  readonly id: string;
  readonly tool: HonuaAgentToolName;
  readonly effect: NlMapPlanEffect;
  /** The typed agent-tools invocation this step will execute. */
  readonly call: HonuaAgentToolCall;
  /**
   * Query-planner IR for data steps: present when the step carries a
   * canonicalizable `query` (currently `runWidgetQuery`). This is the same
   * serializable canonical-query vocabulary `explainQuery` plans over.
   */
  readonly query?: CanonicalQuery;
}

/**
 * A serializable, content-addressed natural-language map plan. Plans are the
 * only input `execute()` accepts; the fingerprint binds approvals to the
 * exact reviewed content.
 */
export interface NlMapPlan {
  readonly kind: typeof NL_MAP_PLAN_KIND;
  readonly version: typeof NL_MAP_CONTROL_VERSION;
  readonly id: string;
  readonly fingerprint: `sha256:${string}`;
  readonly instruction: string;
  /** 1-based number of completions consumed (1 = no self-correction). */
  readonly attempt: number;
  readonly readOnly: boolean;
  readonly effects: readonly NlMapPlanEffect[];
  readonly steps: readonly NlMapPlanStep[];
}

// ── BYO-LLM completion contract ───────────────────────────────────────────

export interface NlCompletionMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface NlCompletionToolCall {
  readonly name: string;
  /** Parsed argument object, or a raw JSON string from the provider. */
  readonly arguments?: Readonly<Record<string, unknown>> | string;
}

export type NlPlanIssueCode =
  | "unknown-tool"
  | "invalid-arguments"
  | "capability-gap"
  | "plan-invalid"
  | "empty-completion";

/** One typed validation failure surfaced to the model for self-correction. */
export interface NlPlanIssue {
  readonly code: NlPlanIssueCode;
  readonly message: string;
  readonly toolCallIndex?: number;
  readonly tool?: string;
  /** `explainCapabilityGap` output when the issue is a capability miss. */
  readonly capabilityGap?: ReturnType<typeof explainHonuaCapabilityGap>;
}

/** Structured retry payload sent back to the model on a failed attempt. */
export interface NlSelfCorrection {
  readonly previousToolCalls: readonly NlCompletionToolCall[];
  readonly issues: readonly NlPlanIssue[];
}

export interface NlCompletionRequest {
  readonly purpose: "propose" | "self-correct";
  /** 1-based attempt counter across the propose/self-correct loop. */
  readonly attempt: number;
  readonly instruction: string;
  readonly system: string;
  readonly messages: readonly NlCompletionMessage[];
  /** Agent-tools JSON schemas in provider-neutral MCP-compatible shape. */
  readonly tools: readonly HonuaMcpCompatibleToolDefinition[];
  readonly correction?: NlSelfCorrection;
}

export interface NlCompletionResponse {
  readonly toolCalls?: readonly NlCompletionToolCall[];
  readonly text?: string;
  readonly refusal?: string;
}

/** Caller-provided LLM transport. The SDK never talks to a model vendor. */
export type NlLlmCallback = (request: NlCompletionRequest) => Promise<NlCompletionResponse>;

// ── Control surface ───────────────────────────────────────────────────────

export interface NlMapControlPolicy {
  /** Auto-execute plans whose every step is `read`. Default `true`. */
  readonly autoExecuteReadOnly?: boolean;
  /** Bounded self-correction retries after a failed attempt. Default `2`. */
  readonly maxSelfCorrections?: number;
  /** Maximum steps accepted in a proposed plan. Default `16`. */
  readonly maxPlanSteps?: number;
  readonly actor?: string;
  /** Injectable clock used for prompts, audits, and receipts. */
  readonly now?: () => string;
  readonly onAudit?: (event: HonuaAgentAuditEvent) => void;
}

export interface NlMapControlToolsOptions {
  /** The agent-tools runtime/map host the plan executes against. */
  readonly runtime: HonuaAgentRuntime;
  /** Restrict the tool surface shown to the model. Default: all ten tools. */
  readonly tools?: ReadonlyArray<HonuaAgentToolName>;
  readonly context?: HonuaAgentContextOptions;
}

export interface CreateNlMapControlOptions {
  readonly tools: NlMapControlToolsOptions;
  readonly llm: NlLlmCallback;
  readonly policy?: NlMapControlPolicy;
  /** Verifies approval envelopes on the mutating execution path. */
  readonly approvalVerifier?: AgentEnvelopeVerifier;
  /** When present, receipts are additionally signed. */
  readonly receiptSigner?: AgentEnvelopeSigner;
}

export interface NlProposeOptions {
  readonly contextOptions?: HonuaAgentContextOptions;
  readonly signal?: AbortSignal;
}

/**
 * A verified agent-safety approval bundle for one plan: the dry run and
 * policy it was issued against, the live source-binding context, and the
 * signed envelope itself. Produced by {@link approveNlMapPlan}.
 */
export interface NlMapPlanApproval {
  readonly dryRun: AgentDryRunV1;
  readonly policy: AgentPlanPolicyV1;
  readonly context: AgentExecutionContextV1;
  readonly approval: AgentApprovalV1;
}

export interface NlExecuteOptions {
  readonly approval?: NlMapPlanApproval;
  readonly signal?: AbortSignal;
}

export interface NlMapPlanReceiptStep {
  readonly id: string;
  readonly tool: HonuaAgentToolName;
  readonly effect: NlMapPlanEffect;
  readonly status: HonuaAgentToolStatus | "skipped";
}

/** Emitted for every execution; content-addressed and optionally signed. */
export interface NlMapPlanReceipt {
  readonly kind: typeof NL_MAP_PLAN_RECEIPT_KIND;
  readonly version: typeof NL_MAP_CONTROL_VERSION;
  readonly id: string;
  readonly planId: string;
  readonly planFingerprint: `sha256:${string}`;
  readonly instruction: string;
  readonly mode: "auto-read-only" | "approved";
  readonly approvalDigest?: `sha256:${string}`;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: "succeeded" | "failed";
  readonly steps: readonly NlMapPlanReceiptStep[];
  readonly receiptDigest: `sha256:${string}`;
  readonly algorithm?: string;
  readonly keyId?: string;
  readonly signature?: string;
}

export interface NlMapPlanExecution {
  readonly planId: string;
  readonly planFingerprint: `sha256:${string}`;
  readonly mode: NlMapPlanReceipt["mode"];
  readonly outcome: NlMapPlanReceipt["outcome"];
  readonly results: readonly HonuaAgentToolResult[];
  readonly receipt: NlMapPlanReceipt;
}

export interface NlMapControl {
  /** Agent-tool definitions exposed to the model for planning. */
  readonly tools: ReadonlyArray<HonuaAgentToolDefinition>;
  readonly mcpTools: ReadonlyArray<HonuaMcpCompatibleToolDefinition>;
  readonly openAiTools: ReadonlyArray<HonuaOpenAiToolDefinition>;
  /** Compile an instruction into a serializable plan. Never executes. */
  propose(instruction: string, options?: NlProposeOptions): Promise<NlMapPlan>;
  /** Execute a reviewed plan. The only execution path; plans only. */
  execute(plan: NlMapPlan, options?: NlExecuteOptions): Promise<NlMapPlanExecution>;
}

// ── Errors ────────────────────────────────────────────────────────────────

export type NlMapControlErrorCode =
  | "invalid-options"
  | "refusal"
  | "retries-exhausted"
  | "plan-required"
  | "plan-invalid"
  | "approval-required"
  | "approval-invalid"
  | "fixture-mismatch";

export class HonuaNlMapControlError extends Error {
  public readonly code: NlMapControlErrorCode;
  public readonly issues: readonly NlPlanIssue[];

  public constructor(
    code: NlMapControlErrorCode,
    message: string,
    options: { readonly issues?: readonly NlPlanIssue[]; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HonuaNlMapControlError";
    this.code = code;
    this.issues = options.issues ?? [];
  }
}

// ── Tool-format publication (REQ-004) ─────────────────────────────────────

export const NL_MAP_CONTROL_TOOL_NAMES = ["proposeMapPlan", "executeMapPlan"] as const;
export type NlMapControlToolName = (typeof NL_MAP_CONTROL_TOOL_NAMES)[number];

export interface NlMapControlToolDefinition extends HonuaAgentToolDefinitionLike {
  readonly name: NlMapControlToolName;
  readonly title: string;
  readonly mode: "read" | "action";
  readonly requiresOptIn: boolean;
}

/**
 * The NL layer's own tool surface: propose (read-only planning) and execute
 * (plan-only, envelope-gated). Publishable in MCP and OpenAI formats through
 * the shared agent-tools exporters so the same capability works in-app and
 * via the MCP server.
 */
export const NL_MAP_CONTROL_TOOL_DEFINITIONS: readonly NlMapControlToolDefinition[] = [
  {
    name: "proposeMapPlan",
    title: "Propose map plan",
    description:
      "Compile a natural-language map instruction into a serializable, inspectable Honua NL map plan (query-planner IR for data operations plus ordered agent-tool invocations). Never executes.",
    mode: "read",
    requiresOptIn: false,
    inputSchema: {
      type: "object",
      required: ["instruction"],
      properties: {
        instruction: { type: "string", description: "Natural-language map instruction." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "executeMapPlan",
    title: "Execute map plan",
    description:
      "Execute a previously proposed Honua NL map plan. Accepts plans only, never raw natural language. Mutating or viewport-changing plans require a signed agent-safety approval envelope.",
    mode: "action",
    requiresOptIn: true,
    inputSchema: {
      type: "object",
      required: ["plan"],
      properties: {
        plan: {
          type: "object",
          description: 'A serialized "honua.nl-map-plan" produced by proposeMapPlan.',
          additionalProperties: true,
        },
        approval: {
          type: "object",
          description: "Signed agent-safety approval bundle; required unless the plan is read-only.",
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
  },
];

export interface NlMapControlToolDefinitionsOptions {
  /** Include the ten underlying agent tools alongside the NL surface. Default `true`. */
  readonly includeAgentTools?: boolean;
}

export function nlMapControlToolDefinitions(
  options: NlMapControlToolDefinitionsOptions = {},
): ReadonlyArray<HonuaAgentToolDefinitionLike> {
  return options.includeAgentTools === false
    ? NL_MAP_CONTROL_TOOL_DEFINITIONS
    : [...NL_MAP_CONTROL_TOOL_DEFINITIONS, ...HONUA_AGENT_TOOL_DEFINITIONS];
}

export function toNlMapControlMcpToolDefinitions(
  options: NlMapControlToolDefinitionsOptions = {},
): ReadonlyArray<HonuaMcpCompatibleToolDefinition> {
  return toHonuaMcpToolDefinitions(nlMapControlToolDefinitions(options));
}

export function toNlMapControlOpenAiToolDefinitions(
  options: NlMapControlToolDefinitionsOptions = {},
): ReadonlyArray<HonuaOpenAiToolDefinition> {
  return toHonuaOpenAiToolDefinitions(nlMapControlToolDefinitions(options));
}

// ── Plan hashing and validation ───────────────────────────────────────────

function canonicalPlanPayload(plan: {
  readonly instruction: string;
  readonly attempt: number;
  readonly readOnly: boolean;
  readonly effects: readonly NlMapPlanEffect[];
  readonly steps: readonly NlMapPlanStep[];
}): string {
  return canonicalStringify(
    toJsonValue({
      kind: NL_MAP_PLAN_KIND,
      version: NL_MAP_CONTROL_VERSION,
      instruction: plan.instruction,
      attempt: plan.attempt,
      readOnly: plan.readOnly,
      effects: plan.effects,
      steps: plan.steps,
    }),
  );
}

/** Recomputes the content fingerprint of a plan (excluding id/fingerprint). */
export function hashNlMapPlan(plan: NlMapPlan): `sha256:${string}` {
  return sha256(canonicalPlanPayload(plan));
}

function assertNlMapPlan(input: unknown): NlMapPlan {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HonuaNlMapControlError(
      "plan-required",
      "execute() accepts a proposed NL map plan only — never raw natural language or other input.",
    );
  }
  const plan = input as NlMapPlan;
  if (plan.kind !== NL_MAP_PLAN_KIND || plan.version !== NL_MAP_CONTROL_VERSION) {
    throw new HonuaNlMapControlError(
      "plan-required",
      `execute() requires a "${NL_MAP_PLAN_KIND}" version "${NL_MAP_CONTROL_VERSION}" plan.`,
    );
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new HonuaNlMapControlError("plan-invalid", "Plan has no steps.");
  }
  let fingerprint: `sha256:${string}`;
  try {
    fingerprint = hashNlMapPlan(plan);
  } catch (error) {
    throw new HonuaNlMapControlError("plan-invalid", "Plan content is not canonical JSON.", { cause: error });
  }
  if (fingerprint !== plan.fingerprint) {
    throw new HonuaNlMapControlError(
      "plan-invalid",
      "Plan content does not match its fingerprint. Re-propose instead of editing a plan in place.",
    );
  }
  // The fingerprint is content-addressed, not signed, so a crafted plan can
  // arrive with a self-consistent fingerprint. Approval binding and receipts
  // are keyed on step.tool/step.effect while execution dispatches step.call,
  // so reject any plan where those identities disagree before either path.
  for (const step of plan.steps) {
    const expectedEffect = NL_TOOL_EFFECTS[step.tool as HonuaAgentToolName] as NlMapPlanEffect | undefined;
    if (expectedEffect === undefined) {
      throw new HonuaNlMapControlError("plan-invalid", `Plan step "${step.id}" names unknown tool "${step.tool}".`);
    }
    if (typeof step.call !== "object" || step.call === null || step.call.name !== step.tool) {
      throw new HonuaNlMapControlError(
        "plan-invalid",
        `Plan step "${step.id}" executes call "${String(step.call?.name)}" but declares tool "${step.tool}". The executed call must match the tool the approval binds to.`,
      );
    }
    if (step.effect !== expectedEffect) {
      throw new HonuaNlMapControlError(
        "plan-invalid",
        `Plan step "${step.id}" declares effect "${step.effect}" but tool "${step.tool}" has effect "${expectedEffect}".`,
      );
    }
  }
  const derivedEffects = new Set(plan.steps.map((step) => step.effect));
  const declaredEffects = Array.isArray(plan.effects) ? plan.effects : [];
  const effectsMatch =
    declaredEffects.length === derivedEffects.size && declaredEffects.every((effect) => derivedEffects.has(effect));
  const derivedReadOnly = [...derivedEffects].every((effect) => effect === "read");
  if (!effectsMatch || plan.readOnly !== derivedReadOnly) {
    throw new HonuaNlMapControlError(
      "plan-invalid",
      "Plan readOnly/effects summary does not match the effects derived from its steps.",
    );
  }
  return plan;
}

// ── JSON-schema argument validation (agent-tools schema subset) ───────────

function schemaTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function schemaIssues(schema: HonuaAgentJsonSchema, value: unknown, path: string): string[] {
  const issues: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(type, value))) {
      issues.push(`${path}: expected ${types.join(" | ")}`);
      return issues;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    issues.push(`${path}: expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
    return issues;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path}: minimum is ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path}: maximum is ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) =>
      issues.push(...schemaIssues(schema.items as HonuaAgentJsonSchema, entry, `${path}[${index}]`)),
    );
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (record[required] === undefined) issues.push(`${path}: missing required property "${required}"`);
    }
    for (const [key, entry] of Object.entries(record)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        issues.push(...schemaIssues(propertySchema, entry, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        issues.push(`${path}: unknown property "${key}"`);
      } else if (typeof schema.additionalProperties === "object") {
        issues.push(...schemaIssues(schema.additionalProperties, entry, `${path}.${key}`));
      }
    }
  }
  return issues;
}

// ── Propose: completion parsing into a typed plan ─────────────────────────

interface ParsedToolCalls {
  readonly steps: NlMapPlanStep[];
  readonly issues: NlPlanIssue[];
}

function parseToolCallArguments(toolCall: NlCompletionToolCall): Record<string, unknown> {
  if (toolCall.arguments === undefined) return {};
  if (typeof toolCall.arguments === "string") {
    const parsed: unknown = JSON.parse(toolCall.arguments);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("tool arguments must decode to a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  return { ...toolCall.arguments };
}

function isAgentToolName(name: string): name is HonuaAgentToolName {
  return (HONUA_AGENT_TOOL_NAMES as readonly string[]).includes(name);
}

const SOURCE_SCOPED_TOOLS: ReadonlySet<HonuaAgentToolName> = new Set(["selectFeature", "runWidgetQuery"]);

function requiredCapabilityFor(tool: HonuaAgentToolName, args: Record<string, unknown>): Capability {
  if (tool === "runWidgetQuery" && args.kind !== "count") return "queryAggregate";
  return "query";
}

function capabilityIssueFor(
  index: number,
  tool: HonuaAgentToolName,
  args: Record<string, unknown>,
  sources: ReadonlyArray<HonuaAgentSourceSummary>,
): NlPlanIssue | undefined {
  if (!SOURCE_SCOPED_TOOLS.has(tool)) return undefined;
  if (sources.length === 0) return undefined; // host advertises no inventory — nothing to check against
  const sourceId = typeof args.sourceId === "string" ? args.sourceId : undefined;
  if (!sourceId) return undefined; // schema validation reports the missing argument
  const capability = requiredCapabilityFor(tool, args);
  const source = sources.find((entry) => entry.id === sourceId);
  if (!source) {
    return {
      code: "capability-gap",
      toolCallIndex: index,
      tool,
      message: `Unknown source "${sourceId}". Known sources: ${sources.map((entry) => entry.id).join(", ")}.`,
      capabilityGap: explainHonuaCapabilityGap({ capability, sourceId, declaredCapabilities: [] }),
    };
  }
  if (!source.capabilities && !source.protocol) return undefined; // no declared capability facts to check
  const capabilityGap = explainHonuaCapabilityGap({
    capability,
    sourceId,
    ...(source.protocol ? { protocol: source.protocol } : {}),
    ...(source.capabilities ? { declaredCapabilities: source.capabilities } : {}),
  });
  if (capabilityGap.supported) return undefined;
  return {
    code: "capability-gap",
    toolCallIndex: index,
    tool,
    message: capabilityGap.message,
    capabilityGap,
  };
}

function parseCompletionToolCalls(
  toolCalls: readonly NlCompletionToolCall[],
  allowedTools: ReadonlyArray<HonuaAgentToolDefinition>,
  sources: ReadonlyArray<HonuaAgentSourceSummary>,
  maxPlanSteps: number,
): ParsedToolCalls {
  const issues: NlPlanIssue[] = [];
  const steps: NlMapPlanStep[] = [];
  if (toolCalls.length === 0) {
    issues.push({
      code: "empty-completion",
      message:
        "The completion contained no tool calls. Respond with ordered agent-tool calls that satisfy the instruction.",
    });
    return { steps, issues };
  }
  if (toolCalls.length > maxPlanSteps) {
    issues.push({
      code: "plan-invalid",
      message: `The plan has ${toolCalls.length} steps; the policy allows at most ${maxPlanSteps}.`,
    });
    return { steps, issues };
  }
  toolCalls.forEach((toolCall, index) => {
    if (!isAgentToolName(toolCall.name)) {
      issues.push({
        code: "unknown-tool",
        toolCallIndex: index,
        tool: toolCall.name,
        message: `Unknown tool "${toolCall.name}". Available tools: ${allowedTools.map((tool) => tool.name).join(", ")}.`,
      });
      return;
    }
    const definition = allowedTools.find((tool) => tool.name === toolCall.name);
    if (!definition) {
      issues.push({
        code: "unknown-tool",
        toolCallIndex: index,
        tool: toolCall.name,
        message: `Tool "${toolCall.name}" is not available under the current policy. Available tools: ${allowedTools
          .map((tool) => tool.name)
          .join(", ")}.`,
      });
      return;
    }
    let args: Record<string, unknown>;
    try {
      args = parseToolCallArguments(toolCall);
    } catch (error) {
      issues.push({
        code: "invalid-arguments",
        toolCallIndex: index,
        tool: toolCall.name,
        message: `Arguments for "${toolCall.name}" are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    delete args.dryRun; // execution policy decides dry runs; plans stay pure
    const validation = schemaIssues(definition.inputSchema, args, "$");
    if (validation.length > 0) {
      issues.push({
        code: "invalid-arguments",
        toolCallIndex: index,
        tool: toolCall.name,
        message: `Arguments for "${toolCall.name}" failed schema validation: ${validation.join("; ")}`,
      });
      return;
    }
    const capabilityIssue = capabilityIssueFor(index, toolCall.name, args, sources);
    if (capabilityIssue) {
      issues.push(capabilityIssue);
      return;
    }
    let query: CanonicalQuery | undefined;
    if (toolCall.name === "runWidgetQuery" && typeof args.query === "object" && args.query !== null) {
      try {
        query = canonicalizeQuery(args.query as Readonly<Query<Record<string, unknown>>>);
      } catch (error) {
        issues.push({
          code: "plan-invalid",
          toolCallIndex: index,
          tool: toolCall.name,
          message: `The widget query is not a valid canonical query: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }
    steps.push({
      id: `step-${steps.length + 1}`,
      tool: toolCall.name,
      effect: NL_TOOL_EFFECTS[toolCall.name],
      call: { name: toolCall.name, args } as HonuaAgentToolCall,
      ...(query ? { query } : {}),
    });
  });
  return { steps, issues };
}

function buildNlMapPlan(instruction: string, attempt: number, steps: readonly NlMapPlanStep[]): NlMapPlan {
  const effects: NlMapPlanEffect[] = [];
  for (const step of steps) {
    if (!effects.includes(step.effect)) effects.push(step.effect);
  }
  const readOnly = effects.every((effect) => effect === "read");
  const draft = { instruction, attempt, readOnly, effects, steps: [...steps] };
  let fingerprint: `sha256:${string}`;
  try {
    fingerprint = sha256(canonicalPlanPayload(draft));
  } catch (error) {
    throw new HonuaNlMapControlError("plan-invalid", "The proposed plan is not canonical JSON.", { cause: error });
  }
  return deepFreeze({
    kind: NL_MAP_PLAN_KIND,
    version: NL_MAP_CONTROL_VERSION,
    id: `nlplan_${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`,
    fingerprint,
    instruction,
    attempt,
    readOnly,
    effects,
    steps: [...steps],
  });
}

async function runtimeSources(runtime: HonuaAgentRuntime): Promise<ReadonlyArray<HonuaAgentSourceSummary>> {
  if (runtime.listSources) return (await runtime.listSources()) ?? [];
  if (runtime.snapshot) return (await runtime.snapshot()).sources ?? [];
  return [];
}

// ── createNlMapControl ────────────────────────────────────────────────────

export function createNlMapControl(options: CreateNlMapControlOptions): NlMapControl {
  if (!options?.tools?.runtime) {
    throw new HonuaNlMapControlError("invalid-options", "createNlMapControl requires tools.runtime.");
  }
  if (typeof options.llm !== "function") {
    throw new HonuaNlMapControlError(
      "invalid-options",
      "createNlMapControl requires an llm callback: (request: NlCompletionRequest) => Promise<NlCompletionResponse>.",
    );
  }
  const runtime = options.tools.runtime;
  const policy = options.policy ?? {};
  const autoExecuteReadOnly = policy.autoExecuteReadOnly !== false;
  const maxSelfCorrections = policy.maxSelfCorrections ?? DEFAULT_NL_MAP_CONTROL_MAX_SELF_CORRECTIONS;
  const maxPlanSteps = policy.maxPlanSteps ?? DEFAULT_NL_MAP_CONTROL_MAX_PLAN_STEPS;
  const now = (): string => policy.now?.() ?? new Date().toISOString();
  const tools = HONUA_AGENT_TOOL_DEFINITIONS.filter(
    (definition) => !options.tools.tools || options.tools.tools.includes(definition.name),
  );
  const mcpTools = toHonuaMcpToolDefinitions(tools);
  const openAiTools = toHonuaOpenAiToolDefinitions(tools);

  async function propose(instruction: string, proposeOptions: NlProposeOptions = {}): Promise<NlMapPlan> {
    if (typeof instruction !== "string" || instruction.trim().length === 0) {
      throw new HonuaNlMapControlError("invalid-options", "propose() requires a non-empty instruction.");
    }
    const contextOptions: HonuaAgentContextOptions = {
      ...options.tools.context,
      ...proposeOptions.contextOptions,
      ...(policy.now ? { now: policy.now } : {}),
      ...(policy.actor ? { actor: policy.actor } : {}),
    };
    const system = await createHonuaAgentSystemPrompt(runtime, contextOptions);
    const sources = await runtimeSources(runtime);
    const baseMessages: NlCompletionMessage[] = [{ role: "user", content: instruction }];

    let request: NlCompletionRequest = {
      purpose: "propose",
      attempt: 1,
      instruction,
      system,
      messages: baseMessages,
      tools: mcpTools,
    };
    let lastIssues: readonly NlPlanIssue[] = [];
    const maxAttempts = 1 + Math.max(0, maxSelfCorrections);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      proposeOptions.signal?.throwIfAborted();
      const response = await options.llm(request);
      if (response.refusal !== undefined) {
        throw new HonuaNlMapControlError("refusal", `The model declined the instruction: ${response.refusal}`);
      }
      const toolCalls = response.toolCalls ?? [];
      const { steps, issues } = parseCompletionToolCalls(toolCalls, tools, sources, maxPlanSteps);
      if (issues.length === 0) {
        return buildNlMapPlan(instruction, attempt, steps);
      }
      lastIssues = issues;
      if (attempt >= maxAttempts) break;
      request = {
        purpose: "self-correct",
        attempt: attempt + 1,
        instruction,
        system,
        messages: [...baseMessages, { role: "assistant", content: JSON.stringify({ toolCalls }) }],
        tools: mcpTools,
        correction: { previousToolCalls: toolCalls, issues },
      };
    }
    throw new HonuaNlMapControlError(
      "retries-exhausted",
      `No valid plan after ${maxAttempts} attempt(s). Last issues: ${lastIssues.map((issue) => issue.message).join(" | ")}`,
      { issues: lastIssues },
    );
  }

  async function execute(planInput: NlMapPlan, executeOptions: NlExecuteOptions = {}): Promise<NlMapPlanExecution> {
    const plan = assertNlMapPlan(planInput);
    const timestamp = now();
    let mode: NlMapPlanReceipt["mode"];
    let approvalDigest: `sha256:${string}` | undefined;
    if (plan.readOnly && autoExecuteReadOnly && !executeOptions.approval) {
      mode = "auto-read-only";
    } else {
      const approval = executeOptions.approval;
      if (!approval) {
        throw new HonuaNlMapControlError(
          "approval-required",
          `Plan ${plan.id} has effects [${plan.effects.join(", ")}] and requires a signed agent-safety approval envelope.`,
        );
      }
      if (!options.approvalVerifier) {
        throw new HonuaNlMapControlError(
          "approval-invalid",
          "No approvalVerifier was configured on createNlMapControl; approved execution is unavailable.",
        );
      }
      try {
        await verifyAgentApproval(
          approval.dryRun,
          approval.policy,
          approval.approval,
          options.approvalVerifier,
          approval.context,
          {
            now: timestamp,
            ...(executeOptions.signal ? { signal: executeOptions.signal } : {}),
          },
        );
      } catch (error) {
        throw new HonuaNlMapControlError(
          "approval-invalid",
          `Approval envelope verification failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      assertApprovalBindsPlan(plan, approval.dryRun);
      mode = "approved";
      approvalDigest = approval.approval.envelopeDigest;
    }

    const results: HonuaAgentToolResult[] = [];
    const receiptSteps: NlMapPlanReceiptStep[] = [];
    let failed = false;
    for (const step of plan.steps) {
      if (failed) {
        receiptSteps.push({ id: step.id, tool: step.tool, effect: step.effect, status: "skipped" });
        continue;
      }
      executeOptions.signal?.throwIfAborted();
      const result = await executeHonuaAgentTool(runtime, step.call, {
        allowActions: mode === "approved",
        ...(policy.actor ? { actor: policy.actor } : {}),
        ...(policy.now ? { now: policy.now } : {}),
        ...(policy.onAudit ? { onAudit: policy.onAudit } : {}),
      });
      results.push(result);
      receiptSteps.push({ id: step.id, tool: step.tool, effect: step.effect, status: result.status });
      if (result.status === "denied" || result.status === "error") failed = true;
    }

    const outcome: NlMapPlanReceipt["outcome"] = failed ? "failed" : "succeeded";
    const completedAt = now();
    const unsignedReceipt = {
      kind: NL_MAP_PLAN_RECEIPT_KIND,
      version: NL_MAP_CONTROL_VERSION,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      instruction: plan.instruction,
      mode,
      ...(approvalDigest ? { approvalDigest } : {}),
      startedAt: timestamp,
      completedAt,
      outcome,
      steps: receiptSteps,
    };
    const receiptPayload = canonicalStringify(toJsonValue(unsignedReceipt));
    const receiptDigest = sha256(receiptPayload);
    let signatureFields: Pick<NlMapPlanReceipt, "algorithm" | "keyId" | "signature"> | undefined;
    if (options.receiptSigner) {
      signatureFields = {
        algorithm: options.receiptSigner.algorithm,
        keyId: options.receiptSigner.keyId,
        signature: await options.receiptSigner.sign(receiptPayload, executeOptions.signal),
      };
    }
    const receipt: NlMapPlanReceipt = deepFreeze({
      ...unsignedReceipt,
      id: `nlreceipt_${receiptDigest.slice("sha256:".length, "sha256:".length + 16)}`,
      receiptDigest,
      ...(signatureFields ?? {}),
    });
    return {
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      mode,
      outcome,
      results,
      receipt,
    };
  }

  return { tools, mcpTools, openAiTools, propose, execute };
}

// ── Agent-safety bridge: plans, approvals, bindings ───────────────────────

export const NL_MAP_RUNTIME_BINDING_ID = "map" as const;
export const DEFAULT_NL_STEP_LIMITS = { rows: 1_000, bytes: 262_144 } as const;

export interface NlMapRuntimeBindingOptions {
  readonly id?: string;
  readonly observedAt: string;
  readonly attribution?: string;
  readonly citationUri?: string;
  readonly authorizationScope?: readonly string[];
  readonly schemaVersion?: string;
  readonly sourceVersion?: string;
}

/**
 * A minimal, valid agent-safety source binding for the map runtime itself,
 * used by plan steps that target no data source (viewport, layers, filters).
 */
export function nlMapRuntimeBinding(options: NlMapRuntimeBindingOptions): AgentSourceBindingV1 {
  return {
    id: options.id ?? NL_MAP_RUNTIME_BINDING_ID,
    schemaVersion: options.schemaVersion ?? "map-runtime",
    sourceVersion: options.sourceVersion ?? "session",
    authorizationScope: [...(options.authorizationScope ?? ["map:control"])],
    provenance: {
      dataMode: "live",
      observedAt: options.observedAt,
      attribution: options.attribution ?? "Honua map runtime",
      citations: [{ uri: options.citationUri ?? "https://runtime.honua.io/map" }],
    },
  };
}

export interface NlAgentSafetyPlanOptions {
  readonly actor: string;
  /** Source bindings keyed by binding id; must cover every step's target. */
  readonly bindings: Readonly<Record<string, AgentSourceBindingV1>>;
  readonly stepLimits?: { readonly rows?: number; readonly bytes?: number };
  /** Binding id used for steps without a `sourceId`. Default `"map"`. */
  readonly mapBindingId?: string;
  readonly provider?: string;
  readonly model?: string;
}

function bindingIdForStep(step: NlMapPlanStep, mapBindingId: string): string {
  const args = (step.call as { readonly args?: Record<string, unknown> }).args;
  const sourceId = args && typeof args.sourceId === "string" ? args.sourceId : undefined;
  return sourceId ?? mapBindingId;
}

function stepParameters(step: NlMapPlanStep): JsonValue {
  const args = (step.call as { readonly args?: Record<string, unknown> }).args ?? {};
  return toJsonValue(args);
}

/**
 * Deterministically projects an NL map plan into the agent-safety plan shape
 * so it can be dry-run, approved with a signed envelope, and receipted.
 */
export function toAgentSafetyPlan(plan: NlMapPlan, options: NlAgentSafetyPlanOptions): AgentPlanV1 {
  const mapBindingId = options.mapBindingId ?? NL_MAP_RUNTIME_BINDING_ID;
  const rows = options.stepLimits?.rows ?? DEFAULT_NL_STEP_LIMITS.rows;
  const bytes = options.stepLimits?.bytes ?? DEFAULT_NL_STEP_LIMITS.bytes;
  const steps: AgentPlanStepV1[] = plan.steps.map((step) => {
    const bindingId = bindingIdForStep(step, mapBindingId);
    const binding = options.bindings[bindingId];
    if (!binding) {
      throw new HonuaNlMapControlError(
        "invalid-options",
        `toAgentSafetyPlan is missing a source binding for "${bindingId}" (step ${step.id}).`,
      );
    }
    const effect = agentEffectForNlEffect(step.effect);
    const parameters = stepParameters(step);
    const queryPlan = { id: `${plan.id}:${step.id}`, fingerprint: plan.fingerprint };
    return {
      id: step.id,
      tool: step.tool,
      effect,
      source: binding,
      queryPlan,
      parametersDigest: sha256(canonicalStringify(parameters)),
      inputDigest: digestAgentOperationInput({
        tool: step.tool,
        effect,
        sourceId: binding.id,
        queryPlan,
        fields: [],
        parameters,
      }),
      fields: [],
      limits: { rows, bytes },
    };
  });
  return {
    kind: AGENT_PLAN_KIND,
    version: AGENT_SAFETY_VERSION,
    id: plan.id,
    actor: options.actor,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    steps,
  };
}

/** Derives an exact-match agent-safety policy that permits only this plan. */
export function nlAgentSafetyPolicyFor(
  safetyPlan: AgentPlanV1,
  overrides: Partial<AgentPlanPolicyV1> = {},
): AgentPlanPolicyV1 {
  const allowedTools = [...new Set(safetyPlan.steps.map((step) => step.tool))];
  const allowedEffects = [...new Set(safetyPlan.steps.map((step) => step.effect))];
  const sources: Record<string, AgentPlanPolicyV1["sources"][string]> = {};
  for (const step of safetyPlan.steps) {
    const binding = step.source;
    if (sources[binding.id]) continue;
    sources[binding.id] = {
      fields: [...step.fields],
      authorizationScope: [...binding.authorizationScope],
      schemaVersions: [binding.schemaVersion],
      sourceVersions: [binding.sourceVersion],
      dataModes: [binding.provenance.dataMode],
      citationOrigins: binding.provenance.citations.map((citation) => new URL(citation.uri).origin),
      citationResourcePrefixes: binding.provenance.citations.map((citation) => new URL(citation.uri).pathname),
    };
  }
  return {
    allowedTools,
    allowedEffects,
    sources,
    maxSteps: safetyPlan.steps.length,
    maxRows: safetyPlan.steps.reduce((total, step) => total + step.limits.rows, 0),
    maxBytes: safetyPlan.steps.reduce((total, step) => total + step.limits.bytes, 0),
    maxFieldsPerStep: 16,
    maxAuthorizationScopesPerSource: 8,
    maxCitationsPerSource: 4,
    maxOperationParameterBytes: 65_536,
    maxOperationParameterNodes: 512,
    maxOperationParameterDepth: 16,
    ...overrides,
  };
}

export interface ApproveNlMapPlanOptions {
  readonly plan: NlMapPlan;
  readonly actor: string;
  readonly approver: string;
  readonly signer: AgentEnvelopeSigner;
  readonly bindings: Readonly<Record<string, AgentSourceBindingV1>>;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly approvalId?: string;
  readonly stepLimits?: { readonly rows?: number; readonly bytes?: number };
  readonly mapBindingId?: string;
  readonly policyOverrides?: Partial<AgentPlanPolicyV1>;
  readonly provider?: string;
  readonly model?: string;
  /** Trusted evaluation time; defaults to `issuedAt`. */
  readonly now?: string;
}

/**
 * Dry-runs the plan's agent-safety projection and issues a signed approval
 * envelope bound to it. The returned bundle is what `execute()` verifies.
 */
export async function approveNlMapPlan(options: ApproveNlMapPlanOptions): Promise<NlMapPlanApproval> {
  const safetyPlan = toAgentSafetyPlan(options.plan, {
    actor: options.actor,
    bindings: options.bindings,
    ...(options.stepLimits ? { stepLimits: options.stepLimits } : {}),
    ...(options.mapBindingId ? { mapBindingId: options.mapBindingId } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  const policy = nlAgentSafetyPolicyFor(safetyPlan, options.policyOverrides);
  const now = options.now ?? options.issuedAt;
  const dryRun = dryRunAgentPlan(safetyPlan, policy, { now });
  const approval = await issueAgentApproval(
    dryRun,
    policy,
    {
      id: options.approvalId ?? `approval-${options.plan.id}`,
      approver: options.approver,
      issuedAt: options.issuedAt,
      expiresAt: options.expiresAt,
      stepLimits: Object.fromEntries(
        safetyPlan.steps.map((step) => [step.id, { rows: step.limits.rows, bytes: step.limits.bytes }]),
      ),
    },
    options.signer,
    { now },
  );
  const context: AgentExecutionContextV1 = {
    sources: Object.fromEntries(safetyPlan.steps.map((step) => [step.source.id, step.source])),
  };
  return { dryRun, policy, context, approval };
}

function assertApprovalBindsPlan(plan: NlMapPlan, dryRun: AgentDryRunV1): void {
  const safetySteps = dryRun.plan.steps;
  if (safetySteps.length !== plan.steps.length) {
    throw new HonuaNlMapControlError(
      "approval-invalid",
      `Approval covers ${safetySteps.length} step(s) but the plan has ${plan.steps.length}.`,
    );
  }
  plan.steps.forEach((step, index) => {
    const safetyStep = safetySteps[index];
    const expectedDigest = sha256(canonicalStringify(stepParameters(step)));
    if (
      safetyStep.id !== step.id ||
      safetyStep.tool !== step.tool ||
      safetyStep.effect !== agentEffectForNlEffect(step.effect) ||
      safetyStep.parametersDigest !== expectedDigest ||
      safetyStep.queryPlan.fingerprint !== plan.fingerprint
    ) {
      throw new HonuaNlMapControlError(
        "approval-invalid",
        `Approval step "${safetyStep.id}" does not bind to plan step "${step.id}" of plan ${plan.id}.`,
      );
    }
  });
}

// ── Recorded-completion replay (deterministic fixture LLM) ────────────────

export interface NlRecordedRequest {
  readonly purpose: NlCompletionRequest["purpose"];
  readonly attempt: number;
  readonly instruction: string;
}

export interface NlRecordedExchange {
  readonly request: NlRecordedRequest;
  readonly response: NlCompletionResponse;
}

/**
 * A deterministic LLM callback replaying recorded request/response
 * exchanges in order. Any drift between the live request and the recording
 * throws `fixture-mismatch` instead of answering from the wrong exchange.
 */
export function createRecordedNlLlm(exchanges: readonly NlRecordedExchange[]): NlLlmCallback {
  let index = 0;
  return async (request) => {
    const exchange = exchanges[index];
    if (!exchange) {
      throw new HonuaNlMapControlError(
        "fixture-mismatch",
        `Recorded LLM exhausted after ${exchanges.length} exchange(s); received ${request.purpose} attempt ${request.attempt}.`,
      );
    }
    const recorded = exchange.request;
    if (
      recorded.purpose !== request.purpose ||
      recorded.attempt !== request.attempt ||
      recorded.instruction !== request.instruction
    ) {
      throw new HonuaNlMapControlError(
        "fixture-mismatch",
        `Recorded exchange ${index} expected ${recorded.purpose} attempt ${recorded.attempt} for "${recorded.instruction}", received ${request.purpose} attempt ${request.attempt} for "${request.instruction}".`,
      );
    }
    index += 1;
    return exchange.response;
  };
}

// ── Internals ─────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}
