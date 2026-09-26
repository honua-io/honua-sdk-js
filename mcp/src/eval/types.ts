/**
 * Cross-model MCP workflow eval — shared types (honua-server #1956, WS-H).
 *
 * The eval proves the north-star claim "any client → any workflow": a held-out
 * corpus of GIS workflows is driven through the honua MCP surface by DIFFERENT
 * client LLMs (Claude AND a GPT model), and end-to-end success / clarification /
 * edit rates are recorded per model. A deterministic (scripted) driver provides
 * an offline control that runs in CI with no model/API calls.
 */

/** A tool as advertised by the MCP surface, handed to a model driver. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Result of a single `tools/call` over the MCP surface. */
export interface ToolCallResult {
  isError: boolean;
  /** Flattened text content of the tool result (what a model would read back). */
  text: string;
}

/** The MCP surface a driver may exercise while solving a workflow. */
export interface WorkflowContext {
  tools: ToolDescriptor[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/** One step a driver took: a tool call and whether it errored. */
export interface TranscriptStep {
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
}

/** What a driver produced for one scenario. */
export interface WorkflowTranscript {
  scenarioId: string;
  modelId: string;
  steps: TranscriptStep[];
  finalAnswer: string;
  /** The driver asked the user a clarifying question instead of completing. */
  clarificationRequested: boolean;
  /** Tool calls that returned isError (a proxy for self-correction / edits). */
  errorCount: number;
  /** Driver-level failure (timeout, exception, model unavailable). */
  driverError?: string;
  /** Which surface produced the step. Docs lookups are `docs`; CLI-only steps are `cli`. */
  surface?: "mcp" | "docs" | "cli";
  /** Skill whose operator sentence was the prompt. */
  skillId?: string;
  /** Copied from the journey oracle after the run. The model never sees these. */
  journeyStage?: string;
  journeyAction?: string;
  /** Who chose the tool call. Console approval stays harness-driven. */
  attribution?: "MODEL_SELECTED" | "HARNESS_DRIVEN";
  /** Ids only. Credential material is never stored here. */
  capturedIds?: Record<string, string>;
  /** Set when a required server profile is off. Grades as `blocked`. */
  blockedReason?: string;
}

/** Declarative success criteria graded against a transcript. */
export interface SuccessCriteria {
  /** Tools that must be called at least once (any order). */
  requiredTools: string[];
  /** An ordered subsequence of tool names that must appear in order. */
  expectedToolSequence?: string[];
  /** Tools that must never be called (e.g. write/destructive tools). */
  forbiddenTools?: string[];
  /** Case-insensitive substrings the final answer must contain. */
  answerMustInclude?: string[];
  /**
   * SEMANTIC assertions (issue #369) — grade the MEANING of the answer, not just
   * the tool trajectory. Ride on the deterministic control against grounded
   * fixtures (known feature counts, known geographic facts), so a wrong number or
   * a hallucinated place name fails the scenario.
   */
  /** Case-insensitive substrings the final answer must NOT contain (anti-hallucination / wrong-answer guard). */
  answerMustNotInclude?: string[];
  /** Regular-expression sources the final answer must ALL match (case-insensitive) — exact numeric / value checks. */
  answerMustMatch?: string[];
  /**
   * The prompt is deliberately ambiguous or unsupported: a correct client asks a
   * clarifying question (or refuses) instead of guessing. When true, a `clarified`
   * transcript grades as `pass` and a completed transcript grades as `fail`.
   */
  expectClarification?: boolean;
  /**
   * Substrings that must not appear in any tool-argument JSON. Used to fail a
   * model that sets `allowAnonymous` or proposes `visibility: public`.
   */
  forbiddenArgumentText?: string[];
  /** Any tool whose name contains "approve" fails the scenario. */
  forbidApproval?: boolean;
}

/** One GIS workflow in the held-out corpus. */
export interface Scenario {
  id: string;
  title: string;
  category: string;
  /** The natural-language task handed to the client LLM. */
  prompt: string;
  criteria: SuccessCriteria;
  /**
   * Scripted "ideal client" trajectory used by the deterministic offline driver.
   * Live LLM drivers ignore this and plan their own tool calls.
   */
  script: { tool: string; args: Record<string, unknown> }[];
  /**
   * Ambiguity/refusal scenarios: the deterministic driver asks this clarifying
   * question INSTEAD of running the script (an empty script is typical). Live LLM
   * drivers decide for themselves whether to clarify from the prompt alone. Pair
   * with `criteria.expectClarification: true`.
   */
  clarify?: { question: string };
  /** Skill file the prompt was taken from. Not shown to the model as an id. */
  skillId?: string;
  /** Journey stage id this scenario covers. Applied to the transcript after the run. */
  journeyStage?: string;
  /** Journey action id this scenario covers. */
  journeyAction?: string;
  /**
   * MCP server profiles that must already be enabled. When any is missing the
   * scenario is `blocked` and the model is not asked to call the tools.
   */
  requiresServerProfiles?: string[];
}

/** Per-scenario grade for one model. `blocked` is a missing server profile, never a pass. */
export type GradeOutcome = "pass" | "fail" | "clarified" | "error" | "blocked";

export interface ScenarioGrade {
  scenarioId: string;
  modelId: string;
  outcome: GradeOutcome;
  /** Human-readable reasons a grade was not `pass`. */
  violations: string[];
  errorCount: number;
}

/** A driver wraps a single client model (or the deterministic control). */
export interface ModelDriver {
  /** Stable identifier recorded in the artifact, e.g. "claude-opus-4-8". */
  readonly id: string;
  readonly vendor: "anthropic" | "openai" | "bedrock" | "deterministic";
  /** Whether this driver can actually run (key + SDK present). */
  isAvailable(): boolean;
  runWorkflow(scenario: Scenario, ctx: WorkflowContext): Promise<WorkflowTranscript>;
}
