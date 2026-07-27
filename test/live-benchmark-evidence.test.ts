import { afterEach, describe, expect, it, vi } from "vitest";

import { collectLiveEvidence, toSampleEvidence } from "../scripts/live-benchmark-evidence.mjs";

describe("live benchmark evidence", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("skips safely and records a reason unless explicitly enabled", async () => {
    const report = await collectLiveEvidence({ GITHUB_EVENT_NAME: "pull_request" });

    expect(report).toMatchObject({
      format: "honua.sdk.benchmark-live-evidence.v1",
      schemaVersion: 1,
      run: {
        status: "skipped",
        trigger: "pull_request",
        skipReason: expect.stringContaining("opt-in"),
      },
      targets: [
        {
          id: "honua-demo-maplibre-quickstart",
          status: "skipped",
          sampleEvidence: { sampleId: "maplibre-quickstart", status: "skipped" },
        },
        {
          id: "honua-demo-incident-realtime",
          status: "skipped",
          sampleEvidence: {
            sampleId: "realtime-incident-dashboard",
            status: "skipped",
            realtime: {
              snapshotAt: null,
              cursor: null,
              lagMs: null,
              reconnectOutcome: "not-attempted-live-probes-disabled",
            },
          },
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("api-key");
  });

  it("projects live probes into the shared sample evidence envelope", () => {
    const evidence = toSampleEvidence(
      {
        id: "aws-earth-search-stac",
        sampleId: "stac-imagery-browser",
        journeyId: "discover-and-search-first-item",
        status: "passed",
        provider: "element84-earth-search-aws",
        endpoint: "https://earth-search.aws.element84.com/v1",
        authMode: "anonymous",
        attribution: "Element 84 Earth Search",
        endpointVersion: "1.0.0",
        protocolVersion: "1.0.0",
        latencyMs: 42,
        checks: { returnedItemCount: 1 },
        journey: {
          timeToFirstSuccessfulInteractionMs: 42,
          visibleOutcome: { kind: "stac-feature-collection", itemCount: 1 },
        },
        freshness: { observedAt: "2026-01-01T00:00:00.000Z", sourceDataTimestamp: null },
        provenance: { source: "earth-search-sentinel-2-l2a" },
      },
      { package: "@honua/sdk-js", version: "0.1.0-beta.0", gitCommit: "1".repeat(40) },
      "2026-01-01T00:00:00.000Z",
      {
        kind: "producer-generator",
        path: "scripts/live-benchmark-evidence.mjs",
        sha256: "2".repeat(64),
      },
    );

    expect(evidence).toMatchObject({
      format: "honua.sdk.sample-evidence.v1",
      sampleId: "stac-imagery-browser",
      lane: "live",
      status: "executed",
      provenance: { state: "live", sourceId: "earth-search-sentinel-2-l2a" },
      semantics: { itemCount: 1 },
      artifacts: [{ kind: "producer-generator" }],
    });
  });

  it("records unavailable realtime capability as an explicit per-sample skip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => liveFixtureResponse(input, { realtime: false })),
    );

    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" });
    const incident = report.targets.find((target) => target.id === "honua-demo-incident-realtime");
    const quickstart = report.targets.find((target) => target.id === "honua-demo-maplibre-quickstart");

    expect(incident).toMatchObject({
      status: "skipped",
      skipReason: expect.stringContaining("HTTP 404"),
      sampleEvidence: {
        sampleId: "realtime-incident-dashboard",
        status: "skipped",
        degradation: { state: "unavailable" },
        realtime: { reconnectOutcome: "not-attempted-capability-unavailable" },
      },
    });
    expect(report.run.status).toBe("passed");
    expect(quickstart).toMatchObject({
      status: "passed",
      endpoint: "https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1",
      protocolVersion: "geoservices-feature-service",
      sampleEvidence: {
        sampleId: "maplibre-quickstart",
        source: { identity: "honua-demo:maui-parcels:1" },
        semantics: { operation: "compatibility-layer-query-renderable-geometry" },
      },
    });
  });

  it("classifies an enabled capability with an empty incident dataset as its own honest skip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        liveFixtureResponse(input, { realtime: true, incidentSnapshot: { features: [] } }),
      ),
    );

    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" });
    const incident = report.targets.find((target) => target.id === "honua-demo-incident-realtime");

    expect(incident).toMatchObject({
      status: "skipped",
      skipReasonCode: "incident-demo-dataset-empty",
      skipReason: expect.stringContaining("zero features"),
      sampleEvidence: {
        sampleId: "realtime-incident-dashboard",
        status: "skipped",
        degradation: { state: "unavailable" },
        realtime: { reconnectOutcome: "not-attempted-demo-dataset-empty" },
      },
    });
    expect(incident?.skipReason).toContain("812");
    expect(sampleEvidenceOf(incident).degradation.reasons).toContain("incident-demo-dataset-empty");
    // The empty-dataset skip must stay distinguishable from the capability skip.
    expect(incident?.skipReasonCode).not.toBe("realtime-capability-disabled");
    expect(sampleEvidenceOf(incident).realtime.reconnectOutcome).not.toBe("not-attempted-capability-unavailable");
  });

  it("proceeds with the live journey when the incident snapshot carries features", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        liveFixtureResponse(input, { realtime: true, secretCursor: "cursor-1" }),
      ),
    );

    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" });
    const incident = report.targets.find((target) => target.id === "honua-demo-incident-realtime");

    expect(incident).toMatchObject({
      status: "passed",
      checks: { snapshotFeatureCount: 1 },
      sampleEvidence: { status: "executed", semantics: { itemCount: 1 } },
    });
    expect(incident?.skipReasonCode).toBeUndefined();
  });

  it("keeps a capability-disabled snapshot on the existing capability skip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        liveFixtureResponse(input, { realtime: false, capabilityDisabled: true, incidentSnapshot: { features: [] } }),
      ),
    );

    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" });
    const incident = report.targets.find((target) => target.id === "honua-demo-incident-realtime");

    expect(incident).toMatchObject({
      status: "skipped",
      skipReasonCode: "realtime-capability-disabled",
      skipReason: expect.stringContaining("requires Pro"),
      sampleEvidence: {
        status: "skipped",
        realtime: { reconnectOutcome: "not-attempted-capability-unavailable" },
      },
    });
  });

  it.each([
    ["an error status", { incidentSnapshotStatus: 500 }],
    ["an error payload behind HTTP 200", { incidentSnapshot: { error: { code: 400, message: "Invalid where" } } }],
    ["a schema mismatch", { incidentSnapshot: { features: "not-an-array" } }],
  ])("keeps %s a failure rather than a skip", async (_label, overrides) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => liveFixtureResponse(input, { realtime: true, ...overrides })),
    );

    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" });
    const incident = report.targets.find((target) => target.id === "honua-demo-incident-realtime");

    expect(incident?.status).toBe("failed");
    expect(incident?.skipReasonCode).toBeUndefined();
    expect(incident?.sampleEvidence).toMatchObject({
      status: "failed",
      degradation: { state: "unexpected" },
    });
    expect(sampleEvidenceOf(incident).degradation.reasons).not.toContain("incident-demo-dataset-empty");
    expect(report.run.status).toBe("failed");
  });

  it("keeps a snapshot timeout a failure rather than a skip", async () => {
    // The producer aborts the snapshot request on its own timer; the observable
    // effect on the probe is an AbortError from fetch, which must stay failed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/FeatureServer/0/query") && url.pathname.includes("maui-incidents")) {
          throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        }
        return liveFixtureResponse(input, { realtime: true });
      }),
    );

    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" });
    const incident = report.targets.find((target) => target.id === "honua-demo-incident-realtime");

    expect(incident).toMatchObject({ status: "failed", error: expect.stringContaining("aborted") });
    expect(incident?.skipReasonCode).toBeUndefined();
  });

  it("uses an opaque cursor for reconnect without publishing it in evidence", async () => {
    const secretCursor = "opaque-secret-cursor";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => liveFixtureResponse(input, { realtime: true, secretCursor })),
    );

    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" });
    const serialized = JSON.stringify(report);
    const incident = report.targets.find((target) => target.id === "honua-demo-incident-realtime");

    expect(incident).toMatchObject({
      status: "passed",
      sampleEvidence: {
        realtime: { cursor: "present", reconnectOutcome: "resumed-from-cursor-and-observed-delta" },
      },
    });
    expect(serialized).not.toContain(secretCursor);
    expect(serialized).toContain("cursor=%7Bredacted%7D");
  });
});

function sampleEvidenceOf(target: { sampleEvidence: Record<string, unknown> } | undefined): any {
  return target?.sampleEvidence;
}

function liveFixtureResponse(
  input: RequestInfo | URL,
  options: {
    realtime: boolean;
    secretCursor?: string;
    capabilityDisabled?: boolean;
    incidentSnapshot?: unknown;
    incidentSnapshotStatus?: number;
  },
): Response {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname.endsWith("/streaming/features/capabilities")) {
    if (options.capabilityDisabled) return json({ enabled: false, minimumEdition: "Pro" });
    return options.realtime
      ? json({ enabled: true, serverVersion: "test" })
      : new Response("not found", { status: 404 });
  }
  if (url.pathname.endsWith("/streaming/features")) {
    const payload = JSON.stringify({
      type: "delta",
      changes: [{ id: 1 }],
      cursor: options.secretCursor,
      sequence: 7,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    return new Response(`data: ${payload}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  if (url.pathname.endsWith("/FeatureServer/0/query")) {
    if (options.incidentSnapshotStatus !== undefined) {
      return new Response(JSON.stringify({ error: { code: options.incidentSnapshotStatus } }), {
        status: options.incidentSnapshotStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return json(options.incidentSnapshot ?? { features: [{ attributes: { id: 1 } }] });
  }
  if (url.pathname.endsWith("/api/v1/admin/capabilities")) return json({ data: { serverVersion: "test" } });
  if (url.pathname.endsWith("/rest/services/maui-parcels/FeatureServer/1")) {
    return json({
      id: 1,
      name: "maui-parcels",
      capabilities: "Query",
      geometryType: "esriGeometryPolygon",
    });
  }
  if (url.pathname.endsWith("/rest/services/maui-parcels/FeatureServer/1/query")) {
    return json({
      features: [
        {
          attributes: { id: 1 },
          geometry: {
            rings: [
              [
                [0, 0],
                [1, 0],
                [0, 0],
              ],
            ],
          },
        },
      ],
    });
  }
  if (url.pathname === "/v1") return json({ stac_version: "1.0.0" });
  if (url.pathname === "/v1/search") {
    return json({
      type: "FeatureCollection",
      features: [{ properties: { datetime: "2026-01-01T00:00:00.000Z" } }],
    });
  }
  return new Response("not found", { status: 404 });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
