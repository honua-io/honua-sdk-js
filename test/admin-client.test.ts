import { describe, expect, it } from "vitest";

import {
  ADMIN_API_OPERATION_COUNT,
  ADMIN_API_SERVER_SHA,
  ADMIN_OPERATIONS,
  HonuaAdminApiError,
  HonuaAdminClient,
} from "../src/control-plane/index.js";

describe("generated admin REST client", () => {
  it("keeps the complete 396-operation inventory pinned to a server commit", () => {
    expect(Object.keys(ADMIN_OPERATIONS)).toHaveLength(396);
    expect(ADMIN_API_OPERATION_COUNT).toBe(396);
    expect(ADMIN_API_SERVER_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(ADMIN_OPERATIONS.createConnection).toMatchObject({ method: "POST", path: "/connections" });
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
