import { describe, expect, it, vi } from "vitest";

import { apiKeyAuth } from "../src/core/auth/static-providers.js";
import { HonuaClient } from "../src/core/client.js";
import { isInsecureRemoteHttpUrl, isLoopbackHostname } from "../src/core/transport-security.js";

function jsonFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ services: [] }), { status: 200 })) as unknown as typeof fetch;
}

const INSECURE = /refuses to send credentials .* over plain HTTP to a non-loopback host/;

describe("HonuaClient credentialed plain-HTTP guard", () => {
  it("accepts https base URLs with every credential source", () => {
    expect(
      () =>
        new HonuaClient({
          baseUrl: "https://api.honua.example",
          apiKey: "k",
          bearerToken: "t",
          auth: () => "t",
        }),
    ).not.toThrow();
  });

  it.each([
    "http://localhost:8080",
    "http://LOCALHOST",
    "http://127.0.0.1:5000",
    "http://127.42.0.7",
    "http://[::1]:8080",
  ])("accepts loopback http base URL %s with credentials", (baseUrl) => {
    expect(() => new HonuaClient({ baseUrl, apiKey: "k", bearerToken: "t" })).not.toThrow();
  });

  it("rejects a non-loopback http base URL with an apiKey", () => {
    expect(() => new HonuaClient({ baseUrl: "http://api.honua.example", apiKey: "k" })).toThrow(INSECURE);
    expect(() => new HonuaClient({ baseUrl: "http://api.honua.example", apiKey: "k" })).toThrow(/apiKey/);
  });

  it("rejects a non-loopback http base URL with a bearerToken", () => {
    expect(() => new HonuaClient({ baseUrl: "http://10.0.0.5:8080", bearerToken: "t" })).toThrow(INSECURE);
    expect(() => new HonuaClient({ baseUrl: "http://10.0.0.5:8080", bearerToken: "t" })).toThrow(/bearerToken/);
  });

  it("rejects hosts that merely look like loopback", () => {
    for (const baseUrl of [
      "http://localhost.attacker.example",
      "http://127.0.0.1.attacker.example",
      "http://128.0.0.1",
    ]) {
      expect(() => new HonuaClient({ baseUrl, apiKey: "k" })).toThrow(INSECURE);
    }
  });

  it("refuses a credential provider at construction time, before any request or provider call", () => {
    const getCredentials = vi.fn(() => "t");
    const fetchFn = jsonFetch();
    expect(() => new HonuaClient({ baseUrl: "http://api.honua.example", auth: getCredentials, fetchFn })).toThrow(
      /\(auth\)/,
    );
    expect(() => new HonuaClient({ baseUrl: "http://api.honua.example", auth: apiKeyAuth("k"), fetchFn })).toThrow(
      INSECURE,
    );
    expect(getCredentials).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("allows credentials over non-loopback http when allowInsecureHttp is true", async () => {
    const fetchFn = jsonFetch();
    const client = new HonuaClient({
      baseUrl: "http://api.honua.example",
      apiKey: "k",
      bearerToken: "t",
      auth: () => "provider-token",
      allowInsecureHttp: true,
      fetchFn,
    });
    await client.listServices();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("allows a non-loopback http base URL when no credentials are configured", async () => {
    const fetchFn = jsonFetch();
    const client = new HonuaClient({ baseUrl: "http://api.honua.example", fetchFn });
    await client.listServices();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not judge relative base URLs (they inherit the embedding page origin)", () => {
    expect(() => new HonuaClient({ baseUrl: "/honua", apiKey: "k" })).not.toThrow();
  });
});

describe("transport-security helpers", () => {
  it("classifies loopback hostnames", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.255.255.255")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.0.0.256")).toBe(false);
    expect(isLoopbackHostname("127.0.0")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });

  it("classifies insecure remote http URLs", () => {
    expect(isInsecureRemoteHttpUrl("http://example.com")).toBe(true);
    expect(isInsecureRemoteHttpUrl("https://example.com")).toBe(false);
    expect(isInsecureRemoteHttpUrl("http://localhost:3000")).toBe(false);
    expect(isInsecureRemoteHttpUrl("/relative")).toBe(false);
  });
});
