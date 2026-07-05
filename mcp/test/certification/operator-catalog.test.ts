import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { type MockUpstream, startMockUpstream } from "../../src/certification/mock-upstream.js";
import { buildOperatorTools } from "../../src/certification/operator-catalog.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    await c();
  }
});

async function connect(mock: MockUpstream, withAuth: boolean): Promise<Client> {
  const headers = withAuth ? { Authorization: `Bearer ${mock.authToken}` } : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(mock.url), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client({ name: "catalog-test", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

describe("operator catalog definition", () => {
  it("advertises a representative ~20-tool operator surface, all with output schemas", () => {
    const tools = buildOperatorTools();
    expect(tools.length).toBeGreaterThanOrEqual(18);
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
    }
    const names = tools.map((t) => t.name);
    expect(names).toContain("honua_query_features");
    expect(names).toContain("honua_execute_plan");
    expect(names).toContain("honua_dry_run_plan");
  });

  it("marks mutating tools as not read-only", () => {
    const tools = buildOperatorTools();
    const execute = tools.find((t) => t.name === "honua_execute_plan");
    const query = tools.find((t) => t.name === "honua_query_features");
    expect(execute?.readOnly).toBe(false);
    expect(query?.readOnly).toBe(true);
  });
});

describe("mock upstream over streamable HTTP", () => {
  it("paginates tools/list with a nextCursor", async () => {
    const mock = await startMockUpstream();
    cleanups.push(() => mock.close());
    const client = await connect(mock, true);

    const first = await client.listTools();
    expect(first.nextCursor).toBeDefined();
    const second = await client.listTools({ cursor: first.nextCursor });
    expect(second.nextCursor).toBeUndefined();
    const total = first.tools.length + second.tools.length;
    expect(total).toBe(buildOperatorTools().length);
  });

  it("returns structured output for a read-only tool call", async () => {
    const mock = await startMockUpstream();
    cleanups.push(() => mock.close());
    const client = await connect(mock, true);

    const result = (await client.callTool({
      name: "honua_query_features",
      arguments: { serviceId: "svc-parks", layerId: 0, limit: 1 },
    })) as { isError?: boolean; structuredContent?: { count?: number } };
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.count).toBe(1);
  });

  it("returns a structured ValidationFailed error on invalid arguments (not a protocol error)", async () => {
    const mock = await startMockUpstream();
    cleanups.push(() => mock.close());
    const client = await connect(mock, true);

    const result = (await client.callTool({
      name: "honua_query_features",
      arguments: { serviceId: "svc-parks" }, // missing required layerId
    })) as { isError?: boolean; structuredContent?: { code?: string; error?: { kind?: string } } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("invalid_argument");
    expect(result.structuredContent?.error?.kind).toBe("ValidationFailed");
  });

  it("enforces the auth boundary on tools/call", async () => {
    const mock = await startMockUpstream();
    cleanups.push(() => mock.close());
    const client = await connect(mock, false);

    const result = (await client.callTool({
      name: "honua_query_features",
      arguments: { serviceId: "svc-parks", layerId: 0 },
    })) as { isError?: boolean; structuredContent?: { code?: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("unauthenticated");
  });

  it("enforces the auth boundary on resources/read", async () => {
    const mock = await startMockUpstream();
    cleanups.push(() => mock.close());
    const client = await connect(mock, false);

    await expect(client.readResource({ uri: "honua://results/res-001" })).rejects.toThrow(/authenticated/i);
  });

  it("reads a resource when authenticated", async () => {
    const mock = await startMockUpstream();
    cleanups.push(() => mock.close());
    const client = await connect(mock, true);

    const res = await client.readResource({ uri: "honua://styles/topographic" });
    expect(res.contents.length).toBeGreaterThan(0);
  });
});
