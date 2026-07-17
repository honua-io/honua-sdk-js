import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { prepareCloudNativeLinkedWorkflow } from "../examples/spatial-analytics-workbench/src/cloud-native-linked-workflow.js";
import {
  createSpatialAnalyticsWorkbenchSession,
  selectAnalyticsUiModels,
} from "../examples/spatial-analytics-workbench/src/model.js";

const fixtureFile = new URL(
  "../examples/spatial-analytics-workbench/public/fixtures/cloud-native-analysis-columnar.v1.json",
  import.meta.url,
);
const moduleFile = new URL(
  "../examples/spatial-analytics-workbench/src/cloud-native-linked-workflow.ts",
  import.meta.url,
);
const aoi = [-157.872, 21.286, -157.812, 21.331] as const;

async function fixtureFetch() {
  const bytes = await readFile(fixtureFile);
  return vi.fn<typeof fetch>(
    async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength), "content-type": "application/json" },
      }),
  );
}

describe("Cloud-Native Spatial Analysis S2 linked workflow", () => {
  it("decodes the public columnar envelope into one shared map/table/chart/selection state", async () => {
    const ticks = [0, 5, 5, 7];
    const result = await prepareCloudNativeLinkedWorkflow({
      origin: "https://sample.test",
      aoiId: "honolulu-urban-core",
      aoi,
      resultSourceId: "honua-cloud:analytics-results",
      acceptsColumnar: true,
      fetch: await fixtureFetch(),
      now: () => ticks.shift() ?? 7,
    });

    expect(result.artifactKind).toBe("columnar-batch");
    expect(result.features.map((feature) => feature.id)).toEqual([
      "asset-001",
      "parcel-002",
      "facility-003",
      "incident-004",
    ]);
    expect(result.timing).toEqual({ prerequisiteMs: 5, sdkLinkMs: 2, sourceMs: null, engineMs: null });
    expect(result.truth.claims).toMatchObject({
      rowGroupPruning: { state: "fixture-modeled" },
      rangeAccess: { state: "unobserved" },
      workerExecution: { state: "unobserved" },
      peakMemory: { state: "unobserved" },
    });

    const session = createSpatialAnalyticsWorkbenchSession();
    session.replaceLinkedFeatures(result.features);
    expect(session.visibleFeatures()).toHaveLength(4);
    expect(session.chartBuckets().map((bucket) => [bucket.risk, bucket.count])).toEqual([
      ["critical", 1],
      ["high", 2],
      ["moderate", 1],
      ["low", 0],
    ]);

    session.selectChartBucket("high");
    expect(session.currentProjection().filters.risk?.value).toBe("high");
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual(["parcel-002", "incident-004"]);
    session.selectFeature("parcel-002");
    expect(selectAnalyticsUiModels(session).detail.selectedRecords[0]?.feature.id).toBe("parcel-002");
    expect(session.currentProjection().selection).toEqual([
      { sourceId: "honua-cloud:analytics-results", id: "parcel-002" },
    ]);

    session.setRiskFilter("critical");
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual(["asset-001"]);
    expect(session.currentProjection().selection).toEqual([]);
    session.dispose();
  });

  it("uses the explicit four-row object fallback without changing linked feature semantics", async () => {
    const columnar = await prepareCloudNativeLinkedWorkflow({
      origin: "https://sample.test",
      aoiId: "honolulu-urban-core",
      aoi,
      resultSourceId: "honua-cloud:analytics-results",
      acceptsColumnar: true,
      fetch: await fixtureFetch(),
    });
    const fallback = await prepareCloudNativeLinkedWorkflow({
      origin: "https://sample.test",
      aoiId: "honolulu-urban-core",
      aoi,
      resultSourceId: "honua-cloud:analytics-results",
      acceptsColumnar: false,
      fetch: await fixtureFetch(),
    });

    expect(fallback.artifactKind).toBe("bounded-object-fallback");
    expect(fallback.features).toEqual(columnar.features);
    expect(fallback.truth.fallback).toMatchObject({ selected: "bounded-object", maxRows: 4 });
    expect(fallback.truth.degradations[0]).toMatchObject({ code: "columnar-consumer-unavailable" });
  });

  it("keeps the S2 adapter on published SDK entrypoints and explicit unobserved boundaries", async () => {
    const source = await readFile(moduleFile, "utf8");
    const sdkImports = [...source.matchAll(/from\s+["'](@honua\/sdk-js[^"']*)["']/g)].map((match) => match[1]);

    expect(sdkImports).toEqual(["@honua/sdk-js/query-planner"]);
    expect(source).not.toContain("../../src/");
    expect(source).not.toContain("../../../src/");
    expect(source).toContain("sourceMs: null");
    expect(source).toContain("engineMs: null");
  });
});
