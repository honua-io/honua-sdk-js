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
    expect(result.data).toEqual({ id: "conn-1", name: "local" });
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
