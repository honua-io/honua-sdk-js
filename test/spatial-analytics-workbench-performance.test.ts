import { expect, it } from "vitest";

import { createFixtureSpatialAnalyticsDataset } from "../examples/spatial-analytics-workbench/src/fixtures.js";
import { createLinkedAnalysisController } from "../examples/spatial-analytics-workbench/src/linked-analysis.js";
import { createSpatialAnalyticsWorkbenchSession } from "../examples/spatial-analytics-workbench/src/model.js";

it("keeps deterministic explain and bounded-local fixture execution within the flagship interaction budget", async () => {
  const session = createSpatialAnalyticsWorkbenchSession(createFixtureSpatialAnalyticsDataset());
  const controller = createLinkedAnalysisController(session.dataset);
  const projection = session.currentProjection();
  const fingerprints = new Set<string>();
  const startedAt = performance.now();

  for (let index = 0; index < 100; index++) {
    const estimate = controller.explain("bounded-local", session.activeAoi, projection);
    if (!estimate.plan) throw new Error("Expected a bounded-local plan");
    fingerprints.add(estimate.plan.fingerprint);
    const executed = await controller.execute(controller.accept(estimate));
    expect(executed.aggregateRows).toHaveLength(3);
  }

  const durationMs = performance.now() - startedAt;
  expect(fingerprints.size).toBe(1);
  expect(durationMs).toBeLessThan(1_000);
  session.dispose();
});
