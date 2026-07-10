import { describe, expect, it } from "vitest";

import { collectLiveEvidence, toSampleEvidence } from "../scripts/live-benchmark-evidence.mjs";

describe("live benchmark evidence", () => {
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
      targets: [],
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
});
