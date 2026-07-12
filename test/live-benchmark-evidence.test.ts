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
      { package: "@honua/sdk-js", version: "0.1.0-beta.0", gitCommit: null },
      "2026-01-01T00:00:00.000Z",
    );

    expect(evidence).toMatchObject({
      format: "honua.sdk.sample-evidence.v1",
      sampleId: "stac-imagery-browser",
      lane: "live",
      status: "executed",
      provenance: { state: "live", sourceId: "earth-search-sentinel-2-l2a" },
      semantics: { itemCount: 1 },
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

function liveFixtureResponse(
  input: RequestInfo | URL,
  options: { realtime: boolean; secretCursor?: string },
): Response {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname.endsWith("/streaming/features/capabilities")) {
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
  if (url.pathname.endsWith("/FeatureServer/0/query")) return json({ features: [{ attributes: { id: 1 } }] });
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
    return json({ features: [{ attributes: { id: 1 }, geometry: { rings: [[[0, 0], [1, 0], [0, 0]]] } }] });
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
