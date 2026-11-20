import { describe, expect, it, vi } from "vitest";

import { DatasetImportTaskClient } from "../src/control-plane/dataset-import/client.js";
import { HonuaAdminClient } from "../src/control-plane/index.js";
import { clientCredentials, oauth2 } from "../src/core/auth/index.js";
import { requestToken } from "../src/core/auth/token-endpoint.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaNetworkError } from "../src/core/errors.js";
import { encodePathSegment, encodePathSegments, encodeServiceIdPath } from "../src/core/path-utils.js";
import { HonuaGeocodingClient } from "../src/geocoding/index.js";

describe("SDK review fixes — path traversal helpers", () => {
  it("rejects dot segments in encodePathSegment, encodeServiceIdPath, and encodePathSegments", () => {
    for (const bad of [".", ".."]) {
      expect(() => encodePathSegment(bad)).toThrow(/path traversal/i);
      expect(() => encodeServiceIdPath(bad)).toThrow(/path traversal|must not contain "\." or "\.\." path segments/i);
      expect(() => encodePathSegments(bad)).toThrow(/path traversal/i);
    }
    for (const nested of ["folder/../secret", "a/./b", "/../escape", "a/b/.."]) {
      expect(() => encodeServiceIdPath(nested)).toThrow(
        /path traversal|must not contain "\." or "\.\." path segments/i,
      );
      expect(() => encodePathSegments(nested)).toThrow(/path traversal/i);
    }
    expect(encodePathSegment("v1.0")).toBe("v1.0");
    expect(encodePathSegment(".hidden")).toBe(".hidden");
    expect(encodePathSegment("...")).toBe("...");
    expect(encodeServiceIdPath("folder.v1/my.service")).toBe("folder.v1/my.service");
    expect(encodePathSegments("/a//b/")).toBe("/a//b/");
  });
});

describe("SDK review fixes — admin path traversal & protocol-relative URLs", () => {
  it("rejects dot-segment path parameters in HonuaAdminClient", async () => {
    const fetchFn = vi.fn(async () => Response.json({}));
    const client = new HonuaAdminClient({
      baseUrl: "https://admin.example.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(client.call("getConnection", { path: { id: ".." } })).rejects.toThrow(/path traversal/i);
    await expect(client.call("getConnection", { path: { id: "." } })).rejects.toThrow(/path traversal/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects protocol-relative URLs when HonuaClient baseUrl is empty", async () => {
    const fetchFn = vi.fn(async () => Response.json({}));
    const client = new HonuaClient({
      baseUrl: "",
      fetchFn: fetchFn as unknown as typeof fetch,
      interceptors: [{ before: ({ url }) => (url.endsWith("/mutate") ? { url: "//evil.example/steal" } : undefined) }],
    });
    await expect(client.request({ path: "//evil.example/steal" })).rejects.toThrow(/Protocol-relative/i);
    await expect(client.request({ path: "/\\evil.example/steal" })).rejects.toThrow(/Protocol-relative/i);
    await expect(client.request({ path: "/rest/mutate" })).rejects.toThrow(/Protocol-relative/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("SDK review fixes — admin fetch binding", () => {
  it("binds default globalThis.fetch in HonuaAdminClient so strict browser receivers succeed", async () => {
    const realFetch = globalThis.fetch;
    const strictFetch = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(Response.json({ data: [] }));
    };
    globalThis.fetch = strictFetch as unknown as typeof fetch;
    try {
      const client = new HonuaAdminClient({ baseUrl: "https://admin.example.test" });
      const result = await client.call("listAdminApiKeys", {});
      expect(result.data).toEqual({ data: [] });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("SDK review fixes — admin cross-origin redirect protection", () => {
  it("refuses cross-origin redirects in HonuaAdminClient without leaking credentials", async () => {
    const seenOrigins: string[] = [];
    const client = new HonuaAdminClient({
      baseUrl: "https://admin.example.test",
      adminKey: "top-secret-admin-key",
      headers: { Authorization: "Bearer top-secret-token" },
      fetchFn: async (input, init) => {
        seenOrigins.push(new URL(String(input)).origin);
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
      },
    });
    await expect(client.call("listAdminApiKeys", {})).rejects.toThrow(HonuaNetworkError);
    expect(seenOrigins).toEqual(["https://admin.example.test"]);
  });
});

describe("SDK review fixes — admin same-origin redirects", () => {
  it("follows same-origin redirects in HonuaAdminClient", async () => {
    const seenUrls: string[] = [];
    const client = new HonuaAdminClient({
      baseUrl: "https://admin.example.test",
      adminKey: "admin-key",
      fetchFn: async (input) => {
        seenUrls.push(String(input));
        if (seenUrls.length === 1) {
          return new Response(null, { status: 307, headers: { location: "/api/v1/admin/api-keys?redirected=1" } });
        }
        return Response.json({ data: [{ id: "k1" }] });
      },
    });
    const result = await client.call("listAdminApiKeys", {});
    expect(seenUrls).toEqual([
      "https://admin.example.test/api/v1/admin/api-keys",
      "https://admin.example.test/api/v1/admin/api-keys?redirected=1",
    ]);
    expect(result.data).toEqual({ data: [{ id: "k1" }] });
  });
});

describe("SDK review fixes — gRPC-web redirect protection", () => {
  it("routes gRPC-web connectTransportOptions fetch through fetchWithSafeRedirects", async () => {
    const seenOrigins: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://grpc.example.test",
      transport: "grpc-web",
      apiKey: "grpc-secret",
      fetchFn: async (input, init) => {
        seenOrigins.push(new URL(String(input)).origin);
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 307, headers: { location: "https://attacker.example/grpc-steal" } });
      },
    });
    const transportOpts = (
      client as unknown as { connectTransportOptions(): { fetch: typeof fetch } }
    ).connectTransportOptions();
    await expect(
      transportOpts.fetch("https://grpc.example.test/geospatial.v1.FeatureService/QueryFeatures", {
        method: "POST",
        headers: { "X-API-Key": "grpc-secret" },
        body: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(/Cross-origin/i);
    expect(seenOrigins).toEqual(["https://grpc.example.test"]);
  });
});

describe("SDK review fixes — geocoding & OAuth2 credential transport security", () => {
  it("enforces assertSecureCredentialedBaseUrl in HonuaGeocodingClient", () => {
    expect(() => new HonuaGeocodingClient({ baseUrl: "http://geo.example.test", apiKey: "k" })).toThrow(
      /refuses to send credentials/,
    );
    expect(() => new HonuaGeocodingClient({ baseUrl: "http://geo.example.test", bearerToken: "t" })).toThrow(
      /refuses to send credentials/,
    );
    expect(() => new HonuaGeocodingClient({ baseUrl: "http://geo.example.test" })).not.toThrow();
    expect(() => new HonuaGeocodingClient({ baseUrl: "http://localhost:8080", apiKey: "k" })).not.toThrow();
    expect(
      () => new HonuaGeocodingClient({ baseUrl: "http://geo.example.test", apiKey: "k", allowInsecureHttp: true }),
    ).not.toThrow();
  });

  it("enforces assertSecureCredentialedBaseUrl in OAuth2 token endpoint and auth providers", async () => {
    const fetchFn = vi.fn(async () => Response.json({ access_token: "tok" })) as unknown as typeof fetch;
    const tokenParams = { grant_type: "client_credentials", client_id: "c", client_secret: "s" };
    await expect(
      requestToken({ fetchFn, tokenEndpoint: "http://idp.example.test/token", params: tokenParams }),
    ).rejects.toThrow(/refuses to send credentials/);
    expect(() =>
      clientCredentials({ tokenEndpoint: "http://idp.example.test/token", clientId: "c", clientSecret: "s", fetchFn }),
    ).toThrow(/refuses to send credentials/);
    expect(() =>
      oauth2({
        authorizationEndpoint: "https://idp.example.test/authorize",
        tokenEndpoint: "http://idp.example.test/token",
        clientId: "c",
        redirectUri: "https://app.example.test/cb",
        fetchFn,
      }),
    ).toThrow(/refuses to send credentials/);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(
      requestToken({ fetchFn, tokenEndpoint: "http://127.0.0.1:8080/token", params: tokenParams }),
    ).resolves.toMatchObject({ accessToken: "tok" });
  });
});

describe("SDK review fixes — dataset import credential transport security", () => {
  it("enforces assertSecureCredentialedBaseUrl in DatasetImportWorkspaceTransport when headers are configured", () => {
    const headers = () => ({ Authorization: "Bearer secret" });
    expect(
      () => new DatasetImportTaskClient({ baseUrl: "http://import.example.test", workspaceId: "w", targetId: "t", headers }),
    ).toThrow(/refuses to send credentials/);
    expect(
      () => new DatasetImportTaskClient({ baseUrl: "http://localhost:5000", workspaceId: "w", targetId: "t", headers }),
    ).not.toThrow();
    expect(
      () => new DatasetImportTaskClient({ baseUrl: "http://import.example.test", workspaceId: "w", targetId: "t" }),
    ).not.toThrow();
    expect(
      () =>
        new DatasetImportTaskClient({
          baseUrl: "http://import.example.test",
          workspaceId: "w",
          targetId: "t",
          headers,
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
  });
});
