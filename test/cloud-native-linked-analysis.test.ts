import { describe, expect, it, vi } from "vitest";

import {
  type CloudNativeAnalysisEvidenceV1,
  type CloudNativeAnalysisRun,
  cloudNativeAnalysisCacheIdentity,
  explainCloudNativeAnalysis,
} from "../examples/overture-geoparquet/src/cloud-native-analysis.js";
import {
  createCloudNativeLinkedArtifact,
  createCloudNativePresentationReceipt,
  createLinkedAnalysisSelection,
  linkedAnalysisViewportBounds,
} from "../examples/overture-geoparquet/src/linked-analysis-workflow.js";
import { planOvertureQuery } from "../examples/overture-geoparquet/src/planner.js";
import { FIXTURE_MANIFEST, OVERTURE_POLICY } from "../examples/overture-geoparquet/src/source-manifests.js";
import { PROTOCOL_DEFAULT_CAPABILITIES, type Result, type SourceDescriptor } from "../src/contract/index.js";

const AOI = [-158.3, 21.2, -157.65, 21.6] as const;

function descriptor(): SourceDescriptor {
  return {
    id: "overture-fixture-places",
    protocol: "geoparquet",
    locator: {
      url: "honua-resource://opaque",
      geoparquet: { geometryColumn: "geometry", geometryEncoding: "native", bboxColumn: "bbox" },
    },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
  };
}

function fixtureResult(
  rows: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly category: string;
    readonly confidence: number;
    readonly longitude: number;
    readonly latitude: number;
  }> = [
    {
      id: "08f2a3c1d4e5f601",
      name: "Waikiki Beach",
      category: "beach",
      confidence: 0.99,
      longitude: -157.83,
      latitude: 21.27,
    },
    {
      id: "08f2a3c1d4e5f602",
      name: "Ala Moana Beach",
      category: "beach",
      confidence: 0.93,
      longitude: -157.85,
      latitude: 21.29,
    },
    {
      id: "08f2a3c1d4e5f603",
      name: "Iolani Palace",
      category: "landmark",
      confidence: 0.96,
      longitude: -157.86,
      latitude: 21.31,
    },
  ],
): Result<Record<string, unknown>> {
  return {
    features: rows.map((row) => ({
      attributes: {
        id: row.id,
        name: row.name,
        category: row.category,
        confidence: row.confidence,
        bbox: {
          xmin: row.longitude,
          ymin: row.latitude,
          xmax: row.longitude,
          ymax: row.latitude,
        },
      },
      geometry: undefined,
    })),
    exceededTransferLimit: false,
  };
}

function withFirstBbox(
  result: Result<Record<string, unknown>>,
  [xmin, ymin, xmax, ymax]: readonly [number, number, number, number],
): Result<Record<string, unknown>> {
  const first = result.features[0];
  if (!first) throw new Error("A fixture feature is required.");
  return {
    ...result,
    features: [
      { ...first, attributes: { ...first.attributes, bbox: { xmin, ymin, xmax, ymax } } },
      ...result.features.slice(1),
    ],
  };
}

function fixtureRun(
  result = fixtureResult(),
  fidelity: "exact" | "approximate" = "exact",
): CloudNativeAnalysisRun<Record<string, unknown>> {
  const workflowPlan = planOvertureQuery({ lane: "fixture", aoi: AOI, category: "all", limit: 8 }, OVERTURE_POLICY);
  const plan = explainCloudNativeAnalysis(workflowPlan, FIXTURE_MANIFEST, descriptor());
  const object = FIXTURE_MANIFEST.objects[0]!;
  const resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  const evidence: CloudNativeAnalysisEvidenceV1 = {
    format: "honua.sdk.cloud-native-analysis-evidence.v1",
    schemaVersion: 1,
    workflow: "bounded-aoi-geoparquet",
    source: {
      lane: "fixture",
      release: FIXTURE_MANIFEST.release,
      schemaVersion: FIXTURE_MANIFEST.schemaVersion,
      objectKey: object.objectKey,
      objectVersion: object.etag,
      crs: "OGC:CRS84",
    },
    query: { aoi: AOI, projection: workflowPlan.projection, category: "all", limit: 8, plan },
    io: {
      rangeBytes: { fidelity: "exact", value: object.bytes, basis: "fixture bytes" },
      rangeRequests: { fidelity: "exact", value: 1, basis: "fixture buffer" },
      filesSelected: { fidelity: "exact", value: 1, basis: "fixture manifest" },
      filesExcluded: { fidelity: "exact", value: 0, basis: "fixture manifest" },
    },
    pruning: {
      selectedObjectRows: { fidelity: "exact", value: object.rows, basis: "fixture metadata" },
      candidateRowGroups: { fidelity: "exact", value: object.rowGroups, basis: "fixture metadata" },
      rowGroupsPruned: { fidelity: "unsupported", value: null, reason: "engine counter unavailable" },
    },
    rows: {
      returned: { fidelity: "exact", value: result.features.length, basis: "accepted Result" },
      scanned: { fidelity: "unsupported", value: null, reason: "engine counter unavailable" },
    },
    memory: {
      engineCeilingBytes: { fidelity: "exact", value: 256 * 1024 * 1024, basis: "configured ceiling" },
      resultCeilingBytes: { fidelity: "exact", value: 1024 * 1024, basis: "configured ceiling" },
      materializedResultBytes: { fidelity: "exact", value: resultBytes, basis: "encoded Result" },
      observedPeakBytes: { fidelity: "unsupported", value: null, reason: "browser counter unavailable" },
    },
    cache: {
      policy: "bypass",
      scope: "execution-only",
      identity: cloudNativeAnalysisCacheIdentity(workflowPlan, FIXTURE_MANIFEST),
      sdkPlanIdentity: plan.cacheIdentity,
      engine: {
        name: "unverified-geoparquet-runtime",
        version: null,
        verification: "unavailable",
        cacheScope: "execution-only",
      },
    },
    resultFidelity:
      fidelity === "exact"
        ? { fidelity: "exact", value: "exact", basis: "adapter reported no degradation" }
        : { fidelity: "approximate", value: "approximate", reason: "envelope predicate fallback" },
    timing: { sdkPlanMs: 2, sourceProbeMs: 1, engineExecutionMs: 7, totalMs: 10 },
    worker: {
      boundedExecution: { fidelity: "exact", value: true, basis: "accepted worker policy" },
      cleanup: { fidelity: "exact", value: true, basis: "runtime disposed" },
    },
    presentation: { fidelity: "unsupported", value: null, reason: "S1 is renderer-free" },
  };
  return { result, evidence };
}

describe("Cloud-Native Spatial Analysis S2 linked artifact", () => {
  it("derives map, table rows, and chart buckets from one immutable accepted Result", () => {
    const artifact = createCloudNativeLinkedArtifact(fixtureRun());

    expect(artifact).toMatchObject({
      format: "honua.sdk.cloud-native-linked-analysis.v1",
      schemaVersion: 1,
      state: "ready",
      materialization: {
        rowCount: 3,
        geometryFeatureCount: 3,
        chartBucketCount: 2,
        policy: { maxRows: 8, maxGeometryFeatures: 8, maxChartBuckets: 16, maxMaterializedBytes: 1024 * 1024 },
      },
    });
    expect(artifact.id).toMatch(/^artifact_[0-9a-f]{64}$/);
    expect(artifact.map.features.map((feature) => feature.id)).toEqual(artifact.rows.map((row) => row.id));
    expect(artifact.chart).toEqual([
      {
        category: "beach",
        count: 2,
        averageConfidence: 0.96,
        featureIds: ["08f2a3c1d4e5f601", "08f2a3c1d4e5f602"],
      },
      {
        category: "landmark",
        count: 1,
        averageConfidence: 0.96,
        featureIds: ["08f2a3c1d4e5f603"],
      },
    ]);
    expect(artifact.execution.rows.scanned).toEqual({
      fidelity: "unsupported",
      value: null,
      reason: "engine counter unavailable",
    });
    expect(artifact.execution.pruning.rowGroupsPruned.fidelity).toBe("unsupported");
    expect(artifact.execution.cache).toMatchObject({ policy: "bypass", scope: "execution-only" });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.rows)).toBe(true);
    expect(Object.isFrozen(artifact.map.features[0])).toBe(true);
    expect(createCloudNativeLinkedArtifact(fixtureRun()).id).toBe(artifact.id);
  });

  it("keeps empty and degraded data states explicit without changing fidelity", () => {
    const empty = createCloudNativeLinkedArtifact(fixtureRun(fixtureResult([])));
    expect(empty.state).toBe("empty");
    expect(empty.rows).toEqual([]);
    expect(empty.map.features).toEqual([]);
    expect(empty.chart).toEqual([]);

    const degraded = createCloudNativeLinkedArtifact(fixtureRun(fixtureResult(), "approximate"));
    expect(degraded.state).toBe("degraded");
    expect(degraded.execution.resultFidelity).toEqual({
      fidelity: "approximate",
      value: "approximate",
      reason: "envelope predicate fallback",
    });
  });

  it("fails closed on row, geometry, chart, byte, identity, and provenance drift", () => {
    const run = fixtureRun();
    expect(() => createCloudNativeLinkedArtifact(run, { maxRows: 2 })).toThrow("row ceiling");
    expect(() => createCloudNativeLinkedArtifact(run, { maxGeometryFeatures: 2 })).toThrow("geometries");
    expect(() => createCloudNativeLinkedArtifact(run, { maxChartBuckets: 1 })).toThrow("chart exceeded");
    expect(() => createCloudNativeLinkedArtifact(run, { maxMaterializedBytes: 64 })).toThrow("materialized");
    expect(() => createCloudNativeLinkedArtifact(run, { maxRows: 9 })).toThrow("cannot widen");

    const duplicate = fixtureResult([
      {
        id: "duplicate",
        name: "First",
        category: "civic",
        confidence: 1,
        longitude: -157.8,
        latitude: 21.3,
      },
      {
        id: "duplicate",
        name: "Second",
        category: "civic",
        confidence: 1,
        longitude: -157.81,
        latitude: 21.31,
      },
    ]);
    expect(() => createCloudNativeLinkedArtifact(fixtureRun(duplicate))).toThrow("duplicated");

    const outside = fixtureResult([
      {
        id: "outside",
        name: "Outside",
        category: "civic",
        confidence: 1,
        longitude: 0,
        latitude: 0,
      },
    ]);
    expect(() => createCloudNativeLinkedArtifact(fixtureRun(outside))).toThrow("does not intersect the accepted AOI");

    const boundaryOverlap = withFirstBbox(fixtureResult(), [-158.5, 21.3, -158.2, 21.31]);
    const overlapArtifact = createCloudNativeLinkedArtifact(fixtureRun(boundaryOverlap));
    expect(overlapArtifact.rows[0]?.longitude).toBeLessThan(AOI[0]);
    expect(linkedAnalysisViewportBounds(overlapArtifact)).toEqual([
      [-158.35, AOI[1]],
      [AOI[2], AOI[3]],
    ]);

    const outsideCrs = withFirstBbox(fixtureResult(), [-181, 21.3, -157.8, 21.31]);
    expect(() => createCloudNativeLinkedArtifact(fixtureRun(outsideCrs))).toThrow("outside OGC:CRS84 bounds");

    for (const id of [undefined, 42, { hostile: true }]) {
      const missingIdentity = fixtureRun();
      const attributes = missingIdentity.result.features[0]!.attributes;
      const hostileIdentity = {
        ...missingIdentity,
        result: {
          ...missingIdentity.result,
          features: [
            { ...missingIdentity.result.features[0]!, attributes: { ...attributes, id } },
            ...missingIdentity.result.features.slice(1),
          ],
        },
      } as CloudNativeAnalysisRun<Record<string, unknown>>;
      expect(() => createCloudNativeLinkedArtifact(hostileIdentity)).toThrow("features[0].id");
    }

    for (const invalidConfidence of [-0.01, 1.01]) {
      const invalid = fixtureRun();
      const attributes = invalid.result.features[0]!.attributes;
      const hostileConfidence = {
        ...invalid,
        result: {
          ...invalid.result,
          features: [
            { ...invalid.result.features[0]!, attributes: { ...attributes, confidence: invalidConfidence } },
            ...invalid.result.features.slice(1),
          ],
        },
      } as CloudNativeAnalysisRun<Record<string, unknown>>;
      expect(() => createCloudNativeLinkedArtifact(hostileConfidence)).toThrow("must be between 0 and 1");
    }

    const mismatched = fixtureRun();
    const hostile = {
      ...mismatched,
      evidence: {
        ...mismatched.evidence,
        rows: { ...mismatched.evidence.rows, returned: { fidelity: "exact", value: 2, basis: "forged" } },
      },
    } as CloudNativeAnalysisRun<Record<string, unknown>>;
    expect(() => createCloudNativeLinkedArtifact(hostile)).toThrow("does not match");

    const staleByteEvidence = fixtureRun();
    const changedResult = withFirstBbox(staleByteEvidence.result, [-157.9, 21.25, -157.7, 21.35]);
    expect(() => createCloudNativeLinkedArtifact({ ...staleByteEvidence, result: changedResult })).toThrow(
      "materialized-byte evidence does not match",
    );
  });

  it("synchronizes one bounded selection identity and stops after disposal", () => {
    const artifact = createCloudNativeLinkedArtifact(fixtureRun());
    const controller = createLinkedAnalysisSelection(artifact);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    controller.select(artifact.rows[1]!.id);
    expect(controller.selectedId).toBe(artifact.rows[1]!.id);
    expect(listener).toHaveBeenLastCalledWith(artifact.rows[1]!.id);
    controller.clear();
    expect(listener).toHaveBeenLastCalledWith(null);
    expect(() => controller.select("not-in-artifact")).toThrow("not in the artifact");

    unsubscribe();
    controller.select(artifact.rows[0]!.id);
    expect(listener).toHaveBeenCalledTimes(2);
    controller.dispose();
    expect(controller.disposed).toBe(true);
    expect(controller.selectedId).toBeNull();
    expect(() => controller.clear()).toThrow("disposed");
  });

  it("separates renderer and cache delivery truth from the source/engine receipt", () => {
    const artifact = createCloudNativeLinkedArtifact(fixtureRun());
    const receipt = createCloudNativePresentationReceipt(artifact, {
      resultCache: "hit",
      rendererMs: 4,
      deliveryWallMs: 5,
      renderedRows: 3,
      renderedGeometries: 3,
      renderedChartBuckets: 2,
    });

    expect(receipt).toMatchObject({
      format: "honua.sdk.cloud-native-presentation.v1",
      artifactId: artifact.id,
      resultCache: "hit",
      renderer: {
        strategy: "maplibre-bounded-geojson-fallback",
        state: "degraded",
        fidelity: "bounded-object-fallback",
        optionalRecipe: "kepler-analytics",
      },
      timing: {
        artifactProduction: { sdkPlanMs: 2, sourceProbeMs: 1, engineExecutionMs: 7, totalMs: 10 },
        delivery: { sdkPlanMs: 0, sourceProbeMs: 0, engineExecutionMs: 0, rendererMs: 4, wallMs: 5 },
      },
    });
    expect(artifact.execution.cache.policy).toBe("bypass");
    const miss = createCloudNativePresentationReceipt(artifact, {
      resultCache: "miss",
      rendererMs: 4,
      deliveryWallMs: 14,
      renderedRows: 3,
      renderedGeometries: 3,
      renderedChartBuckets: 2,
    });
    expect(miss.timing.artifactProduction).toEqual(receipt.timing.artifactProduction);
    expect(miss.timing.delivery).toEqual({
      sdkPlanMs: 2,
      sourceProbeMs: 1,
      engineExecutionMs: 7,
      rendererMs: 4,
      wallMs: 14,
    });
    expect(() =>
      createCloudNativePresentationReceipt(artifact, {
        resultCache: "miss",
        rendererMs: 4,
        deliveryWallMs: 14,
        renderedRows: 2,
        renderedGeometries: 3,
        renderedChartBuckets: 2,
      }),
    ).toThrow("row count");
  });
});
