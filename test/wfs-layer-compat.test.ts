import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WFSLayerCompat } from "../src/esri-compat-entry.js";

describe("WFSLayerCompat queryFeatures", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("serializes the where option into CQL_FILTER on GetFeature requests", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      calledUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ features: [], numberMatched: 0, numberReturned: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const layer = new WFSLayerCompat({
      url: "https://example.test/wfs",
      name: "parcels",
    });

    await layer.queryFeatures({ where: "STATE = 'CA'" });

    expect(calledUrls).toHaveLength(1);
    const requested = new URL(calledUrls[0]);
    expect(requested.searchParams.get("CQL_FILTER")).toBe("STATE = 'CA'");
    expect(requested.searchParams.get("REQUEST")).toBe("GetFeature");
  });

  it("omits CQL_FILTER when no where option is provided", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      calledUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ features: [], numberMatched: 0, numberReturned: 0 }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    const layer = new WFSLayerCompat({
      url: "https://example.test/wfs",
      name: "parcels",
    });

    await layer.queryFeatures();

    const requested = new URL(calledUrls[0]);
    expect(requested.searchParams.get("CQL_FILTER")).toBeNull();
  });

  it("omits CQL_FILTER when where is empty or whitespace-only", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      calledUrls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ features: [], numberMatched: 0, numberReturned: 0 }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    const layer = new WFSLayerCompat({
      url: "https://example.test/wfs",
      name: "parcels",
    });

    await layer.queryFeatures({ where: "   " });

    const requested = new URL(calledUrls[0]);
    expect(requested.searchParams.get("CQL_FILTER")).toBeNull();
  });
});
