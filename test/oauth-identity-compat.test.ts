import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryCredentialStore, oauth2 } from "../src/core/auth/index.js";
import { identityManager } from "../src/esri-compat-entry.js";
import { OAuthInfoCompat } from "../src/esri-compat-entry.js";

afterEach(() => {
  identityManager.reset();
});

describe("OAuth/Identity compat", () => {
  it("stores OAuth info entries with lifecycle/watch behavior", async () => {
    const info = new OAuthInfoCompat({
      appId: "app-123",
      portalUrl: "https://portal.example.test",
      popup: true,
      expiration: 90,
    });
    const loadStatusValues: unknown[] = [];
    const loadedValues: unknown[] = [];
    const appIdValues: unknown[] = [];
    const loadStatusHandle = info.watch("loadStatus", (value) => {
      loadStatusValues.push(value);
    });
    const loadedHandle = info.watch("loaded", (value) => {
      loadedValues.push(value);
    });
    const appIdHandle = info.watch("appId", (value) => {
      appIdValues.push(value);
    });

    let callbackInfo: OAuthInfoCompat | undefined;
    const resolved = await info.when((readyInfo) => {
      callbackInfo = readyInfo;
    });
    info.update({ appId: "app-124" });

    loadStatusHandle.remove();
    loadedHandle.remove();
    appIdHandle.remove();
    const watchSnapshot = {
      loadStatus: loadStatusValues.length,
      loaded: loadedValues.length,
      appId: appIdValues.length,
    };

    await info.load();
    info.update({ appId: "app-125" });

    identityManager.registerOAuthInfos([info]);
    const stored = identityManager.oauthInfos;

    expect(resolved).toBe(info);
    expect(callbackInfo).toBe(info);
    expect(info.loaded).toBe(true);
    expect(info.loadStatus).toBe("loaded");
    expect(loadStatusValues).toEqual(["loading", "loaded"]);
    expect(loadedValues).toEqual([true]);
    expect(appIdValues).toEqual(["app-124"]);
    expect(loadStatusValues).toHaveLength(watchSnapshot.loadStatus);
    expect(loadedValues).toHaveLength(watchSnapshot.loaded);
    expect(appIdValues).toHaveLength(watchSnapshot.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.appId).toBe("app-125");
    expect(stored[0]?.portalUrl).toBe("https://portal.example.test");
  });

  it("registers and resolves credentials by server", async () => {
    identityManager.registerToken({
      server: "https://portal.example.test/sharing",
      token: "token-abc",
      userId: "user-1",
    });

    const credential = await identityManager.checkSignInStatus("https://portal.example.test/sharing/rest");

    expect(credential.token).toBe("token-abc");
    expect(credential.userId).toBe("user-1");
  });

  it("replaces credentials when the server URL matches after normalization", async () => {
    identityManager.registerToken({
      server: "https://portal.example.test/sharing",
      token: "token-old",
    });
    identityManager.registerToken({
      server: "https://portal.example.test/sharing/",
      token: "token-new",
    });

    const credential = await identityManager.checkSignInStatus("https://portal.example.test/sharing/rest");

    expect(credential.token).toBe("token-new");
    expect(identityManager.credentials).toHaveLength(1);
  });

  it("rejects expired credentials", async () => {
    identityManager.registerToken({
      server: "https://portal.example.test/sharing",
      token: "expired-token",
      expires: Date.now() - 1_000,
    });

    await expect(identityManager.checkSignInStatus("https://portal.example.test/sharing/rest")).rejects.toThrow(
      "expired",
    );
    expect(identityManager.findCredential("https://portal.example.test/sharing/rest")).toBeUndefined();
  });

  it("clears state on reset", () => {
    identityManager.registerOAuthInfos([{ appId: "app-1" }]);
    identityManager.registerToken({
      server: "https://portal.example.test/sharing",
      token: "token-1",
    });

    identityManager.reset();

    expect(identityManager.oauthInfos).toEqual([]);
    expect(identityManager.credentials).toEqual([]);
  });
});

describe("OAuthInfoCompat.toOAuth2Config", () => {
  it("derives ArcGIS Portal endpoints from portalUrl and appId", () => {
    const info = new OAuthInfoCompat({ appId: "app-123", portalUrl: "https://portal.example.test", popup: true });
    const config = info.toOAuth2Config({ redirectUri: "https://app.example.test/callback", scopes: ["read"] });

    expect(config.authorizationEndpoint).toBe("https://portal.example.test/sharing/rest/oauth2/authorize");
    expect(config.tokenEndpoint).toBe("https://portal.example.test/sharing/rest/oauth2/token");
    expect(config.clientId).toBe("app-123");
    expect(config.redirectUri).toBe("https://app.example.test/callback");
    expect(config.mode).toBe("popup");
    expect(config.scopes).toEqual(["read"]);
  });

  it("throws when neither appId nor a clientId override is available", () => {
    const info = new OAuthInfoCompat({ portalUrl: "https://portal.example.test" });
    expect(() => info.toOAuth2Config({ redirectUri: "https://app.example.test/callback" })).toThrow(/appId/);
  });
});

describe("IdentityManager backed by the real OAuth2 engine", () => {
  it("drives the engine to obtain and register a credential on getCredential", async () => {
    const store = new InMemoryCredentialStore();
    // Seed a refreshable credential so the engine resolves silently (no browser).
    store.set("app-123@https://portal.example.test", {
      accessToken: "ignored-stale",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1_000,
    });
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "portal-access-1", token_type: "Bearer", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const info = new OAuthInfoCompat({ appId: "app-123", portalUrl: "https://portal.example.test" });
    identityManager.registerOAuthInfos([info]);
    identityManager.registerOAuth2Engine(
      info.portalUrl,
      oauth2({
        ...info.toOAuth2Config({ redirectUri: "https://app.example.test/callback" }),
        store,
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    );

    const credential = await identityManager.getCredential("https://portal.example.test/sharing/rest");

    expect(credential.token).toBe("portal-access-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The resolved token is registered so a subsequent lookup is served from the store.
    expect(identityManager.findCredential("https://portal.example.test/sharing/rest")?.token).toBe("portal-access-1");
  });

  it("runs interactive signIn() when the engine reports interaction_required", async () => {
    const engineCredentials = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("sign in"), { name: "HonuaAuthError", code: "interaction_required" }),
      )
      .mockResolvedValueOnce({ bearerToken: "after-signin", expiresAt: Date.now() + 3_600_000 });
    const signIn = vi.fn().mockResolvedValue(undefined);

    identityManager.registerOAuth2Engine("https://portal.example.test", {
      getCredentials: engineCredentials,
      signIn,
    });

    const credential = await identityManager.getCredential("https://portal.example.test/sharing/rest");

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(engineCredentials).toHaveBeenCalledTimes(2);
    expect(credential.token).toBe("after-signin");
  });
});
