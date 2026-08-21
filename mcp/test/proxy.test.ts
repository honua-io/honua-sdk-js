import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createFixtureClient } from "../src/certification/fixture-client.js";
import { createServer } from "../src/index.js";
import { buildUpstreamHeaders, createProxyServer, resolveProxyOptions } from "../src/proxy.js";

/**
 * Parity harness for honua-server #1950: the stdio proxy must expose the SAME
 * tool/resource catalog and behavior as the upstream (HTTP-SSE) MCP surface.
 *
 * We stand up the canonical honua MCP server over an in-memory transport as the
 * "remote" surface, connect the proxy's upstream client to it, then connect a
 * downstream client to the proxy over a second in-memory transport. Anything the
 * downstream client sees must be byte-identical to what the upstream exposes —
 * that is the transport-symmetry contract.
 */

async function buildProxyHarness() {
  const remote = createServer(createFixtureClient());
  const [upstreamClientT, remoteServerT] = InMemoryTransport.createLinkedPair();
  const upstream = new Client({ name: "parity-upstream", version: "1.0.0" });
  await remote.connect(remoteServerT);
  await upstream.connect(upstreamClientT);

  const proxy = createProxyServer(upstream);
  const [downstreamClientT, proxyServerT] = InMemoryTransport.createLinkedPair();
  const downstream = new Client({ name: "parity-downstream", version: "1.0.0" });
  await proxy.connect(proxyServerT);
  await downstream.connect(downstreamClientT);

  return {
    remote,
    upstream,
    proxy,
    downstream,
    async close() {
      await downstream.close();
      await proxy.close();
      await upstream.close();
      await remote.close();
    },
  };
}

describe("stdio proxy parity (#1950)", () => {
  it("advertises the same server identity as upstream", async () => {
    const h = await buildProxyHarness();
    try {
      expect(h.downstream.getServerVersion()).toEqual(h.upstream.getServerVersion());
    } finally {
      await h.close();
    }
  });

  it("exposes an identical tool catalog (names + input schemas)", async () => {
    const h = await buildProxyHarness();
    try {
      const upstreamTools = (await h.upstream.listTools()).tools;
      const downstreamTools = (await h.downstream.listTools()).tools;

      const normalize = (tools: typeof upstreamTools) =>
        [...tools]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            outputSchema: t.outputSchema,
            annotations: t.annotations,
          }));

      expect(downstreamTools.length).toBeGreaterThan(0);
      expect(normalize(downstreamTools)).toEqual(normalize(upstreamTools));
    } finally {
      await h.close();
    }
  });

  it("exposes an identical resource and resource-template catalog", async () => {
    const h = await buildProxyHarness();
    try {
      const upstreamResources = (await h.upstream.listResources()).resources;
      const downstreamResources = (await h.downstream.listResources()).resources;
      expect(downstreamResources).toEqual(upstreamResources);

      const upstreamTemplates = (await h.upstream.listResourceTemplates()).resourceTemplates;
      const downstreamTemplates = (await h.downstream.listResourceTemplates()).resourceTemplates;
      expect(downstreamTemplates.length).toBeGreaterThan(0);
      expect(downstreamTemplates).toEqual(upstreamTemplates);
    } finally {
      await h.close();
    }
  });

  it("round-trips a tools/call through the proxy identically", async () => {
    const h = await buildProxyHarness();
    try {
      const direct = await h.upstream.callTool({ name: "honua_list_services", arguments: {} });
      const proxied = await h.downstream.callTool({ name: "honua_list_services", arguments: {} });
      expect(proxied).toEqual(direct);
      expect((proxied as { isError?: boolean }).isError).not.toBe(true);
    } finally {
      await h.close();
    }
  });

  it("round-trips a resource read through the proxy identically", async () => {
    const h = await buildProxyHarness();
    try {
      const direct = await h.upstream.readResource({ uri: "honua://services" });
      const proxied = await h.downstream.readResource({ uri: "honua://services" });
      expect(proxied).toEqual(direct);
    } finally {
      await h.close();
    }
  });

  it("forwards tools/list_changed notifications downstream", async () => {
    const h = await buildProxyHarness();
    try {
      const received = new Promise<void>((resolve) => {
        h.downstream.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          resolve();
        });
      });
      // Emit a list_changed from the canonical (upstream) server; it must reach
      // the downstream stdio client through the proxy.
      await h.remote.sendToolListChanged();
      await expect(Promise.race([received, timeout(2000)])).resolves.toBeUndefined();
    } finally {
      await h.close();
    }
  });
});

describe("proxy option resolution (#1950)", () => {
  it("requires a remote URL", () => {
    expect(() => resolveProxyOptions({})).toThrow(/HONUA_MCP_REMOTE_URL/);
  });

  it("rejects non-http URLs", () => {
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "ftp://x/mcp" })).toThrow(/http or https/);
  });

  it("refuses plaintext non-loopback and ambiguous credential endpoints", () => {
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "http://example.test/mcp" })).toThrow(/requires HTTPS/);
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "https://user:pass@example.test/mcp" })).toThrow(
      /must not include/,
    );
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "https://example.test/mcp?token=secret" })).toThrow(
      /must not include/,
    );
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "http://127.0.0.1:8080/mcp" })).not.toThrow();
  });

  it("accepts HONUA_MCP_URL as an alias", () => {
    const opts = resolveProxyOptions({ HONUA_MCP_URL: "https://demo.honua.io/mcp" });
    expect(opts.remoteUrl).toBe("https://demo.honua.io/mcp");
  });

  it("builds bearer + api-key headers", () => {
    const headers = buildUpstreamHeaders({
      remoteUrl: "https://demo.honua.io/mcp",
      authToken: "tok",
      apiKey: "key",
    });
    expect(headers).toEqual({ Authorization: "Bearer tok", "x-api-key": "key" });
  });

  it("prefers HONUA_ADMIN_KEY for the admin operation family", () => {
    const opts = resolveProxyOptions({
      HONUA_MCP_REMOTE_URL: "https://demo.honua.io/mcp",
      HONUA_ADMIN_KEY: "admin",
      HONUA_API_KEY: "general",
    });
    expect(opts.apiKey).toBe("admin");
  });

  it("omits headers when no credentials are configured", () => {
    expect(buildUpstreamHeaders({ remoteUrl: "https://demo.honua.io/mcp" })).toEqual({});
  });
});

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
}
