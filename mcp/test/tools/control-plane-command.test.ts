import { HonuaClient } from "@honua/sdk-js";
import {
  HONUA_COMMANDS,
  HONUA_COMMAND_IDS,
  type HonuaCommandReceipt,
  createHonuaCommandRuntime,
  importCreateCommand,
  mapPackagePublishCommand,
} from "@honua/sdk-js/control-plane";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/index.js";
import { controlPlaneCommandToolName, controlPlaneCommandToolSchema } from "../../src/tools/control-plane-command.js";

afterEach(() => {
  vi.restoreAllMocks();
});

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const MAP_PACKAGE = { id: "pkg-ops", version: "1.0.0", layers: [] } as unknown as Record<string, unknown>;

const PUBLISH_RESPONSE = {
  packageId: "pkg-ops-42",
  etag: 'W/"7"',
  links: { self: "/api/v1/admin/packages/pkg-ops-42" },
};

const IDENTITY = { actor: "user-1", tenantId: "acme" } as const;

/** A recording transport; both halves of every equality check drive it. */
function recorder(body: unknown = PUBLISH_RESPONSE): { requests: CapturedRequest[]; fetchFn: typeof fetch } {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(headersToRecord(init?.headers))) {
      headers[name.toLowerCase()] = value;
    }
    requests.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function runtimeFor(fetchFn: typeof fetch) {
  return createHonuaCommandRuntime({ client: new HonuaClient({ baseUrl: "https://example.test", fetchFn }) });
}

/** Connect an in-memory MCP client to a server that publishes the command tools. */
async function connect(fetchFn: typeof fetch) {
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  const server = createServer(client, {
    controlPlaneCommands: { runtime: createHonuaCommandRuntime({ client }), identity: IDENTITY },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "command-probe", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return {
    mcp,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

interface ToolCallResult {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
}

function payloadOf(result: ToolCallResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("control-plane command tools are a projection of the shared catalog", () => {
  it("publishes one tool per catalog command, named and described from the command itself", async () => {
    const { mcp, close } = await connect(recorder().fetchFn);
    try {
      const names = (await mcp.listTools()).tools.map((tool) => tool.name);
      for (const id of HONUA_COMMAND_IDS) {
        const command = HONUA_COMMANDS[id];
        const tool = (await mcp.listTools()).tools.find((entry) => entry.name === controlPlaneCommandToolName(id));
        expect(tool, id).toBeDefined();
        expect(tool?.description, id).toContain(command.description);
        // The agent-visible argument schema is derived from the command's own
        // declaration, not written a second time for MCP.
        const properties = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        expect(Object.keys(properties).sort(), id).toEqual(["dryRun", "idempotencyKey", "ifMatch", "input"]);
      }
      expect(names).toContain("honua_command_map_package_publish");
      // The platform-free read-only surface is still there and still first.
      expect(names[0]).toBe("honua_list_sources");
    } finally {
      await close();
    }
  });

  it("keeps the default standalone catalog free of control-plane mutation", async () => {
    const server = createServer(new HonuaClient({ baseUrl: "https://example.test" }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "default-probe", version: "1.0.0" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    try {
      const names = (await mcp.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith("honua_command_"))).toEqual([]);
    } finally {
      await mcp.close();
      await server.close();
    }
  });

  it("projects the command's declared input onto the tool arguments and nothing else", () => {
    const schema = controlPlaneCommandToolSchema(importCreateCommand);
    // Declared input travels through untouched.
    expect(
      schema.parse({ input: { sourceKind: "geojson", sourceUrl: "https://example.test/a.geojson" } }).input,
    ).toEqual({ sourceKind: "geojson", sourceUrl: "https://example.test/a.geojson" });
    // An unknown *input* key survives the projection so the command's own
    // sealed schema is what refuses it, with the shared typed error.
    expect(schema.parse({ input: { sourceKind: "geojson", approvedBy: "self" } }).input).toMatchObject({
      approvedBy: "self",
    });
    // An unknown *invocation* key is an MCP-level mistake and never reaches the runtime.
    expect(() => schema.parse({ input: { sourceKind: "geojson" }, headers: { Authorization: "forged" } })).toThrow();
  });
});

describe("transports adapt input and output only", () => {
  it("produces the same receipt from an MCP-shaped call and a direct JS call", async () => {
    // 1. The MCP path: a real in-memory MCP round trip through the registered tool.
    const mcpSide = recorder();
    const { mcp, close } = await connect(mcpSide.fetchFn);
    let mcpReceipt: HonuaCommandReceipt;
    try {
      const result = (await mcp.callTool({
        name: controlPlaneCommandToolName("map-package.publish"),
        arguments: {
          input: { mapId: "map-ops", workspaceId: "ws-1", package: MAP_PACKAGE, message: "ship it" },
        },
      })) as ToolCallResult;
      expect(result.isError).toBeFalsy();
      mcpReceipt = payloadOf(result) as unknown as HonuaCommandReceipt;
    } finally {
      await close();
    }

    // 2. The direct JS path: the same command, the same input, no MCP involved.
    const jsSide = recorder();
    const jsReceipt = await runtimeFor(jsSide.fetchFn).execute(
      mapPackagePublishCommand,
      { mapId: "map-ops", workspaceId: "ws-1", package: MAP_PACKAGE, message: "ship it" },
      { transport: "sdk", identity: IDENTITY },
    );

    // The transport is recorded and is the *only* difference; everything a
    // server-side audit join needs is identical, including the join key itself.
    expect(mcpReceipt.transport).toBe("mcp");
    expect(jsReceipt.transport).toBe("sdk");
    expect(mcpReceipt.auditKey).toBe(jsReceipt.auditKey);
    expect({ ...mcpReceipt, transport: undefined }).toEqual({ ...jsReceipt, transport: undefined });

    // And both put the same bytes on the wire.
    expect(mcpSide.requests).toHaveLength(1);
    expect(mcpSide.requests[0].method).toBe(jsSide.requests[0].method);
    expect(mcpSide.requests[0].path).toBe(jsSide.requests[0].path);
    expect(mcpSide.requests[0].body).toEqual(jsSide.requests[0].body);
    expect(mcpSide.requests[0].headers["idempotency-key"]).toBe(jsSide.requests[0].headers["idempotency-key"]);
    expect(mcpSide.requests[0].headers["idempotency-key"]).toBe(mcpReceipt.idempotencyKey);
  });

  it("previews through MCP without contacting the server, exactly as the shared runtime does", async () => {
    const side = recorder();
    const { mcp, close } = await connect(side.fetchFn);
    try {
      const result = (await mcp.callTool({
        name: controlPlaneCommandToolName("map-package.publish"),
        arguments: { input: { mapId: "map-ops", package: MAP_PACKAGE }, dryRun: true },
      })) as ToolCallResult;
      const receipt = payloadOf(result) as unknown as HonuaCommandReceipt;
      expect(side.requests).toHaveLength(0);
      expect(receipt.status).toBe("dry-run");
      expect(receipt.output).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("threads an explicit idempotency key and If-Match as invocation fields, not caller headers", async () => {
    const side = recorder();
    const { mcp, close } = await connect(side.fetchFn);
    try {
      const result = (await mcp.callTool({
        name: controlPlaneCommandToolName("map-package.publish"),
        arguments: {
          input: { mapId: "map-ops", package: MAP_PACKAGE },
          idempotencyKey: "key-explicit",
          ifMatch: 'W/"6"',
        },
      })) as ToolCallResult;
      const receipt = payloadOf(result) as unknown as HonuaCommandReceipt;
      expect(receipt.idempotencyKey).toBe("key-explicit");
      // The value on the wire is the value the receipt records.
      expect(side.requests[0].headers["idempotency-key"]).toBe("key-explicit");
      expect(side.requests[0].headers["if-match"]).toBe('W/"6"');
    } finally {
      await close();
    }
  });
});

describe("no self-approval by selecting the MCP transport", () => {
  it("refuses an approval field with the shared typed error, before any request", async () => {
    const side = recorder();
    const { mcp, close } = await connect(side.fetchFn);
    try {
      const result = (await mcp.callTool({
        name: controlPlaneCommandToolName("map-package.publish"),
        arguments: {
          input: { mapId: "map-ops", package: MAP_PACKAGE, approvedBy: "self", approved: true },
        },
      })) as ToolCallResult;
      expect(result.isError).toBe(true);
      const error = payloadOf(result);
      // The command layer's taxonomy, not an MCP-invented one.
      expect(error.kind).toBe("honua.command.error.v1");
      expect(error.errorKind).toBe("validation");
      expect(error.commandId).toBe("map-package.publish");
      expect((error.issues as Array<{ path: string }>).map((issue) => issue.path).sort()).toEqual([
        "approved",
        "approvedBy",
      ]);
      expect(side.requests).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("records every MCP receipt as server-enforced and never puts the identity echo on the wire", async () => {
    const side = recorder();
    const { mcp, close } = await connect(side.fetchFn);
    try {
      const result = (await mcp.callTool({
        name: controlPlaneCommandToolName("map-package.publish"),
        arguments: { input: { mapId: "map-ops", package: MAP_PACKAGE } },
      })) as ToolCallResult;
      const receipt = payloadOf(result) as unknown as HonuaCommandReceipt;
      expect(receipt.authorization).toBe("server-enforced");
      // Host-supplied identity is echoed, never asserted to the server.
      expect(receipt.identity).toEqual({ actor: "user-1", tenantId: "acme" });
      expect(Object.keys(side.requests[0].headers)).not.toContain("x-honua-actor");
      expect(JSON.stringify(side.requests[0].body)).not.toContain("user-1");
    } finally {
      await close();
    }
  });

  it("surfaces a command validation failure as a typed tool error rather than an opaque MCP fault", async () => {
    const side = recorder();
    const { mcp, close } = await connect(side.fetchFn);
    try {
      // `import.create` needs `sourceUrl` for /import/upload-url; the rule is
      // the command's `validate`, so MCP reports it identically to the CLI.
      const result = (await mcp.callTool({
        name: controlPlaneCommandToolName("import.create"),
        arguments: { input: { sourceKind: "geojson" } },
      })) as ToolCallResult;
      expect(result.isError).toBe(true);
      const error = payloadOf(result);
      expect(error.errorKind).toBe("validation");
      expect((error.issues as Array<{ message: string }>).map((issue) => issue.message)).toEqual([
        "`sourceUrl` is required by /import/upload-url",
      ]);
      expect(side.requests).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
