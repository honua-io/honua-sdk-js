import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AuthMode } from "../provenance.js";
import { type ProxyOptions, connectUpstream } from "../proxy.js";
import { type MockUpstream, startMockUpstream } from "./mock-upstream.js";

/**
 * Certification target selection.
 *
 * The certifier drives one of three targets, all reached through the SAME MCP
 * client path the proxy uses so what's certified is the real operator surface,
 * never the retired static server:
 *
 *   - `offline`     (CI default): a real in-process streamable-HTTP mock of the
 *                    honua `/mcp` operator catalog. Gates every PR without a
 *                    live server.
 *   - `remote`      : a live streamable-HTTP `/mcp` (HONUA_MCP_REMOTE_URL + auth).
 *                    Reuses the proxy's upstream connection logic verbatim.
 *   - `stdio-proxy` : spawns the `honua-mcp-proxy` binary against an upstream and
 *                     certifies through stdio, proving the proxy chain end-to-end.
 */

export type CertTargetMode = "offline" | "remote" | "stdio-proxy";

export interface CertificationTarget {
  mode: CertTargetMode;
  backend: "mock-upstream" | "live";
  /** Human-readable label for the certified surface (artifact provenance). */
  serverLabel: string;
  /** How the authenticated client reached the surface (recorded in provenance). */
  authMode: AuthMode;
  honuaTransport: string | null;
  /** Authenticated, connected MCP client. */
  client: Client;
  /** Whether an unauthenticated pass is possible for the auth contract. */
  supportsUnauthenticatedPass: boolean;
  /** Open a fresh, UNauthenticated client to the same surface (auth contract). */
  connectUnauthenticated(): Promise<Client>;
  close(): Promise<void>;
}

export function resolveTargetMode(env: NodeJS.ProcessEnv = process.env): CertTargetMode {
  const raw = (env.HONUA_MCP_CERT_TARGET ?? "offline").trim().toLowerCase();
  if (raw === "offline" || raw === "remote" || raw === "stdio-proxy") {
    return raw;
  }
  throw new Error(`HONUA_MCP_CERT_TARGET must be "offline", "remote", or "stdio-proxy", received "${raw}"`);
}

/** Resolve the remote `/mcp` endpoint + credentials from the environment. */
export function resolveRemoteProxyOptions(env: NodeJS.ProcessEnv): ProxyOptions {
  const remoteUrl = env.HONUA_MCP_REMOTE_URL ?? env.HONUA_MCP_URL;
  if (!remoteUrl) {
    throw new Error("HONUA_MCP_REMOTE_URL is required for remote / stdio-proxy certification against a live /mcp.");
  }
  const parsed = new URL(remoteUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`HONUA_MCP_REMOTE_URL must use http or https: ${remoteUrl}`);
  }
  return {
    remoteUrl: parsed.toString(),
    authToken: env.HONUA_MCP_AUTH_TOKEN,
    apiKey: env.HONUA_API_KEY,
  };
}

/** Resolve the built `honua-mcp-proxy` entry usable from src (vitest) or dist. */
export function resolveProxyEntry(): string {
  const candidates = ["../proxy.js", "../../dist/src/proxy.js"];
  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url);
    if (url.protocol === "file:" && existsSync(url)) {
      const path = fileURLToPath(url);
      if (path.endsWith(".js")) {
        return path;
      }
    }
  }
  throw new Error(
    "Could not locate the built honua-mcp-proxy entry (dist/src/proxy.js). Run `npm run build` before stdio-proxy certification.",
  );
}

/** Open the configured certification target. */
export async function openCertificationTarget(env: NodeJS.ProcessEnv = process.env): Promise<CertificationTarget> {
  const mode = resolveTargetMode(env);
  if (mode === "remote") {
    return openRemoteTarget(env);
  }
  if (mode === "stdio-proxy") {
    return openStdioProxyTarget(env);
  }
  return openOfflineTarget(env);
}

async function openOfflineTarget(env: NodeJS.ProcessEnv): Promise<CertificationTarget> {
  const mock = await startMockUpstream();
  const authedClients: Client[] = [];

  const client = await connectUpstream({ remoteUrl: mock.url, authToken: mock.authToken });
  authedClients.push(client);

  return {
    mode: "offline",
    backend: "mock-upstream",
    serverLabel: "honua /mcp operator catalog (in-process streamable-HTTP mock)",
    authMode: "bearer",
    honuaTransport: env.HONUA_TRANSPORT ?? null,
    client,
    supportsUnauthenticatedPass: true,
    async connectUnauthenticated() {
      const unauth = await connectUpstream({ remoteUrl: mock.url });
      authedClients.push(unauth);
      return unauth;
    },
    async close() {
      for (const c of authedClients) {
        await c.close().catch(() => {});
      }
      await mock.close();
    },
  };
}

function resolveAuthMode(options: ProxyOptions): AuthMode {
  return options.authToken ? "bearer" : options.apiKey ? "api-key" : "anonymous";
}

async function openRemoteTarget(env: NodeJS.ProcessEnv): Promise<CertificationTarget> {
  const options = resolveRemoteProxyOptions(env);
  const clients: Client[] = [];
  const client = await connectUpstream(options);
  clients.push(client);

  return {
    mode: "remote",
    backend: "live",
    serverLabel: `live honua /mcp (${options.remoteUrl})`,
    authMode: resolveAuthMode(options),
    honuaTransport: env.HONUA_TRANSPORT ?? null,
    client,
    supportsUnauthenticatedPass: true,
    async connectUnauthenticated() {
      const unauth = await connectUpstream({ remoteUrl: options.remoteUrl });
      clients.push(unauth);
      return unauth;
    },
    async close() {
      for (const c of clients) {
        await c.close().catch(() => {});
      }
    },
  };
}

async function openStdioProxyTarget(env: NodeJS.ProcessEnv): Promise<CertificationTarget> {
  const proxyEntry = resolveProxyEntry();
  const clients: Client[] = [];

  // Upstream: a live /mcp when configured, otherwise the in-process mock.
  let mock: MockUpstream | undefined;
  let upstreamUrl: string;
  let upstreamToken: string | undefined;
  let backend: "mock-upstream" | "live";
  if (env.HONUA_MCP_REMOTE_URL ?? env.HONUA_MCP_URL) {
    const options = resolveRemoteProxyOptions(env);
    upstreamUrl = options.remoteUrl;
    upstreamToken = options.authToken;
    backend = "live";
  } else {
    mock = await startMockUpstream();
    upstreamUrl = mock.url;
    upstreamToken = mock.authToken;
    backend = "mock-upstream";
  }

  const spawnProxyClient = async (withAuth: boolean): Promise<Client> => {
    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HONUA_MCP_REMOTE_URL: upstreamUrl,
    };
    if (withAuth && upstreamToken) {
      childEnv.HONUA_MCP_AUTH_TOKEN = upstreamToken;
    } else {
      delete childEnv.HONUA_MCP_AUTH_TOKEN;
      delete childEnv.HONUA_API_KEY;
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [proxyEntry],
      env: childEnv,
      stderr: "inherit",
    });
    const c = new Client({ name: "honua-mcp-certifier", version: "1.0.0" });
    await c.connect(transport);
    clients.push(c);
    return c;
  };

  const client = await spawnProxyClient(true);

  return {
    mode: "stdio-proxy",
    backend,
    serverLabel: `honua-mcp-proxy → ${backend === "live" ? upstreamUrl : "in-process mock /mcp"}`,
    authMode: upstreamToken ? "bearer" : env.HONUA_API_KEY ? "api-key" : "anonymous",
    honuaTransport: env.HONUA_TRANSPORT ?? null,
    client,
    supportsUnauthenticatedPass: true,
    async connectUnauthenticated() {
      return spawnProxyClient(false);
    },
    async close() {
      for (const c of clients) {
        await c.close().catch(() => {});
      }
      if (mock) {
        await mock.close();
      }
    },
  };
}
