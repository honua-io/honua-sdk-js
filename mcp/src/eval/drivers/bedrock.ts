import type {
  ModelDriver,
  Scenario,
  ToolDescriptor,
  TranscriptStep,
  WorkflowContext,
  WorkflowTranscript,
} from "../types.js";

/**
 * Claude-via-Amazon-Bedrock driver for the cross-model eval (honua-server #1956).
 *
 * This is the "any client LLM" counterpart to the direct-Anthropic driver, but it
 * reaches Claude through Amazon Bedrock's Converse API instead of the Anthropic
 * API. It exists so the AI proof can run on infrastructure that has AWS Bedrock
 * access (default `~/.aws` credential chain) but no ANTHROPIC_API_KEY — exactly
 * the situation on the build host. The SAME corpus and grading are driven over
 * the identical MCP catalog, so the artifact compares success / clarification /
 * edit rates across vendors and transports.
 *
 * Auth uses the standard AWS SDK credential provider chain (env vars, shared
 * config/credentials files, SSO, instance/role credentials) — no key is ever
 * hardcoded. Because that chain is resolved asynchronously and cannot be sniffed
 * synchronously, the driver opts in via the `HONUA_EVAL_BEDROCK` env flag (set by
 * `resolveDrivers`) or by explicit selection (`--driver bedrock`).
 *
 * Model id: defaults to `anthropic.claude-sonnet-4-5-20250929-v1:0`, overridable
 * via `HONUA_EVAL_BEDROCK_MODEL`. NOTE: most current Anthropic models on Bedrock
 * are not enabled for on-demand throughput by the bare id and must be invoked
 * through a cross-region inference profile — i.e. the `us.`-prefixed form
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0` in us.* regions. Set
 * `HONUA_EVAL_BEDROCK_MODEL` accordingly for live runs.
 *
 * Region: `AWS_REGION` if set, else `us-west-2`.
 *
 * `@aws-sdk/client-bedrock-runtime` is a declared dependency but is imported
 * dynamically (variable specifier) so the offline CI path — which only runs the
 * deterministic control — never needs to load it, and a graceful `driverError`
 * is recorded if it is somehow absent.
 *
 * Live cross-model runs are tracked under honua-io/honua-server#1956.
 */

const ASK_USER_TOOL_NAME = "ask_user";
const ASK_USER_TOOL: BedrockTool = {
  toolSpec: {
    name: ASK_USER_TOOL_NAME,
    description:
      "Call this ONLY if the request is too ambiguous to proceed. Provide the clarifying question you would ask.",
    inputSchema: {
      json: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
};

const SYSTEM_PROMPT =
  "You are a GIS analyst working through the Honua MCP tools. Complete the user's task by calling the available tools. " +
  "Ground every step in real tool results — do not invent service names, layers, or fields. " +
  "If, and only if, the request is genuinely ambiguous and you cannot proceed, call ask_user. " +
  "When finished, give a concise final answer that references what the tools returned.";

const MAX_ITERATIONS = 8;
const MAX_TOKENS = 4096;
const DEFAULT_MODEL = "anthropic.claude-sonnet-4-5-20250929-v1:0";
const DEFAULT_REGION = "us-west-2";

export interface BedrockDriverOptions {
  /** Bedrock model id or inference-profile id. Defaults to Sonnet 4.5. */
  model?: string | undefined;
  /** AWS region. Defaults to AWS_REGION, then us-west-2. */
  region?: string | undefined;
  /** Opt-in flag value (defaults to process.env.HONUA_EVAL_BEDROCK). */
  enabled?: string | undefined;
}

export class BedrockDriver implements ModelDriver {
  readonly vendor = "bedrock" as const;
  readonly id: string;
  readonly region: string;
  private readonly enabled: boolean;

  constructor(options: BedrockDriverOptions = {}) {
    this.id = options.model ?? DEFAULT_MODEL;
    this.region = options.region ?? DEFAULT_REGION;
    const flag = options.enabled ?? process.env.HONUA_EVAL_BEDROCK;
    this.enabled = isTruthy(flag);
  }

  isAvailable(): boolean {
    return this.enabled;
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

    let runtime: BedrockRuntimeModule;
    try {
      // Variable specifier → not statically resolved; keeps the AWS SDK an
      // optional load for live runs only and the build independent of it.
      const specifier = "@aws-sdk/client-bedrock-runtime";
      runtime = (await import(specifier)) as BedrockRuntimeModule;
    } catch {
      transcript.driverError = "@aws-sdk/client-bedrock-runtime is not installed (required for live Bedrock eval runs)";
      return transcript;
    }

    const { BedrockRuntimeClient, ConverseCommand } = runtime;
    const client = new BedrockRuntimeClient({ region: this.region });
    const toolConfig: BedrockToolConfig = { tools: [...toBedrockTools(ctx.tools), ASK_USER_TOOL] };
    const messages: BedrockMessage[] = [{ role: "user", content: [{ text: scenario.prompt }] }];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await client.send(
          new ConverseCommand({
            modelId: this.id,
            system: [{ text: SYSTEM_PROMPT }],
            messages,
            toolConfig,
            inferenceConfig: { maxTokens: MAX_TOKENS },
          }),
        );

        const content = response.output?.message?.content ?? [];
        const toolUses = extractToolUses(content);
        const text = extractText(content);

        if (response.stopReason !== "tool_use" || toolUses.length === 0) {
          transcript.finalAnswer = text;
          return transcript;
        }

        messages.push({ role: "assistant", content });
        const toolResults: BedrockContentBlock[] = [];
        for (const use of toolUses) {
          if (use.name === ASK_USER_TOOL_NAME) {
            transcript.clarificationRequested = true;
            transcript.finalAnswer = text;
            return transcript;
          }
          const args = (use.input ?? {}) as Record<string, unknown>;
          const result = await ctx.callTool(use.name, args);
          steps.push({ tool: use.name, args, isError: result.isError });
          if (result.isError) {
            transcript.errorCount++;
          }
          toolResults.push(toToolResultBlock(use.toolUseId, result.text, result.isError));
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

function isTruthy(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const v = value.trim().toLowerCase();
  return v.length > 0 && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Map MCP tool descriptors to Bedrock Converse `toolSpec` entries. */
export function toBedrockTools(tools: ToolDescriptor[]): BedrockTool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> },
    },
  }));
}

/** Pull tool-use blocks out of a Converse content array. */
export function extractToolUses(content: BedrockContentBlock[]): BedrockToolUse[] {
  return content
    .map((b) => b.toolUse)
    .filter((u): u is BedrockToolUse => typeof u === "object" && u !== null && typeof u.name === "string");
}

/** Concatenate text blocks of a Converse content array. */
export function extractText(content: BedrockContentBlock[]): string {
  return content
    .map((b) => b.text)
    .filter((t): t is string => typeof t === "string")
    .join("\n");
}

/** Build a Converse `toolResult` content block to feed back to the model. */
export function toToolResultBlock(toolUseId: string, text: string, isError: boolean): BedrockContentBlock {
  return {
    toolResult: {
      toolUseId,
      content: [{ text }],
      status: isError ? "error" : "success",
    },
  };
}

// Minimal structural types for the dynamically-imported AWS SDK (avoids a hard,
// statically-resolved dependency in the build / coverage paths).
interface BedrockToolUse {
  toolUseId: string;
  name: string;
  input?: unknown;
}
interface BedrockToolResult {
  toolUseId: string;
  content: { text: string }[];
  status: "error" | "success";
}
interface BedrockContentBlock {
  text?: string;
  toolUse?: BedrockToolUse;
  toolResult?: BedrockToolResult;
}
interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
}
interface BedrockTool {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}
interface BedrockToolConfig {
  tools: BedrockTool[];
}
interface ConverseInput {
  modelId: string;
  system: { text: string }[];
  messages: BedrockMessage[];
  toolConfig: BedrockToolConfig;
  inferenceConfig: { maxTokens: number };
}
interface ConverseResponse {
  output?: { message?: { content?: BedrockContentBlock[] } };
  stopReason?: string;
}
interface BedrockRuntimeClientLike {
  send(command: object): Promise<ConverseResponse>;
}
interface BedrockRuntimeModule {
  BedrockRuntimeClient: new (config: { region: string }) => BedrockRuntimeClientLike;
  ConverseCommand: new (input: ConverseInput) => object;
}
