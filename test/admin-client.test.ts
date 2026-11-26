import { describe, expect, it } from "vitest";

import { ADMIN_ONE_TIME_SECRET_OPERATION_IDS } from "../src/cli/admin-secret-output.js";
import {
  ADMIN_API_OPERATION_COUNT,
  ADMIN_API_SERVER_SHA,
  ADMIN_MCP_CONTRACT_REVIEW_SERVER_SHA,
  ADMIN_MCP_CONTRACT_SERVER_SHA,
  ADMIN_MCP_CONTRACT_STATUS,
  ADMIN_MCP_COVERAGE_SHA256,
  ADMIN_MCP_EXCLUDED_OPERATIONS,
  ADMIN_MCP_EXCLUDED_OPERATION_COUNT,
  ADMIN_MCP_EXCLUSION_ROSTER_SHA256,
  ADMIN_MCP_PUBLISHED_TOOL_NAMES,
  ADMIN_OPERATIONS,
  ADMIN_PUBLISHED_OPERATION_COUNT,
  HonuaAdminApiError,
  HonuaAdminClient,
  MCP_DEFAULT_STATIC_TOOL_COUNT,
  MCP_DEFAULT_TOTAL_TOOL_COUNT,
} from "../src/control-plane/index.js";

describe("generated admin REST client", () => {
  it("keeps the complete 396-operation inventory pinned to a server commit", () => {
    expect(Object.keys(ADMIN_OPERATIONS)).toHaveLength(396);
    expect(ADMIN_API_OPERATION_COUNT).toBe(396);
    expect(ADMIN_API_SERVER_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(ADMIN_OPERATIONS.createConnection).toMatchObject({ method: "POST", path: "/connections" });
  });

  it("classifies every REST operation into the complete default Admin MCP roster", () => {
    expect(ADMIN_PUBLISHED_OPERATION_COUNT).toBe(385);
    expect(ADMIN_MCP_PUBLISHED_TOOL_NAMES).toHaveLength(385);
    expect(new Set(ADMIN_MCP_PUBLISHED_TOOL_NAMES)).toHaveProperty("size", 385);
    expect(ADMIN_MCP_EXCLUDED_OPERATION_COUNT).toBe(11);
    expect(ADMIN_MCP_EXCLUDED_OPERATIONS).toHaveLength(11);
    expect(ADMIN_PUBLISHED_OPERATION_COUNT + ADMIN_MCP_EXCLUDED_OPERATION_COUNT).toBe(ADMIN_API_OPERATION_COUNT);
    expect(MCP_DEFAULT_STATIC_TOOL_COUNT).toBe(47);
    expect(MCP_DEFAULT_TOTAL_TOOL_COUNT).toBe(432);
    expect(MCP_DEFAULT_STATIC_TOOL_COUNT + ADMIN_PUBLISHED_OPERATION_COUNT).toBe(MCP_DEFAULT_TOTAL_TOOL_COUNT);
    expect(ADMIN_MCP_COVERAGE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(ADMIN_MCP_EXCLUSION_ROSTER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(ADMIN_MCP_EXCLUDED_OPERATIONS.map((operation) => operation.operationId)).toEqual([
      "admin.api-key.create",
      "admin.api-key.rotate",
      "admin.oauth-client.create",
      "admin.openapi.create-admin-auth-authorize-url",
      "admin.openapi.create-embed-key",
      "admin.openapi.get-admin-auth-logout-url",
      "admin.openapi.get-admin-auth-session",
      "admin.openapi.issue-admin-operator-bearer",
      "admin.openapi.logout-admin-auth-session",
      "admin.openapi.request-admin-auth-token",
      "admin.openapi.rotate-embed-key",
    ]);
    const publishedNames = new Set<string>(ADMIN_MCP_PUBLISHED_TOOL_NAMES);
    expect(ADMIN_MCP_EXCLUDED_OPERATIONS.every((operation) => !publishedNames.has(operation.toolName))).toBe(true);
    expect([...ADMIN_ONE_TIME_SECRET_OPERATION_IDS].sort()).toEqual(
      ADMIN_MCP_EXCLUDED_OPERATIONS.filter((operation) => operation.code === "one-time-secret-result")
        .map((operation) => operation.openApiOperationId)
        .sort(),
    );
    expect(ADMIN_MCP_CONTRACT_SERVER_SHA === null || /^[0-9a-f]{40}$/.test(ADMIN_MCP_CONTRACT_SERVER_SHA)).toBe(true);
    if (ADMIN_MCP_CONTRACT_SERVER_SHA === null) {
      expect(ADMIN_MCP_CONTRACT_STATUS).toBe("review-head-validated-awaiting-merged-trunk-pin");
      expect(ADMIN_MCP_CONTRACT_SERVER_SHA).toBeNull();
      expect(ADMIN_MCP_CONTRACT_REVIEW_SERVER_SHA).toBe("c810ef3df29269527d4eceb26151921c8c5d5eab");
    }
  });

  it("calls an operation with typed path parameters and admin-key precedence", async () => {
    let observed: { url: string; init?: RequestInit } | undefined;
    const client = new HonuaAdminClient({
      baseUrl: "https://example.test/",
      apiKey: "scoped-key",
      adminKey: "admin-key",
      fetchFn: async (input, init) => {
        observed = { url: String(input), init };
        return Response.json({ id: "conn-1", name: "local" });
      },
    });

    const result = await client.call("getConnection", {
      path: { id: "conn/1" },
    });

    expect(observed?.url).toBe("https://example.test/api/v1/admin/connections/conn%2F1");
    expect(new Headers(observed?.init?.headers).get("X-API-Key")).toBe("admin-key");
    expect(observed?.init?.redirect).toBe("manual");
    expect(result.data).toEqual({ id: "conn-1", name: "local" });
  });

  it("refuses credential-bearing endpoints outside HTTPS or exact loopback HTTP", () => {
    expect(() => new HonuaAdminClient({ baseUrl: "http://example.test" })).toThrow("requires HTTPS");
    expect(() => new HonuaAdminClient({ baseUrl: "http://user:pass@127.0.0.1" })).toThrow("must not include");
    expect(() => new HonuaAdminClient({ baseUrl: "https://example.test?credential=1" })).toThrow("must not include");
    expect(() => new HonuaAdminClient({ baseUrl: "https://example.test#credential" })).toThrow("must not include");
    expect(() => new HonuaAdminClient({ baseUrl: "http://127.0.0.1:8080" })).not.toThrow();
    expect(() => new HonuaAdminClient({ baseUrl: "http://[::1]:8080" })).not.toThrow();
  });

  it("does not let per-call headers override the configured admin credential", async () => {
    let observedKey: string | null = null;
    const client = new HonuaAdminClient({
      baseUrl: "https://example.test",
      apiKey: "scoped-key",
      adminKey: "admin-key",
      fetchFn: async (_input, init) => {
        observedKey = new Headers(init?.headers).get("X-API-Key");
        return Response.json({ data: [] });
      },
    });

    await client.call("listAdminApiKeys", { headers: { "X-API-Key": "per-call-key" } } as never);
    expect(observedKey).toBe("admin-key");
  });

  it("encodes typed query parameters", async () => {
    let url = "";
    const client = new HonuaAdminClient({
      baseUrl: "https://example.test",
      fetchFn: async (input) => {
        url = String(input);
        return Response.json({ data: [] });
      },
    });

    await client.call("listAlertRules", { query: { serviceId: "public maps", layerId: 2 } });
    expect(url).toBe("https://example.test/api/v1/admin/alerts/rules?serviceId=public+maps&layerId=2");
  });

  it("normalizes an adversarial trailing-slash base path in linear time", async () => {
    let url = "";
    const client = new HonuaAdminClient({
      baseUrl: "https://example.test",
      basePath: `/api/v1/admin${"/".repeat(200_000)}`,
      fetchFn: async (input) => {
        url = String(input);
        return Response.json({ data: [] });
      },
    });

    await client.call("listAlertRules", {});
    expect(url).toBe("https://example.test/api/v1/admin/alerts/rules");
  });

  it("serializes JSON request bodies and returns typed response data", async () => {
    let body: unknown;
    const client = new HonuaAdminClient({
      baseUrl: "https://example.test",
      fetchFn: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ data: { id: "key-1" } }, { status: 201 });
      },
    });

    const result = await client.call("createAdminApiKey", {
      body: { name: "automation", permissions: ["admin:read"] },
    });

    expect(body).toEqual({ name: "automation", permissions: ["admin:read"] });
    expect(result.response.status).toBe(201);
  });

  it("surfaces problem details without erasing the operation identity", async () => {
    const client = new HonuaAdminClient({
      baseUrl: "https://example.test",
      fetchFn: async () => Response.json({ title: "Forbidden", status: 403 }, { status: 403 }),
    });

    const error = await client.call("listAdminApiKeys", {}).catch((caught) => caught);

    expect(error).toBeInstanceOf(HonuaAdminApiError);
    expect(error).toMatchObject({ operationId: "listAdminApiKeys", statusCode: 403 });
    expect((error as HonuaAdminApiError).body).toEqual({ title: "Forbidden", status: 403 });
  });

  it("fails closed when a required path parameter is absent at runtime", async () => {
    const client = new HonuaAdminClient({ baseUrl: "https://example.test", fetchFn: async () => new Response() });
    await expect(client.call("getConnection", {} as never)).rejects.toThrow(/Missing required.*id/);
  });
});

it("enforces per-attempt timeouts with HonuaTimeoutError", async () => {
  const client = new HonuaAdminClient({
    baseUrl: "https://example.test",
    timeoutMs: 15,
    retry: { maxRetries: 0 },
    fetchFn: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortError = new Error("Aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      }),
  });
  await expect(client.call("listAdminApiKeys", {})).rejects.toMatchObject({ name: "HonuaTimeoutError" });
});

it("retries transient GET 429 honoring Retry-After and stops on Honua-Retryable: false 503", async () => {
  let calls = 0;
  const retryClient = new HonuaAdminClient({
    baseUrl: "https://example.test",
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ title: "Too Many Requests" }, { status: 429, headers: { "Retry-After": "0" } });
      }
      return Response.json({ data: [] });
    },
  });
  await retryClient.call("listAdminApiKeys", {});
  expect(calls).toBe(2);

  let nonRetryableCalls = 0;
  const nonRetryableClient = new HonuaAdminClient({
    baseUrl: "https://example.test",
    retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
    fetchFn: async () => {
      nonRetryableCalls += 1;
      return Response.json(
        { code: "CAPABILITY_UNAVAILABLE", detail: "PostGIS-only" },
        { status: 503, headers: { "Honua-Retryable": "false" } },
      );
    },
  });
  await expect(nonRetryableClient.call("listAdminApiKeys", {})).rejects.toBeInstanceOf(HonuaAdminApiError);
  expect(nonRetryableCalls).toBe(1);
});

it("enforces bearerToken against per-call overrides and refreshes pluggable OIDC auth on 401", async () => {
  let observedAuth: string | null = null;
  const bearerClient = new HonuaAdminClient({
    baseUrl: "https://example.test",
    bearerToken: "operator-jwt",
    fetchFn: async (_input, init) => {
      observedAuth = new Headers(init?.headers).get("authorization");
      return Response.json({ data: [] });
    },
  });
  await bearerClient.call("listAdminApiKeys", { headers: { authorization: "Bearer spoofed" } } as never);
  expect(observedAuth).toBe("Bearer operator-jwt");

  let authCalls = 0;
  const seenHeaders: (string | null)[] = [];
  const oidcClient = new HonuaAdminClient({
    baseUrl: "https://example.test",
    retry: { maxRetries: 0 },
    auth: {
      async getCredentials(context) {
        return { bearerToken: context.forceRefresh ? "refreshed-oidc" : "expired-oidc" };
      },
    },
    fetchFn: async (_input, init) => {
      authCalls += 1;
      seenHeaders.push(new Headers(init?.headers).get("authorization"));
      return authCalls === 1
        ? Response.json({ title: "Unauthorized" }, { status: 401 })
        : Response.json({ data: [] }, { status: 200 });
    },
  });
  await oidcClient.call("listAdminApiKeys", {});
  expect(seenHeaders).toEqual(["Bearer expired-oidc", "Bearer refreshed-oidc"]);
});

function stalledJsonResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":'));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

it("aborts a stalled response body when timeoutMs expires", async () => {
  const client = new HonuaAdminClient({
    baseUrl: "https://example.test",
    timeoutMs: 25,
    retry: { maxRetries: 0 },
    fetchFn: async () => stalledJsonResponse(),
  });
  await expect(client.call("listAdminApiKeys", {})).rejects.toMatchObject({ name: "HonuaTimeoutError" });
});

it("aborts a stalled response body when the caller signal is aborted", async () => {
  const controller = new AbortController();
  const client = new HonuaAdminClient({
    baseUrl: "https://example.test",
    timeoutMs: 5_000,
    retry: { maxRetries: 0 },
    fetchFn: async () => {
      queueMicrotask(() => controller.abort());
      return stalledJsonResponse();
    },
  });
  await expect(client.call("listAdminApiKeys", { signal: controller.signal })).rejects.toMatchObject({
    name: "HonuaAbortError",
  });
});
