import { describe, expect, it, vi } from "vitest";

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

describe("response body deadlines across typed and raw transports", () => {
  const requests = {
    bytes: (client: HonuaClient, signal?: AbortSignal) =>
      (client as any).requestBytes("GET", "/tile", undefined, undefined, signal),
    pbf: (client: HonuaClient, signal?: AbortSignal) => client.queryFeatures({ serviceId: "svc", layerId: 0, signal }),
    text: (client: HonuaClient, signal?: AbortSignal) => client.requestText("GET", "/capabilities", { signal }),
    boundedText: (client: HonuaClient, signal?: AbortSignal) =>
      client.requestText("GET", "/capabilities", { signal, maxResponseBytes: 100 }),
    metadata: (client: HonuaClient, signal?: AbortSignal) => client.getLayerMetadata("svc", 0, { signal }),
    raw: async (client: HonuaClient, signal?: AbortSignal) =>
      (await client.pipelineFetch("GET", "/raw", undefined, signal)).text(),
  };
  for (const [name, request] of Object.entries(requests)) {
    it(`${name} times out after headers and cancels the stalled body`, async () => {
      let cancelled = false;
      let attempts = 0;
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        timeoutMs: 20,
        preferBinary: name === "pbf",
        fetchFn: async () => {
          attempts++;
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: { "content-type": name === "pbf" ? "application/x-protobuf" : "application/json" },
            },
          );
        },
      });
      await expect(request(client)).rejects.toBeInstanceOf(HonuaTimeoutError);
      expect(cancelled).toBe(true);
      expect(attempts).toBe(1);
    });
    it(`${name} honors caller cancellation after headers`, async () => {
      const controller = new AbortController();
      let headers!: () => void;
      const receivedHeaders = new Promise<void>((resolve) => {
        headers = resolve;
      });
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        timeoutMs: 10_000,
        preferBinary: name === "pbf",
        fetchFn: async () => {
          headers();
          return new Response(new ReadableStream<Uint8Array>({}), {
            headers: { "content-type": name === "pbf" ? "application/x-protobuf" : "application/json" },
          });
        },
      });
      const pending = request(client, controller.signal);
      await receivedHeaders;
      await Promise.resolve();
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    });
  }

  it("bounds raw error bodies before HTTP error parsing", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 20,
      fetchFn: async () => new Response(new ReadableStream<Uint8Array>({}), { status: 503 }),
    });
    await expect(client.pipelineFetch("GET", "/raw")).rejects.toBeInstanceOf(HonuaTimeoutError);
  });

  it("keeps a PBF decoding fallback inside the original deadline", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let fallbackSignal: AbortSignal | null | undefined;
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        timeoutMs: 20,
        preferBinary: true,
        fetchFn: async (_input, init) => {
          attempts += 1;
          if (attempts === 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return new Response(new Uint8Array([255]), { headers: { "content-type": "application/x-protobuf" } });
          }
          fallbackSignal = init?.signal;
          return new Response(new ReadableStream<Uint8Array>({}));
        },
      });
      const rejected = expect(client.queryFeatures({ serviceId: "svc", layerId: 0 })).rejects.toBeInstanceOf(
        HonuaTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(attempts).toBe(2);
      expect(fallbackSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, 10_000])(
    "cancels the raw stream if an after interceptor fails with timeout %s",
    async (timeoutMs) => {
      let cancelled = false;
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        timeoutMs,
        fetchFn: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
            }),
          ),
        interceptors: [
          {
            after() {
              throw new Error("interceptor failed");
            },
          },
        ],
      });
      await expect(client.pipelineFetch("GET", "/raw")).rejects.toThrow("interceptor failed");
      expect(cancelled).toBe(true);
    },
  );

  it("bounds a stalled metadata revalidation interceptor by the request deadline", async () => {
    let calls = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 20,
      fetchFn: async () =>
        ++calls === 1
          ? Response.json({ id: 0, name: "layer" }, { headers: { etag: '"v1"' } })
          : new Response(null, { status: 304 }),
      interceptors: [{ after: ({ response }) => (response.status === 304 ? new Promise<void>(() => {}) : undefined) }],
    });
    await client.getLayerMetadata("svc", 0);
    await expect(client.getLayerMetadata("svc", 0, { refresh: true, staleIfError: false })).rejects.toBeInstanceOf(
      HonuaTimeoutError,
    );
    expect(calls).toBe(2);
  });

  it("preserves opted-in stale metadata fallback when a response body times out", async () => {
    let calls = 0;
    const onError = vi.fn();
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 20,
      interceptors: [{ error: onError }],
      fetchFn: async () =>
        ++calls === 1
          ? Response.json({ id: 0, name: "cached layer" })
          : new Response(new ReadableStream<Uint8Array>({})),
    });
    await client.getLayerMetadata("svc", 0);
    const stale = await client.getLayerMetadata("svc", 0, { refresh: true, staleIfError: true });
    expect(stale.name).toBe("cached layer");
    expect(stale.cache?.status).toBe("stale");
    expect(calls).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    "notifies error hooks only after text-body retries are exhausted with %s retries",
    async (maxRetries) => {
      let calls = 0;
      const onError = vi.fn();
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        timeoutMs: 20,
        retry: { maxRetries, baseDelayMs: 0, maxDelayMs: 0 },
        interceptors: [{ error: onError }],
        fetchFn: async () =>
          ++calls === 1 ? new Response(new ReadableStream<Uint8Array>({})) : new Response("complete"),
      });
      const pending = client.requestText("GET", "/capabilities");
      if (maxRetries === 0) {
        await expect(pending).rejects.toBeInstanceOf(HonuaTimeoutError);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].error).toBeInstanceOf(HonuaTimeoutError);
      } else {
        await expect(pending).resolves.toMatchObject({ text: "complete" });
        expect(onError).not.toHaveBeenCalled();
      }
      expect(calls).toBe(maxRetries + 1);
    },
  );

  it("returns raw streaming headers immediately and preserves status and URL", async () => {
    const original = new Response(new ReadableStream<Uint8Array>({}), {
      status: 206,
      statusText: "Partial Content",
      headers: { "x-test": "stream" },
    });
    Object.defineProperty(original, "url", { value: "https://example.test/final" });
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      timeoutMs: 10_000,
      fetchFn: async () => original,
    });
    const response = await client.pipelineFetch("GET", "/raw");
    expect(response.status).toBe(206);
    expect(response.statusText).toBe("Partial Content");
    expect(response.headers.get("x-test")).toBe("stream");
    expect(response.url).toBe(original.url);
    await response.body!.cancel();
  });

  it("releases the raw deadline on EOF, cancellation, and empty responses", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        timeoutMs: 20,
        fetchFn: async (input) =>
          String(input).endsWith("/done")
            ? new Response("done")
            : String(input).endsWith("/empty")
              ? new Response(null, { status: 204 })
              : new Response(
                  new ReadableStream<Uint8Array>({
                    cancel() {
                      cancelled = true;
                    },
                  }),
                ),
      });
      const done = await client.pipelineFetch("GET", "/done");
      expect(await done.text()).toBe("done");
      expect(vi.getTimerCount()).toBe(0);
      const stopped = await client.pipelineFetch("GET", "/cancel");
      expect(vi.getTimerCount()).toBe(1);
      await stopped.body!.cancel();
      expect(cancelled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect((await client.pipelineFetch("GET", "/empty")).status).toBe(204);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
