import { describe, expect, it, vi } from "vitest";

import {
  type HonuaAuthEvent,
  InMemoryCredentialStore,
  type OAuth2Config,
  type StoredCredential,
  oauth2,
} from "../src/core/auth/index.js";
import { HonuaAuthError } from "../src/index.js";

const AUTHORIZATION_ENDPOINT = "https://idp.example.test/authorize";
const TOKEN_ENDPOINT = "https://idp.example.test/token";
const REDIRECT_URI = "https://app.example.test/callback";

interface FakeLocation {
  href: string;
  assign: (url: string) => void;
}

/** Minimal `window` double good enough for the provider's redirect/session use. */
function fakeWindow(initialHref = REDIRECT_URI): {
  window: Window;
  location: FakeLocation;
  storage: Map<string, string>;
} {
  const storage = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const location: FakeLocation = {
    href: initialHref,
    assign(url: string) {
      this.href = url;
    },
  };
  const win = { location, sessionStorage } as unknown as Window;
  return { window: win, location, storage };
}

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

/**
 * Kick off a redirect-mode sign-in. In redirect mode `signIn()` intentionally
 * never resolves (the page unloads), so we must NOT await it; instead we wait
 * for the redirect to be issued and return the generated `state`.
 */
async function beginRedirectSignIn(provider: ReturnType<typeof oauth2>, location: FakeLocation): Promise<string> {
  void provider.signIn();
  for (let i = 0; i < 100 && location.href === REDIRECT_URI; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new URL(location.href).searchParams.get("state") ?? "";
}

function baseConfig(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
  const { window } = fakeWindow();
  return {
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "app-1",
    redirectUri: REDIRECT_URI,
    scopes: ["openid", "profile"],
    windowRef: window,
    ...overrides,
  };
}

describe("oauth2 provider — authorization URL", () => {
  it("builds an S256 PKCE authorize URL with state and redirects", async () => {
    const { window, location, storage } = fakeWindow();
    const provider = oauth2(baseConfig({ windowRef: window }));

    await beginRedirectSignIn(provider, location);

    const authorizeUrl = new URL(location.href);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(AUTHORIZATION_ENDPOINT);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("app-1");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("scope")).toBe("openid profile");
    const challenge = authorizeUrl.searchParams.get("code_challenge");
    const state = authorizeUrl.searchParams.get("state");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url SHA-256, no padding
    expect(state).toBeTruthy();

    // The PKCE transaction (verifier + state) is stashed for the redirect leg.
    const txnKey = [...storage.keys()].find((key) => key.startsWith("honua.auth.txn:"));
    expect(txnKey).toBeTruthy();
    const txn = JSON.parse(storage.get(txnKey ?? "") ?? "{}");
    expect(txn.state).toBe(state);
    expect(txn.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("oauth2 provider — redirect callback code exchange", () => {
  it("validates state, exchanges the code with PKCE, and stores tokens", async () => {
    const { window, location } = fakeWindow();
    const events: HonuaAuthEvent[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("auth-code-1");
      expect(body.get("code_verifier")).toBeTruthy();
      expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
      return tokenResponse();
    });
    const provider = oauth2(
      baseConfig({ windowRef: window, fetchFn: fetchFn as unknown as typeof fetch, onEvent: (e) => events.push(e) }),
    );

    const state = await beginRedirectSignIn(provider, location);

    const credential = await provider.handleRedirectCallback(`${REDIRECT_URI}?code=auth-code-1&state=${state}`);

    expect(credential.accessToken).toBe("access-1");
    expect(credential.refreshToken).toBe("refresh-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toContain("signed-in");
    expect(await provider.isSignedIn()).toBe(true);

    const headers = await provider.getCredentials({ reason: "manual", forceRefresh: false });
    expect(headers).toEqual({ bearerToken: "access-1", expiresAt: expect.any(Number) });
  });

  it("rejects a callback whose state does not match (CSRF guard)", async () => {
    const { window, location } = fakeWindow();
    const provider = oauth2(baseConfig({ windowRef: window, fetchFn: (async () => tokenResponse()) as typeof fetch }));
    await beginRedirectSignIn(provider, location);

    await expect(
      provider.handleRedirectCallback(`${REDIRECT_URI}?code=auth-code-1&state=forged-state`),
    ).rejects.toMatchObject({ name: "HonuaAuthError", code: "invalid_grant" });
  });

  it("maps an authorization-server error response to invalid_grant", async () => {
    const { window, location } = fakeWindow();
    const provider = oauth2(baseConfig({ windowRef: window }));
    await beginRedirectSignIn(provider, location);

    await expect(
      provider.handleRedirectCallback(`${REDIRECT_URI}?error=access_denied&error_description=nope`),
    ).rejects.toMatchObject({ name: "HonuaAuthError", code: "invalid_grant" });
  });
});

describe("oauth2 provider — expiry and refresh", () => {
  function seededStore(overrides: Partial<StoredCredential> = {}): InMemoryCredentialStore {
    const store = new InMemoryCredentialStore();
    store.set("app-1@https://idp.example.test", {
      accessToken: "old-access",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAt: Date.now() - 1_000, // already expired
      ...overrides,
    });
    return store;
  }

  it("silently refreshes an expiring token with the refresh_token grant", async () => {
    const events: HonuaAuthEvent[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-1");
      return tokenResponse({ access_token: "access-2", refresh_token: "refresh-2" });
    });
    const provider = oauth2(
      baseConfig({
        store: seededStore(),
        fetchFn: fetchFn as unknown as typeof fetch,
        onEvent: (e) => events.push(e),
      }),
    );

    const credentials = await provider.getCredentials({ reason: "expired", forceRefresh: false });
    expect(credentials).toMatchObject({ bearerToken: "access-2" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toContain("token-refreshed");
  });

  it("is clock-skew tolerant: refreshes a token expiring within the skew window", async () => {
    const fetchFn = vi.fn(async () => tokenResponse({ access_token: "access-skew" }));
    const provider = oauth2(
      baseConfig({
        clockSkewMs: 120_000,
        store: seededStore({ expiresAt: Date.now() + 60_000 }), // valid for 60s, but < skew
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    );
    const credentials = await provider.getCredentials({ reason: "manual", forceRefresh: false });
    expect(credentials).toMatchObject({ bearerToken: "access-skew" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws interaction_required when the token is expired and there is no refresh token", async () => {
    const provider = oauth2(baseConfig({ store: seededStore({ refreshToken: undefined }) }));
    await expect(provider.getCredentials({ reason: "expired", forceRefresh: false })).rejects.toMatchObject({
      name: "HonuaAuthError",
      code: "interaction_required",
    });
  });

  it("throws interaction_required from a clean slate (no stored credential)", async () => {
    const provider = oauth2(baseConfig());
    await expect(provider.getCredentials()).rejects.toBeInstanceOf(HonuaAuthError);
  });

  it("maps an invalid_grant refresh failure to code invalid_grant and clears the credential", async () => {
    const events: HonuaAuthEvent[] = [];
    const store = seededStore();
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "expired" }), { status: 400 }),
    );
    const provider = oauth2(
      baseConfig({ store, fetchFn: fetchFn as unknown as typeof fetch, onEvent: (e) => events.push(e) }),
    );

    await expect(provider.getCredentials({ reason: "expired", forceRefresh: false })).rejects.toMatchObject({
      code: "invalid_grant",
    });
    expect(store.get("app-1@https://idp.example.test")).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["refresh-failed", "signed-out"]));
  });

  it("maps a transient token-endpoint failure to refresh_failed and keeps the credential", async () => {
    const store = seededStore();
    const fetchFn = vi.fn(async () => new Response("upstream down", { status: 503 }));
    const provider = oauth2(baseConfig({ store, fetchFn: fetchFn as unknown as typeof fetch }));

    await expect(provider.getCredentials({ reason: "expired", forceRefresh: false })).rejects.toMatchObject({
      code: "refresh_failed",
    });
    // Transient failure must not destroy the still-present refresh token.
    expect(store.get("app-1@https://idp.example.test")?.refreshToken).toBe("refresh-1");
  });
});

describe("oauth2 provider — single-flight refresh (REQ-002)", () => {
  it("collapses N concurrent refreshes into exactly one token-endpoint call", async () => {
    const CONCURRENCY = 12;
    let tokenCalls = 0;
    let releaseToken: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });

    const store = new InMemoryCredentialStore();
    store.set("app-1@https://idp.example.test", {
      accessToken: "old-access",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1_000,
    });

    const fetchFn = vi.fn(async () => {
      tokenCalls += 1;
      // Hold the round-trip open so all N callers pile up on the same refresh.
      await gate;
      return tokenResponse({ access_token: "access-shared", refresh_token: "refresh-shared" });
    });

    const provider = oauth2(baseConfig({ store, fetchFn: fetchFn as unknown as typeof fetch }));

    const inFlight = Array.from({ length: CONCURRENCY }, () =>
      provider.getCredentials({ reason: "expired", forceRefresh: false }),
    );
    // Let all N callers reach the single-flight guard before the token resolves.
    await Promise.resolve();
    releaseToken?.();

    const results = await Promise.all(inFlight);

    expect(tokenCalls).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toMatchObject({ bearerToken: "access-shared" });
    }

    // A later refresh (after the in-flight one settled) issues a fresh call.
    store.set("app-1@https://idp.example.test", {
      accessToken: "access-shared",
      refreshToken: "refresh-shared",
      expiresAt: Date.now() - 1_000,
    });
    await provider.getCredentials({ reason: "expired", forceRefresh: false });
    expect(tokenCalls).toBe(2);
  });
});

describe("oauth2 provider — sign-out", () => {
  it("clears the stored credential and emits signed-out", async () => {
    const events: HonuaAuthEvent[] = [];
    const store = new InMemoryCredentialStore();
    store.set("app-1@https://idp.example.test", { accessToken: "a", refreshToken: "r" });
    const provider = oauth2(baseConfig({ store, onEvent: (e) => events.push(e) }));

    await provider.signOut();

    expect(store.get("app-1@https://idp.example.test")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "signed-out" });
    expect(await provider.isSignedIn()).toBe(false);
  });
});
