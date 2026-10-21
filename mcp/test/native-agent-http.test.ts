import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentRuntime } from "../src/agent/local-runtime.js";
import { createNativeAgentHttpServer } from "../src/agent/native-http.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const bridgeKey = "independent-native-bridge-key-at-least-32-bytes";
const apiKey = "workspace-agent-credential-test-only";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(privateAdapter = false) {
  const actions: { workspace: string | undefined; turn: string | undefined; name: string }[] = [];
  let allowed = true;
  let privateAllowed = true;
  let currentKey = apiKey;
  const upstream = await listen(
    createServer((req, res) => {
      void (async () => {
        if (req.headers["x-api-key"] !== currentKey) {
          res.writeHead(403).end();
          return;
        }
        if (req.url?.startsWith("/api/v1/agent/workspaces/")) {
          if (!allowed || !req.url.includes("/workspace-a/")) {
            res.writeHead(403).end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              turnId: req.url.split("/").at(-1),
              context: {
                workspaceId: "workspace-a",
                targetId: "target-a",
                tenantId: "public",
              },
            }),
          );
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        let body = "";
        for await (const chunk of req) body += String(chunk);
        const message = JSON.parse(body);
        if (req.url === "/api/v1/agent/devops/authorize") {
          if (!privateAllowed) {
            res.writeHead(403).end();
            return;
          }
          actions.push({
            workspace: String(req.headers["x-honua-workspace"]),
            turn: String(req.headers["x-honua-turn"]),
            name: "authorize-private",
          });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ targetId: "target-a", deployTargetId: "ecs-a", environment: "dev" }));
          return;
        }
        if (!("id" in message)) {
          res.writeHead(202).end();
          return;
        }
        let result: unknown;
        if (message.method === "initialize")
          result = {
            protocolVersion: message.params.protocolVersion,
            serverInfo: { name: "fixture", version: "1" },
            capabilities: { tools: {} },
          };
        else if (message.method === "tools/list")
          result = { tools: [{ name: "canonical_echo", inputSchema: { type: "object" } }] };
        else if (message.method === "tools/call") {
          const call = {
            workspace: String(req.headers["x-honua-workspace"]),
            turn: String(req.headers["x-honua-turn"]),
            name: message.params.name,
          };
          actions.push(call);
          await new Promise((resolve) => setTimeout(resolve, message.params.arguments?.delay ?? 0));
          result = { content: [{ type: "text", text: JSON.stringify(call) }], structuredContent: call };
        } else throw new Error("Unexpected fixture RPC");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    }),
  );
  let currentRelease = "release-a";
  let currentCredentialKind: "workspace-agent" | "bootstrap-admin" = "workspace-agent";
  const runtime: AgentRuntime = {
    inspect: async () => ({ ready: true }),
    install: async () => {
      throw new Error("No fixture install");
    },
    resolve: async () => ({
      target: { id: "connection-a", credentialId: "key-a", endpoint: `${upstream}/mcp` },
      transport: { remoteUrl: `${upstream}/mcp`, apiKey: currentKey },
      credentialKind: currentCredentialKind,
      releaseId: currentRelease,
      deploymentId: "target-a",
    }),
  };
  let config: string | undefined;
  if (privateAdapter) {
    const directory = await mkdtemp(path.join(tmpdir(), "native-agent-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    config = path.join(directory, "private.json");
    const child = `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line); if(!('id' in m)) return;
      const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'private',version:'1'}}:
        m.method==='tools/list'?{tools:[{name:'describe_environment',inputSchema:{type:'object'}}]}:
        {content:[{type:'text',text:'private receipt'}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });`;
    await writeFile(
      config,
      JSON.stringify({
        serverTargetId: "target-a",
        deployTargetId: "ecs-a",
        environment: "dev",
        command: process.execPath,
        args: ["-e", child],
      }),
      { mode: 0o600 },
    );
  }
  const url = await listen(createNativeAgentHttpServer({ runtime, bridgeKey, devopsConfiguration: config }));
  function headers(turn = "turn-a", overrides: Record<string, string> = {}) {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-API-Key": currentKey,
      "X-Honua-Gateway-Key": bridgeKey,
      "X-Honua-Workspace": "workspace-a",
      "X-Honua-Turn": turn,
      "X-Honua-Operator-Partition": "operator-a",
      ...overrides,
    };
  }
  async function rpc(message: unknown, turn = "turn-a", session?: string, overrides: Record<string, string> = {}) {
    return fetch(`${url}/mcp`, {
      method: "POST",
      headers: headers(turn, { ...(session ? { "Mcp-Session-Id": session } : {}), ...overrides }),
      body: JSON.stringify(message),
    });
  }
  async function initialize() {
    const response = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "native-fixture", version: "1" } },
    });
    expect(response.status).toBe(200);
    const session = response.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, "turn-a", session!);
    return session!;
  }
  return {
    url,
    rpc,
    initialize,
    actions,
    headers,
    revoke: () => {
      allowed = false;
    },
    denyPrivate: () => {
      privateAllowed = false;
    },
    rotate: () => {
      currentKey = "replacement-agent-key";
    },
    changeRelease: () => {
      currentRelease = "release-b";
    },
    changeCredentialKind: () => {
      currentCredentialKind = "bootstrap-admin";
    },
  };
}

it("preserves separate concurrent turn headers in one native MCP session and hides bootstrap tools", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const catalog = await (await f.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "turn-a", session)).json();
  expect(catalog.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["canonical_echo"]);
  const responses = await Promise.all(
    ["turn-a", "turn-b"].map((turn, index) =>
      f.rpc(
        {
          jsonrpc: "2.0",
          id: 3 + index,
          method: "tools/call",
          params: { name: "canonical_echo", arguments: { delay: index ? 1 : 30 } },
        },
        turn,
        session,
      ),
    ),
  );
  const results = await Promise.all(responses.map((response) => response.json()));
  expect(results.map((result) => result.result.structuredContent.turn)).toEqual(["turn-a", "turn-b"]);
  const refused = await (
    await f.rpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "honua_agent_install_local", arguments: { confirm: true } },
      },
      "turn-b",
      session,
    )
  ).json();
  expect(refused.error).toBeDefined();
  expect(f.actions).toHaveLength(2);
});

it("rejects wrong bridge identity, workspace, partition, revoked membership and rotated credentials before dispatch", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canonical_echo", arguments: {} } };
  for (const bad of [
    { "X-Honua-Gateway-Key": "wrong" },
    { "X-Honua-Gateway-Key": "x".repeat(bridgeKey.length) },
    { "X-Honua-Gateway-Key": `${bridgeKey}suffix` },
    { "X-API-Key": "x".repeat(apiKey.length) },
    { "X-API-Key": `${apiKey}suffix` },
    { "X-Honua-Workspace": "workspace-b" },
    { "X-Honua-Operator-Partition": "operator-b" },
    { Origin: "https://browser.invalid" },
  ]) {
    expect((await f.rpc(call, "turn-a", session, bad)).status).toBe(403);
  }
  f.rotate();
  expect((await f.rpc(call, "turn-a", session)).status).toBe(403);
  f.revoke();
  expect((await f.rpc(call, "turn-a", session)).status).toBe(403);
  expect(f.actions).toHaveLength(0);
});

it("rejects an existing native session after a same-key release or credential-kind change", async () => {
  const f = await fixture();
  const session = await f.initialize();
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canonical_echo", arguments: {} } };
  f.changeRelease();
  expect((await f.rpc(call, "turn-a", session)).status).toBe(403);
  expect(f.actions).toHaveLength(0);
  const other = await fixture();
  const otherSession = await other.initialize();
  other.changeCredentialKind();
  expect((await other.rpc(call, "turn-a", otherSession)).status).toBe(403);
  expect(
    (
      await other.rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "native-fixture", version: "1" },
        },
      })
    ).status,
  ).toBe(403);
  expect(other.actions).toHaveLength(0);
});

it("attests private tools only after authorized discovery and rechecks their current turn and RBAC", async () => {
  const f = await fixture(true);
  const capabilities = await (await fetch(`${f.url}/capabilities`, { headers: f.headers() })).json();
  expect(capabilities).toEqual({
    schemaVersion: "honua.agent-gateway.capabilities.v1",
    targetId: "target-a",
    workspaceId: "workspace-a",
    turnId: "turn-a",
    toolFamilies: ["honua.workspace.devops"],
  });
  const session = await f.initialize();
  const catalog = await (await f.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "turn-b", session)).json();
  expect(
    catalog.result.tools.find((tool: { name: string }) => tool.name === "honua_agent_devops_describe_environment")
      ._meta["honua.studio"].family,
  ).toBe("honua.workspace.devops");
  const result = await (
    await f.rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "honua_agent_devops_describe_environment", arguments: {} },
      },
      "turn-c",
      session,
    )
  ).json();
  expect(result.result.content[0].text).toBe("private receipt");
  expect(f.actions.at(-1)).toMatchObject({ turn: "turn-c", workspace: "workspace-a", name: "authorize-private" });
  f.denyPrivate();
  const refused = await (
    await f.rpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "honua_agent_devops_describe_environment", arguments: {} },
      },
      "turn-c",
      session,
    )
  ).json();
  expect(refused.error).toBeDefined();
  const unavailable = await (await fetch(`${f.url}/capabilities`, { headers: f.headers("turn-c") })).json();
  expect(unavailable.toolFamilies).toEqual([]);
});
