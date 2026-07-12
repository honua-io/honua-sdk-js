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
  /** Deterministically count logical rows/records in the returned MCP result. */
  countRows(result: unknown): number;
}

/**
 * Adapt a standalone MCP read tool without introducing a second approval or
 * audit model. The SDK validates the exact tool/effect before this handler runs.
 */
export function createReadOnlyMcpAgentExecutor<TArguments>(
  tool: ReadOnlyMcpAgentTool<TArguments>,
): AgentOperationExecutorV1 {
  if (!tool || typeof tool !== "object") throw new TypeError("MCP tool descriptor is required");
  const name = dataProperty(tool, "name");
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name))
    throw new TypeError("MCP tool name must be a bounded exact identifier");
  const parse = callback(tool, "parse") as (parameters: JsonValue) => TArguments;
  const execute = callback(tool, "execute") as (arguments_: TArguments, signal?: AbortSignal) => Promise<unknown>;
  const countRows = callback(tool, "countRows") as (result: unknown) => number;
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
      const rows = countRows(result);
      if (!Number.isSafeInteger(rows) || rows < 0)
        throw new TypeError("MCP tool row count must be a non-negative safe integer");
      return { rows, value: result as JsonValue };
    },
  });
}

function dataProperty(input: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  } catch {
    throw new TypeError(`MCP tool ${key} could not be safely captured`);
  }
  if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`MCP tool ${key} must be a data property`);
  return descriptor.value;
}

function callback(input: object, key: string): (...args: never[]) => unknown {
  const value = dataProperty(input, key);
  if (typeof value !== "function") throw new TypeError(`MCP tool ${key} callback is required`);
  return value.bind(input);
}
