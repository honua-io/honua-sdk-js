import { describe, expect, it } from "vitest";

import { createHonuaCacheState, isHonuaCacheStatus } from "@honua/sdk-js/honua";
import { HonuaClient } from "../src/index.js";

const layerFixture = {
  id: 0,
  name: "Service Requests",
  geometryType: "esriGeometryPoint",
  fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
};

describe("Honua cache state", () => {
  it("serializes public cache-state values", () => {
    const state = createHonuaCacheState({
      scope: "metadata",
      status: "hit",
      keyFingerprint: "metadata:fixture:layer:0",
      ageMs: 10.8,
      ttlMs: 300_000,
      validator: { etag: '"v1"' },
    });

    expect(JSON.parse(JSON.stringify(state))).toEqual({
      scope: "metadata",
      status: "hit",
      keyFingerprint: "metadata:fixture:layer:0",
      ageMs: 10,
      ttlMs: 300000,
      validator: { etag: '"v1"' },
    });
    expect(isHonuaCacheStatus("refreshed")).toBe(true);
    expect(isHonuaCacheStatus("loading")).toBe(false);
  });

  it("reports metadata cache miss, hit, refreshed, stale, and bypass states", async () => {
    const requestedHeaders: HeadersInit[] = [];
    let requestCount = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (_input, init) => {
        requestCount += 1;
        requestedHeaders.push(init?.headers ?? {});

        if (requestCount === 1) {
          return json(layerFixture, 200, { etag: '"v1"', "last-modified": "Tue, 05 May 2026 19:30:00 GMT" });
        }
        if (requestCount === 2) {
          expect(init?.headers).toMatchObject({ "If-None-Match": '"v1"' });
          return new Response(null, { status: 304, headers: { etag: '"v1"' } });
        }
        if (requestCount === 3) {
          return json({ error: { message: "upstream unavailable" } }, 503);
        }
        return json({ ...layerFixture, name: "Bypassed Layer" }, 200, { etag: '"v2"' });
      },
    });

    const miss = await client.getLayerMetadata("civic", 0);
    const hit = await client.getLayerMetadata("civic", 0);
    const refreshed = await client.getLayerMetadata("civic", 0, { refresh: true });
    const stale = await client.getLayerMetadata("civic", 0, { refresh: true });
    const bypass = await client.getLayerMetadata("civic", 0, { cache: "bypass" });
    const postBypassHit = await client.getLayerMetadata("civic", 0);

    expect(miss.cache?.status).toBe("miss");
    expect(hit.cache?.status).toBe("hit");
    expect(refreshed.cache?.status).toBe("refreshed");
    expect(stale.cache).toMatchObject({ status: "stale", refreshErrorId: "http-503" });
    expect(bypass.cache?.status).toBe("bypass");
    expect(bypass.name).toBe("Bypassed Layer");
    expect(postBypassHit.name).toBe("Service Requests");
    expect(postBypassHit.cache?.status).toBe("hit");
    expect(requestCount).toBe(4);
    expect(requestedHeaders[3]).toMatchObject({ "Cache-Control": "no-store", Pragma: "no-cache" });
  });

  it("revalidates cached metadata when the requested TTL has expired", async () => {
    let requestCount = 0;
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (_input, init) => {
        requestCount += 1;
        if (requestCount === 1) {
          return json(layerFixture, 200, { etag: '"ttl-v1"' });
        }

        expect(new Headers(init?.headers).get("If-None-Match")).toBe('"ttl-v1"');
        return json({ ...layerFixture, name: "TTL refreshed layer" }, 200, { etag: '"ttl-v2"' });
      },
    });

    const miss = await client.getLayerMetadata("ttl-service", 0, { ttlMs: 0 });
    const refreshed = await client.getLayerMetadata("ttl-service", 0, { ttlMs: 0 });

    expect(miss.cache?.status).toBe("miss");
    expect(refreshed.cache?.status).toBe("refreshed");
    expect(refreshed.name).toBe("TTL refreshed layer");
    expect(requestCount).toBe(2);
  });
});

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}
