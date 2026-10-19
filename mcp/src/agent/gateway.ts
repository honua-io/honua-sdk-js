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
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  type Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SERVER_VERSION } from "../index.js";
import { WORKFLOW_VIEW_META_KEY, buildUpstreamHeaders, readWorkflowView } from "../proxy.js";
import type { DevOpsExtension } from "./devops-runtime.js";
import type { AgentConnection, AgentRuntime, AgentTarget } from "./local-runtime.js";
import { WORKFLOW_KNOWLEDGE, WORKFLOW_KNOWLEDGE_URI } from "./workflow-knowledge.js";

// Honua chunks large resource documents. The standard MCP schema strips
// these extension fields before the handler runs, so declare them explicitly.
const honuaReadResourceRequestSchema = ReadResourceRequestSchema.extend({
  params: ReadResourceRequestSchema.shape.params.extend({
    cursor: z.string().optional(),
    maxChars: z.number().int().min(1).max(1_000_000).optional(),
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
const installInput = z
  .object({
    confirm: z.literal(true),
    profile: z.enum(["quickstart", "gp-dev"]).default("quickstart"),
    httpPort: z.number().int().min(1).max(65535).default(8080),
  })
  .strict();
const emptyInput = z.object({}).strict();
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
      "Verify and attach the host-configured existing local installation. Replaces no active target and executes no GIS mutation.",
    inputSchema: emptySchema,
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

export type UpstreamFactory = (connection: AgentConnection, view?: string) => Promise<Client>;

/** A gateway owns initialization; it does not impersonate the downstream client. */
export async function connectAgentUpstream(
  connection: AgentConnection,
  view?: string,
  fetchImpl?: typeof fetch,
): Promise<Client> {
  const headers = buildUpstreamHeaders(connection.transport);
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
  #transition = false;
  #active = 0;
  #initialized = false;
  #closed = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly upstream: UpstreamFactory = connectAgentUpstream,
    private readonly devops?: DevOpsExtension,
    private readonly options: { bootstrapTools?: boolean } = {},
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
      if (!this.#client) return { tools: bootstrap };
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
        ? {
            contents: [
              { uri: WORKFLOW_KNOWLEDGE_URI, mimeType: "application/json", text: JSON.stringify(WORKFLOW_KNOWLEDGE) },
            ],
          }
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
          this.#view = readWorkflowView(InitializeRequestSchema.parse(message));
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
    if (!client || this.#transition)
      throw new McpError(ErrorCode.InvalidRequest, "Honua is not attached; inspect connector status");
    this.#active++;
    try {
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

  async #attach(install?: z.infer<typeof installInput>): Promise<void> {
    if (this.#transition || this.#active) throw new Error("Connector is busy");
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
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await candidate.listTools(cursor ? { cursor } : undefined);
        if (page.tools.some((tool) => tool.name.startsWith(PREFIX))) throw new Error("Reserved namespace collision");
        cursor = page.nextCursor;
        if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid catalog pagination");
        if (cursor) cursors.add(cursor);
      } while (cursor);
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
      candidate = undefined;
    } finally {
      await candidate?.close().catch(() => {});
      this.#transition = false;
      await this.#notify();
    }
  }

  async #local(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      if (name !== `${PREFIX}install_local`) emptyInput.parse(args);
      switch (name) {
        case `${PREFIX}status`:
          return result({
            state: this.#transition ? "connecting" : this.#client ? "attached" : "unattached",
            target: this.#target ?? null,
            activeRequests: this.#active,
          });
        case `${PREFIX}inspect_local`:
          return result(await this.runtime.inspect());
        case `${PREFIX}connect`:
          await this.#attach();
          return result({ state: "attached", target: this.#target });
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
