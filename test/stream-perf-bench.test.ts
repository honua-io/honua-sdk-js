import { describe, expect, it } from "vitest";

import { buildFeatureFixture } from "../bench/feature-fixture.js";
import { createMockTransport } from "../bench/mock-transport.js";
import { formatReport, runStreamBench } from "../bench/stream-bench.js";

describe("stream/pagination performance harness", () => {
  it("drains a fixture-backed stream and emits coherent metrics", async () => {
    const report = await runStreamBench({
      featureCount: 5_000,
      pageSizes: [1_000, 2_500],
    });

    expect(report.featureCount).toBe(5_000);
    expect(report.runs).toHaveLength(2);

    for (const run of report.runs) {
      // Every feature is drained regardless of page size.
      expect(run.totalFeatures).toBe(5_000);
      // 5_000 features / page size, rounded up.
      expect(run.pageCount).toBe(Math.ceil(5_000 / run.pageSize));
      // Throughput and timing metrics are present and sane.
      expect(run.featuresPerSecond).toBeGreaterThan(0);
      expect(run.totalDurationMs).toBeGreaterThan(0);
      expect(run.timeToFirstPageMs).toBeGreaterThanOrEqual(0);
      expect(run.timeToFirstPageMs).toBeLessThanOrEqual(run.totalDurationMs + 1);
      // Memory profile fields are populated.
      expect(run.heapUsedPeakBytes).toBeGreaterThan(0);
      expect(Number.isFinite(run.heapUsedDeltaBytes)).toBe(true);
    }

    // The text report renders without throwing and includes the metric columns.
    const text = formatReport(report);
    expect(text).toContain("feat/sec");
    expect(text).toContain("ttfpMs");
  });

  it("mock transport serves exactly the requested page slice", async () => {
    const features = buildFeatureFixture(10);
    const transport = createMockTransport({ features });
    const response = await transport.fetchFn(
      "http://bench.local/rest/services/incidents/FeatureServer/0/query?resultOffset=4&resultRecordCount=3",
    );
    const body = (await response.json()) as {
      features: Array<{ attributes: { OBJECTID: number } }>;
      exceededTransferLimit: boolean;
    };

    expect(body.features.map((f) => f.attributes.OBJECTID)).toEqual([5, 6, 7]);
    expect(body.exceededTransferLimit).toBe(true);
    expect(transport.requestCount()).toBe(1);
  });

  it("omits geometry when the client requests returnGeometry=false", async () => {
    const features = buildFeatureFixture(5);
    const transport = createMockTransport({ features });

    const withGeometry = (await (
      await transport.fetchFn(
        "http://bench.local/rest/services/incidents/FeatureServer/0/query?resultRecordCount=5&returnGeometry=true",
      )
    ).json()) as { geometryType?: string; features: Array<Record<string, unknown>> };
    expect(withGeometry.geometryType).toBe("esriGeometryPoint");
    expect(withGeometry.features.every((f) => "geometry" in f)).toBe(true);

    const withoutGeometry = (await (
      await transport.fetchFn(
        "http://bench.local/rest/services/incidents/FeatureServer/0/query?resultRecordCount=5&returnGeometry=false",
      )
    ).json()) as { geometryType?: string; features: Array<Record<string, unknown>> };
    expect(withoutGeometry.geometryType).toBeUndefined();
    expect(withoutGeometry.features.every((f) => !("geometry" in f))).toBe(true);
    // Attributes still come through so the feature payload remains decodable.
    expect(withoutGeometry.features.every((f) => "attributes" in f)).toBe(true);
  });
});
