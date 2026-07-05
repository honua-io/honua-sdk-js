import type { ModelDriver, Scenario, TranscriptStep, WorkflowContext, WorkflowTranscript } from "../types.js";

/**
 * GPT client driver for the cross-model eval (honua-server #1956).
 *
 * Gated behind OPENAI_API_KEY and a dynamically-imported `openai` SDK — neither
 * is a dependency of this package, so the offline CI path never needs them. This
 * is the "any client" counterpart to the Claude driver: the SAME corpus and the
 * SAME grading are driven by a GPT model over the identical MCP catalog, so the
 * artifact can compare success / clarification / edit rates across vendors.
 *
 * Live cross-model runs are tracked under honua-io/honua-server#1956.
 */

const ASK_USER_FUNCTION = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "Call this ONLY if the request is too ambiguous to proceed. Provide the clarifying question you would ask.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
} as const;

const SYSTEM_PROMPT =
  "You are a GIS analyst working through the Honua MCP tools. Complete the user's task by calling the available tools. " +
  "Ground every step in real tool results — do not invent service names, layers, or fields. " +
  "If, and only if, the request is genuinely ambiguous and you cannot proceed, call ask_user. " +
  "When finished, give a concise final answer that references what the tools returned.";

const MAX_ITERATIONS = 8;
/**
 * Default GPT model for live cross-model runs.
 *
 * `gpt-5.5` is OpenAI's generally-available flagship reasoning model as of
 * July 2026 (the apex of the public Chat Completions catalog; see
 * developers.openai.com/api/docs/models/all). The newer GPT-5.6 "Sol" family was
 * still preview-gated to a handful of orgs at that date and not callable by an
 * ordinary API key, so it is NOT the default — set `OPENAI_MODEL=gpt-5.6-sol`
 * (or any other id) to override once you have access. The resolved id is recorded
 * per-driver in the results artifact (`models[].model`) so published comparisons
 * are attributable to an exact model.
 */
const DEFAULT_MODEL = "gpt-5.5";

export interface OpenAiDriverOptions {
  apiKey?: string | undefined;
  model?: string;
}

export class OpenAiDriver implements ModelDriver {
  readonly vendor = "openai" as const;
  readonly id: string;
  private readonly apiKey: string | undefined;

  constructor(options: OpenAiDriverOptions = {}) {
    this.id = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
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

    let OpenAI: new (opts: { apiKey: string }) => OpenAiClient;
    try {
      const specifier = "openai";
      const mod = (await import(specifier)) as { default: new (o: { apiKey: string }) => OpenAiClient };
      OpenAI = mod.default;
    } catch {
      transcript.driverError = "openai SDK is not installed (required for live GPT eval runs)";
      return transcript;
    }
    if (!this.apiKey) {
      transcript.driverError = "OPENAI_API_KEY is not set";
      return transcript;
    }

    const client = new OpenAI({ apiKey: this.apiKey });
    const tools = [
      ...ctx.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      ASK_USER_FUNCTION,
    ];
    const messages: OpenAiMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: scenario.prompt },
    ];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await client.chat.completions.create({ model: this.id, messages, tools });
        const message = response.choices[0]?.message;
        if (!message) {
          transcript.driverError = "no choice returned by the model";
          return transcript;
        }

        const toolCalls = message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          transcript.finalAnswer = message.content ?? "";
          return transcript;
        }

        messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });
        for (const call of toolCalls) {
          const args = safeParse(call.function.arguments);
          if (call.function.name === "ask_user") {
            transcript.clarificationRequested = true;
            transcript.finalAnswer = message.content ?? "";
            return transcript;
          }
          const result = await ctx.callTool(call.function.name, args);
          steps.push({ tool: call.function.name, args, isError: result.isError });
          if (result.isError) {
            transcript.errorCount++;
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
        }
      }
      transcript.driverError = `exceeded ${MAX_ITERATIONS} tool-use iterations without finishing`;
      return transcript;
    } catch (err) {
      transcript.driverError = err instanceof Error ? err.message : String(err);
      return transcript;
    }
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Minimal structural types for the dynamically-imported SDK (avoids a hard dep).
interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}
type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface OpenAiResponse {
  choices: { message: { content: string | null; tool_calls?: OpenAiToolCall[] } }[];
}
interface OpenAiClient {
  chat: {
    completions: {
      create(params: { model: string; messages: OpenAiMessage[]; tools: unknown[] }): Promise<OpenAiResponse>;
    };
  };
}
