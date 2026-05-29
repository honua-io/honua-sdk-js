/**
 * Deterministic in-process transport for the stream/pagination benchmark.
 *
 * Produces a `fetch`-compatible function that answers GeoServices FeatureServer
 * `/query` requests by slicing a fixture array according to the `resultOffset`
 * and `resultRecordCount` query parameters the SDK's paginating stream emits.
 * No sockets, no server — every page is served synchronously from memory so the
 * harness measures the SDK's streaming/decoding overhead rather than network jitter.
 */
import type { HonuaFeature } from "../src/core/types.js";

export interface MockTransportOptions {
  /** Backing fixture; one page is a contiguous slice of this array. */
  features: readonly HonuaFeature[];
  /**
   * Optional artificial per-page latency in milliseconds. Defaults to 0 so the
   * benchmark isolates client-side cost. Set this to model server round-trips.
   */
  pageLatencyMs?: number;
}

export interface MockTransportHandle {
  /** The `fetchFn` to pass to `new HonuaClient({ fetchFn })`. */
  fetchFn: typeof fetch;
  /** Number of `/query` requests served — i.e. the number of pages fetched. */
  requestCount(): number;
}

function readOffsetAndCount(url: string): { offset: number; count: number } {
  const parsed = new URL(url, "http://bench.local");
  const offset = Number.parseInt(parsed.searchParams.get("resultOffset") ?? "0", 10);
  const count = Number.parseInt(parsed.searchParams.get("resultRecordCount") ?? "2000", 10);
  return {
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
    count: Number.isFinite(count) && count > 0 ? count : 2000,
  };
}

/**
 * Build a deterministic mock transport over `features`. The returned `fetchFn`
 * recognises FeatureServer `/query` URLs and returns the requested page; any
 * other path resolves to an empty feature response so capability probes do not
 * throw.
 */
export function createMockTransport(options: MockTransportOptions): MockTransportHandle {
  const { features, pageLatencyMs = 0 } = options;
  let requests = 0;

  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (!url.includes("/FeatureServer/") || !url.includes("/query")) {
      return new Response(JSON.stringify({ features: [], exceededTransferLimit: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    requests += 1;
    if (pageLatencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, pageLatencyMs));
    }

    const { offset, count } = readOffsetAndCount(url);
    const page = features.slice(offset, offset + count);
    const exceededTransferLimit = offset + count < features.length;

    return new Response(
      JSON.stringify({
        objectIdFieldName: "OBJECTID",
        geometryType: "esriGeometryPoint",
        features: page,
        exceededTransferLimit,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  return {
    fetchFn,
    requestCount: () => requests,
  };
}
