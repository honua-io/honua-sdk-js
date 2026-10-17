import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  type Progress,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const PREFIX = "honua_agent_devops_";
/** Private provisioning/planning only. Day-2 operations remain on the server's canonical MCP surface. */
export const DEVOPS_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "describe_environment",
  "find_recent_operations",
  "provision_infrastructure",
  "install_handoff",
  "verify_install_handoff",
  "plan_gitops_engine",
  "generate_metadata_release_changeset",
  "explain_metadata_release_changeset",
  "plan_metadata_release_gitops",
  "create_gitops_proposal",
  "get_gitops_proposal",
  "get_devops_operation_status",
  "deploy_service_gitops",
  "create_scoped_gitops_pull_request",
  "revert_scoped_gitops_pull_request",
]);

export interface DevOpsExtension {
  listTools(): Promise<Tool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; onprogress?: (progress: Progress) => void },
  ): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Host configuration only. Never accept this configuration from an MCP tool argument. */
export interface DevOpsProcessConfiguration {
  command: string;
  args?: string[];
  cwd?: string;
  /** Explicit child environment, including any operator credentials. Never returned to the model. */
  env?: Record<string, string>;
}

export type DevOpsAuthorization = (action: { canonicalTool: string | null }) => Promise<void>;

/**
 * One optional private subprocess behind the existing public registration. Authorization is
 * rechecked before EVERY discovery/action by the gateway against its current bound principal
 * and target. Canonical handlers still enforce their own approval, audit and exact-plan gates.
 * Errors are intentionally opaque; upstream exceptions may contain credentials or stderr.
 */
export function createDevOpsExtension(
  configuration: DevOpsProcessConfiguration,
  authorize: DevOpsAuthorization,
): DevOpsExtension {
  if (!path.isAbsolute(configuration.command)) throw new Error("DevOps executable must be an absolute host path");
  // Copy configuration so a caller cannot silently change credentials/commands after binding.
  const config = {
    command: configuration.command,
    args: [...(configuration.args ?? ["--mcp"])],
    ...(configuration.cwd ? { cwd: configuration.cwd } : {}),
    ...(configuration.env ? { env: { ...configuration.env } } : {}),
  };
  let pending: Promise<Client> | undefined;
  let closed = false;
  let progressToken = 0;
  const secretValues = Object.entries(config.env ?? {})
    .filter(([key, value]) => /secret|token|password|api_?key|credential/i.test(key) && value.length >= 4)
    .map(([, value]) => value);
  function scrub<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value, (_key, field: unknown) => {
        if (typeof field !== "string") return field;
        let text = field;
        for (const secret of secretValues) text = text.split(secret).join("[REDACTED]");
        return text;
      }),
    ) as T;
  }
  async function connect(): Promise<Client> {
    if (closed) throw new Error("DevOps integration is closed");
    if (!pending) {
      pending = (async () => {
        const client = new Client({ name: "honua-agent-devops", version: "1.0.0" }, { capabilities: {} });
        client.onerror = () => {};
        // Ignore child stderr: operator diagnostics are not model-visible tool content.
        const transport = new StdioClientTransport({ ...config, stderr: "ignore" });
        try {
          await client.connect(transport);
          if (closed) throw new Error("closed");
          return client;
        } catch {
          await client.close().catch(() => {});
          throw new Error("Private DevOps connection failed");
        }
      })();
      // A failed handshake can be retried, but a tool call is NEVER automatically replayed.
      const attempt = pending;
      void attempt.catch(() => {
        if (pending === attempt) pending = undefined;
      });
    }
    return pending;
  }
  async function catalog(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        if (!DEVOPS_TOOL_ALLOWLIST.has(tool.name)) continue;
        if (tools.some((existing) => existing.name === tool.name)) throw new Error("Duplicate private tool");
        tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Invalid private tool cursor");
      if (cursor) cursors.add(cursor);
      if (cursors.size > 100) throw new Error("Private tool catalog too large");
    } while (cursor);
    return tools;
  }
  return {
    async listTools() {
      try {
        await authorize({ canonicalTool: null });
        const tools = await catalog(await connect());
        return scrub(tools.map((tool) => ({ ...tool, name: `${PREFIX}${tool.name}` })));
      } catch {
        throw new Error("Private DevOps discovery unavailable or unauthorized");
      }
    },
    async callTool(name, args, options) {
      const canonicalTool = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : "";
      if (!DEVOPS_TOOL_ALLOWLIST.has(canonicalTool)) throw new Error("Unsupported private DevOps tool");
      try {
        await authorize({ canonicalTool });
        const client = await connect();
        // Discover afresh: do not use a stale descriptor after a target/policy change.
        if (!(await catalog(client)).some((tool) => tool.name === canonicalTool))
          throw new Error("Private DevOps capability unavailable");
        if (canonicalTool === "provision_infrastructure" && args.stack !== "aws-ecs")
          throw new Error("Unsupported provisioning adapter");
        return scrub(
          await client.request(
            {
              method: "tools/call",
              params: {
                name: canonicalTool,
                arguments: args,
                ...(options?.onprogress ? { _meta: { progressToken: ++progressToken } } : {}),
              },
            },
            CallToolResultSchema,
            { signal: options?.signal, onprogress: options?.onprogress },
          ),
        );
      } catch {
        throw new Error(
          "Private DevOps action failed or unauthorized; reconcile canonical operation state before retry",
        );
      }
    },
    async close() {
      closed = true;
      await pending?.then((client) => client.close()).catch(() => {});
    },
  };
}
