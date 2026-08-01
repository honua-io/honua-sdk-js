import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import type { KeplerResultProjectionRequest } from "@honua/sdk-js/kepler";

import { createFixtureSpatialAnalyticsDataset } from "./fixtures.js";
import { createLinkedAnalysisController } from "./linked-analysis.js";

export const SPATIAL_ANALYTICS_KEPLER_DATASET_ID = "cloud-native-risk-summary";

export interface SpatialAnalyticsKeplerHandoff {
  readonly state: "fixture-replay";
  readonly request: KeplerResultProjectionRequest;
}

/**
 * Execute the accepted #547 fixture plan and expose its result through the
 * protocol-neutral Kepler projection request. The renderer owns presentation;
 * this sample-owned handoff preserves the accepted plan and source identity.
 */
export async function createSpatialAnalyticsKeplerHandoff(): Promise<SpatialAnalyticsKeplerHandoff> {
  const dataset = createFixtureSpatialAnalyticsDataset();
  const aoi = dataset.aois[0];
  if (aoi === undefined) {
    throw new Error("The spatial analytics fixture requires an area of interest.");
  }

  const projection: LinkedViewQueryProjection = {
    filters: {},
    extent: aoi.extent,
    orderBy: [],
    pagination: { offset: 0, limit: 10 },
    outFields: ["risk", "score"],
    grouping: ["risk"],
    aggregation: {
      groupBy: ["risk"],
      metrics: [
        { fn: "count", field: "OBJECTID", alias: "feature_count" },
        { fn: "avg", field: "score", alias: "average_score" },
      ],
    },
    selection: [],
  };
  const controller = createLinkedAnalysisController(dataset, {
    now: () => Date.parse(dataset.generatedAt),
  });
  const estimate = controller.explain("remote-pushdown", aoi, projection);
  const executed = await controller.execute(controller.accept(estimate));
  const artifact = executed.outputArtifact;
  if (executed.state !== "fixture-replay" || artifact === undefined) {
    throw new Error(`The accepted spatial analytics fixture did not execute (state=${executed.state}).`);
  }

  return Object.freeze({
    state: executed.state,
    request: Object.freeze({
      datasetId: SPATIAL_ANALYTICS_KEPLER_DATASET_ID,
      label: "Accepted cloud-native risk summary",
      result: Object.freeze({
        features: Object.freeze([]),
        aggregateRows: artifact.aggregateRows,
        exceededTransferLimit: false,
      }),
      provenance: Object.freeze({
        sourceId: artifact.provenance.sourceId,
        sourceVersion: artifact.provenance.sourceVersion,
        schemaVersion: artifact.provenance.schemaVersion,
        planId: artifact.planId,
        planFingerprint: artifact.planFingerprint,
        authorizationScope: "data:read",
        attribution: artifact.provenance.attribution,
        protocol: "geoservices-feature-service",
        freshness: Object.freeze({ observedAt: artifact.generatedAt }),
      }),
    }),
  });
}
