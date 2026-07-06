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
}

/** Per-scenario grade for one model. */
export type GradeOutcome = "pass" | "fail" | "clarified" | "error";

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
