import { createFixtureSpatialAnalyticsDataset } from "../examples/spatial-analytics-workbench/src/fixtures.js";
import { createLinkedAnalysisController } from "../examples/spatial-analytics-workbench/src/linked-analysis.js";
import { createSpatialAnalyticsWorkbenchSession } from "../examples/spatial-analytics-workbench/src/model.js";

export async function runSpatialAnalyticsCycles(operationCount: number) {
  const session = createSpatialAnalyticsWorkbenchSession(createFixtureSpatialAnalyticsDataset());
  const controller = createLinkedAnalysisController(session.dataset);
  const projection = session.currentProjection();
  const fingerprints = new Set<string>();
  let rowsValid = true;
  const startedAt = performance.now();
  try {
    for (let index = 0; index < operationCount; index++) {
      const estimate = controller.explain("bounded-local", session.activeAoi, projection);
      if (!estimate.plan) throw new Error("Expected a bounded-local plan");
      fingerprints.add(estimate.plan.fingerprint);
      const executed = await controller.execute(controller.accept(estimate));
      rowsValid &&= executed.aggregateRows.length === 3;
    }
    return {
      totalDurationMs: performance.now() - startedAt,
      fingerprintCount: fingerprints.size,
      rowsValid,
    };
  } finally {
    session.dispose();
  }
}
