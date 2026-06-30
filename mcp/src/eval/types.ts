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
