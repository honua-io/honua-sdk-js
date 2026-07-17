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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      liveFixtureResponse(input, { realtime: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const report = await collectLiveEvidence({
      HONUA_BENCH_LIVE_ENABLED: "true",
      HONUA_BENCH_LIVE_API_KEY: "must-not-reach-first-map",
    });
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
    expect(quickstart?.status, quickstart?.error).toBe("passed");
    expect(quickstart).toMatchObject({
      status: "passed",
      endpoint: "https://demo.honua.io",
      authMode: "anonymous",
      protocolVersion: "geoservices-feature-service+ogc-api-features-1",
      checks: {
        protocolsObserved: ["geoservices", "ogc-features"],
        rawEndpointHealth: {
          kind: "availability-only",
          requestCount: 6,
          geoservices: { renderableGeometry: true },
          ogcFeatures: { renderableGeometry: true },
        },
        publicSdkWorkflowQualification: {
          kind: "connect-inspect-explain-bounded-query-mount",
          cleanup: "verified-empty-map-host-after-each-execution",
          executions: [
            {
              protocol: "geoservices-feature-service",
              strategy: "geojson",
              featureCount: 1,
              layerCount: 4,
              queryLimit: 1,
              withinBudget: true,
            },
            {
              protocol: "ogc-features",
              strategy: "geojson",
              featureCount: 1,
              layerCount: 4,
              queryLimit: 1,
              withinBudget: true,
            },
          ],
        },
      },
      sampleEvidence: {
        sampleId: "maplibre-quickstart",
        source: { identity: "honua-demo:maui-parcels:1:geoservices+ogc-features" },
        semantics: {
          operation: "first-map-dual-protocol-bounded-query",
          assertions: expect.arrayContaining([
            'protocolsObserved=["geoservices","ogc-features"]',
            expect.stringContaining('rawEndpointHealth={"kind":"availability-only"'),
            expect.stringContaining(
              'publicSdkWorkflowQualification={"kind":"connect-inspect-explain-bounded-query-mount"',
            ),
          ]),
        },
      },
    });
    expect(report.run.status).toBe("passed");
    const firstMapRequests = fetchMock.mock.calls.filter(([input]) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return (
        url.pathname.startsWith("/rest/services/maui-parcels/FeatureServer/1") ||
        url.pathname.startsWith("/ogc/features")
      );
    });
    expect(firstMapRequests).toHaveLength(14);
    for (const [input, init] of firstMapRequests) {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
    }
    expect(JSON.stringify(report)).not.toContain("must-not-reach-first-map");
  });

  it("fails First Map evidence when either required anonymous protocol fails", async () => {
    let ogcItemsRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/ogc/features/collections/1/items")) {
          ogcItemsRequests += 1;
          if (ogcItemsRequests > 1) return new Response("unavailable", { status: 503 });
        }
        return liveFixtureResponse(input, { realtime: false });
      }),
    );

    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" });
    const quickstart = report.targets.find((target) => target.id === "honua-demo-maplibre-quickstart");

    expect(report.run.status).toBe("failed");
    expect(quickstart).toMatchObject({
      status: "failed",
      authMode: "anonymous",
      error: expect.stringContaining("ogc-features First Map workflow did not become ready"),
      sampleEvidence: {
        sampleId: "maplibre-quickstart",
        status: "failed",
        reason: expect.stringContaining("ogc-features First Map workflow did not become ready"),
        degradation: {
          state: "unexpected",
          reasons: [expect.stringContaining("ogc-features First Map workflow did not become ready")],
        },
      },
    });
  });

  it("aborts and explicitly classifies a never-resolving First Map workflow fetch", async () => {
    let layerMetadataRequests = 0;
    let workflowSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/rest/services/maui-parcels/FeatureServer/1")) {
          layerMetadataRequests += 1;
          if (layerMetadataRequests > 1) {
            workflowSignal = input instanceof Request ? input.signal : (init?.signal ?? undefined);
            return new Promise<Response>((_resolve, reject) => {
              const abort = () => reject(workflowSignal?.reason ?? new DOMException("aborted", "AbortError"));
              if (workflowSignal?.aborted) abort();
              else workflowSignal?.addEventListener("abort", abort, { once: true });
            });
          }
        }
        return Promise.resolve(liveFixtureResponse(input, { realtime: false }));
      }),
    );

    const startedAt = performance.now();
    const report = await collectLiveEvidence({ HONUA_BENCH_LIVE_ENABLED: "true" }, { firstMapDeadlineMs: 20 });
    const quickstart = report.targets.find((target) => target.id === "honua-demo-maplibre-quickstart");

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(workflowSignal?.aborted).toBe(true);
    expect(report.run.status).toBe("failed");
    expect(quickstart).toMatchObject({
      status: "failed",
      error: "geoservices-feature-service First Map workflow deadline exceeded after 20 ms",
      sampleEvidence: {
        status: "failed",
        reason: "geoservices-feature-service First Map workflow deadline exceeded after 20 ms",
        degradation: {
          state: "unexpected",
          reasons: ["geoservices-feature-service First Map workflow deadline exceeded after 20 ms"],
        },
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
      advancedQueryCapabilities: {
        supportsPagination: true,
        supportsReturningQueryExtent: false,
        supportsStatistics: false,
      },
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
  if (url.pathname === "/ogc/features") {
    return json({ links: [{ rel: "conformance", href: `${url.origin}/ogc/features/conformance` }] });
  }
  if (url.pathname === "/ogc/features/conformance") {
    return json({
      conformsTo: [
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
      ],
    });
  }
  if (url.pathname === "/ogc/features/collections") {
    return json({ collections: [{ id: "1", title: "maui-parcels" }] });
  }
  if (url.pathname === "/ogc/features/collections/1/items") {
    return json({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [0, 0] } }],
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
