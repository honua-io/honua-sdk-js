import type { ModelDriver, Scenario, TranscriptStep, WorkflowContext, WorkflowTranscript } from "../types.js";

/**
 * Claude client driver for the cross-model eval (honua-server #1956).
 *
 * Gated behind ANTHROPIC_API_KEY and a dynamically-imported `@anthropic-ai/sdk`
 * — neither is a dependency of this package, so the offline CI path never needs
 * them. Live runs use the latest Opus model (claude-opus-4-8) with a manual
 * tool-use loop over the advertised MCP catalog. A synthetic `ask_user` tool
 * lets the model signal that it needs clarification, which the harness records
 * separately from success/failure.
 *
 * Live cross-model runs are tracked under honua-io/honua-server#1956.
 */

const ASK_USER_TOOL = {
  name: "ask_user",
  description:
    "Call this ONLY if the request is too ambiguous to proceed. Provide the clarifying question you would ask.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

const SYSTEM_PROMPT =
  "You are a GIS analyst working through the Honua MCP tools. Complete the user's task by calling the available tools. " +
  "Ground every step in real tool results — do not invent service names, layers, or fields. " +
  "If, and only if, the request is genuinely ambiguous and you cannot proceed, call ask_user. " +
  "When finished, give a concise final answer that references what the tools returned.";

const MAX_ITERATIONS = 8;
const DEFAULT_MODEL = "claude-opus-4-8";

export interface AnthropicDriverOptions {
  apiKey?: string | undefined;
  model?: string;
}

export class AnthropicDriver implements ModelDriver {
  readonly vendor = "anthropic" as const;
  readonly id: string;
  private readonly apiKey: string | undefined;

  constructor(options: AnthropicDriverOptions = {}) {
    this.id = options.model ?? DEFAULT_MODEL;
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  }

  isAvailable(): boolean {
    return typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  async runWorkflow(scenario: Scenario, ctx: WorkflowContext): Promise<WorkflowTranscript> {
    const steps: TranscriptStep[] = [];
    const transcript: WorkflowTranscript = {
      scenarioId: scenario.id,
      modelId: this.id,
      steps,
      finalAnswer: "",
      clarificationRequested: false,
      errorCount: 0,
    };

    let Anthropic: new (opts: { apiKey: string }) => AnthropicClient;
    try {
      // Variable specifier → not statically resolved; keeps @anthropic-ai/sdk
      // an optional, non-bundled dependency for live runs only.
      const specifier = "@anthropic-ai/sdk";
      const mod = (await import(specifier)) as { default: new (o: { apiKey: string }) => AnthropicClient };
      Anthropic = mod.default;
    } catch {
      transcript.driverError = "@anthropic-ai/sdk is not installed (required for live Claude eval runs)";
      return transcript;
    }
    if (!this.apiKey) {
      transcript.driverError = "ANTHROPIC_API_KEY is not set";
      return transcript;
    }

    const client = new Anthropic({ apiKey: this.apiKey });
    const tools = [
      ...ctx.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      ASK_USER_TOOL,
    ];
    const messages: AnthropicMessage[] = [{ role: "user", content: scenario.prompt }];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await client.messages.create({
          model: this.id,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools,
          messages,
        });

        const toolUses = response.content.filter((b): b is AnthropicToolUse => b.type === "tool_use");
        const text = response.content
          .filter((b): b is AnthropicText => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
          transcript.finalAnswer = text;
          return transcript;
        }

        messages.push({ role: "assistant", content: response.content });
        const toolResults: AnthropicToolResult[] = [];
        for (const use of toolUses) {
          if (use.name === ASK_USER_TOOL.name) {
            transcript.clarificationRequested = true;
            transcript.finalAnswer = text;
            return transcript;
          }
          const result = await ctx.callTool(use.name, (use.input ?? {}) as Record<string, unknown>);
          steps.push({ tool: use.name, args: (use.input ?? {}) as Record<string, unknown>, isError: result.isError });
          if (result.isError) {
            transcript.errorCount++;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: result.text,
            is_error: result.isError,
          });
        }
        messages.push({ role: "user", content: toolResults });
      }
      transcript.driverError = `exceeded ${MAX_ITERATIONS} tool-use iterations without finishing`;
      return transcript;
    } catch (err) {
      transcript.driverError = err instanceof Error ? err.message : String(err);
      return transcript;
    }
  }
}

// Minimal structural types for the dynamically-imported SDK (avoids a hard dep).
interface AnthropicText {
  type: "text";
  text: string;
}
interface AnthropicToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
type AnthropicContentBlock = AnthropicText | AnthropicToolUse | { type: string; [k: string]: unknown };
interface AnthropicToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}
type AnthropicMessage =
  | { role: "user"; content: string | AnthropicToolResult[] }
  | { role: "assistant"; content: AnthropicContentBlock[] };
interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
}
interface AnthropicClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      tools: unknown[];
      messages: AnthropicMessage[];
    }): Promise<AnthropicResponse>;
  };
}
