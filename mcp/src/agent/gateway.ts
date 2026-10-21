import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  InitializeRequestSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  type Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { z as protocolZod } from "zod/v4";
import { SERVER_VERSION } from "../index.js";
import { WORKFLOW_VIEW_META_KEY, buildUpstreamHeaders, readWorkflowView } from "../proxy.js";
import type { DevOpsExtension } from "./devops-runtime.js";
import type { AgentConnection, AgentRuntime, AgentTarget } from "./local-runtime.js";
import { WORKFLOW_KNOWLEDGE, WORKFLOW_KNOWLEDGE_URI } from "./workflow-knowledge.js";

// Honua chunks large resource documents. The standard MCP schema strips
// these extension fields before the handler runs, so declare them explicitly.
const honuaReadResourceRequestSchema = ReadResourceRequestSchema.extend({
  params: ReadResourceRequestSchema.shape.params.extend({
    cursor: protocolZod.string().optional(),
    maxChars: protocolZod.number().int().min(1).max(1_000_000).optional(),
  }),
});

const PREFIX = "honua_agent_";
const DEVOPS_PREFIX = "honua_agent_devops_";
const knowledgeResource = {
  uri: WORKFLOW_KNOWLEDGE_URI,
  name: "Honua conversational GIS workflows v1",
  description: "Versioned workflow semantics and evidence requirements; canonical tools remain authoritative.",
  mimeType: "application/json",
};
const knowledgeText = JSON.stringify(WORKFLOW_KNOWLEDGE);
const knowledgeDigest = createHash("sha256").update(knowledgeText).digest("hex");

function readKnowledgeWindow(params: { cursor?: string; maxChars?: number }): ReadResourceResult {
  let offset = 0;
  if (params.cursor !== undefined) {
    const invalid = () => new McpError(ErrorCode.InvalidParams, "Invalid workflow knowledge continuation cursor");
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(params.cursor)) throw invalid();
    const decoded = Buffer.from(params.cursor, "base64url");
    if (decoded.toString("base64url") !== params.cursor) throw invalid();
    const [digest, position, ...extra] = decoded.toString("utf8").split(":");
    if (digest !== knowledgeDigest || extra.length !== 0 || !/^[1-9][0-9]*$/.test(position ?? "")) throw invalid();
    offset = Number(position);
    if (!Number.isSafeInteger(offset) || offset >= knowledgeText.length) throw invalid();
  }
  const end = Math.min(offset + (params.maxChars ?? 64_000), knowledgeText.length);
  return {
    contents: [{ uri: WORKFLOW_KNOWLEDGE_URI, mimeType: "application/json", text: knowledgeText.slice(offset, end) }],
    ...(end < knowledgeText.length
      ? { nextCursor: Buffer.from(`${knowledgeDigest}:${end}`).toString("base64url") }
      : {}),
  };
}

const installInput = z
  .object({
    confirm: z.literal(true),
    profile: z.enum(["quickstart", "gp-dev"]).default("quickstart"),
    httpPort: z.number().int().min(1).max(65535).default(8080),
  })
  .strict();
const emptyInput = z.object({}).strict();
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const connectInput = z.union([emptyInput, z.object({ workspaceId: identifier, turnId: identifier }).strict()]);
const emptySchema = { type: "object" as const, properties: {}, additionalProperties: false };
const localTools: Tool[] = [
  {
    name: `${PREFIX}status`,
    description: "Read this connector's verified target and handoff state. No credentials are returned.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: `${PREFIX}inspect_local`,
    description: "Inspect Docker prerequisites on this host without creating an installation.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: `${PREFIX}connect`,
    description:
      "Verify and attach the host-configured installation. With workspaceId and turnId, explicitly bind subsequent calls to that authorized human turn. An idle later call may bind a different verified turn; in-flight calls keep their original session. The Server rechecks current authority on every call.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
        turnId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
      },
      oneOf: [{ maxProperties: 0 }, { required: ["workspaceId", "turnId"] }],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: `${PREFIX}install_local`,
    description:
      "Install Honua into the host-configured directory, then verify authentication and attach its MCP catalog. Requires explicit installation authorization; returns no secrets.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { const: true, type: "boolean" },
        profile: { type: "string", enum: ["quickstart", "gp-dev"], default: "quickstart" },
        httpPort: { type: "integer", minimum: 1, maximum: 65535, default: 8080 },
      },
      required: ["confirm"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

export interface AgentTurnBinding {
  workspaceId: string;
  turnId: string;
}
export type UpstreamFactory = (
  connection: AgentConnection,
  view?: string,
  binding?: AgentTurnBinding,
) => Promise<Client>;

/** A gateway owns initialization; it does not impersonate the downstream client. */
export async function connectAgentUpstream(
  connection: AgentConnection,
  view?: string,
  fetchImpl?: typeof fetch,
  binding?: AgentTurnBinding,
): Promise<Client> {
  const headers = buildUpstreamHeaders(connection.transport);
  if (binding) {
    headers["X-Honua-Workspace"] = binding.workspaceId;
    headers["X-Honua-Turn"] = binding.turnId;
  }
  const transport = new StreamableHTTPClientTransport(new URL(connection.transport.remoteUrl), {
    requestInit: { headers, redirect: "manual" },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if ("method" in message && message.method === "initialize" && view) {
      return send({ ...message, params: { ...message.params, _meta: { [WORKFLOW_VIEW_META_KEY]: view } } }, options);
    }
    return send(message, options);
  };
  const client = new Client({ name: "honua-agent-gateway", version: SERVER_VERSION }, { capabilities: {} });
  try {
    await client.connect(transport);
    return client;
  } catch {
    await client.close().catch(() => {});
    throw new Error("Upstream connection failed");
  }
}

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function sameConnection(left: AgentConnection, right: AgentConnection): boolean {
  return (
    left.target.id === right.target.id &&
    left.target.endpoint === right.target.endpoint &&
    left.target.credentialId === right.target.credentialId &&
    left.transport.remoteUrl === right.transport.remoteUrl &&
    left.transport.apiKey === right.transport.apiKey &&
    left.transport.authToken === right.transport.authToken &&
    left.credentialKind === right.credentialKind &&
    left.releaseId === right.releaseId
  );
}

/** One configured installation per process. Target changes require an explicit host restart. */
export class HonuaAgentGateway {
  readonly server = new Server(
    { name: "honua-agent", version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
    },
  );
  #client?: Client;
  #target?: AgentTarget;
  #view?: string;
  #connection?: AgentConnection;
  #turnBinding?: AgentTurnBinding;
  #boundTargetId?: string;
  #bindingStale = false;
  #bindingFailed = false;
  #transition = false;
  #active = 0;
  #initialized = false;
  #closed = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly upstream: UpstreamFactory = (connection, view, binding) =>
      connectAgentUpstream(connection, view, undefined, binding),
    private readonly devops?: DevOpsExtension,
    private readonly options: { bootstrapTools?: boolean; fetchImpl?: typeof fetch } = {},
  ) {
    this.server.oninitialized = () => {
      this.#initialized = true;
      void this.#attach().catch(() => {});
    };
    this.server.onclose = () => {
      this.#closed = true;
      void this.#client?.close().catch(() => {});
      void this.devops?.close().catch(() => {});
    };
    // Never log transport errors: HTTP error bodies can contain credentials.
    this.server.onerror = () => {};
    this.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const bootstrap = this.options.bootstrapTools === false ? [] : localTools;
      if (!this.#client || this.#bindingFailed || this.#bindingStale) return { tools: bootstrap };
      const page = await this.#withClient((client) =>
        client.request(request, ListToolsResultSchema, { signal: extra.signal }),
      );
      if (page.tools.some((tool) => tool.name.startsWith(PREFIX)))
        throw new McpError(ErrorCode.InvalidRequest, "Reserved connector tool namespace collision");
      // A missing/private integration must not make the public GIS catalog unavailable.
      const privateTools = !request.params?.cursor && this.devops ? await this.devops.listTools().catch(() => []) : [];
      return { ...page, tools: request.params?.cursor ? page.tools : [...bootstrap, ...privateTools, ...page.tools] };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const token = request.params._meta?.progressToken;
      if (request.params.name.startsWith(DEVOPS_PREFIX)) {
        if (!this.devops) throw new McpError(ErrorCode.MethodNotFound, "Private DevOps integration is not configured");
        return this.#withClient(() =>
          this.devops!.callTool(request.params.name, request.params.arguments ?? {}, {
            signal: extra.signal,
            ...(token === undefined
              ? {}
              : {
                  onprogress: (progress) => {
                    void extra
                      .sendNotification({
                        method: "notifications/progress",
                        params: { ...progress, progressToken: token },
                      })
                      .catch(() => {});
                  },
                }),
          }),
        );
      }
      if (request.params.name.startsWith(PREFIX) && this.options.bootstrapTools === false)
        throw new McpError(ErrorCode.MethodNotFound, "Host installation tools are unavailable in native chat");
      if (request.params.name.startsWith(PREFIX))
        return this.#local(request.params.name, request.params.arguments ?? {});
      return this.#withClient((client) =>
        client.request(request, CallToolResultSchema, {
          signal: extra.signal,
          ...(token === undefined
            ? {}
            : {
                onprogress: (progress) => {
                  void extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: { ...progress, progressToken: token },
                    })
                    .catch(() => {});
                },
              }),
        }),
      );
    });
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
      if (!this.#client) return { resources: [knowledgeResource] };
      const page = await this.#withClient((client) =>
        client.request(request, ListResourcesResultSchema, { signal: extra.signal }),
      );
      if (page.resources.some((resource) => resource.uri === WORKFLOW_KNOWLEDGE_URI))
        throw new McpError(ErrorCode.InvalidRequest, "Reserved workflow knowledge URI collision");
      return { ...page, resources: request.params?.cursor ? page.resources : [knowledgeResource, ...page.resources] };
    });
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, (request, extra) =>
      !this.#client
        ? { resourceTemplates: [] }
        : this.#withClient((client) =>
            client.request(request, ListResourceTemplatesResultSchema, { signal: extra.signal }),
          ),
    );
    this.server.setRequestHandler(honuaReadResourceRequestSchema, (request, extra) =>
      request.params.uri === WORKFLOW_KNOWLEDGE_URI
        ? readKnowledgeWindow(request.params)
        : this.#withClient((client) => client.request(request, ReadResourceResultSchema, { signal: extra.signal })),
    );
    this.server.setRequestHandler(ListPromptsRequestSchema, (request, extra) =>
      !this.#client
        ? { prompts: [] }
        : this.#withClient((client) => client.request(request, ListPromptsResultSchema, { signal: extra.signal })),
    );
    this.server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
      this.#withClient((client) => client.request(request, GetPromptResultSchema, { signal: extra.signal })),
    );
  }

  async connect(transport: Transport): Promise<void> {
    // Capture only the upstream-owned view selector while letting Server negotiate
    // its own identity and capabilities with the downstream client.
    let receiver: Transport["onmessage"];
    const wrapper: Transport = {
      start: () => transport.start(),
      close: () => transport.close(),
      send: (message, options) => transport.send(message, options),
      get sessionId() {
        return transport.sessionId;
      },
      setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
      get onclose() {
        return transport.onclose;
      },
      set onclose(value) {
        transport.onclose = value;
      },
      get onerror() {
        return transport.onerror;
      },
      set onerror(value) {
        transport.onerror = value;
      },
      get onmessage() {
        return receiver;
      },
      set onmessage(value) {
        receiver = value;
      },
    };
    transport.onmessage = (message, extra) => {
      if ("method" in message && message.method === "initialize") {
        try {
          // Ordinary MCP hosts do not send Honua-specific view metadata. The
          // persistent connector spans GIS workflows, including Studio; the
          // Server's bounded default omits those tools. Membership and authority
          // remain Server-owned, and an explicit client view still takes priority.
          this.#view = readWorkflowView(InitializeRequestSchema.parse(message)) ?? "full";
        } catch {
          if ("id" in message)
            void transport
              .send({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: ErrorCode.InvalidParams, message: "Invalid workflow view" },
              })
              .catch(() => {})
              .finally(() => transport.close());
          return;
        }
      }
      receiver?.(message, extra);
    };
    await this.server.connect(wrapper);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#client?.close();
    await this.devops?.close();
    await this.server.close();
  }

  /** Native HTTP discovery must not race the external connector's background attachment. */
  async prepare(view?: string): Promise<void> {
    this.#view = view;
    await this.#attach();
  }

  async #withClient<T>(call: (client: Client) => Promise<T>): Promise<T> {
    const client = this.#client;
    const binding = this.#turnBinding;
    if (!client || this.#transition || this.#bindingStale || this.#bindingFailed)
      throw new McpError(ErrorCode.InvalidRequest, "Honua is not attached; inspect connector status");
    this.#active++;
    try {
      if (binding) {
        let current: AgentConnection | undefined;
        try {
          current = await this.runtime.resolve();
        } catch {
          this.#bindingStale = true;
        }
        if (!this.#connection || !current || !sameConnection(this.#connection, current)) {
          this.#bindingStale = true;
          throw new Error("Turn-bound connector identity changed");
        }
        try {
          const targetId = await this.#readTurnTarget(current, binding);
          if (targetId !== this.#boundTargetId) throw new Error("Bound turn target changed");
        } catch {
          this.#bindingStale = true;
          throw new Error("Turn-bound authorization changed");
        }
      }
      // Another preflight can revoke this session while this one awaits its
      // authorized turn read. Never dispatch after that revocation or a swap.
      if (
        this.#bindingStale ||
        this.#bindingFailed ||
        this.#transition ||
        this.#client !== client ||
        this.#turnBinding !== binding
      )
        throw new Error("Connector binding changed during authorization");
      return await call(client);
    } catch (error) {
      // Preserve structured tool errors (returned results), but never echo raw
      // HTTP/protocol exception messages into a credentialed model session.
      if (error instanceof McpError && error.code === ErrorCode.MethodNotFound)
        throw new McpError(error.code, "Operation unavailable on the attached deployment");
      throw new McpError(
        ErrorCode.InternalError,
        "Upstream request failed; outcome may be unknown. Inspect the existing operation before retrying a mutation.",
      );
    } finally {
      this.#active--;
    }
  }

  async #notify(): Promise<void> {
    if (!this.#initialized || this.#closed) return;
    await Promise.all([
      this.server.notification({ method: "notifications/tools/list_changed" }),
      this.server.notification({ method: "notifications/resources/list_changed" }),
      this.server.notification({ method: "notifications/prompts/list_changed" }),
    ]).catch(() => {});
  }

  async #validateCatalog(candidate: Client): Promise<void> {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await candidate.listTools(cursor ? { cursor } : undefined);
      if (page.tools.some((tool) => tool.name.startsWith(PREFIX))) throw new Error("Reserved namespace collision");
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid catalog pagination");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }

  async #attach(install?: z.infer<typeof installInput>): Promise<void> {
    if (this.#transition || this.#active) throw new Error("Connector is busy");
    if (this.#turnBinding || this.#bindingStale || this.#bindingFailed)
      throw new Error("A turn-bound connector cannot fall back to unbound mode");
    if (install && this.#target) throw new Error("An established target cannot be reinstalled in this session");
    if (this.#client) {
      if (install) throw new Error("Already attached; installation cannot run in an active session");
      return;
    }
    this.#transition = true;
    let candidate: Client | undefined;
    try {
      if (install) await this.runtime.install(install);
      const connection = await this.runtime.resolve();
      if (this.#target && this.#target.id !== connection.target.id)
        throw new Error("Target identity changed; reconnect explicitly");
      candidate = await this.upstream(connection, this.#view);
      await this.#validateCatalog(candidate);
      if (this.#closed) throw new Error("Connector closed during attachment");
      const attached = candidate;
      attached.onerror = () => {
        if (this.#client === attached) {
          this.#client = undefined;
          void attached.close().catch(() => {});
          void this.#notify();
        }
      };
      attached.onclose = () => {
        if (this.#client === attached) {
          this.#client = undefined;
          void this.#notify();
        }
      };
      attached.setNotificationHandler(ToolListChangedNotificationSchema, () => this.#notify());
      attached.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.#notify());
      attached.setNotificationHandler(PromptListChangedNotificationSchema, () => this.#notify());
      this.#client = attached;
      this.#target = connection.target;
      this.#connection = connection;
      candidate = undefined;
    } finally {
      await candidate?.close().catch(() => {});
      this.#transition = false;
      await this.#notify();
    }
  }

  async #readTurnTarget(connection: AgentConnection, binding: AgentTurnBinding): Promise<string> {
    const response = await (this.options.fetchImpl ?? fetch)(
      new URL(
        `/api/v1/agent/workspaces/${binding.workspaceId}/turns/${binding.turnId}`,
        connection.transport.remoteUrl,
      ),
      { headers: buildUpstreamHeaders(connection.transport), redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error("Original authorized turn is unavailable");
    const observed = (await response.json()) as {
      turnId?: unknown;
      context?: { workspaceId?: unknown; targetId?: unknown; tenantId?: unknown };
    };
    if (
      observed.turnId !== binding.turnId ||
      observed.context?.workspaceId !== binding.workspaceId ||
      typeof observed.context?.targetId !== "string" ||
      !observed.context.targetId ||
      typeof observed.context.tenantId !== "string" ||
      !observed.context.tenantId
    )
      throw new Error("Original turn does not match this target");
    return observed.context.targetId;
  }

  async #bindTurn(binding: AgentTurnBinding): Promise<void> {
    if (this.#transition || this.#active || !this.#client || !this.#connection)
      throw new Error("Connector is busy or unavailable");
    if (this.#bindingStale && !this.#turnBinding) throw new Error("Connector identity is unavailable");
    if (
      this.#bindingStale &&
      this.#turnBinding &&
      (this.#turnBinding.workspaceId !== binding.workspaceId || this.#turnBinding.turnId !== binding.turnId)
    )
      throw new Error("A stale connector can only recover its original turn");
    // A valid explicit bind supersedes the prior context. If verification
    // fails, retain that client only for an explicit verified retry.
    this.#bindingFailed = true;
    this.#transition = true;
    let candidate: Client | undefined;
    try {
      const connection = await this.runtime.resolve();
      if (
        connection.credentialKind !== "workspace-agent" ||
        !connection.releaseId ||
        !sameConnection(this.#connection, connection)
      )
        throw new Error("Current workspace agent credential changed or is unavailable");
      const targetId = await this.#readTurnTarget(connection, binding);
      candidate = await this.upstream(connection, this.#view, binding);
      await this.#validateCatalog(candidate);
      if (!sameConnection(connection, await this.runtime.resolve()) || this.#closed)
        throw new Error("Connector identity changed while binding the turn");
      const prior = this.#client;
      this.#client = candidate;
      this.#turnBinding = { ...binding };
      this.#boundTargetId = targetId;
      const bound = candidate;
      bound.onerror = () => {
        if (this.#client === bound) this.#bindingStale = true;
      };
      bound.onclose = () => {
        if (this.#client === bound) this.#bindingStale = true;
      };
      bound.setNotificationHandler(ToolListChangedNotificationSchema, () => this.#notify());
      bound.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.#notify());
      bound.setNotificationHandler(PromptListChangedNotificationSchema, () => this.#notify());
      this.#bindingStale = false;
      this.#bindingFailed = false;
      candidate = undefined;
      await prior.close().catch(() => {});
    } finally {
      await candidate?.close().catch(() => {});
      this.#transition = false;
      await this.#notify();
    }
  }

  async #local(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      if (name === `${PREFIX}connect`) connectInput.parse(args);
      else if (name !== `${PREFIX}install_local`) emptyInput.parse(args);
      switch (name) {
        case `${PREFIX}status`:
          return result({
            state:
              this.#bindingStale || this.#bindingFailed
                ? "unavailable"
                : this.#transition
                  ? "connecting"
                  : this.#client
                    ? "attached"
                    : "unattached",
            target: this.#target ?? null,
            activeRequests: this.#active,
            turnBinding: this.#turnBinding ?? null,
          });
        case `${PREFIX}inspect_local`:
          return result(await this.runtime.inspect());
        case `${PREFIX}connect`:
          if ("workspaceId" in args && "turnId" in args)
            await this.#bindTurn({ workspaceId: String(args.workspaceId), turnId: String(args.turnId) });
          else await this.#attach();
          return result({
            state: "attached",
            target: this.#target,
            ...(this.#turnBinding ? { turnBinding: this.#turnBinding } : {}),
          });
        case `${PREFIX}install_local`:
          await this.#attach(installInput.parse(args));
          return result({ state: "attached", target: this.#target });
        default:
          throw new McpError(ErrorCode.MethodNotFound, "Unknown connector tool");
      }
    } catch {
      return {
        ...result({
          state: "unavailable",
          code: "connector-action-refused",
          next: "Inspect connector status and local prerequisites; do not retry uncertain mutations.",
        }),
        isError: true,
      };
    }
  }
}
