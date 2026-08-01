import { describe, expect, it } from "vitest";

import { createSpatialAnalyticsKeplerHandoff } from "../examples/spatial-analytics-workbench/src/kepler-handoff.js";
import { createKeplerWorkspaceBridge } from "../src/kepler/index.js";

describe("Kepler cloud-native analytics handoff", () => {
  it("opens the accepted #547 fixture result through the reusable bridge", async () => {
    const handoff = await createSpatialAnalyticsKeplerHandoff();
    const bridge = createKeplerWorkspaceBridge({
      peers: {
        version: "3.2.6",
        addDataToMap: (payload) => ({ type: "kepler/addDataToMap", payload }),
      },
    });

    const opened = bridge.openResult(handoff.request);

    expect(handoff.state).toBe("fixture-replay");
    expect(opened.projection.dataset.info.id).toBe("cloud-native-risk-summary");
    expect(opened.projection.dataset.data.fields.map((field) => field.name)).toEqual([
      "average_score",
      "feature_count",
      "risk",
    ]);
    expect(opened.projection.dataset.data.rows).toEqual([
      [94, 1, "critical"],
      [82, 1, "high"],
      [67, 1, "moderate"],
    ]);
    expect(opened.projection.diagnostic).toMatchObject({
      strategy: "row-object-direct",
      geoJsonBytes: 0,
    });
    expect(opened.projection.dataset.metadata.provenance).toMatchObject({
      sourceId: "fixture:honolulu-exposure",
      sourceVersion: "honolulu-exposure-fixture.v2",
      schemaVersion: "analytics-feature-schema.v2",
      authorizationScope: "data:read",
      protocol: "geoservices-feature-service",
    });
    expect(opened.projection.dataset.metadata.provenance.planFingerprint).toMatch(/^sha256:/);
    expect(bridge.metrics).toMatchObject({ datasets: 1, rows: 3 });

    bridge.dispose();
    expect(bridge.disposed).toBe(true);
  });
});
