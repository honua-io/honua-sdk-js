import { afterEach, describe, expect, it } from "vitest";

import { clientConfig, getClientConfigHonuaInterceptors, resetClientConfig } from "../src/client-compat-entry.js";

afterEach(() => {
  resetClientConfig();
});

describe("clientConfig compat", () => {
  it("stores common request/auth settings", () => {
    clientConfig.apiKey = "demo-key";
    clientConfig.portalUrl = "https://portal.example.test";
    clientConfig.request.timeout = 10_000;
    clientConfig.request.useIdentity = false;
    clientConfig.request.trustedServers.push("portal.example.test");

    expect(clientConfig.apiKey).toBe("demo-key");
    expect(clientConfig.portalUrl).toBe("https://portal.example.test");
    expect(clientConfig.request.timeout).toBe(10_000);
    expect(clientConfig.request.useIdentity).toBe(false);
    expect(clientConfig.request.trustedServers).toEqual(["portal.example.test"]);
  });

  it("converts request interceptors to Honua interceptors", () => {
    clientConfig.request.interceptors.push({
      urls: "services/parcels",
      before(params) {
        params.requestOptions.headers = {
          ...(params.requestOptions.headers ?? {}),
          Authorization: "Bearer token",
        };
      },
    });

    const honuaInterceptors = getClientConfigHonuaInterceptors();
    expect(honuaInterceptors).toHaveLength(1);
    expect(honuaInterceptors[0]?.before).toBeTypeOf("function");
  });

  it("resets mutable config state", () => {
    clientConfig.apiKey = "changed";
    clientConfig.request.interceptors.push({});
    clientConfig.request.trustedServers.push("changed");

    resetClientConfig();

    expect(clientConfig.apiKey).toBeUndefined();
    expect(clientConfig.portalUrl).toBe("https://www.arcgis.com");
    expect(clientConfig.request.interceptors).toEqual([]);
    expect(clientConfig.request.trustedServers).toEqual([]);
  });
});
