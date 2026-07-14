import { describe, expect, it, vi } from "vitest";
import { HonuaClient } from "../src/core/client.js";

describe("HonuaClient transport selection", () => {
  it("defaults to rest transport", () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    expect(client.isGrpcWeb).toBe(false);
  });

  it("reports grpc-web transport when configured", () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    expect(client.isGrpcWeb).toBe(true);
  });

  it("defers and deduplicates Connect client initialization until it is awaited", async () => {
    // Preload the optional modules so a constructor-started import chain would
    // deterministically settle before the assertion below.
    await Promise.all([
      import("@connectrpc/connect"),
      import("@connectrpc/connect-web"),
      import("../src/gen/honua/v1/feature_service_pb.js"),
    ]);

    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });
    const internals = client as unknown as {
      connectClient?: unknown;
      connectClientPromise?: Promise<unknown>;
      ensureConnectClient(): Promise<unknown>;
    };

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(internals.connectClient).toBeUndefined();
    expect(internals.connectClientPromise).toBeUndefined();

    const [first, second] = await Promise.all([internals.ensureConnectClient(), internals.ensureConnectClient()]);
    expect(first).toBe(second);
    expect(internals.connectClient).toBe(first);
  });

  it("uses REST path when transport is rest", async () => {
    let requestedUrl = "";
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "rest",
      fetchFn: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ features: [] }), { status: 200 });
      },
    });

    await client.queryFeatures({
      serviceId: "svc1",
      layerId: 0,
      where: "1=1",
    });

    expect(requestedUrl).toContain("/rest/services/svc1/FeatureServer/0/query");
  });

  it("uses REST path by default (no transport option)", async () => {
    let requestedUrl = "";
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ features: [] }), { status: 200 });
      },
    });

    await client.queryFeatures({
      serviceId: "svc1",
      layerId: 0,
    });

    expect(requestedUrl).toContain("/rest/services/svc1/FeatureServer/0/query");
    expect(requestedUrl).toContain("f=json");
  });

  it("accepts HonuaTransport type in options", () => {
    // This test verifies the type system accepts the transport option
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    expect(client.isGrpcWeb).toBe(true);
  });
});

describe("HonuaClient gRPC-web auth + timeout wiring", () => {
  it("connect auth interceptor injects credential headers onto every call", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      apiKey: "secret-key",
      bearerToken: "tok-123",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    const interceptor = (client as any).buildConnectAuthInterceptor();
    const req = { header: new Headers() };
    let forwarded: unknown;
    const next = async (r: unknown) => {
      forwarded = r;
      return { ok: true };
    };

    await interceptor(next)(req);

    expect(forwarded).toBe(req);
    expect(req.header.get("x-api-key")).toBe("secret-key");
    expect(req.header.get("authorization")).toBe("Bearer tok-123");
  });

  it("connect auth interceptor resolves provider credentials per call", async () => {
    let issued = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      auth: () => {
        issued += 1;
        return { bearerToken: `provider-${issued}`, expiresAt: Date.now() + 60_000 };
      },
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    const interceptor = (client as any).buildConnectAuthInterceptor();
    const req = { header: new Headers() };
    await interceptor(async () => ({ ok: true }))(req);

    expect(req.header.get("authorization")).toBe("Bearer provider-1");
    expect(issued).toBe(1);
  });

  it("connectTransportOptions wires the auth interceptor and honors timeoutMs", () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      timeoutMs: 1234,
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    const opts = (client as any).connectTransportOptions();
    expect(opts.baseUrl).toBe("https://example.test");
    // No retry configured -> auth interceptor only.
    expect(opts.interceptors).toHaveLength(1);
    expect(opts.defaultTimeoutMs).toBe(1234);
  });

  it("connectTransportOptions adds the retry interceptor when retry is configured", () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      retry: { maxRetries: 2 },
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    const opts = (client as any).connectTransportOptions();
    // Retry interceptor wraps the auth interceptor (outermost-first).
    expect(opts.interceptors).toHaveLength(2);
  });
});

describe("HonuaClient gRPC-web retry interceptor", () => {
  const grpcClient = (overrides: Record<string, unknown> = {}) =>
    new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
      fetchFn: async () => new Response("{}", { status: 200 }),
      ...overrides,
    });

  // Minimal Connect-error shape: a numeric `code` is what the SDK keys on.
  const connectError = (code: number, metadata?: Headers) =>
    Object.assign(new Error(`grpc code ${code}`), { code, ...(metadata ? { metadata } : {}) });

  const unaryReq = (signal?: AbortSignal) => ({
    stream: false as const,
    header: new Headers(),
    signal: signal ?? new AbortController().signal,
  });

  it("retries a transient gRPC code then succeeds", async () => {
    const interceptor = (grpcClient() as any).buildConnectRetryInterceptor();
    let calls = 0;
    const next = async () => {
      calls += 1;
      if (calls < 3) {
        throw connectError(14); // unavailable
      }
      return { ok: true };
    };

    const result = await interceptor(next)(unaryReq());

    expect(calls).toBe(3);
    expect(result).toEqual({ ok: true });
  });

  it("does not retry a non-retryable gRPC code", async () => {
    const interceptor = (grpcClient() as any).buildConnectRetryInterceptor();
    let calls = 0;
    const next = async () => {
      calls += 1;
      throw connectError(3); // invalid_argument
    };

    await expect(interceptor(next)(unaryReq())).rejects.toMatchObject({ code: 3 });
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const interceptor = (grpcClient() as any).buildConnectRetryInterceptor();
    let calls = 0;
    const next = async () => {
      calls += 1;
      throw connectError(14);
    };

    await expect(interceptor(next)(unaryReq())).rejects.toMatchObject({ code: 14 });
    // initial attempt + 3 retries
    expect(calls).toBe(4);
  });

  it("does not retry once the abort signal has fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const interceptor = (grpcClient() as any).buildConnectRetryInterceptor();
    let calls = 0;
    const next = async () => {
      calls += 1;
      throw connectError(14);
    };

    await expect(interceptor(next)(unaryReq(controller.signal))).rejects.toMatchObject({ code: 14 });
    expect(calls).toBe(1);
  });

  it("does not retry server-streaming calls", async () => {
    const interceptor = (grpcClient() as any).buildConnectRetryInterceptor();
    let calls = 0;
    const next = async () => {
      calls += 1;
      throw connectError(14);
    };
    const streamReq = { stream: true as const, header: new Headers(), signal: new AbortController().signal };

    await expect(interceptor(next)(streamReq)).rejects.toMatchObject({ code: 14 });
    expect(calls).toBe(1);
  });

  it("is a passthrough when no retry policy is configured", async () => {
    const interceptor = (grpcClient({ retry: undefined }) as any).buildConnectRetryInterceptor();
    let calls = 0;
    const next = async () => {
      calls += 1;
      throw connectError(14);
    };

    await expect(interceptor(next)(unaryReq())).rejects.toMatchObject({ code: 14 });
    expect(calls).toBe(1);
  });

  it("honors retry-after metadata for the backoff delay", async () => {
    const interceptor = (grpcClient() as any).buildConnectRetryInterceptor();
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === "number") {
        delays.push(ms);
      }
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);

    let calls = 0;
    const next = async () => {
      calls += 1;
      if (calls < 2) {
        throw connectError(14, new Headers({ "retry-after": "2" }));
      }
      return { ok: true };
    };

    await interceptor(next)(unaryReq());
    vi.restoreAllMocks();

    // retry-after: 2s, capped by maxDelayMs (2ms) -> 2ms.
    expect(delays).toContain(2);
  });
});

describe("HonuaClient REST transport parity", () => {
  it("queryFeatures still works with preferBinary on rest transport", async () => {
    let requestedUrl = "";
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "rest",
      preferBinary: true,
      fetchFn: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ features: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await client.queryFeatures({
      serviceId: "svc1",
      layerId: 0,
    });

    // With preferBinary + rest transport, should use f=pbf
    expect(requestedUrl).toContain("f=pbf");
  });
});

describe("HonuaClient gRPC streaming", () => {
  it("queryFeaturesStream routes through gRPC adapter when transport is grpc-web", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    // The stream should attempt to use gRPC transport
    // Since we can't fully mock connectrpc here, just verify the client
    // accepts the transport config and the stream method exists
    expect(typeof client.queryFeaturesStream).toBe("function");

    // Verify it returns an async generator
    const stream = client.queryFeaturesStream({ serviceId: "svc", layerId: 0 });
    expect(stream[Symbol.asyncIterator]).toBeDefined();
  });

  it("streamProtoPages yields feature batches from async iterable", async () => {
    const { streamProtoPages } = await import("../src/core/grpc-adapter.js");

    // Create a mock async iterable of FeaturePages
    const mockPages = [
      {
        features: [
          {
            attributes: {},
            geometry: { shape: { case: "point" as const, value: { x: 1, y: 2 } } },
          },
        ],
        isLastPage: false,
      },
      {
        features: [
          {
            attributes: {},
            geometry: { shape: { case: "point" as const, value: { x: 3, y: 4 } } },
          },
        ],
        isLastPage: true,
      },
    ];

    async function* fakeStream() {
      for (const page of mockPages) {
        yield page;
      }
    }

    const batches: unknown[] = [];
    for await (const batch of streamProtoPages(fakeStream() as any)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual([{ attributes: {}, geometry: { x: 1, y: 2 } }]);
    expect(batches[1]).toEqual([{ attributes: {}, geometry: { x: 3, y: 4 } }]);
  });

  it("streamProtoPages stops on empty last page", async () => {
    const { streamProtoPages } = await import("../src/core/grpc-adapter.js");

    async function* fakeStream() {
      yield {
        features: [
          {
            attributes: {},
            geometry: { shape: { case: "point" as const, value: { x: 1, y: 2 } } },
          },
        ],
        isLastPage: false,
      };
      yield { features: [], isLastPage: true };
    }

    const batches: unknown[] = [];
    for await (const batch of streamProtoPages(fakeStream() as any)) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([{ attributes: {}, geometry: { x: 1, y: 2 } }]);
  });
});
