#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type InitializeRequest,
  InitializeRequestSchema,
  type JSONRPCMessage,
  type JSONRPCRequest,
  isInitializedNotification,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { requireSecureCredentialEndpoint } from "./credential-endpoint.js";
import { isMainEntrypoint } from "./entrypoint.js";
import { SERVER_VERSION } from "./index.js";

/**
 * Transport-symmetric stdio proxy for the honua MCP surface (honua-server #1950).
 *
 * The honua server exposes a single MCP catalog over streamable-HTTP/SSE at
 * `/mcp`. Claude-Desktop-style clients speak stdio. Rather than reimplementing
 * the tool/resource catalog (the older `@honua/mcp-server` discovery surface did
 * exactly that, which is how the two halves drifted apart), this proxy bridges a
 * local stdio MCP client to the remote HTTP-SSE MCP server: each stdio client
 * gets one upstream streamable-HTTP session, opened by the client's own
 * initialize, and every later message is relayed over that session.
 *
 * Because every request and notification is forwarded verbatim (initialize's
 * `_meta` is narrowed to the workflow-view selector), the stdio
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

interface UpstreamHttpDiagnostic {
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}

const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 502, 503, 504]);

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (trimmed.length > 0 && Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate)) return undefined;
  return Math.max(0, Math.ceil((parsedDate - Date.now()) / 1_000));
}

function resolveUpstreamRetryable(statusCode: number, headerValue: string | null): boolean {
  const normalized = headerValue?.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return RETRYABLE_UPSTREAM_STATUSES.has(statusCode);
}

function createObservingFetch(onHttpError: (diagnostic: UpstreamHttpDiagnostic) => void): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) {
      const retryableHeader = response.headers.get("honua-retryable") ?? response.headers.get("honua-error-retryable");
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
      onHttpError({
        statusCode: response.status,
        retryable: resolveUpstreamRetryable(response.status, retryableHeader),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    }
    return response;
  };
}

function buildUpstreamDiagnostic(
  error: unknown,
  lastHttpFailure: UpstreamHttpDiagnostic | undefined,
): { readonly message: string; readonly data: UpstreamHttpDiagnostic } {
  const errorStatus =
    error instanceof StreamableHTTPError && typeof error.code === "number" && error.code >= 100
      ? error.code
      : undefined;
  const statusCode = errorStatus ?? lastHttpFailure?.statusCode;
  if (statusCode === undefined) {
    return { message: "Upstream MCP transport error", data: { retryable: false } };
  }
  const matched = lastHttpFailure?.statusCode === statusCode ? lastHttpFailure : undefined;
  const retryable = matched?.retryable ?? resolveUpstreamRetryable(statusCode, null);
  const retryAfterSeconds = matched?.retryAfterSeconds;
  const retryText = retryable ? "retryable" : "non-retryable";
  const delayText = retryAfterSeconds !== undefined ? `; retry after ${retryAfterSeconds}s` : "";
  return {
    message: `Upstream MCP HTTP ${statusCode} (${retryText}${delayText})`,
    data: {
      statusCode,
      retryable,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    },
  };
}

function createUpstreamTransport(
  options: ProxyOptions,
  onHttpError?: (diagnostic: UpstreamHttpDiagnostic) => void,
): StreamableHTTPClientTransport {
  const headers = buildUpstreamHeaders(options);
  return new StreamableHTTPClientTransport(validateProxyOptions(options), {
    requestInit: { ...(Object.keys(headers).length > 0 ? { headers } : {}), redirect: "manual" },
    ...(onHttpError ? { fetch: createObservingFetch(onHttpError) } : {}),
  });
}

/**
 * Connect a direct MCP client to the remote honua /mcp over streamable HTTP.
 * Certification and evals use it as the HTTP reference side; the stdio proxy
 * does not, because Client.connect would send its own initialize.
 */
export async function connectUpstream(options: ProxyOptions): Promise<Client> {
  const client = new Client({ name: "honua-mcp-stdio-proxy", version: SERVER_VERSION });
  await client.connect(createUpstreamTransport(options));
  return client;
}

/** The server's only initialize metadata key; the session view selector. */
export const WORKFLOW_VIEW_META_KEY = "honua.io/workflow-view";
const MAX_WORKFLOW_VIEW_LENGTH = 64;
const INITIALIZE_TIMEOUT_MS = 30_000;

/** Read the optional view selector under the server's own contract. */
export function readWorkflowView(request: InitializeRequest): string | undefined {
  const value = request.params._meta?.[WORKFLOW_VIEW_META_KEY];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_WORKFLOW_VIEW_LENGTH) {
    throw new Error("Invalid workflow view selector");
  }
  return value.trim().length === 0 ? undefined : value;
}

/**
 * Validate the caller's initialize and narrow its `_meta` to the recognised
 * view selector. Every other field is the caller's own and passes unchanged;
 * other metadata stays local rather than entering the credentialed session.
 */
function upstreamInitialize(message: JSONRPCRequest): JSONRPCRequest {
  const view = readWorkflowView(InitializeRequestSchema.parse(message));
  const { _meta: _ignored, ...params } = message.params ?? {};
  return {
    ...message,
    params: { ...params, ...(view === undefined ? {} : { _meta: { [WORKFLOW_VIEW_META_KEY]: view } }) },
  };
}

export interface ProxyBridgeOptions {
  /** Bound on initialize arriving and its upstream response; defaults to 30 s. */
  initializeTimeoutMs?: number;
}

/**
 * Bridge one downstream transport to one upstream HTTP session. In particular,
 * forward the caller's initialize instead of letting Client.connect synthesize
 * an earlier initialize without its metadata. The server owns view selection
 * and request overrides; the proxy never supplies a tools/list selector.
 *
 * The handshake fails closed: traffic before initialize, an initialize the
 * server's selector contract would refuse, a second initialize, or a handshake
 * that does not complete within the bound gets a JSON-RPC error (when it has
 * an id) and closes both transports. Nothing invalid reaches the server.
 */
export async function connectProxyTransport(
  options: ProxyOptions,
  downstream: Transport,
  bridge: ProxyBridgeOptions = {},
): Promise<Transport> {
  let lastHttpFailure: UpstreamHttpDiagnostic | undefined;
  const upstream = createUpstreamTransport(options, (diagnostic) => {
    lastHttpFailure = diagnostic;
  });
  let closed = false;
  let refused = false;
  let initializeSeen = false;
  let initializeId: string | number | undefined;
  let initialized = Promise.resolve();
  let pendingErrorTimer: ReturnType<typeof setTimeout> | undefined;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(handshake);
    if (pendingErrorTimer !== undefined) clearTimeout(pendingErrorTimer);
    await Promise.all([downstream.close().catch(() => {}), upstream.close().catch(() => {})]);
  };
  // Reply before closing so the caller learns why its session ended. The
  // message is the proxy's own; nothing from upstream is echoed.
  const refuse = (
    id: string | number | undefined,
    error: { readonly code: ErrorCode; readonly message: string; readonly data?: UpstreamHttpDiagnostic },
  ) => {
    if (closed || refused) return;
    refused = true;
    const reply = id === undefined ? Promise.resolve() : downstream.send({ jsonrpc: "2.0", id, error });
    void reply.catch(() => {}).finally(() => shutdown());
  };
  const reportUpstreamFailure = (id: string | number | undefined, error: unknown) => {
    if (closed || refused) return;
    const diagnostic = buildUpstreamDiagnostic(error, lastHttpFailure);
    if (id !== undefined) {
      refuse(id, { code: ErrorCode.InternalError, message: diagnostic.message, data: diagnostic.data });
      return;
    }
    refused = true;
    const notice: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "error", logger: "honua-mcp-proxy", data: { message: diagnostic.message, ...diagnostic.data } },
    };
    void downstream
      .send(notice)
      .catch(() => {})
      .finally(() => shutdown());
  };
  const handshake = setTimeout(
    () => refuse(initializeId, { code: ErrorCode.RequestTimeout, message: "Proxy initialization timed out" }),
    bridge.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
  );
  downstream.onclose = upstream.onclose = () => {
    void shutdown();
  };
  // HTTP/SSE errors can contain credential-bearing response bodies. Emit only
  // redacted status/retryability diagnostics before closing both transports.
  // Defer onerror by a macrotask so a request-scoped send() rejection can claim
  // its JSON-RPC request id first while background SSE failures still close.
  upstream.onerror = (error) => {
    if (closed || refused || pendingErrorTimer !== undefined) return;
    pendingErrorTimer = setTimeout(() => {
      pendingErrorTimer = undefined;
      reportUpstreamFailure(initializeId, error);
    }, 0);
  };
  downstream.onmessage = (message) => {
    if (closed || refused) return;
    let forwarded: JSONRPCMessage = message;
    const isInitialize = isJSONRPCRequest(message) && message.method === "initialize";
    if (isJSONRPCRequest(message) && message.method === "initialize") {
      if (initializeSeen) {
        refuse(message.id, { code: ErrorCode.InvalidRequest, message: "Duplicate initialize is not permitted" });
        return;
      }
      try {
        forwarded = upstreamInitialize(message);
      } catch {
        refuse(message.id, {
          code: ErrorCode.InvalidRequest,
          message: "Invalid initialize request or workflow view selector",
        });
        return;
      }
      initializeSeen = true;
      initializeId = message.id;
    } else if (!initializeSeen) {
      refuse(isJSONRPCRequest(message) ? message.id : undefined, {
        code: ErrorCode.InvalidRequest,
        message: "Initialize must be the first request",
      });
      return;
    }
    const sending = initialized.then(() => upstream.send(forwarded));
    // HTTP POSTs may otherwise overtake initialize (which establishes the
    // session) or the initialized notification. Await their acceptance before
    // subsequent traffic, while allowing later tool calls and cancellation
    // notifications to proceed concurrently.
    if (isInitialize || isInitializedNotification(message)) initialized = sending;
    const requestId = isJSONRPCRequest(message) ? message.id : undefined;
    void sending.catch((error: unknown) => {
      reportUpstreamFailure(requestId, error);
    });
  };
  upstream.onmessage = (message) => {
    if (
      initializeId !== undefined &&
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      message.id === initializeId
    ) {
      clearTimeout(handshake);
      initializeId = undefined;
      if (isJSONRPCResultResponse(message) && typeof message.result.protocolVersion === "string") {
        upstream.setProtocolVersion(message.result.protocolVersion);
        downstream.setProtocolVersion?.(message.result.protocolVersion);
      }
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
