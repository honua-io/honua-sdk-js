#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
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
} from "@modelcontextprotocol/sdk/types.js";
import { requireSecureCredentialEndpoint } from "./credential-endpoint.js";
import { isMainEntrypoint } from "./entrypoint.js";
import { SERVER_VERSION } from "./index.js";
import { DeferredInitializationTransport, WORKFLOW_VIEW_META_KEY } from "./proxy-initialization.js";

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
export async function connectUpstream(options: ProxyOptions, workflowView?: string, signal?: AbortSignal): Promise<Client> {
  const headers = buildUpstreamHeaders(options);
  const remoteUrl = validateProxyOptions(options);
  const transport = new StreamableHTTPClientTransport(remoteUrl, {
    requestInit: { ...(Object.keys(headers).length > 0 ? { headers } : {}), redirect: "manual" },
  });
  // Client.connect owns protocol negotiation, session headers and initialized.
  // Add only the recognized view to its initialize; downstream metadata cannot
  // inject credentials, client identity or other upstream configuration.
  if (workflowView !== undefined) {
    const send = transport.send.bind(transport);
    transport.send = async (message, sendOptions) => {
      if ("method" in message && message.method === "initialize") {
        return send({
          ...message,
          params: { ...message.params, _meta: { [WORKFLOW_VIEW_META_KEY]: workflowView } },
        }, sendOptions);
      }
      return send(message, sendOptions);
    };
  }
  const client = new Client({ name: "honua-mcp-stdio-proxy", version: SERVER_VERSION });
  try {
    await client.connect(transport, { timeout: 30_000, signal });
    return client;
  } catch (error) {
    // Client.connect starts cleanup on failure, but does not await it. Retain
    // ownership here until the transport and its pending HTTP/SSE work close.
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
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

/* v8 ignore start -- live-process entry: wires the stdio transport to a real
   remote /mcp upstream; exercised by running the proxy, not by unit tests. The
   unit-testable logic (option/header resolution, upstream connect, catalog
   forwarding) lives in the exported functions above and is covered there. */

/**
 * Run the stdio proxy end-to-end: resolve the remote `/mcp` from the
 * environment, connect upstream, and expose the mirrored catalog over stdio.
 * Also used by the deprecated `honua-mcp` bin, which now delegates here.
 */
export async function runProxy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = resolveProxyOptions(env);
  const transport = new DeferredInitializationTransport(new StdioServerTransport());
  const initialization = new AbortController();
  let upstream: Client | undefined;
  let server: Server | undefined;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  const inputEnded = () => { void shutdown(); };

  // Tear down both ends together so a dropped upstream surfaces to the client.
  const shutdown = (): Promise<void> => {
    if (closing) return shutdownPromise ?? Promise.resolve();
    closing = true;
    process.stdin.off("end", inputEnded);
    initialization.abort();
    shutdownPromise = (async () => {
      await server?.close().catch(() => {});
      await transport.close().catch(() => {});
      await upstream?.close().catch(() => {});
    })();
    return shutdownPromise;
  };
  // Until Server.connect installs its lifecycle hook, EOF/timeout must cancel
  // the pending upstream initialize too; no detached HTTP session may survive.
  transport.onclose = () => { initialization.abort(); };
  // The SDK stdio transport watches data/error, but does not turn stdin EOF
  // into its onclose callback. Own that process lifecycle boundary explicitly.
  process.stdin.once("end", inputEnded);
  try {
    const workflowView = await transport.waitForInitialize();
    upstream = await connectUpstream(options, workflowView, initialization.signal);
    if (closing || initialization.signal.aborted) {
      await upstream.close().catch(() => {});
      throw new Error("Downstream closed while the upstream session connected");
    }
    server = createProxyServer(upstream);
    const closeBoth = () => {
      void shutdown();
    };
    upstream.onclose = closeBoth;
    server.onclose = closeBoth;
    await server.connect(transport);
  } catch {
    await shutdown();
    throw new Error("Proxy initialization failed; verify the endpoint, credentials and workflow view");
  }
}

if (isMainEntrypoint(import.meta.url)) {
  runProxy().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
/* v8 ignore stop */
