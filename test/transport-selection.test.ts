import { fromBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import { HonuaOptionalGrpcPeerError } from "../src/core/optional-grpc-peer.js";
import { createHonuaClient, selectHonuaTransport } from "../src/core/transport-selection.js";
import { DescribeServiceRequestSchema } from "../src/gen/geospatial/v1/feature_service_pb.js";
import {
  HonuaClient as GrpcWebHonuaClient,
  createHonuaClient as createBrowserClient,
  selectHonuaTransport as selectBrowserTransport,
} from "../src/grpc-web.js";
import { createHonuaClient as fromHonua } from "../src/honua.js";
import { createHonuaClient as fromIndex } from "../src/index.js";

const baseUrl = "https://example.test";

function grpcStatus(code: number): Response {
  return new Response(null, {
    headers: { "content-type": "application/grpc-web+proto", "grpc-status": String(code), "grpc-message": "x" },
  });
}

function recordingFetch(answer: () => Response | Promise<Response>, calls: string[] = []): typeof fetch {
  return async (input, init) => {
    calls.push(String(input));
    const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    expect(fromBinary(DescribeServiceRequestSchema, bytes.subarray(5))).toMatchObject({ serviceId: "" });
    return answer();
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHonuaClient transport selection", () => {
  it("selects gRPC-Web when the server answers the probe with a gRPC status", async () => {
    const calls: string[] = [];
    const client = await createHonuaClient({
      baseUrl,
      apiKey: "key",
      fetchFn: recordingFetch(() => grpcStatus(3), calls),
    });
    expect(client).toBeInstanceOf(HonuaClient);
    expect(client.isGrpcWeb).toBe(true);
    expect(calls).toEqual([`${baseUrl}/geospatial.v1.FeatureService/DescribeService`]);
  });

  it("treats an UNIMPLEMENTED status as a gRPC-Web server", async () => {
    await expect(selectHonuaTransport({ baseUrl, fetchFn: recordingFetch(() => grpcStatus(12)) })).resolves.toBe(
      "grpc-web",
    );
  });

  it("selects REST when the answer is not gRPC-Web", async () => {
    const fetchFn = recordingFetch(
      () => new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } }),
    );
    const client = await createHonuaClient({ baseUrl, fetchFn });
    expect(client.isGrpcWeb).toBe(false);
  });

  it("selects REST for a bare HTTP 400 without gRPC headers", async () => {
    await expect(
      selectHonuaTransport({ baseUrl, fetchFn: recordingFetch(() => new Response(null, { status: 400 })) }),
    ).resolves.toBe("rest");
  });

  it("selects REST when no response arrives", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(selectHonuaTransport({ baseUrl, fetchFn })).resolves.toBe("rest");
  });

  it("does not retry the probe even when the client has a retry policy", async () => {
    const calls: string[] = [];
    await expect(
      selectHonuaTransport({ baseUrl, retry: { maxRetries: 3 }, fetchFn: recordingFetch(() => grpcStatus(14), calls) }),
    ).resolves.toBe("grpc-web");
    expect(calls).toHaveLength(1);
  });

  it("selects REST when the optional gRPC peers are not installed", async () => {
    const missing = new HonuaOptionalGrpcPeerError("@connectrpc/connect-web", new Error("Cannot find package"));
    vi.spyOn(HonuaClient.prototype, "describeService").mockRejectedValue(missing);
    const fetchFn = vi.fn<typeof fetch>();
    const client = await createHonuaClient({ baseUrl, fetchFn });
    expect(client.isGrpcWeb).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("honours an explicit transport without probing", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    expect((await createHonuaClient({ baseUrl, fetchFn, transport: "rest" })).isGrpcWeb).toBe(false);
    expect((await createHonuaClient({ baseUrl, fetchFn, transport: "grpc-web" })).isGrpcWeb).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects with the abort reason instead of choosing a transport", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const fetchFn: typeof fetch = async () => {
      controller.abort(reason);
      throw reason;
    };
    await expect(createHonuaClient({ baseUrl, fetchFn, signal: controller.signal })).rejects.toBe(reason);

    const fetchNever = vi.fn<typeof fetch>();
    await expect(createHonuaClient({ baseUrl, fetchFn: fetchNever, signal: controller.signal })).rejects.toBe(reason);
    expect(fetchNever).not.toHaveBeenCalled();
  });

  it("is exported from the package entrypoint", () => {
    expect(fromIndex).toBe(createHonuaClient);
    expect(fromHonua).toBe(createHonuaClient);
  });

  it("returns the statically bound gRPC-Web class from the browser entrypoint", async () => {
    const native = await createBrowserClient({ baseUrl, fetchFn: recordingFetch(() => grpcStatus(3)) });
    expect(native).toBeInstanceOf(GrpcWebHonuaClient);
    expect(native.isGrpcWeb).toBe(true);

    const rest = await createBrowserClient({
      baseUrl,
      fetchFn: recordingFetch(() => new Response(null, { status: 404 })),
    });
    expect(rest).not.toBeInstanceOf(GrpcWebHonuaClient);
    expect(rest.isGrpcWeb).toBe(false);
  });

  it("detects gRPC-Web from the content type alone, including grpc-web-text", async () => {
    for (const contentType of ["application/grpc-web+proto", "application/grpc-web-text"]) {
      const fetchFn = recordingFetch(
        () => new Response(null, { status: 200, headers: { "content-type": contentType } }),
      );
      await expect(selectHonuaTransport({ baseUrl, fetchFn })).resolves.toBe("grpc-web");
    }
  });

  it("selects REST when the probe gets no answer before its deadline", async () => {
    const fetchFn: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expect(selectHonuaTransport({ baseUrl, fetchFn, probeTimeoutMs: 20 })).resolves.toBe("rest");
  });

  it("rethrows a failure raised before the probe request is sent", async () => {
    const failure = new Error("token refresh failed");
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      createHonuaClient({
        baseUrl,
        fetchFn,
        auth: async () => {
          throw failure;
        },
      }),
    ).rejects.toThrow("token refresh failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("selects REST for browser module-loader failures that name no peer", async () => {
    const messages = [
      'The specifier "@connectrpc/connect" was a bare specifier, but was not remapped to anything.',
      "Module name, '@connectrpc/connect' does not resolve to a valid URL.",
      "Failed to fetch dynamically imported module: https://app.example/assets/grpc-adapter.js",
    ];
    for (const message of messages) {
      vi.spyOn(HonuaClient.prototype, "describeService").mockRejectedValueOnce(new TypeError(message));
      const fetchFn = vi.fn<typeof fetch>();
      await expect(selectHonuaTransport({ baseUrl, fetchFn })).resolves.toBe("rest");
    }
  });

  it("rejects with the caller's reason when it aborts a hung probe", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const fetchFn: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        setTimeout(() => controller.abort(reason), 10);
      });
    await expect(
      selectHonuaTransport({ baseUrl, fetchFn, signal: controller.signal, probeTimeoutMs: 60_000 }),
    ).rejects.toBe(reason);
  });

  it("refuses a probe timeout that a timer cannot represent", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const probeTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(selectHonuaTransport({ baseUrl, fetchFn, probeTimeoutMs })).rejects.toBeInstanceOf(RangeError);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("exposes the probe on the browser entrypoint", async () => {
    await expect(selectBrowserTransport({ baseUrl, fetchFn: recordingFetch(() => grpcStatus(3)) })).resolves.toBe(
      "grpc-web",
    );
  });
});
