import { describe, expect, it } from "vitest";

import { URBAN_CORE_EXTENT } from "../examples/unified-ops-workspace/src/fixtures.js";
import {
  applyUnifiedOpsDraft,
  applyUnifiedOpsProjection,
  applyUnifiedOpsRealtimeEvent,
  createUnifiedOpsWorkspace,
  moveUnifiedOpsMap,
  restoreUnifiedOpsSnapshot,
  saveUnifiedOpsSnapshot,
  selectUnifiedOpsEditFeature,
  setUnifiedOpsActiveModule,
  setUnifiedOpsActiveSource,
  stageUnifiedOpsAiDraft,
  stageUnifiedOpsEditAttachment,
  submitUnifiedOpsEditDraft,
  updateUnifiedOpsEditDraftValue,
  visibleUnifiedOpsEditFeatures,
} from "../examples/unified-ops-workspace/src/model.js";
import { FIELD_INSPECTION_SOURCE_ID, INCIDENT_SOURCE_ID } from "../examples/unified-ops-workspace/src/types.js";
import { selectHonuaAppWorkspaceDetailModel, selectHonuaAppWorkspaceFilterModel } from "../src/app-workspace/index.js";
import { selectLinkedViewQueryProjection, sourceFeatureSelectionTarget } from "../src/exploration/index.js";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("unified ops workspace", () => {
  it("keeps map, filters, table, chart, and detail linked across modules", async () => {
    const shell = createUnifiedOpsWorkspace({ now: () => 1_000 });

    shell.controllers.filters.setFilter("status", {
      field: "status",
      operator: "=",
      value: "open",
      appliesTo: [INCIDENT_SOURCE_ID],
    });
    moveUnifiedOpsMap(shell, URBAN_CORE_EXTENT);
    await flush();

    const projection = selectLinkedViewQueryProjection(shell.exploration.state);
    const result = applyUnifiedOpsProjection(shell.workspace.state, projection, { sourceId: INCIDENT_SOURCE_ID });
    expect(result.incidentRows.map((row) => row.id)).toEqual(["INC-2001"]);

    shell.controllers.table.select([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, "INC-2001")], { replace: true });
    setUnifiedOpsActiveModule(shell, "analysis-review");
    await flush();

    expect(shell.workspace.state.layout.activeViewId).toBe("analysis-review");
    expect(selectHonuaAppWorkspaceFilterModel(shell.workspace.state).filters.status?.value).toBe("open");
    expect(selectHonuaAppWorkspaceFilterModel(shell.workspace.state).extent).toEqual(URBAN_CORE_EXTENT);
    expect(selectHonuaAppWorkspaceDetailModel(shell.workspace.state).selectedRecords[0]?.feature.id).toBe("INC-2001");

    const criticalBucket = result.buckets.find((bucket) => bucket.id === "critical");
    expect(criticalBucket?.count).toBe(1);
    shell.controllers.chart.selectBucket(
      {
        filters: { severity: criticalBucket?.filter ?? { field: "severity", operator: "=", value: "critical" } },
        targets: criticalBucket?.targets ?? [],
      },
      { replaceSelection: true },
    );
    await flush();

    expect(shell.exploration.state.filters.severity?.value).toBe("critical");
    expect(selectHonuaAppWorkspaceDetailModel(shell.workspace.state).selection).toEqual([
      sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, "INC-2001"),
    ]);

    shell.dispose();
  });

  it("reconciles realtime updates without resetting user context", async () => {
    const shell = createUnifiedOpsWorkspace({ now: () => 2_000 });
    shell.controllers.filters.setFilter("status", {
      field: "status",
      operator: "=",
      value: "assigned",
      appliesTo: [INCIDENT_SOURCE_ID],
    });
    moveUnifiedOpsMap(shell, URBAN_CORE_EXTENT);
    shell.controllers.table.select([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, "INC-2002")], { replace: true });
    setUnifiedOpsActiveModule(shell, "analysis-review");
    await flush();

    applyUnifiedOpsRealtimeEvent(shell, {
      type: "upsert",
      eventId: "unit-escalate",
      cursor: "fixture-unit-1",
      sequence: 1,
      receivedAt: 3_000,
      feature: {
        sourceId: INCIDENT_SOURCE_ID,
        id: "INC-2002",
        updatedAt: "2026-05-05T18:02:20.000Z",
        feature: {
          id: "INC-2002",
          sourceId: INCIDENT_SOURCE_ID,
          kind: "incident",
          title: "Kakaako grid outage",
          type: "Utilities",
          severity: "critical",
          status: "assigned",
          district: "Urban Core",
          coordinate: [-157.8558, 21.2994],
          updatedAt: "2026-05-05T18:02:20.000Z",
          etaMinutes: 6,
          impactScore: 88,
          assignment: "Utility Strike Team",
          summary: "Escalated after the backup power window shrank.",
          relatedIds: ["CASE-7782"],
          attachments: ["Feeder telemetry extract"],
        },
      },
    });
    await flush();

    expect(shell.workspace.state.layout.activeViewId).toBe("analysis-review");
    expect(shell.exploration.state.filters.status?.value).toBe("assigned");
    expect(shell.exploration.state.extent).toEqual(URBAN_CORE_EXTENT);
    expect(shell.exploration.state.selection).toEqual([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, "INC-2002")]);
    expect(selectHonuaAppWorkspaceDetailModel(shell.workspace.state).selectedRecords[0]?.feature.severity).toBe(
      "critical",
    );

    shell.dispose();
  });

  it("stages AI outputs as drafts before mutating visible linked state", async () => {
    const shell = createUnifiedOpsWorkspace({ now: () => 4_000 });
    shell.controllers.filters.setFilter("status", {
      field: "status",
      operator: "=",
      value: "open",
      appliesTo: [INCIDENT_SOURCE_ID],
    });
    await flush();

    const draftId = stageUnifiedOpsAiDraft(shell, { now: 4_500, source: "mcp" });
    await flush();

    expect(shell.workspace.state.drafts.entries[draftId]?.source).toBe("mcp");
    expect(shell.exploration.state.filters.aiCritical).toBeUndefined();
    expect(selectHonuaAppWorkspaceFilterModel(shell.workspace.state).filters.aiCritical).toBeUndefined();
    expect(shell.workspace.state.jobs.entries["mcp-review-4500"]?.snapshot.result?.outputs.draft).toMatchObject({
      kind: "analysis-draft",
      draftId,
    });

    applyUnifiedOpsDraft(shell, draftId);
    await flush();

    expect(shell.workspace.state.drafts.entries[draftId]).toBeUndefined();
    expect(shell.exploration.state.filters.aiCritical?.value).toBe("critical");
    expect(selectHonuaAppWorkspaceFilterModel(shell.workspace.state).filters.aiCritical?.value).toBe("critical");

    shell.dispose();
  });

  it("bridges field edit workflow saves into the shared linked context", async () => {
    const shell = createUnifiedOpsWorkspace({ now: () => 4_800 });

    shell.controllers.filters.setFilter("status", {
      field: "status",
      operator: "=",
      value: "open",
      appliesTo: [INCIDENT_SOURCE_ID],
    });
    moveUnifiedOpsMap(shell, URBAN_CORE_EXTENT);
    shell.controllers.table.select([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, "INC-2001")], { replace: true });
    setUnifiedOpsActiveModule(shell, "field-editing");
    await flush();

    expect(shell.workspace.state.layout.activeViewId).toBe("field-editing");
    expect(selectHonuaAppWorkspaceDetailModel(shell.workspace.state).selectedRecords[0]?.feature.id).toBe("INC-2001");
    expect(visibleUnifiedOpsEditFeatures(shell).map((feature) => feature.id)).toEqual(["4101", "4103"]);

    selectUnifiedOpsEditFeature(shell, 4101);
    updateUnifiedOpsEditDraftValue(shell, "status", "closed");
    updateUnifiedOpsEditDraftValue(shell, "inspection_score", 95);
    stageUnifiedOpsEditAttachment(shell, "workspace-closeout.png");
    await flush();

    expect(shell.exploration.state.selection).toEqual([
      sourceFeatureSelectionTarget(FIELD_INSPECTION_SOURCE_ID, "4101"),
    ]);
    expect(shell.editWorkflow.pendingAttachments()).toHaveLength(1);

    const result = await submitUnifiedOpsEditDraft(shell);
    await flush();

    const projection = selectLinkedViewQueryProjection(shell.exploration.state);
    const fieldRows = applyUnifiedOpsProjection(shell.workspace.state, projection, {
      sourceId: FIELD_INSPECTION_SOURCE_ID,
    }).rows;

    expect(result.status).toBe("succeeded");
    expect(shell.workspace.state.layout.activeViewId).toBe("field-editing");
    expect(shell.exploration.state.filters.status?.value).toBe("open");
    expect(shell.exploration.state.extent).toEqual(URBAN_CORE_EXTENT);
    expect(fieldRows.find((feature) => feature.id === "4101")).toMatchObject({
      status: "closed",
      impactScore: 95,
    });
    expect(selectHonuaAppWorkspaceDetailModel(shell.workspace.state).selectedRecords[0]?.feature).toMatchObject({
      id: "4101",
      sourceId: FIELD_INSPECTION_SOURCE_ID,
      status: "closed",
    });
    expect(shell.editWorkflow.pendingAttachments()).toHaveLength(0);

    shell.dispose();
  });

  it("saves and restores snapshots with diagnostics", async () => {
    const shell = createUnifiedOpsWorkspace({ now: () => 5_000 });
    setUnifiedOpsActiveModule(shell, "analysis-review");
    setUnifiedOpsActiveSource(shell, "response-crews", false, { now: 5_100 });
    shell.controllers.filters.setFilter("status", {
      field: "status",
      operator: "=",
      value: "open",
      appliesTo: [INCIDENT_SOURCE_ID],
    });
    shell.controllers.table.select([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, "INC-2001")], { replace: true });
    await flush();

    const saved = saveUnifiedOpsSnapshot(shell, {
      id: "unit-snapshot",
      savedAt: "2026-05-06T00:00:00.000Z",
    });
    expect(saved.diagnostics).toMatchObject({
      activeSourceCount: 2,
      filterCount: 1,
      selectedFeatureCount: 1,
      activeViewId: "analysis-review",
    });

    setUnifiedOpsActiveModule(shell, "incident-command");
    setUnifiedOpsActiveSource(shell, "response-crews", true, { now: 5_200 });
    shell.controllers.filters.clearFilter("status");
    await flush();

    const restored = restoreUnifiedOpsSnapshot(shell, saved.document);
    await flush();

    expect(restored.ok).toBe(true);
    expect(shell.workspace.state.layout.activeViewId).toBe("analysis-review");
    expect(shell.workspace.state.sources.entries["response-crews"]?.metadata?.active).toBe(false);
    expect(shell.exploration.state.filters.status?.value).toBe("open");
    expect(shell.exploration.state.selection).toEqual([sourceFeatureSelectionTarget(INCIDENT_SOURCE_ID, "INC-2001")]);
    expect(saved.document.metadata?.diagnostics).toMatchObject({
      realtimeRecordCount: 10,
      modulePanelCount: 5,
    });

    shell.dispose();
  });
});
