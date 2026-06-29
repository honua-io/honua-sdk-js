import { afterEach, describe, expect, it, vi } from "vitest";

import { esriRequest } from "../src/esri-compat-entry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("esriRequest compat", () => {
  it("executes JSON requests with query params", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await esriRequest("https://example.test/rest/services/demo", {
      query: {
        f: "json",
        where: "1=1",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = (fetchMock.mock.calls as unknown[][])[0]?.[0];
    expect(String(calledUrl)).toContain("f=json");
    expect(result.data).toEqual({ ok: true });
    expect(result.status).toBe(200);
  });

  it("supports text response type", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await esriRequest<string>("https://example.test/ping", {
      responseType: "text",
    });

    expect(result.data).toBe("ok");
  });

  it("follows a same-origin redirect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://example.test/final" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await esriRequest("https://example.test/start");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual({ ok: true });
    // Manual redirect mode is used so cross-origin hops cannot replay creds.
    expect((fetchMock.mock.calls as unknown[][])[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses to follow a cross-origin redirect so auth headers are never replayed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(esriRequest("https://example.test/start", { headers: { "X-API-Key": "secret-key" } })).rejects.toThrow(
      /cross-origin/i,
    );
    // The credentialed request is never replayed to the attacker origin.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports relative URLs when query params are provided", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await esriRequest("/rest/services/demo/FeatureServer/0/query", {
      query: {
        f: "json",
        where: "1=1",
      },
    });

    const calledUrl = String((fetchMock.mock.calls as unknown[][])[0]?.[0]);
    expect(calledUrl.startsWith("/rest/services/demo/FeatureServer/0/query?")).toBe(true);
    expect(calledUrl).toContain("f=json");
    expect(calledUrl).toContain("where=1%3D1");
  });
});
