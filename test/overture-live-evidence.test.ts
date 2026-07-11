import { afterEach, describe, expect, it } from "vitest";

import { collectOvertureLiveEvidence, summarizeOvertureRangeTraffic } from "../scripts/overture-live-evidence.mjs";

const original = process.env.HONUA_OVERTURE_LIVE_ENABLED;

afterEach(() => {
  if (original === undefined) delete process.env.HONUA_OVERTURE_LIVE_ENABLED;
  else process.env.HONUA_OVERTURE_LIVE_ENABLED = original;
});

describe("Overture live evidence", () => {
  it("measures exact range-only traffic and rejects any unbounded fallback", () => {
    const objectBytes = 1_000_000;
    expect(
      summarizeOvertureRangeTraffic(
        [
          { method: "HEAD", range: null, status: 200, contentRange: null, contentLength: "1000000" },
          { method: "GET", range: "bytes=0-0", status: 206, contentRange: "bytes 0-0/1000000", contentLength: "1" },
          {
            method: "GET",
            range: "bytes=934464-999999",
            status: 206,
            contentRange: "bytes 934464-999999/1000000",
            contentLength: "65536",
          },
          {
            method: "GET",
            range: "bytes=100-249",
            status: 206,
            contentRange: "bytes 100-199/1000000",
            contentLength: "100",
          },
        ],
        objectBytes,
      ),
    ).toEqual({
      observedRequests: 3,
      observedBytes: 65_637,
      engineRequests: 1,
      engineBytes: 100,
      byteBudget: 32 * 1024 * 1024,
      unboundedGets: 0,
    });
    expect(() =>
      summarizeOvertureRangeTraffic(
        [{ method: "GET", range: null, status: 200, contentRange: null, contentLength: String(objectBytes) }],
        objectBytes,
      ),
    ).toThrow("unbounded Overture GET");
    expect(() =>
      summarizeOvertureRangeTraffic(
        [
          {
            method: "GET",
            range: "bytes=0-199",
            status: 206,
            contentRange: "bytes 0-199/1000000",
            contentLength: "200",
          },
        ],
        objectBytes,
        100,
      ),
    ).toThrow("exceeding the 100-byte evidence budget");
  });

  it("is opt-in and emits a valid shared skipped envelope without network access", async () => {
    delete process.env.HONUA_OVERTURE_LIVE_ENABLED;
    const evidence = await collectOvertureLiveEvidence();
    expect(evidence).toMatchObject({
      format: "honua.sdk.sample-evidence.v1",
      sampleId: "overture-geoparquet",
      lane: "live",
      status: "skipped",
      authMode: "anonymous",
      degradation: { state: "unavailable" },
    });
    expect(evidence.reason).toContain("opt-in");
    expect(JSON.stringify(evidence)).not.toMatch(/AKIA|Bearer\s|[?&](token|key|signature)=/i);
  });
});
