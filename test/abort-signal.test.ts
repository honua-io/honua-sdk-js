import { describe, expect, it } from "vitest";

import { HonuaAbortError, HonuaClient, HonuaHttpError, HonuaTimeoutError } from "../src/index.js";

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

  it("retries a replay-safe JSON request when the body stalls after headers", async () => {
    let attempts = 0;
    const intercepted: unknown[] = [];
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 20,
      retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
      interceptors: [
        {
          error: ({ error }) => {
            intercepted.push(error);
          },
        },
      ],
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) return new Response(new ReadableStream<Uint8Array>({}));
        return new Response(JSON.stringify({ features: [] }));
      },
    });

    await expect(client.queryFeatures({ serviceId: "svc", layerId: 0, method: "GET" })).resolves.toEqual({
      features: [],
    });
    expect(attempts).toBe(2);
    expect(intercepted).toEqual([]);
  });

  it("does not retry a non-replay-safe JSON request when the body stalls after headers", async () => {
    let attempts = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 20,
      retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      fetchFn: async () => {
        attempts += 1;
        return new Response(new ReadableStream<Uint8Array>({}));
      },
    });

    await expect(client.queryFeatures({ serviceId: "svc", layerId: 0, method: "POST" })).rejects.toBeInstanceOf(
      HonuaTimeoutError,
    );
    expect(attempts).toBe(1);
  });

  it("bounds a stalled error-response body with timeoutMs and retries replay-safe requests", async () => {
    let attempts = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 20,
      retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) return new Response(new ReadableStream<Uint8Array>({}), { status: 503 });
        return new Response(JSON.stringify({ features: [{ attributes: { OBJECTID: 1 } }] }));
      },
    });

    await expect(client.queryFeatures({ serviceId: "svc", layerId: 0, method: "GET" })).resolves.toEqual({
      features: [{ attributes: { OBJECTID: 1 } }],
    });
    expect(attempts).toBe(2);
  });

  it("keeps caller cancellation active while an error-response body stalls", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 10_000,
      retry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
      fetchFn: async () => {
        attempts += 1;
        return new Response(new ReadableStream<Uint8Array>({}), { status: 500 });
      },
    });

    const pending = client.queryFeatures({
      serviceId: "svc",
      layerId: 0,
      method: "GET",
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(attempts).toBe(1);
  });

  it("invokes each error interceptor once for an HTTP 200 GeoServices error envelope", async () => {
    const seen: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      interceptors: [
        {
          error: () => {
            seen.push("first");
          },
        },
        {
          error: () => {
            seen.push("second");
          },
        },
      ],
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { code: 400, message: "Invalid field: BOGUS" } }), { status: 200 }),
    });

    await expect(client.queryFeatures({ serviceId: "svc", layerId: 0, method: "GET" })).rejects.toBeInstanceOf(
      HonuaHttpError,
    );
    expect(seen).toEqual(["first", "second"]);
  });
});
