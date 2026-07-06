import { describe, expect, it, vi } from "vitest";

import { InMemoryCredentialStore, bearerTokenAuth, oauth2 } from "../src/core/auth/index.js";
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
