import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createFixtureClient } from "../src/certification/fixture-client.js";
import { createServer } from "../src/index.js";
import { buildUpstreamHeaders, connectUpstream, createProxyServer, resolveProxyOptions } from "../src/proxy.js";

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

  it("refuses credentialed plaintext non-loopback and ambiguous credential endpoints", () => {
    expect(() =>
      resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "http://example.test/mcp", HONUA_API_KEY: "key" }),
    ).toThrow(/requires HTTPS/);
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "https://user:pass@example.test/mcp" })).toThrow(
      /must not include/,
    );
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "https://example.test/mcp?token=secret" })).toThrow(
      /must not include/,
    );
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "http://127.0.0.1:8080/mcp" })).not.toThrow();
  });

  it.each(["http://localhost:8080/mcp", "http://127.0.0.1:8080/mcp", "http://[::1]:8080/mcp"])(
    "allows credentialed HTTP for the exact loopback host %s",
    (remoteUrl) => {
      expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: remoteUrl, HONUA_API_KEY: "key" })).not.toThrow();
    },
  );

  it.each(["http://localhost.example.test/mcp", "http://127.0.0.2/mcp", "http://0.0.0.0/mcp", "http://[::2]/mcp"])(
    "rejects credentialed HTTP for the non-loopback host %s",
    (remoteUrl) => {
      expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: remoteUrl, HONUA_API_KEY: "key" })).toThrow(
        /requires HTTPS/,
      );
    },
  );

  it("allows anonymous non-loopback HTTP without weakening URL validation", () => {
    expect(resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "http://example.test/mcp" }).remoteUrl).toBe(
      "http://example.test/mcp",
    );
    expect(() => resolveProxyOptions({ HONUA_MCP_REMOTE_URL: "http://example.test/mcp#token" })).toThrow(
      /must not include/,
    );
  });

  it("accepts HONUA_MCP_URL as an alias", () => {
    const opts = resolveProxyOptions({ HONUA_MCP_URL: "https://demo.honua.io/mcp" });
    expect(opts.remoteUrl).toBe("https://demo.honua.io/mcp");
  });

  it("rejects bearer + api-key headers at the programmatic boundary", () => {
    expect(() =>
      buildUpstreamHeaders({
        remoteUrl: "https://demo.honua.io/mcp",
        authToken: "tok",
        apiKey: "key",
      }),
    ).toThrow(/exactly one upstream authentication scheme/);
  });

  it("builds exactly one bearer or api-key header", () => {
    expect(
      buildUpstreamHeaders({
        remoteUrl: "https://demo.honua.io/mcp",
        authToken: "tok",
      }),
    ).toEqual({ Authorization: "Bearer tok" });
    expect(
      buildUpstreamHeaders({
        remoteUrl: "https://demo.honua.io/mcp",
        apiKey: "key",
      }),
    ).toEqual({ "x-api-key": "key" });
  });

  it("applies endpoint safety at the programmatic header boundary", () => {
    expect(() =>
      buildUpstreamHeaders({
        remoteUrl: "http://example.test/mcp",
        apiKey: "key",
      }),
    ).toThrow(/requires HTTPS/);
  });

  it("rejects conflicting Admin/API key environment sources", () => {
    expect(() =>
      resolveProxyOptions({
        HONUA_MCP_REMOTE_URL: "https://demo.honua.io/mcp",
        HONUA_ADMIN_KEY: "admin-secret",
        HONUA_API_KEY: "api-secret",
      }),
    ).toThrow(/unset either HONUA_ADMIN_KEY or HONUA_API_KEY/);
  });

  it("rejects bearer plus API-key environment sources without exposing values", () => {
    const bearer = "bearer-secret-must-not-leak";
    const apiKey = "api-secret-must-not-leak";
    let message = "";
    try {
      resolveProxyOptions({
        HONUA_MCP_REMOTE_URL: "https://demo.honua.io/mcp",
        HONUA_MCP_AUTH_TOKEN: bearer,
        HONUA_API_KEY: apiKey,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("exactly one upstream authentication scheme");
    expect(message).not.toContain(bearer);
    expect(message).not.toContain(apiKey);
  });

  it("rejects unsafe programmatic URLs without exposing embedded values", () => {
    const secret = "url-secret-must-not-leak";
    let message = "";
    try {
      buildUpstreamHeaders({
        remoteUrl: `https://example.test/mcp?token=${secret}`,
        apiKey: "key",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("must not include");
    expect(message).not.toContain(secret);
  });

  it("rejects programmatic userinfo and fragment URLs", () => {
    expect(() =>
      buildUpstreamHeaders({
        remoteUrl: "https://user:pass@example.test/mcp",
        authToken: "tok",
      }),
    ).toThrow(/must not include/);
    expect(() =>
      buildUpstreamHeaders({
        remoteUrl: "https://example.test/mcp#credential",
        authToken: "tok",
      }),
    ).toThrow(/must not include/);
  });

  it("does not forward credentials across redirects", async () => {
    let redirectedRequests = 0;
    const destination = createHttpServer((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const destinationPort = (destination.address() as AddressInfo).port;
    const redirector = createHttpServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/stolen` });
      response.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const redirectorPort = (redirector.address() as AddressInfo).port;
    const secret = "redirect-secret-must-not-leak";
    try {
      let message = "";
      try {
        await connectUpstream({
          remoteUrl: `http://127.0.0.1:${redirectorPort}/mcp`,
          authToken: secret,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => redirector.close((error) => (error ? reject(error) : resolve()))),
        new Promise<void>((resolve, reject) => destination.close((error) => (error ? reject(error) : resolve()))),
      ]);
    }
  });

  it("rejects non-http programmatic URLs", () => {
    expect(() =>
      buildUpstreamHeaders({
        remoteUrl: "ftp://example.test/mcp",
        authToken: "tok",
      }),
    ).toThrow(/must use http or https/);
  });

  it("normalizes an HTTPS option after validating its single auth source", () => {
    const options = resolveProxyOptions({
      HONUA_MCP_REMOTE_URL: "https://demo.honua.io/mcp",
      HONUA_MCP_AUTH_TOKEN: "tok",
    });
    expect(options).toMatchObject({ remoteUrl: "https://demo.honua.io/mcp", authToken: "tok" });
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
