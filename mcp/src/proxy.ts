#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  type ServerCapabilities,
  ToolListChangedNotificationSchema,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { requireSecureCredentialEndpoint } from "./credential-endpoint.js";
import { isMainEntrypoint } from "./entrypoint.js";
import { SERVER_VERSION } from "./index.js";

// MCP permits server extensions such as Honua's tools/list `view`. The SDK's
// nested params schema strips unknown keys by default, so preserve them before
// forwarding or a stdio caller silently receives the default catalog instead.
const ForwardedListToolsRequestSchema = ListToolsRequestSchema.extend({
  params: ListToolsRequestSchema.shape.params.unwrap().passthrough().optional(),
});

/**
 * Transport-symmetric stdio proxy for the honua MCP surface (honua-server #1950).
 *
 * The honua server exposes a single MCP catalog over streamable-HTTP/SSE at
 * `/mcp`. Claude-Desktop-style clients speak stdio. Rather than reimplementing
 * the tool/resource catalog (the older `@honua/mcp-server` discovery surface did
 * exactly that, which is how the two halves drifted apart), this proxy bridges a
 * local stdio MCP client to the remote HTTP-SSE MCP server: it connects upstream
 * as an MCP client, then re-exposes the *same* catalog downstream over stdio.
 *
 * Because every request and notification is forwarded verbatim, the stdio
 * surface is transport-symmetric with the HTTP-SSE surface by construction —
 * identical tools, identical input/output schemas, identical resources and
 * prompts, and live `list_changed` notifications. There is one source-of-truth
 * catalog (the server's `/mcp`); the SDK proxies it.
 */

export interface ProxyOptions {
  /** Absolute URL of the remote honua MCP endpoint (e.g. https://demo.honua.io/mcp). */
  remoteUrl: string;
  /** Optional bearer token for the remote MCP surface. */
  authToken?: string | undefined;
  /** Optional API key (sent as x-api-key) for deployments that require it. */
  apiKey?: string | undefined;
}

function isConfigured(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function validateAuthentication(options: ProxyOptions): "bearer" | "api-key" | "anonymous" {
  const hasBearer = isConfigured(options.authToken);
  const hasApiKey = isConfigured(options.apiKey);
  if (hasBearer && hasApiKey) {
    throw new Error(
      "Configure exactly one upstream authentication scheme: unset either authToken/HONUA_MCP_AUTH_TOKEN or apiKey/HONUA_ADMIN_KEY/HONUA_API_KEY",
    );
  }
  return hasBearer ? "bearer" : hasApiKey ? "api-key" : "anonymous";
}

function validateProxyOptions(options: ProxyOptions): URL {
  const authMode = validateAuthentication(options);
  return requireSecureCredentialEndpoint(options.remoteUrl, "remoteUrl", authMode !== "anonymous");
}

export function resolveProxyOptions(env: NodeJS.ProcessEnv = process.env): ProxyOptions {
  const remoteUrl = env.HONUA_MCP_REMOTE_URL ?? env.HONUA_MCP_URL;
  if (!remoteUrl) {
    throw new Error("HONUA_MCP_REMOTE_URL environment variable is required (the remote honua /mcp endpoint to proxy).");
  }

  const hasAdminKey = isConfigured(env.HONUA_ADMIN_KEY);
  const hasApiKey = isConfigured(env.HONUA_API_KEY);
  if (hasAdminKey && hasApiKey) {
    throw new Error(
      "Configure one API-key source: unset either HONUA_ADMIN_KEY or HONUA_API_KEY; credential precedence is not allowed",
    );
  }

  const options: ProxyOptions = {
    remoteUrl,
    authToken: env.HONUA_MCP_AUTH_TOKEN,
    apiKey: hasAdminKey ? env.HONUA_ADMIN_KEY : hasApiKey ? env.HONUA_API_KEY : undefined,
  };
  const parsed = validateProxyOptions(options);
  return { ...options, remoteUrl: parsed.toString() };
}

/** Build request headers for the upstream connection from the resolved options. */
export function buildUpstreamHeaders(options: ProxyOptions): Record<string, string> {
  validateProxyOptions(options);
  const headers: Record<string, string> = {};
  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }
  if (options.apiKey) {
    headers["x-api-key"] = options.apiKey;
  }
  return headers;
}

/** Connect an upstream MCP client to the remote honua /mcp over streamable HTTP. */
export async function connectUpstream(options: ProxyOptions): Promise<Client> {
  const headers = buildUpstreamHeaders(options);
  const remoteUrl = validateProxyOptions(options);
  const transport = new StreamableHTTPClientTransport(remoteUrl, {
    requestInit: { ...(Object.keys(headers).length > 0 ? { headers } : {}), redirect: "manual" },
  });
  const client = new Client({ name: "honua-mcp-stdio-proxy", version: SERVER_VERSION });
  await client.connect(transport);
  return client;
}

/**
 * Build a low-level MCP server that forwards every request and `list_changed`
 * notification to the already-connected upstream client. The proxy advertises
 * exactly the upstream's name, version, and capabilities, so the downstream
 * (stdio) surface mirrors the upstream (HTTP-SSE) surface.
 */
export function createProxyServer(upstream: Client): Server {
  const upstreamInfo = upstream.getServerVersion() ?? { name: "honua", version: SERVER_VERSION };
  const upstreamCapabilities: ServerCapabilities = upstream.getServerCapabilities() ?? {};

  const server = new Server(
    { name: upstreamInfo.name, version: upstreamInfo.version },
    {
      capabilities: upstreamCapabilities,
      instructions: upstream.getInstructions(),
    },
  );

  // ── Tools ──────────────────────────────────────────────────────
  if (upstreamCapabilities.tools) {
    server.setRequestHandler(ForwardedListToolsRequestSchema, async (request) => upstream.listTools(request.params));
    server.setRequestHandler(CallToolRequestSchema, async (request) => upstream.callTool(request.params));
  }

  // ── Resources ──────────────────────────────────────────────────
  if (upstreamCapabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => upstream.listResources(request.params));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) =>
      upstream.listResourceTemplates(request.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => upstream.readResource(request.params));
  }

  // ── Prompts ────────────────────────────────────────────────────
  if (upstreamCapabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => upstream.listPrompts(request.params));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => upstream.getPrompt(request.params));
  }

  // ── list_changed notification forwarding ───────────────────────
  // Keeps the stdio surface live: when the server's catalog changes, the
  // downstream client is told, exactly as an HTTP-SSE client would be.
  upstream.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    await server.sendToolListChanged();
  });
  upstream.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
    await server.sendResourceListChanged();
  });
  upstream.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
    await server.sendPromptListChanged();
  });

  return server;
}

/**
 * Bridge one downstream transport to one upstream HTTP session. In particular,
 * forward the caller's initialize instead of letting Client.connect synthesize
 * an earlier initialize without its metadata. The server owns view selection
 * and request overrides; the proxy never supplies a tools/list selector.
 */
export async function connectProxyTransport(options: ProxyOptions, downstream: Transport): Promise<Transport> {
  const headers = buildUpstreamHeaders(options);
  const upstream = new StreamableHTTPClientTransport(validateProxyOptions(options), {
    requestInit: { ...(Object.keys(headers).length > 0 ? { headers } : {}), redirect: "manual" },
  });
  let closed = false;
  let initializeId: string | number | undefined;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([downstream.close().catch(() => {}), upstream.close().catch(() => {})]);
  };
  downstream.onclose = upstream.onclose = () => {
    void shutdown();
  };
  // HTTP errors can contain credential-bearing response bodies. Report a
  // bounded protocol error below, without copying the upstream error text.
  upstream.onerror = () => {};
  downstream.onmessage = (message) => {
    if (isJSONRPCRequest(message) && message.method === "initialize") initializeId = message.id;
    void upstream.send(message).catch(async () => {
      if (isJSONRPCRequest(message)) {
        await downstream
          .send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: ErrorCode.InternalError, message: "Upstream MCP transport request failed" },
          })
          .catch(() => {
            void shutdown();
          });
      } else {
        await shutdown();
      }
    });
  };
  upstream.onmessage = (message) => {
    if (
      isJSONRPCResultResponse(message) &&
      message.id === initializeId &&
      typeof message.result.protocolVersion === "string"
    ) {
      upstream.setProtocolVersion(message.result.protocolVersion);
      downstream.setProtocolVersion?.(message.result.protocolVersion);
      initializeId = undefined;
    }
    void downstream.send(message).catch(() => {
      void shutdown();
    });
  };
  try {
    await upstream.start();
    await downstream.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
  return upstream;
}

/** Run the published stdio executable with the caller's initialize intact. */
export async function runProxy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = resolveProxyOptions(env);
  const transport = new StdioServerTransport();
  const close = () => {
    void transport.close().catch(() => {});
  };
  process.stdin.once("end", close);
  process.stdin.once("close", close);
  try {
    await connectProxyTransport(options, transport);
  } catch (error) {
    process.stdin.off("end", close);
    process.stdin.off("close", close);
    throw error;
  }
}

/* v8 ignore start -- process entry; the transport bridge is tested above. */
if (isMainEntrypoint(import.meta.url)) {
  runProxy().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
/* v8 ignore stop */
