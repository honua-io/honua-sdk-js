import { describe, expect, it, vi } from "vitest";

import { InMemoryCredentialStore, bearerTokenAuth, oauth2 } from "../src/core/auth/index.js";
import { mergeHeaders } from "../src/core/wire-shared.js";
import { HonuaClient } from "../src/index.js";

const TOKEN_ENDPOINT = "https://idp.example.test/token";
const SERVICE_KEY = "app-1@https://idp.example.test";

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: "access-1",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh-1",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function oauthClientHarness(store: InMemoryCredentialStore) {
  const tokenCalls: string[] = [];
  const apiCalls: HeadersInit[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(TOKEN_ENDPOINT)) {
      const body = new URLSearchParams(String(init?.body));
      tokenCalls.push(body.get("grant_type") ?? "");
      return tokenResponse({ access_token: `access-${tokenCalls.length + 1}` });
    }
    apiCalls.push(init?.headers ?? {});
    return new Response(JSON.stringify({ services: [] }), { status: 200 });
  });
  const auth = oauth2({
    authorizationEndpoint: "https://idp.example.test/authorize",
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "app-1",
    redirectUri: "https://app.example.test/callback",
    store,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  const client = new HonuaClient({
    baseUrl: "https://api.example.test",
    auth,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, auth, tokenCalls, apiCalls, fetchFn };
}

describe("HonuaClient + oauth2 provider (fetch transport)", () => {
  it("attaches the stored access token to REST requests", async () => {
    const store = new InMemoryCredentialStore();
    store.set(SERVICE_KEY, {
      accessToken: "seeded-access",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
    });
    const { client, apiCalls } = oauthClientHarness(store);

    await client.listServices();

    expect(apiCalls[0]).toMatchObject({ Authorization: "Bearer seeded-access" });
  });

  it("silently refreshes an expiring token before attaching it", async () => {
    const store = new InMemoryCredentialStore();
    store.set(SERVICE_KEY, { accessToken: "stale", refreshToken: "refresh-1", expiresAt: Date.now() - 1_000 });
    const { client, apiCalls, tokenCalls } = oauthClientHarness(store);

    await client.listServices();

    expect(tokenCalls).toEqual(["refresh_token"]);
    expect(apiCalls[0]).toMatchObject({ Authorization: "Bearer access-2" });
  });

  it("is single-flight across concurrent client requests (one token call for N requests)", async () => {
    const store = new InMemoryCredentialStore();
    store.set(SERVICE_KEY, { accessToken: "stale", refreshToken: "refresh-1", expiresAt: Date.now() - 1_000 });
    const { client, tokenCalls } = oauthClientHarness(store);

    await Promise.all([client.listServices(), client.listServices(), client.listServices(), client.listServices()]);

    expect(tokenCalls).toEqual(["refresh_token"]);
  });

  it("exposes fresh auth headers via getAuthHeaders() for realtime re-auth on reconnect", async () => {
    const store = new InMemoryCredentialStore();
    store.set(SERVICE_KEY, { accessToken: "stale", refreshToken: "refresh-1", expiresAt: Date.now() - 1_000 });
    const { client } = oauthClientHarness(store);

    // A realtime transport would call this on each (re)connect. It must return
    // the refreshed token, not the stale one captured at construction.
    const headers = await client.getAuthHeaders();
    expect(headers.Authorization).toBe("Bearer access-2");
    expect(await client.getAuthToken()).toBe("access-2");
  });
});

describe("cross-origin credential-leak guard extends to auth providers (REQ-003, issue #305)", () => {
  it("never replays a provider bearer token to a cross-origin redirect target", async () => {
    const calls: { origin: string; authorization: string | undefined; redirect: RequestRedirect | undefined }[] = [];
    const client = new HonuaClient({
      baseUrl: "https://api.example.test",
      auth: bearerTokenAuth("super-secret-bearer"),
      fetchFn: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
          origin: new URL(url).origin,
          authorization: headers.get("authorization") ?? undefined,
          redirect: init?.redirect,
        });
        if (new URL(url).origin === "https://api.example.test") {
          return new Response(null, { status: 302, headers: { location: "https://attacker.test/steal" } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await expect(client.request({ path: "/rest/services", method: "GET" })).rejects.toThrow(/cross-origin/i);

    expect(calls[0]?.redirect).toBe("manual");
    // The secret bearer token must never have reached the attacker origin.
    expect(calls.some((call) => call.origin === "https://attacker.test")).toBe(false);
    expect(calls.some((call) => call.origin === "https://attacker.test" && call.authorization !== undefined)).toBe(
      false,
    );
  });

  it("scopes oauth2 credentials per service key so a second service key sees no token", async () => {
    const store = new InMemoryCredentialStore();
    store.set("app-1@https://idp.example.test", { accessToken: "svc-a-token", expiresAt: Date.now() + 3_600_000 });

    // A provider configured for a *different* service key must not read svc-a's token.
    const otherProvider = oauth2({
      authorizationEndpoint: "https://other.example.test/authorize",
      tokenEndpoint: "https://other.example.test/token",
      clientId: "app-2",
      redirectUri: "https://app.example.test/callback",
      store,
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });

    await expect(otherProvider.getCredentials()).rejects.toMatchObject({ code: "interaction_required" });
  });
});

async function runMixedCaseAuthReplay(config: {
  readonly initialHeaders: HeadersInit;
  readonly headerName: string;
  readonly credentials: (forceRefresh: boolean) => { bearerToken?: string; apiKey?: string };
}): Promise<(string | null)[]> {
  let calls = 0;
  const observed: (string | null)[] = [];
  const client = new HonuaClient({
    baseUrl: "https://api.example.test",
    auth: {
      async getCredentials(options) {
        return config.credentials(options?.forceRefresh === true);
      },
    },
    fetchFn: async (_input, init) => {
      calls += 1;
      observed.push(new Headers(init?.headers).get(config.headerName));
      return calls === 1
        ? new Response(JSON.stringify({ detail: "expired" }), { status: 401 })
        : new Response(JSON.stringify({ services: [] }), { status: 200 });
    },
  });
  await client.request({ path: "/rest/services", method: "GET", headers: config.initialHeaders });
  return observed;
}

describe("mergeHeaders case-insensitive replacement", () => {
  it("overwrites earlier headers regardless of casing while keeping the latest key", () => {
    expect(mergeHeaders({ authorization: "Bearer expired" }, { Authorization: "Bearer fresh" })).toEqual({
      Authorization: "Bearer fresh",
    });
    expect(mergeHeaders(new Headers({ Authorization: "Bearer expired" }), { Authorization: "Bearer fresh" })).toEqual({
      Authorization: "Bearer fresh",
    });
    expect(mergeHeaders({ "x-api-key": "old-key" }, { "X-API-Key": "new-key" })).toEqual({
      "X-API-Key": "new-key",
    });
    expect(mergeHeaders([["X-API-Key", "old-key"]], { "x-api-key": "new-key" })).toEqual({
      "x-api-key": "new-key",
    });
  });
});

describe("401 replay replaces mixed-case auth headers cleanly", () => {
  it("replaces authorization without concatenating expired and fresh bearer tokens", async () => {
    const seen = await runMixedCaseAuthReplay({
      initialHeaders: new Headers({ Authorization: "Bearer expired-token" }),
      headerName: "authorization",
      credentials: (refresh) => ({ bearerToken: refresh ? "fresh-token" : "expired-token" }),
    });
    expect(seen).toEqual(["Bearer expired-token", "Bearer fresh-token"]);
  });

  it("replaces lowercase x-api-key cleanly on 401 replay", async () => {
    const seen = await runMixedCaseAuthReplay({
      initialHeaders: { "x-api-key": "expired-api-key" },
      headerName: "x-api-key",
      credentials: (refresh) => ({ apiKey: refresh ? "fresh-api-key" : "expired-api-key" }),
    });
    expect(seen).toEqual(["expired-api-key", "fresh-api-key"]);
  });
});

describe("GeoServices HTTP-200 error envelope resilience", () => {
  it.each([498, 499])("refreshes auth and replays on HTTP-200 GeoServices code %i", async (code) => {
    let calls = 0;
    const seenAuth: (string | null)[] = [];
    const client = new HonuaClient({
      baseUrl: "https://api.example.test",
      auth: {
        async getCredentials(options) {
          return { bearerToken: options?.forceRefresh ? "fresh-token" : "stale-token" };
        },
      },
      fetchFn: async (_input, init) => {
        calls += 1;
        seenAuth.push(new Headers(init?.headers).get("authorization"));
        if (calls === 1) {
          return Response.json({ error: { code, message: "Token expired" } }, { status: 200 });
        }
        return Response.json({ features: [{ attributes: { OBJECTID: 1 } }] }, { status: 200 });
      },
    });

    const result = await client.queryFeatures({ serviceId: "Parks", layerId: 0 });
    expect(calls).toBe(2);
    expect(seenAuth).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(result.features).toHaveLength(1);
  });

  it("retries HTTP-200 GeoServices 429 and 503 envelopes respecting Retry-After", async () => {
    let calls = 0;
    const client = new HonuaClient({
      baseUrl: "https://api.example.test",
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { error: { code: 429, message: "Too many requests" } },
            { status: 200, headers: { "Retry-After": "0" } },
          );
        }
        if (calls === 2) {
          return Response.json({ error: { code: 503, message: "Temporarily unavailable" } }, { status: 200 });
        }
        return Response.json({ features: [{ attributes: { OBJECTID: 7 } }] }, { status: 200 });
      },
    });

    const result = await client.queryFeatures({ serviceId: "Parks", layerId: 0 });
    expect(calls).toBe(3);
    expect(result.features).toHaveLength(1);
  });

  it("honors Honua-Retryable: true and false on HTTP-200 GeoServices error envelopes", async () => {
    let nonRetryableCalls = 0;
    const nonRetryableClient = new HonuaClient({
      baseUrl: "https://api.example.test",
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
      fetchFn: async () => {
        nonRetryableCalls += 1;
        return Response.json(
          { error: { code: 503, message: "Capability unavailable" } },
          { status: 200, headers: { "Honua-Retryable": "false" } },
        );
      },
    });
    await expect(nonRetryableClient.queryFeatures({ serviceId: "Parks", layerId: 0 })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(nonRetryableCalls).toBe(1);

    let explicitRetryCalls = 0;
    const explicitRetryClient = new HonuaClient({
      baseUrl: "https://api.example.test",
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
      fetchFn: async () => {
        explicitRetryCalls += 1;
        if (explicitRetryCalls === 1) {
          return Response.json(
            { error: { code: 500, message: "Transient backend fault" } },
            { status: 200, headers: { "Honua-Retryable": "true" } },
          );
        }
        return Response.json({ id: 0, name: "Parks" }, { status: 200 });
      },
    });
    const metadata = await explicitRetryClient.getLayerMetadata("Parks", 0);
    expect(explicitRetryCalls).toBe(2);
    expect(metadata.name).toBe("Parks");
  });
});
