import { randomUUID } from "node:crypto";
import { type Server as HttpServer, type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createOperatorCatalogServer } from "./operator-catalog.js";

/**
 * A real, in-process streamable-HTTP mock of the honua `/mcp` operator surface.
 *
 * The certification harness connects to this over the SAME client transport it
 * uses for a live server (`StreamableHTTPClientTransport`), so the offline CI
 * path exercises the identical connect/negotiate/tools-call code as the remote
 * path — only the upstream is swapped for a deterministic fixture.
 *
 * Auth is enforced per request: the listener parses the bearer token / API key
 * and attaches `req.auth` when present. Requests without a credential reach the
 * operator server as unauthenticated, so the certifier's auth-contract pass sees
 * the same structured `unauthenticated` signal a real deployment would emit.
 */

export interface MockUpstreamOptions {
  /** Bearer token the mock accepts; default `mock-cert-token`. */
  authToken?: string;
  /** Whether tools/list and resources/list paginate (default true). */
  paginate?: boolean;
}

export interface MockUpstream {
  /** Absolute URL of the mock `/mcp` endpoint (loopback, ephemeral port). */
  url: string;
  /** Bearer token the mock accepts. */
  authToken: string;
  close(): Promise<void>;
}

function readBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return apiKey;
  }
  return undefined;
}

/** Start the mock operator upstream and resolve once it is listening. */
export async function startMockUpstream(options: MockUpstreamOptions = {}): Promise<MockUpstream> {
  const authToken = options.authToken ?? "mock-cert-token";
  const paginate = options.paginate ?? true;

  // One transport + server per session (the documented multi-session pattern),
  // so multiple certifier clients — the authenticated pass and the
  // unauthenticated auth-contract pass — can connect concurrently.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer: HttpServer = createServer((req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse) => {
    void handleHttpRequest(req, res, sessions, authToken, paginate);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    url,
    authToken,
    async close() {
      for (const transport of sessions.values()) {
        await transport.close().catch(() => {});
      }
      sessions.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function handleHttpRequest(
  req: IncomingMessage & { auth?: AuthInfo },
  res: ServerResponse,
  sessions: Map<string, StreamableHTTPServerTransport>,
  authToken: string,
  paginate: boolean,
): Promise<void> {
  const token = readBearer(req);
  if (token && token === authToken) {
    // AuthInfo the transport threads through to request handlers (per request).
    req.auth = { token, clientId: "cert-client", scopes: ["operator"] };
  }

  const sessionId = req.headers["mcp-session-id"];
  const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (existing) {
    await existing.handleRequest(req, res);
    return;
  }

  // No session yet — only an initialize request may open one.
  const body = await readJsonBody(req);
  if (!isInitializeRequest(body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session ID provided" },
        id: null,
      }),
    );
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };
  const server = createOperatorCatalogServer({ paginate });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
