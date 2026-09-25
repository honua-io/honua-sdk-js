import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const selector = "honua.io/workflow-view";
const adminKey = "ephemeral-proxy-contract-key";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function initialize(view: unknown = "setup") {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "downstream", version: "1" },
    _meta: { [selector]: view, Authorization: "must-not-forward", "Mcp-Session-Id": "client-forged" },
  };
}

function catalog(view: string) {
  return {
    tools: [
      {
        name: `tool_${view}`,
        description: "Canonical μ schema",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { value: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
    ],
    _meta: { view, revision: `${view}.v1`, descriptorDigest: `sha256:${"a".repeat(64)}` },
  };
}

async function upstreamFixture(holdInitialize = false) {
  const sessions = new Map<string, string>();
  const streams = new Map<string, ServerResponse>();
  const requests: { body: Record<string, any>; session?: string; authorization?: string }[] = [];
  let abandonedInitializations = 0;
  const server = createServer(async (req, res) => {
    if (req.headers["x-api-key"] !== adminKey) {
      res.writeHead(401).end();
      return;
    }
    const session = req.headers["mcp-session-id"] as string | undefined;
    if (req.method === "GET") {
      if (!session || !sessions.has(session)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": connected\n\n");
      streams.set(session, res);
      return;
    }
    if (req.method === "DELETE") {
      if (session) sessions.delete(session);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ body, session, authorization: req.headers.authorization });
    if (body.method === "initialize") {
      if (holdInitialize) {
        res.on("close", () => {
          abandonedInitializations++;
        });
        return;
      }
      const view = body.params?._meta?.[selector] ?? "default";
      if (!["setup", "default"].includes(view)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Unknown view" } }));
        return;
      }
      const id = randomUUID();
      sessions.set(id, view);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": id });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params.protocolVersion,
            serverInfo: { name: "http-session-fixture", version: "1" },
            capabilities: { tools: { listChanged: true } },
          },
        }),
      );
      return;
    }
    if (!session || !sessions.has(session)) {
      res.writeHead(404).end();
      return;
    }
    if (body.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (body.method !== "tools/list") {
      res.writeHead(400).end();
      return;
    }
    const view = body.params?.view ?? body.params?._meta?.[selector] ?? sessions.get(session);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: catalog(view) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const response of streams.values()) response.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    requests,
    streams,
    abandonedInitializations: () => abandonedInitializations,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
  };
}

function childProxy(url: string) {
  // The hosted packed-package lane supplies npm's actual installed executable.
  // The ordinary source suite is explicitly source smoke, never registry proof.
  const installed = process.env.HONUA_MCP_INSTALLED_PROXY;
  const child = spawn(installed ?? process.execPath, installed ? [] : ["dist/src/proxy.js"], {
    env: {
      ...process.env,
      HONUA_MCP_REMOTE_URL: url,
      HONUA_API_KEY: adminKey,
      HONUA_ADMIN_KEY: "",
      HONUA_MCP_AUTH_TOKEN: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const notifications: any[] = [];
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (typeof message.id === "number") {
      const waiting = responses.get(message.id);
      if (waiting) {
        clearTimeout(waiting.timer);
        responses.delete(message.id);
        waiting.resolve(message);
      }
    } else notifications.push(message);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      for (const waiting of responses.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error("Proxy exited before responding"));
      }
      responses.clear();
      resolve(code);
    }),
  );
  cleanup.push(async () => {
    child.kill();
    await exited;
    lines.close();
  });
  return {
    notifications,
    exited,
    stderr: () => stderr,
    closeInput: () => child.stdin.end(),
    request(method: string, params?: unknown): Promise<any> {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Proxy timed out on ${method}`)), 10_000);
        responses.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify() {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
  };
}

describe("real HTTP and spawned stdio session negotiation", () => {
  it("binds setup at initialize, preserves overrides, descriptors and listChanged", async () => {
    const server = await upstreamFixture();
    const proxy = childProxy(server.url);
    const initialized = await proxy.request("initialize", initialize());
    expect(initialized.result.serverInfo.name).toBe("http-session-fixture");
    proxy.notify();
    const selected = await proxy.request("tools/list");
    expect(selected.result).toEqual(catalog("setup"));
    expect((await proxy.request("tools/list", { view: "default" })).result).toEqual(catalog("default"));
    expect((await proxy.request("tools/list")).result).toEqual(catalog("setup"));
    const upstreamInit = server.requests.find((request) => request.body.method === "initialize");
    expect(upstreamInit?.body.params._meta).toEqual({ [selector]: "setup" });
    expect(upstreamInit?.body.params.clientInfo.name).toBe("honua-mcp-stdio-proxy");
    expect(server.requests.every((request) => request.authorization === undefined)).toBe(true);
    const lists = server.requests.filter((request) => request.body.method === "tools/list");
    expect(new Set(lists.map((request) => request.session)).size).toBe(1);
    expect(lists[0].session).toMatch(/^[a-f0-9-]{36}$/);

    const direct = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": adminKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize() }),
    });
    const session = direct.headers.get("Mcp-Session-Id");
    expect(session).toBeTruthy();
    await direct.json();
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": adminKey, "Mcp-Session-Id": session! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect((await response.json()).result).toEqual(selected.result);
    await expect.poll(() => server.streams.size).toBeGreaterThan(0);
    for (const stream of server.streams.values())
      stream.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
      );
    await expect
      .poll(() => proxy.notifications.some((message) => message.method === "notifications/tools/list_changed"))
      .toBe(true);
  });

  it.each([42, "x".repeat(65)])("rejects malformed initialize without any upstream request: %j", async (view) => {
    const server = await upstreamFixture();
    const proxy = childProxy(server.url);
    expect((await proxy.request("initialize", initialize(view))).error.code).toBe(-32600);
    expect(await proxy.exited).not.toBe(0);
    expect(server.requests).toEqual([]);
    expect(proxy.stderr()).not.toContain(adminKey);
  });

  it("rejects duplicate initialize without rebinding the established upstream session", async () => {
    const server = await upstreamFixture();
    const proxy = childProxy(server.url);
    await proxy.request("initialize", initialize());
    proxy.notify();
    expect((await proxy.request("initialize", initialize("default"))).error.code).toBe(-32600);
    await proxy.exited;
    expect(server.requests.filter((request) => request.body.method === "initialize")).toHaveLength(1);
  });

  it("fails closed when the upstream rejects an unknown view", async () => {
    const server = await upstreamFixture();
    const proxy = childProxy(server.url);
    // The upstream handshake fails before the downstream SDK can report success.
    const rejected = proxy.request("initialize", initialize("unknown")).catch(() => undefined);
    expect(await proxy.exited).not.toBe(0);
    expect(server.requests.filter((request) => request.body.method === "tools/list")).toHaveLength(0);
    expect(proxy.stderr()).not.toContain(adminKey);
    await rejected;
  });

  it("cancels the real upstream handshake when downstream closes before initialize completes", async () => {
    const server = await upstreamFixture(true);
    const proxy = childProxy(server.url);
    const rejected = proxy.request("initialize", initialize()).catch(() => undefined);
    await expect.poll(() => server.requests.length).toBe(1);
    proxy.closeInput();
    expect(await proxy.exited).not.toBe(0);
    await expect.poll(server.abandonedInitializations).toBe(1);
    expect(server.streams.size).toBe(0);
    await rejected;
  });
});
