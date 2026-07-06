import { describe, expect, it, vi } from "vitest";

import { InMemoryCredentialStore, clientCredentials } from "../src/core/auth/index.js";

const TOKEN_ENDPOINT = "https://idp.example.test/token";

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ access_token: "cc-access-1", token_type: "Bearer", expires_in: 3600, ...overrides }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("clientCredentials provider", () => {
  it("requests a client_credentials grant and caches the token", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("svc-client");
      expect(body.get("client_secret")).toBe("s3cr3t");
      expect(body.get("scope")).toBe("honua.read");
      return tokenResponse();
    });
    const provider = clientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "svc-client",
      clientSecret: "s3cr3t",
      scopes: ["honua.read"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const first = await provider.getCredentials({ reason: "initial", forceRefresh: false });
    expect(first).toMatchObject({ bearerToken: "cc-access-1", expiresAt: expect.any(Number) });

    // Second call within the token lifetime reuses the cached token.
    await provider.getCredentials({ reason: "manual", forceRefresh: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent token requests into one endpoint call", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn(async () => {
      calls += 1;
      await gate;
      return tokenResponse();
    });
    const provider = clientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "svc-client",
      clientSecret: "s3cr3t",
      store: new InMemoryCredentialStore(),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const inFlight = Array.from({ length: 8 }, () =>
      provider.getCredentials({ reason: "initial", forceRefresh: false }),
    );
    await Promise.resolve();
    release?.();
    await Promise.all(inFlight);

    expect(calls).toBe(1);
  });

  it("re-requests a token after forceRefresh", async () => {
    const fetchFn = vi.fn(async () => tokenResponse({ access_token: `cc-${fetchFn.mock.calls.length}` }));
    const provider = clientCredentials({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "svc-client",
      clientSecret: "s3cr3t",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await provider.getCredentials({ reason: "initial", forceRefresh: false });
    const refreshed = await provider.getCredentials({ reason: "unauthorized", forceRefresh: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(refreshed).toMatchObject({ bearerToken: "cc-2" });
  });
});
