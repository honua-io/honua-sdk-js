import { describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import type { HonuaClientOptions } from "../src/core/types.js";

const query = {
  serviceId: "Flights",
  layerId: 0,
  where: `name = '${"helicopter".repeat(300)}'`,
  geometry: {
    rings: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [0, 0],
      ],
    ],
  },
  geometryType: "esriGeometryPolygon" as const,
  outFields: ["objectid", "name"],
  returnGeometry: false,
  outSr: 4326,
  resultOffset: 10,
  resultRecordCount: 20,
};
const result = { features: [{ attributes: { objectid: 7, name: "Selected aircraft" } }] };
const retry = { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 };

function makeClient(options: Partial<HonuaClientOptions>) {
  return new HonuaClient({ baseUrl: "https://mock.honua.test", retry, ...options });
}

describe.each(["queryFeatures", "queryMapLayer"] as const)("%s automatic POST replay", (method) => {
  it.each(["503", "network"])("retries a read after %s without changing constraints", async (failure) => {
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      bodies.push(String(init?.body));
      if (bodies.length === 1) {
        if (failure === "network") throw new TypeError("fetch failed");
        return new Response("Unavailable", { status: 503 });
      }
      return Response.json(result);
    });
    expect(await makeClient({ fetchFn })[method](query)).toEqual(result);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    const params = new URLSearchParams(bodies[1]);
    expect(params.get("where")).toBe(query.where);
    expect(JSON.parse(params.get("geometry")!)).toEqual(query.geometry);
    expect(params.get("resultOffset")).toBe("10");
    expect(params.get("resultRecordCount")).toBe("20");
  });

  it.each([401, 403])("refreshes credentials once after %s with transient retries disabled", async (status) => {
    const auth = vi.fn(({ forceRefresh }: { forceRefresh: boolean }) => ({
      bearerToken: forceRefresh ? "fresh-token" : "old-token",
    }));
    const bodies: string[] = [];
    const credentials: (string | null)[] = [];
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      credentials.push(new Headers(init?.headers).get("authorization"));
      return bodies.length === 1 ? new Response("Unauthorized", { status }) : Response.json(result);
    });
    expect(await makeClient({ auth, fetchFn, retry: { maxRetries: 0 } })[method](query)).toEqual(result);
    expect(credentials).toEqual(["Bearer old-token", "Bearer fresh-token"]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(auth).toHaveBeenCalledTimes(2);
    expect(auth).toHaveBeenLastCalledWith(expect.objectContaining({ reason: "unauthorized", forceRefresh: true }));
  });

  it.each([301, 302, 303])("refuses a %s redirect that would drop query constraints", async (status) => {
    const fetchFn = vi.fn(async () => new Response(null, { status, headers: { location: "/unfiltered" } }));
    await expect(makeClient({ fetchFn })[method](query)).rejects.toMatchObject({ statusCode: status });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([307, 308])("preserves the complete POST body across a same-origin %s", async (status) => {
    const requests: { url: string; body: string; method?: string; key: string | null }[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: String(init?.body),
        method: init?.method,
        key: new Headers(init?.headers).get("x-api-key"),
      });
      return requests.length === 1
        ? new Response(null, { status, headers: { location: "/redirected-query" } })
        : Response.json(result);
    });
    expect(await makeClient({ fetchFn, apiKey: "test-key" })[method](query)).toEqual(result);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ ...requests[0], url: "https://mock.honua.test/redirected-query" });
    expect(requests[1]!.method).toBe("POST");
    expect(requests[1]!.key).toBe("test-key");
  });

  it("never sends query credentials to a cross-origin redirect", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: "https://other.test/query" } }),
    );
    await expect(
      makeClient({ fetchFn, apiKey: "test-key", retry: { maxRetries: 0 } })[method](query),
    ).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry after caller cancellation", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      return new Response("Unavailable", { status: 503 });
    });
    await expect(makeClient({ fetchFn })[method]({ ...query, signal: controller.signal })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([401, 503])("keeps explicit POST replay opt-out on %s", async (status) => {
    const auth = vi.fn(() => ({ bearerToken: "old-token" }));
    const fetchFn = vi.fn(async () => new Response("Failure", { status }));
    await expect(makeClient({ fetchFn, auth })[method]({ ...query, method: "POST" })).rejects.toMatchObject({
      statusCode: status,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it.each(["https://mock.honua.test/honua", "/honua", "/東京"])(
    "uses the encoded deployment path at the exact URL budget: %s",
    async (baseUrl) => {
      const requests: { url: URL; method?: string; body: string }[] = [];
      const client = makeClient({
        baseUrl,
        fetchFn: async (input, init) => {
          const url = new URL(String(input), "https://app.test");
          requests.push({ url, method: init?.method, body: String(init?.body ?? "") });
          return url.pathname.length + url.search.length > 2000
            ? new Response("Too large", { status: 431 })
            : Response.json(result);
        },
      });
      const baseQuery = { serviceId: "Flights", layerId: 0, where: "x" };
      await client[method](baseQuery);
      const initial = requests[0]!.url;
      const where = "x".repeat(1 + 2000 - initial.pathname.length - initial.search.length);
      await client[method]({ ...baseQuery, where });
      await client[method]({ ...baseQuery, where: `${where}x` });
      expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "POST"]);
      expect(requests[1]!.url.pathname.length + requests[1]!.url.search.length).toBe(2000);
      expect(new URLSearchParams(requests[2]!.body).get("where")).toBe(`${where}x`);
    },
  );
});

it.each([401, 503])("does not make an applyEdits mutation replayable on %s", async (status) => {
  const auth = vi.fn(() => ({ bearerToken: "old-token" }));
  const fetchFn = vi.fn(async () => new Response("Failure", { status }));
  await expect(
    makeClient({ fetchFn, auth }).applyEdits({
      serviceId: "Flights",
      layerId: 0,
      adds: [{ attributes: { name: "New" } }],
    }),
  ).rejects.toMatchObject({ statusCode: status });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(auth).toHaveBeenCalledTimes(1);
});
