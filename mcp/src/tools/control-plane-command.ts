/**
 * The MCP transport adapter for the shared control-plane command layer.
 *
 * Every tool registered here is *generated* from `HONUA_COMMANDS` in
 * `@honua/sdk-js/control-plane`: the name, title, description, and argument
 * schema are projections of the command's own declaration, and the handler
 * does exactly three things — build a `HonuaCommandInvocation`, call
 * `HonuaCommandRuntime.execute`, and render the returned receipt. There is no
 * MCP-side sequencing, no MCP-side validation beyond the projected schema, and
 * no MCP-side authorization: an equivalent `honua map publish` invocation, an
 * equivalent Studio invocation, and a direct `runtime.execute(...)` call all
 * produce the same receipt and the same `auditKey`, differing only in the
 * recorded `transport`.
 *
 * ## Why the projected object is `passthrough`
 *
 * A Zod object strips unknown keys by default. Stripping here would mean an
 * agent that sent `approvedBy` got a *silent success* instead of the shared
 * typed refusal, and MCP would then be the one transport where a sealed input
 * schema is enforced by omission rather than by the command. So the projection
 * lets unknown keys through to the runtime, where the command's closed schema
 * (`additionalProperties: false`) rejects them with the same `validation`
 * `HonuaCommandError` every other transport gets.
 *
 * ## What an agent may not assert
 *
 * The tool arguments carry no identity fields and no request headers. Acting
 * identity and tenant come from the host that constructed the runtime — a
 * model-supplied `actor` would be an authority claim dressed as an argument.
 * `Idempotency-Key` and `If-Match` are likewise not header inputs: `ifMatch`
 * and `idempotencyKey` travel as invocation fields so the value on the wire is
 * the value the receipt records.
 *
 * @module
 */

import {
  HONUA_COMMANDS,
  type HonuaAnyCommand,
  HonuaCommandError,
  type HonuaCommandIdentity,
  type HonuaCommandInvocation,
  type HonuaCommandJsonSchema,
  type HonuaCommandRuntime,
} from "@honua/sdk-js/control-plane";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** Prefix every generated command tool carries. */
export const CONTROL_PLANE_COMMAND_TOOL_PREFIX = "honua_command_";

/**
 * Host wiring for the command tools.
 *
 * The host owns the credential (through the runtime's client) and the acting
 * identity echo. Neither is reachable from tool arguments.
 */
export interface ControlPlaneCommandMcpHost {
  /** Runtime built from the caller's own `HonuaClient`; never a shared admin key. */
  readonly runtime: HonuaCommandRuntime;
  /** Acting identity echoed onto every receipt. Host-supplied, never model-supplied. */
  readonly identity?: HonuaCommandIdentity;
}

/** `map-package.publish` → `honua_command_map_package_publish`. */
export function controlPlaneCommandToolName(commandId: string): string {
  return `${CONTROL_PLANE_COMMAND_TOOL_PREFIX}${commandId.replace(/[.-]/g, "_")}`;
}

/**
 * Project a command's JSON-schema input into the tool's argument schema.
 *
 * `input` is the command's own declared shape; the three siblings are the
 * invocation fields a caller is allowed to set. The outer object is `strict`
 * so an unknown *invocation* field is an MCP-level mistake, while the inner
 * object is `passthrough` so an unknown *input* field reaches the command's
 * sealed schema and is refused there.
 */
export function controlPlaneCommandToolSchema(command: HonuaAnyCommand) {
  return z
    .object({
      input: zodForSchema(command.inputSchema),
      dryRun: z
        .boolean()
        .optional()
        .describe("Preview the plan without contacting the server. The command never reaches `execute`."),
      idempotencyKey: z
        .string()
        .min(1)
        .optional()
        .describe("Explicit Idempotency-Key. Derived deterministically from the input when omitted."),
      ifMatch: z.string().min(1).optional().describe("Optimistic-concurrency validator, sent as If-Match."),
    })
    .strict();
}

type ControlPlaneCommandToolArgs = z.infer<ReturnType<typeof controlPlaneCommandToolSchema>>;

/**
 * Run one command for the MCP transport and render its receipt.
 *
 * A {@link HonuaCommandError} is returned as a tool error carrying the shared
 * serialized taxonomy, not rethrown as an opaque MCP failure: an agent has to
 * be able to tell a `validation` refusal from a `conflict` it should retry.
 */
export async function execute(
  host: ControlPlaneCommandMcpHost,
  command: HonuaAnyCommand,
  args: ControlPlaneCommandToolArgs,
): Promise<CallToolResult> {
  const invocation: HonuaCommandInvocation = {
    transport: "mcp",
    ...(host.identity ? { identity: host.identity } : {}),
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    ...(args.ifMatch ? { ifMatch: args.ifMatch } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
  };
  try {
    const receipt = await host.runtime.execute(command, args.input, invocation);
    return { content: [{ type: "text" as const, text: JSON.stringify(receipt, null, 2) }] };
  } catch (error) {
    if (error instanceof HonuaCommandError) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: JSON.stringify({ ...error.toJSON(), message: error.message }, null, 2) },
        ],
      };
    }
    throw error;
  }
}

/**
 * Register one MCP tool per catalog command.
 *
 * Opt-in, exactly like the NL map-control tools: the platform-free standalone
 * catalog stays read-only and Honua-server-free unless a host supplies a
 * control-plane runtime.
 */
export function registerControlPlaneCommandTools(server: McpServer, host: ControlPlaneCommandMcpHost): void {
  for (const command of Object.values(HONUA_COMMANDS) as readonly HonuaAnyCommand[]) {
    server.registerTool(
      controlPlaneCommandToolName(command.id),
      {
        title: command.title,
        description: `${command.description} Runs the shared \`${command.id}\` control-plane command and returns its deterministic receipt; the receipt's auditKey matches the equivalent CLI, Studio, or direct-JS invocation.`,
        inputSchema: controlPlaneCommandToolSchema(command),
        annotations: {
          readOnlyHint: command.mode === "read",
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => execute(host, command, args as ControlPlaneCommandToolArgs),
    );
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → Zod projection
// ---------------------------------------------------------------------------

function zodForSchema(schema: HonuaCommandJsonSchema): z.ZodTypeAny {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  let base: z.ZodTypeAny;
  switch (type) {
    case "string": {
      let value = z.string();
      if (schema.minLength !== undefined) value = value.min(schema.minLength);
      if (schema.maxLength !== undefined) value = value.max(schema.maxLength);
      base = value;
      break;
    }
    case "integer":
    case "number": {
      let value = z.number();
      if (type === "integer") value = value.int();
      if (schema.minimum !== undefined) value = value.min(schema.minimum);
      if (schema.maximum !== undefined) value = value.max(schema.maximum);
      base = value;
      break;
    }
    case "boolean":
      base = z.boolean();
      break;
    case "array":
      base = z.array(schema.items ? zodForSchema(schema.items) : z.unknown());
      break;
    case "object":
      base = zodForObject(schema);
      break;
    default:
      base = z.unknown();
      break;
  }
  return schema.description ? base.describe(schema.description) : base;
}

function zodForObject(schema: HonuaCommandJsonSchema): z.ZodTypeAny {
  const properties = schema.properties;
  // An object with no declared properties (`options` on `import.create`) is a
  // free-form bag the command passes through verbatim.
  if (!properties) return z.record(z.unknown());
  const required = new Set(schema.required ?? []);
  const shape: z.ZodRawShape = {};
  for (const [name, property] of Object.entries(properties)) {
    const value = zodForSchema(property);
    shape[name] = required.has(name) ? value : value.optional();
  }
  // Passthrough is deliberate — see this module's header.
  return z.object(shape).passthrough();
}
