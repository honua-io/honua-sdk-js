import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  OVERTURE_LIVE_PRODUCER_ARTIFACT,
  collectOvertureLiveEvidence,
  normalizeValidAt,
  summarizeOvertureRangeTraffic,
} from "../scripts/overture-live-evidence.mjs";
import { validateEvidenceEnvelope } from "../scripts/sample-contract.mjs";

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

  it("counts duplicate probe ranges as engine traffic and rejects credentials", () => {
    const objectBytes = 1_000_000;
    const footer: {
      method: string;
      range: string;
      status: number;
      contentRange: string;
      contentLength: string;
      hasCredentials?: boolean;
      hasCredentialQuery?: boolean;
    } = {
      method: "GET",
      range: "bytes=934464-999999",
      status: 206,
      contentRange: "bytes 934464-999999/1000000",
      contentLength: "65536",
    };
    expect(
      summarizeOvertureRangeTraffic(
        [
          { method: "GET", range: "bytes=0-0", status: 206, contentRange: "bytes 0-0/1000000", contentLength: "1" },
          footer,
          footer,
        ],
        objectBytes,
      ),
    ).toMatchObject({ engineRequests: 1, engineBytes: 65_536 });
    expect(() =>
      summarizeOvertureRangeTraffic([Object.assign({}, footer, { hasCredentials: true })], objectBytes),
    ).toThrow("credential-bearing Overture request");
    expect(() =>
      summarizeOvertureRangeTraffic([Object.assign({}, footer, { hasCredentialQuery: true })], objectBytes),
    ).toThrow("credential-bearing Overture request");
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

  it("content-binds the producer on a representative successful envelope without network access", async () => {
    const producerBytes = await readFile(OVERTURE_LIVE_PRODUCER_ARTIFACT.path);
    expect(OVERTURE_LIVE_PRODUCER_ARTIFACT.sha256).toBe(createHash("sha256").update(producerBytes).digest("hex"));
    const observedAt = "2026-07-01T00:00:00.000Z";
    const evidence = {
      format: "honua.sdk.sample-evidence.v1",
      schemaVersion: 1,
      sampleId: "overture-geoparquet",
      lane: "live",
      status: "executed",
      reason: null,
      observedAt,
      authMode: "anonymous",
      sdk: { package: "@honua/sdk-js", version: "0.1.0-beta.0", gitCommit: "1".repeat(40) },
      source: {
        provider: "overture-aws-open-data",
        identity: "release/theme=places/type=place/part.parquet",
        endpoint: "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/part.parquet",
        deploymentVersion: "2026-06-17.0",
        dataVersion: "v1.17.0",
      },
      provenance: {
        sourceId: "overture:2026-06-17.0:places:place:00000",
        observedAt,
        validAt: observedAt,
        state: "live",
        attribution: "Overture Maps Foundation Open Map Data",
      },
      semantics: {
        operation: "bounded-aoi-columnar-query",
        outcome: "bounded-range-result-engine-pruning-unverified",
        itemCount: 3,
        assertions: ["unbounded-http-gets=0", "duckdb-full-http-fallback=disabled"],
      },
      timing: { totalMs: 250, firstSuccessfulInteractionMs: 100 },
      degradation: { state: "expected", reasons: ["row-group counters are not exposed"] },
      artifacts: [OVERTURE_LIVE_PRODUCER_ARTIFACT],
    };
    expect(validateEvidenceEnvelope(evidence, { now: observedAt })).toBe(evidence);
  });

  // #767: S3 reports `Last-Modified` as an HTTP-date and the fixture lane reports
  // a non-date marker. Both were forwarded straight into provenance.validAt,
  // which the envelope contract only accepts as null-or-RFC 3339 — so every live
  // envelope, success or failure, was replaced by a generic validation failure
  // that hid the real outcome.
  it("normalizes the raw Last-Modified header into an RFC 3339 provenance.validAt", () => {
    expect(normalizeValidAt("Wed, 17 Jun 2026 17:24:54 GMT")).toBe("2026-06-17T17:24:54.000Z");
    expect(normalizeValidAt("2026-06-17T17:24:54.000Z")).toBe("2026-06-17T17:24:54.000Z");
    for (const absent of [null, undefined, "", "   ", "fixture-commit", "not-a-date", 17, {}]) {
      expect(normalizeValidAt(absent as never)).toBeNull();
    }
  });

  it("accepts a live envelope whose validAt came from a raw HTTP-date header", () => {
    const observedAt = "2026-07-01T00:00:00.000Z";
    const envelope = {
      format: "honua.sdk.sample-evidence.v1",
      schemaVersion: 1,
      sampleId: "overture-geoparquet",
      lane: "live",
      status: "failed",
      reason: "engine budget exceeded",
      observedAt,
      authMode: "anonymous",
      sdk: { package: "@honua/sdk-js", version: "0.1.2-beta.0", gitCommit: "1".repeat(40) },
      source: {
        provider: "overture-aws-open-data",
        identity: "release/theme=places/type=place/part.parquet",
        endpoint: "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/part.parquet",
        deploymentVersion: "2026-06-17.0",
        dataVersion: "v1.17.0",
      },
      provenance: {
        sourceId: "overture:2026-06-17.0:places:place:00000",
        observedAt,
        validAt: normalizeValidAt("Wed, 17 Jun 2026 17:24:54 GMT"),
        state: "live",
        attribution: "Overture Maps Foundation Open Map Data",
      },
      semantics: { operation: "bounded-aoi-columnar-query", outcome: null, itemCount: null, assertions: [] },
      timing: { totalMs: 250, firstSuccessfulInteractionMs: 100 },
      degradation: { state: "unexpected", reasons: ["engine budget exceeded"] },
      artifacts: [],
    };

    expect(validateEvidenceEnvelope(envelope, { now: observedAt })).toBe(envelope);
    expect(() =>
      validateEvidenceEnvelope(
        { ...envelope, provenance: { ...envelope.provenance, validAt: "Wed, 17 Jun 2026 17:24:54 GMT" } },
        { now: observedAt },
      ),
    ).toThrow(/validAt must be null or an RFC 3339 date-time/);
  });
});
