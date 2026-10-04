import { describe, expect, it } from "vitest";

import { HonuaAbortError, HonuaClient, HonuaTimeoutError } from "../src/index.js";

describe("AbortSignal support (Direction 14)", () => {
  it("pre-aborted signal throws HonuaAbortError on queryFeatures", async () => {
    const controller = new AbortController();
    controller.abort();

    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return new Response(JSON.stringify({ features: [] }));
      },
    });

    await expect(
      client.queryFeatures({
        serviceId: "svc",
        layerId: 0,
        signal: controller.signal,
      }),
    ).rejects.toThrow(HonuaAbortError);
  });

  it("pre-aborted signal throws HonuaAbortError on request()", async () => {
    const controller = new AbortController();
    controller.abort();

    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return new Response("{}");
      },
    });

    await expect(
      client.request({
        path: "/rest/services",
        signal: controller.signal,
      }),
    ).rejects.toThrow(HonuaAbortError);
  });

  it("request succeeds without signal", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () => new Response(JSON.stringify({ features: [] })),
    });

    const result = await client.queryFeatures({
      serviceId: "svc",
      layerId: 0,
    });
    expect(result).toEqual({ features: [] });
  });

  it("keeps timeout active while a JSON response body stalls after headers", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 20,
      fetchFn: async () => new Response(new ReadableStream<Uint8Array>({})),
    });

    await expect(client.queryFeatures({ serviceId: "svc", layerId: 0 })).rejects.toBeInstanceOf(HonuaTimeoutError);
  });

  it("keeps caller cancellation active while a JSON response body stalls after headers", async () => {
    const controller = new AbortController();
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 10_000,
      fetchFn: async () => new Response(new ReadableStream<Uint8Array>({})),
    });

    const pending = client.queryFeatures({ serviceId: "svc", layerId: 0, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
  });
});
