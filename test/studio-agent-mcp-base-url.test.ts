import { describe, expect, it } from "vitest";
import { McpClient, McpNotificationStream, createStudioAgentSession } from "../src/studio-agent/index.js";

function createMcpAndChatFetch(recordedUrls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    recordedUrls.push(url);
    if (url.endsWith("/v1/studio/ai/chat")) {
      const sse = [
        'data: {"type":"text_delta","text":"ok"}\n\n',
        'data: {"type":"done","stopReason":"end_turn"}\n\n',
      ].join("");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26", serverInfo: { name: "test", version: "1.0.0" }, capabilities: {} }
        : { tools: [] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
    });
  };
}

describe("studio-agent default MCP base URL", () => {
  it("routes default session MCP calls to /mcp and chat calls to /api/v1/studio/ai/chat", async () => {
    const urls: string[] = [];
    const session = createStudioAgentSession({ fetchImpl: createMcpAndChatFetch(urls) });
    const turn = await session.chat("hello");

    expect(turn.status).toBe("completed");
    expect(urls).toContain("/mcp");
    expect(urls).toContain("/api/v1/studio/ai/chat");
    expect(urls.some((url) => url.endsWith("/api/mcp"))).toBe(false);
  });

  it("strips a trailing /api segment from baseUrl when deriving MCP base URL", async () => {
    const urls: string[] = [];
    const session = createStudioAgentSession({
      baseUrl: "https://honua.example/api/",
      fetchImpl: createMcpAndChatFetch(urls),
    });
    await session.refreshTools();

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url === "https://honua.example/mcp")).toBe(true);
  });

  it("honors an explicit mcpBaseUrl override and strips trailing slashes", async () => {
    const urls: string[] = [];
    const session = createStudioAgentSession({
      baseUrl: "https://honua.example/api",
      mcpBaseUrl: "https://mcp.example/proxy///",
      fetchImpl: createMcpAndChatFetch(urls),
    });
    await session.refreshTools();

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url === "https://mcp.example/proxy/mcp")).toBe(true);
  });

  it("defaults standalone McpClient and McpNotificationStream to the server root /mcp", async () => {
    const postUrls: string[] = [];
    const client = new McpClient({ fetchImpl: createMcpAndChatFetch(postUrls) });
    await client.initialize();
    expect(postUrls).toEqual(["/mcp"]);

    const getUrls: string[] = [];
    const stream = new McpNotificationStream({
      fetchImpl: async (input) => {
        getUrls.push(String(input));
        return new Response(null, { status: 405 });
      },
    });
    stream.start();
    await stream.done;
    expect(getUrls).toEqual(["/mcp"]);
  });
});
