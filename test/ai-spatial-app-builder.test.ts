import { describe, expect, it } from "vitest";

import { createAiSpatialAppBuilderSession } from "../examples/ai-spatial-app-builder/src/model.js";

describe("AI Spatial App Builder sample", () => {
  it("turns an ambiguous prompt into clarification, deterministic draft, plan, and generated linked app", () => {
    const session = createAiSpatialAppBuilderSession();

    const clarification = session.submitPrompt("Show parcels within 500m of fire stations built before 1970");
    expect(clarification.clarification?.id).toBe("flood-zone-source");

    const drafted = session.answerClarification("fema");
    expect(drafted.draft?.id).toBe("draft-parcels-flood");
    expect(session.activeDraft?.views).toEqual(["map", "table", "chart", "filter", "detail"]);

    const plan = session.previewPlan();
    expect(plan.steps.map((step) => step.status)).toContain("degraded");
    expect(plan.cacheNotes.join(" ")).toContain("Metadata/schema cache hit");

    const jobId = session.applyPlan();
    expect(session.advanceJob(jobId).status).toBe("running");
    expect(session.advanceJob(jobId).status).toBe("successful");
    expect(session.generatedApp()?.viewIds).toMatchObject({
      map: "builder-map",
      table: "builder-table",
      chart: "builder-chart",
      filter: "builder-filters",
      detail: "builder-detail",
    });
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual([
      "parcel-1001",
      "parcel-1002",
      "parcel-1003",
      "parcel-1005",
      "parcel-1006",
    ]);

    session.dispose();
  });

  it("keeps filter, chart, table, and detail views synchronized through linked exploration state", () => {
    const session = createAiSpatialAppBuilderSession();
    session.submitPrompt("Join parcels to nearby fire stations and summarize count by flood zone.");
    session.previewPlan();
    const jobId = session.applyPlan();
    session.advanceJob(jobId);
    session.advanceJob(jobId);

    session.selectChartBucket("X");
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual(["parcel-1002", "parcel-1006"]);

    session.selectFeature("parcel-1006");
    const exported = JSON.parse(session.exportState());
    expect(exported.selectedFeatures).toEqual([{ sourceId: "honua-cloud:ai-builder-results", id: "parcel-1006" }]);
    expect(exported.analysisOutputs[0].metadata.linkedViewSync).toBe(true);
    expect(exported.savedQueries[0].metadata.spatialPredicate).toBe("spatial-join");

    session.dispose();
  });

  it("exposes AI map kit tools for inspect, filter, select, widget query, and dry-run layer actions", async () => {
    const session = createAiSpatialAppBuilderSession();
    session.submitPrompt("Join parcels to nearby fire stations and summarize count by flood zone.");
    session.previewPlan();
    const jobId = session.applyPlan();
    session.advanceJob(jobId);
    session.advanceJob(jobId);

    const results = await session.runAiMapKitDemo();

    expect(session.aiMapKit.mcpTools.map((tool) => tool.name)).toEqual([
      "inspectMap",
      "listSources",
      "listCapabilities",
      "addLayer",
      "setFilter",
      "selectFeature",
      "runWidgetQuery",
    ]);
    expect(results.map((result) => (result as { status: string }).status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "dry-run",
    ]);
    expect(session.agentAudit.map((event) => [event.tool, event.outcome, event.dryRun])).toEqual([
      ["inspectMap", "allowed", false],
      ["runWidgetQuery", "allowed", false],
      ["setFilter", "allowed", false],
      ["selectFeature", "allowed", false],
      ["addLayer", "dry-run", true],
    ]);
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual(["parcel-1006", "parcel-1002"]);

    session.dispose();
  });

  it("covers five fixture prompt patterns and unsupported/degraded cloud capability notes", () => {
    const session = createAiSpatialAppBuilderSession();

    expect(session.dataset.prompts.map((prompt) => prompt.id)).toEqual([
      "parcels-flood",
      "station-distance",
      "spatial-join",
      "bbox-filter",
      "grouped-chart",
    ]);
    expect(session.dataset.capabilityNotes.map((note) => note.state)).toEqual(["available", "degraded", "unsupported"]);

    const direct = session.submitPrompt(
      "Show only the downtown extent and keep residential parcels in a map and table.",
    );
    expect(direct.draft?.spatialPredicate).toBe("bbox");
    expect(direct.draft?.cacheNotes.join(" ")).toContain("not blindly cached");

    session.dispose();
  });
});
