import { HonuaClient } from "@honua/sdk-js";
import {
  type HonuaCommandReceipt,
  createHonuaCommandRuntime,
  honuaCommandReceiptProjection,
  studioDraftSaveVersionCommand,
} from "@honua/sdk-js/control-plane";
import { HonuaStudioLifecycleClient } from "@honua/sdk-js/studio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createServer } from "../../src/index.js";
import { controlPlaneCommandToolName } from "../../src/tools/control-plane-command.js";

it("dispatches the registered Studio tool with the same receipt and generation/auth wire behavior as the SDK", async () => {
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    correlation: string | null;
    idempotency: string | null;
  }> = [];
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    bearerToken: "synthetic-viewer-token",
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        authorization: headers.get("authorization"),
        correlation: headers.get("x-correlation-id"),
        idempotency: headers.get("idempotency-key"),
      });
      return Response.json({
        success: true,
        data:
          init?.method === "POST"
            ? { versionId: "version-1", itemId: "item-1", versionNumber: 1 }
            : { draftId: "draft-1", generation: 7 },
      });
    },
  });
  const runtime = createHonuaCommandRuntime({ client, studio: new HonuaStudioLifecycleClient({ client }) });
  const identity = { actor: "editor-1", tenantId: "tenant-1" } as const;
  const server = createServer(client, { controlPlaneCommands: { runtime, identity } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "draft-command-probe", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  try {
    const result = await mcp.callTool({
      name: controlPlaneCommandToolName("studio.draft.saveVersion"),
      arguments: { input: { draftId: "draft-1", generation: 7 }, idempotencyKey: "draft-version-key" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const receipt = JSON.parse(content[0].text) as HonuaCommandReceipt;
    const mcpRequests = requests.splice(0);
    const sdk = await runtime.execute(
      studioDraftSaveVersionCommand,
      { draftId: "draft-1", generation: 7 },
      { transport: "sdk", identity, idempotencyKey: "draft-version-key" },
    );
    expect(receipt.transport).toBe("mcp");
    expect(honuaCommandReceiptProjection(receipt)).toEqual(honuaCommandReceiptProjection(sdk));
    expect(mcpRequests).toEqual(requests);
    expect(mcpRequests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
    for (const request of mcpRequests) {
      expect(request.authorization).toBe("Bearer synthetic-viewer-token");
      expect(request.correlation).toBe(receipt.correlationId);
      expect(request.idempotency).toBe(request.method === "POST" ? "draft-version-key" : null);
    }
  } finally {
    await mcp.close();
    await server.close();
  }
});
