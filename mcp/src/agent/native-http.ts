import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildUpstreamHeaders, readWorkflowView } from "../proxy.js";
import { configuredDevOps } from "./devops-configuration.js";
import { DEVOPS_TOOL_FAMILY } from "./devops-runtime.js";
import { HonuaAgentGateway, connectAgentUpstream } from "./gateway.js";
import type { AgentConnection, AgentRuntime } from "./local-runtime.js";

interface NativeBinding {
  workspaceId: string;
  turnId: string;
  targetId: string;
  partition: string;
  connection: AgentConnection;
}

export interface NativeGatewayOptions {
  runtime: AgentRuntime;
  /** Independent backend bridge credential. Never supplied by a browser or a model. */
  bridgeKey: string;
  devopsConfiguration?: string;
  fetchImpl?: typeof fetch;
  maxSessions?: number;
  idleTimeoutMs?: number;
}

class Refusal extends Error {
  constructor(readonly status: number) {
    super("Native gateway request refused");
  }
}

function header(request: IncomingMessage, name: string, optional = false): string {
  const values = request.rawHeaders.filter(
    (_value, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === name,
  );
  const value = request.headers[name];
  if (optional && values.length === 0) return "";
  if (values.length !== 1 || typeof value !== "string" || !value || value.length > 8192) throw new Refusal(400);
  return value;
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Refusal(400);
  return value;
}

function sameSecret(left: string, right: string): boolean {
  const supplied = Buffer.from(left, "utf8");
  const expected = Buffer.from(right, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function samePrincipal(expected: NativeBinding, current: NativeBinding): boolean {
  return (
    expected.workspaceId === current.workspaceId &&
    expected.targetId === current.targetId &&
    expected.partition === current.partition &&
    expected.connection.target.id === current.connection.target.id &&
    expected.connection.target.credentialId === current.connection.target.credentialId &&
    expected.connection.transport.remoteUrl === current.connection.transport.remoteUrl &&
    sameSecret(expected.connection.transport.apiKey ?? "", current.connection.transport.apiKey ?? "")
  );
}

/**
 * Backend-only HTTP transport over the same gateway used by external agents.
 * Sessions pin identity/workspace; AsyncLocalStorage pins each concurrent request's turn.
 * Every request rereads the captured turn under the actual agent credential.
 */
export function createNativeAgentHttpServer(options: NativeGatewayOptions) {
  if (Buffer.byteLength(options.bridgeKey) < 32)
    throw new Error("A separate bridge key of at least 32 bytes is required");
  const network = options.fetchImpl ?? fetch;
  const bindings = new AsyncLocalStorage<NativeBinding>();
  const sessions = new Map<
    string,
    {
      binding: NativeBinding;
      gateway: HonuaAgentGateway;
      transport: StreamableHTTPServerTransport;
      touched: number;
      active: number;
    }
  >();
  let initializing = 0;
  const maximum = options.maxSessions ?? 32;
  const idle = options.idleTimeoutMs ?? 600_000;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 128 || !Number.isFinite(idle) || idle < 1000)
    throw new Error("Invalid native gateway session limits");

  async function authorize(request: IncomingMessage): Promise<NativeBinding> {
    if (request.headers.origin || request.headers.authorization) throw new Refusal(403);
    if (!sameSecret(header(request, "x-honua-gateway-key"), options.bridgeKey)) throw new Refusal(403);
    const workspaceId = identifier(header(request, "x-honua-workspace"));
    const turnId = identifier(header(request, "x-honua-turn"));
    const partition = identifier(header(request, "x-honua-operator-partition"));
    const supplied = header(request, "x-api-key");
    const connection = await options.runtime.resolve();
    if (
      !connection.transport.apiKey ||
      connection.transport.authToken ||
      sameSecret(connection.transport.apiKey, options.bridgeKey) ||
      !sameSecret(supplied, connection.transport.apiKey)
    )
      throw new Refusal(403);
    const base = new URL(connection.transport.remoteUrl);
    const response = await network(new URL(`/api/v1/agent/workspaces/${workspaceId}/turns/${turnId}`, base), {
      headers: buildUpstreamHeaders(connection.transport),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Refusal(response.status >= 500 ? 503 : 403);
    const turn = (await response.json()) as {
      turnId?: unknown;
      context?: { workspaceId?: unknown; targetId?: unknown; tenantId?: unknown };
    };
    if (
      turn.turnId !== turnId ||
      turn.context?.workspaceId !== workspaceId ||
      typeof turn.context.targetId !== "string" ||
      typeof turn.context.tenantId !== "string" ||
      !turn.context.tenantId
    )
      throw new Refusal(403);
    return { workspaceId, turnId, targetId: identifier(turn.context.targetId), partition, connection };
  }

  const boundFetch: typeof fetch = async (input, init) => {
    const binding = bindings.getStore();
    if (!binding) throw new Error("A verified native turn is required for upstream requests");
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(binding.connection.transport.remoteUrl).origin)
      throw new Error("Native upstream origin mismatch");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("X-Honua-Workspace", binding.workspaceId);
    headers.set("X-Honua-Turn", binding.turnId);
    return network(input, { ...init, headers, redirect: "error" });
  };

  function boundRuntime(initial: NativeBinding): AgentRuntime {
    return {
      inspect: async () => ({ ready: true, targetId: initial.targetId }),
      install: async () => {
        throw new Error("Native chat cannot bootstrap the host");
      },
      resolve: async () => {
        const binding = bindings.getStore();
        if (!binding || !samePrincipal(initial, binding)) throw new Error("Native gateway identity changed");
        const connection = await options.runtime.resolve();
        if (!samePrincipal(initial, { ...binding, connection })) throw new Error("Native gateway credential changed");
        return connection;
      },
    };
  }

  async function privateExtension(runtime: AgentRuntime) {
    return options.devopsConfiguration ? configuredDevOps(options.devopsConfiguration, runtime, boundFetch) : undefined;
  }

  async function body(request: IncomingMessage): Promise<unknown> {
    if (
      !String(request.headers["content-type"] ?? "")
        .toLowerCase()
        .startsWith("application/json")
    )
      throw new Refusal(415);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 256 * 1024) throw new Refusal(413);
      chunks.push(bytes);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Refusal(400);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    if (request.url !== "/mcp" && request.url !== "/capabilities") throw new Refusal(404);
    if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) throw new Refusal(405);
    const binding = await authorize(request);
    await bindings.run(binding, async () => {
      if (request.url === "/capabilities") {
        if (request.method !== "GET") throw new Refusal(405);
        const extension = await privateExtension(boundRuntime(binding));
        let available = false;
        try {
          available = Boolean(extension && (await extension.listTools()).length);
        } catch {
          /* Private authorization failure never widens the native catalog. */
        } finally {
          await extension?.close();
        }
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: "honua.agent-gateway.capabilities.v1",
            targetId: binding.targetId,
            workspaceId: binding.workspaceId,
            turnId: binding.turnId,
            toolFamilies: available ? [DEVOPS_TOOL_FAMILY] : [],
          }),
        );
        return;
      }
      const sessionId = header(request, "mcp-session-id", true);
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && (!session || !samePrincipal(session.binding, binding))) throw new Refusal(403);
      const parsed = request.method === "POST" ? await body(request) : undefined;
      if (!session) {
        const initialization = InitializeRequestSchema.safeParse(parsed);
        if (sessionId || request.method !== "POST" || !initialization.success) throw new Refusal(400);
        if (sessions.size + initializing >= maximum) throw new Refusal(429);
        initializing++;
        let gateway: HonuaAgentGateway | undefined;
        try {
          const runtime = boundRuntime(binding);
          gateway = new HonuaAgentGateway(
            runtime,
            (connection, view, binding) => connectAgentUpstream(connection, view, boundFetch, binding),
            await privateExtension(runtime),
            { bootstrapTools: false },
          );
          // Attach before initialize's response so immediate discovery is authoritative.
          await gateway.prepare(readWorkflowView(initialization.data));
          const id = randomUUID();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => id,
            enableJsonResponse: true,
          });
          await gateway.connect(transport);
          session = { binding, gateway, transport, touched: Date.now(), active: 0 };
          sessions.set(id, session);
          const previous = transport.onclose;
          transport.onclose = () => {
            sessions.delete(id);
            previous?.();
          };
        } catch (error) {
          await gateway?.close().catch(() => {});
          throw error;
        } finally {
          initializing--;
        }
      }
      session.touched = Date.now();
      session.active++;
      try {
        await session.transport.handleRequest(request, response, parsed);
      } finally {
        session.active--;
        session.touched = Date.now();
      }
    });
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(error instanceof Refusal ? error.status : 503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end('{"error":"Native gateway request unavailable or unauthorized"}');
      } else response.end();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  const sweep = setInterval(
    () => {
      for (const [id, session] of sessions) {
        if (session.active === 0 && Date.now() - session.touched > idle) {
          sessions.delete(id);
          void session.gateway.close().catch(() => {});
        }
      }
    },
    Math.min(idle, 30_000),
  );
  sweep.unref();
  server.once("close", () => {
    clearInterval(sweep);
    for (const session of sessions.values()) void session.gateway.close().catch(() => {});
    sessions.clear();
  });
  return server;
}
