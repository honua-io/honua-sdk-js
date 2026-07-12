import type {
  AgentOperationExecutionResultV1,
  AgentOperationExecutorV1,
  AgentOperationInputV1,
} from "@honua/sdk-js/agent-safety";
import type { JsonValue } from "@honua/sdk-js/query-planner";

/** A named, read-only MCP tool handler adapted to the SDK approval boundary. */
export interface ReadOnlyMcpAgentTool<TArguments> {
  readonly name: string;
  parse(parameters: JsonValue): TArguments;
  execute(arguments_: TArguments, signal?: AbortSignal): Promise<unknown>;
  countRows?(result: unknown): number;
}

/**
 * Adapt a standalone MCP read tool without introducing a second approval or
 * audit model. The SDK validates the exact tool/effect before this handler runs.
 */
export function createReadOnlyMcpAgentExecutor<TArguments>(
  tool: ReadOnlyMcpAgentTool<TArguments>,
): AgentOperationExecutorV1 {
  if (!tool || typeof tool.name !== "string" || tool.name.length === 0)
    throw new TypeError("MCP tool name is required");
  if (typeof tool.parse !== "function" || typeof tool.execute !== "function")
    throw new TypeError("MCP tool parse and execute callbacks are required");
  const name = tool.name;
  const parse = tool.parse.bind(tool);
  const execute = tool.execute.bind(tool);
  const countRows = tool.countRows?.bind(tool);
  return Object.freeze({
    tool: name,
    effect: "read" as const,
    async execute(
      operation: AgentOperationInputV1,
      _limits: { readonly rows: number; readonly bytes: number },
      signal?: AbortSignal,
    ): Promise<AgentOperationExecutionResultV1> {
      if (operation.tool !== name || operation.effect !== "read")
        throw new TypeError("approved operation does not match the read-only MCP tool");
      const arguments_ = parse(operation.parameters);
      const result = await execute(arguments_, signal);
      const rows = countRows?.(result) ?? 0;
      return { rows, value: result as JsonValue };
    },
  });
}
