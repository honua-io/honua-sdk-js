import { describe, expect, it } from "vitest";

import {
  createHonuaCommandRuntime,
  honuaCommandReceiptProjection,
  studioDraftSaveVersionCommand,
} from "../../src/control-plane/index.js";
import { HonuaClient } from "../../src/index.js";
import { HonuaStudioCommandAdapter, HonuaStudioLifecycleClient } from "../../src/studio/index.js";

function recordingClient(): { client: HonuaClient; requests: Array<{ path: string; headers: Headers }> } {
  const requests: Array<{ path: string; headers: Headers }> = [];
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    fetchFn: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, headers: new Headers(init?.headers) });
      if (path.endsWith("/content-versions")) {
        return Response.json({ success: true, data: { versionId: "version-1", itemId: "item-1", versionNumber: 1 } });
      }
      return Response.json({ success: true, data: { draftId: "draft-1", generation: 7 } });
    },
  });
  return { client, requests };
}

describe("Studio command adapter", () => {
  it("returns the same command receipt projection as direct SDK dispatch", async () => {
    const studioTransport = recordingClient();
    const sdkTransport = recordingClient();
    const identity = { actor: "editor-1", tenantId: "tenant-1" } as const;
    const invocation = { identity, idempotencyKey: "draft-version-key", correlationId: "correlation-1" } as const;

    const adapter = new HonuaStudioCommandAdapter({ client: studioTransport.client });
    const studioReceipt = await adapter.saveDraftVersion({ draftId: "draft-1", generation: 7 }, invocation);

    const lifecycle = new HonuaStudioLifecycleClient({ client: sdkTransport.client });
    const runtime = createHonuaCommandRuntime({ client: sdkTransport.client, studio: lifecycle });
    const sdkReceipt = await runtime.execute(
      studioDraftSaveVersionCommand,
      { draftId: "draft-1", generation: 7 },
      { ...invocation, transport: "sdk" },
    );

    expect(studioReceipt.transport).toBe("studio");
    expect(sdkReceipt.transport).toBe("sdk");
    expect(honuaCommandReceiptProjection(studioReceipt)).toEqual(honuaCommandReceiptProjection(sdkReceipt));
    expect(studioReceipt.auditKey).toBe(sdkReceipt.auditKey);
    expect(studioTransport.requests.map((request) => request.path)).toEqual([
      "/api/v1/studio/package-drafts/draft-1",
      "/api/v1/studio/package-drafts/draft-1/content-versions",
      "/api/v1/studio/package-drafts/draft-1",
    ]);
    expect(studioTransport.requests[1].headers.get("idempotency-key")).toBe("draft-version-key");
  });
});
