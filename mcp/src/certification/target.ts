import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClientFromEnv, createServer } from "../index.js";
import type { AuthMode } from "../provenance.js";
import { type ProxyOptions, connectUpstream, resolveProxyOptions } from "../proxy.js";
import { createStandaloneFixtureClient } from "./census-fixture-client.js";
import { type MockUpstream, startMockUpstream } from "./mock-upstream.js";
import { OGC_ENDPOINT } from "./ogc-data.js";
import { createOgcFixtureClient } from "./ogc-fixture-client.js";

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
 *   - `standalone`  : the PLATFORM-FREE front door (issue #369). Certifies the
 *                     direct-SDK `createServer` surface against an in-process fixture
 *                     of a PLAIN public FeatureServer (recorded census layer, no
 *                     Honua surfaces). Proves the tools certify green against a
 *                     non-Honua endpoint, with Honua-only tools skip-with-reason.
 *   - `standalone-ogc` : the same surface against a NON-GeoServices endpoint
 *                     (issue #1005) — an in-process fixture of a plain OGC API
 *                     Features server replaying recorded pygeoapi collections.
 *                     Nothing Esri-shaped exists there (the GeoServices entry
 *                     points all reject), so it proves the tool contract is
 *                     genuinely protocol-neutral rather than GeoServices with
 *                     extra fields.
 */

export type CertTargetMode = "offline" | "remote" | "stdio-proxy" | "standalone" | "standalone-ogc";

/** Target modes that certify the platform-free `createServer` surface. */
export function isStandaloneTargetMode(mode: CertTargetMode): boolean {
  return mode === "standalone" || mode === "standalone-ogc";
}

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
  if (
    raw === "offline" ||
    raw === "remote" ||
    raw === "stdio-proxy" ||
    raw === "standalone" ||
    raw === "standalone-ogc"
  ) {
    return raw;
  }
  throw new Error(
    `HONUA_MCP_CERT_TARGET must be "offline", "remote", "stdio-proxy", "standalone", or "standalone-ogc", received "${raw}"`,
  );
}

/** Resolve the remote `/mcp` endpoint + credentials from the environment. */
export function resolveRemoteProxyOptions(env: NodeJS.ProcessEnv): ProxyOptions {
  if (!(env.HONUA_MCP_REMOTE_URL ?? env.HONUA_MCP_URL)) {
    throw new Error("HONUA_MCP_REMOTE_URL is required for remote / stdio-proxy certification against a live /mcp.");
  }
  return resolveProxyOptions(env);
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
  if (mode === "standalone") {
    return openStandaloneTarget(env);
  }
  if (mode === "standalone-ogc") {
    return openStandaloneOgcTarget(env);
  }
  return openOfflineTarget(env);
}

/**
 * Open the NON-GeoServices standalone target (#1005): the same platform-free
 * `createServer` surface, wired to an in-process fixture of a plain OGC API
 * Features endpoint (recorded pygeoapi collections). The GeoServices entry
 * points on that fixture all reject, so any tool still requiring Esri
 * addressing fails here rather than passing by accident.
 */
async function openStandaloneOgcTarget(env: NodeJS.ProcessEnv): Promise<CertificationTarget> {
  const server = createServer(createOgcFixtureClient());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "honua-mcp-certifier", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    mode: "standalone-ogc",
    backend: "mock-upstream",
    serverLabel: `honua-mcp standalone → ${OGC_ENDPOINT} (recorded OGC API Features fixture, no GeoServices surface)`,
    authMode: "anonymous",
    honuaTransport: env.HONUA_TRANSPORT ?? null,
    client,
    supportsUnauthenticatedPass: false,
    connectUnauthenticated() {
      return Promise.reject(new Error("standalone-ogc target has no auth boundary"));
    },
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

/**
 * Open the platform-free standalone target: the direct-SDK `createServer` surface,
 * reached over an in-memory MCP transport. By default it is wired to an in-process
 * fixture of a plain public FeatureServer (recorded census layer, no Honua
 * surfaces) — deterministic, no network, gates CI. When `HONUA_BASE_URL` is set
 * (the scheduled live variant) it drives a REAL `HonuaClient` against that public
 * FeatureServer/OGC endpoint instead. Either way there is no transport auth
 * boundary, so the auth contracts skip-with-reason and the Honua-only style tools
 * degrade to structured "not available on this target" results.
 */
async function openStandaloneTarget(env: NodeJS.ProcessEnv): Promise<CertificationTarget> {
  const live = typeof env.HONUA_BASE_URL === "string" && env.HONUA_BASE_URL.length > 0;
  const client_ = live ? createClientFromEnv(env) : createStandaloneFixtureClient();
  const server = createServer(client_);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "honua-mcp-certifier", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    mode: "standalone",
    backend: live ? "live" : "mock-upstream",
    serverLabel: live
      ? `honua-mcp standalone → ${env.HONUA_BASE_URL} (live public FeatureServer, no Honua surfaces)`
      : "honua-mcp standalone → plain public FeatureServer (recorded census fixture, no Honua surfaces)",
    authMode: "anonymous",
    honuaTransport: env.HONUA_TRANSPORT ?? null,
    client,
    // A plain FeatureServer has no MCP transport auth boundary — the auth
    // contracts skip-with-reason rather than assert an enforcement that a
    // platform-free target does not (and should not) provide.
    supportsUnauthenticatedPass: false,
    connectUnauthenticated() {
      return Promise.reject(new Error("standalone target has no auth boundary"));
    },
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
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
  let upstreamOptions: ProxyOptions;
  let backend: "mock-upstream" | "live";
  if (env.HONUA_MCP_REMOTE_URL ?? env.HONUA_MCP_URL) {
    upstreamOptions = resolveRemoteProxyOptions(env);
    backend = "live";
  } else {
    mock = await startMockUpstream();
    upstreamOptions = { remoteUrl: mock.url, authToken: mock.authToken };
    backend = "mock-upstream";
  }

  const spawnProxyClient = async (withAuth: boolean): Promise<Client> => {
    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HONUA_MCP_REMOTE_URL: upstreamOptions.remoteUrl,
    };
    delete childEnv.HONUA_MCP_AUTH_TOKEN;
    delete childEnv.HONUA_ADMIN_KEY;
    delete childEnv.HONUA_API_KEY;
    if (withAuth && upstreamOptions.authToken) {
      childEnv.HONUA_MCP_AUTH_TOKEN = upstreamOptions.authToken;
    } else if (withAuth && upstreamOptions.apiKey) {
      childEnv.HONUA_API_KEY = upstreamOptions.apiKey;
    } else {
      // Keep the certification's anonymous negative control credential-free.
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
    serverLabel: `honua-mcp-proxy → ${backend === "live" ? upstreamOptions.remoteUrl : "in-process mock /mcp"}`,
    authMode: upstreamOptions.authToken ? "bearer" : upstreamOptions.apiKey ? "api-key" : "anonymous",
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
