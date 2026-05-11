import { describe, expect, it } from "vitest";

import { createEditWorkflowDemoSession } from "../examples/edit-workflow-demo/src/model.js";

describe("Edit Workflow demo", () => {
  it("keeps map extent, table rows, filters, and form selection synchronized through workspace context", () => {
    const session = createEditWorkflowDemoSession();

    expect(session.uiModels().cache.ready.map((entry) => entry.sourceId)).toContain(session.sourceId);
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual([4101]);

    session.selectMapArea("airport-corridor");
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual([4102]);

    session.setPriorityFilter("high");
    expect(session.visibleFeatures().map((feature) => feature.id)).toEqual([4102]);

    session.selectFeature(4102);
    expect(session.detailFeature()?.attributes.asset_id).toBe("VALVE-AIR-17");
    expect(session.draft().values.status).toBe("in-progress");

    session.dispose();
  });

  it("submits update edits and attachment mutations through one edit session", async () => {
    const session = createEditWorkflowDemoSession();
    session.selectFeature(4101);
    session.updateDraftValue("status", "closed");
    session.updateDraftValue("inspection_score", 88);
    session.applySketchGeometry("point", {
      type: "point",
      x: -157.874,
      y: 21.312,
      spatialReference: { wkid: 4326 },
    });
    expect(session.sketchSnapshot().dirty).toBe(true);
    session.stageAttachmentAdd("after-action.png");
    await session.stageAttachmentDelete(9101);

    const result = await session.submitDraft();

    expect(result.status).toBe("succeeded");
    expect(result.attachmentResults.map((entry) => entry.operation)).toEqual(["add", "delete"]);
    expect(session.detailFeature()?.attributes.status).toBe("closed");
    expect(session.detailFeature()?.attributes.version).toBe(5);
    expect(session.sketchSnapshot().dirty).toBe(false);
    await expect(session.attachmentList(4101)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "after-action.png" })]),
    );

    session.dispose();
  });

  it("rolls back optimistic edits and exposes conflict/version details", async () => {
    const session = createEditWorkflowDemoSession();
    session.selectFeature(4101);
    const previousNotes = session.detailFeature()?.attributes.notes;
    session.updateDraftValue("notes", "Conflicting update");
    session.forceNextConflict();

    const result = await session.submitDraft();

    expect(result.status).toBe("failed");
    expect(result.optimistic).toEqual({ applied: true, rolledBack: true });
    expect(result.failures[0]).toMatchObject({
      kind: "conflict",
      code: 409,
      conflict: { state: "supported", versionField: "version", value: 4 },
    });
    expect(session.detailFeature()?.attributes.notes).toBe(previousNotes);
    expect(session.operationLog()[0]?.optimistic).toBe("rolled back");

    session.dispose();
  });

  it("keeps partial attachment failures and unsupported capability states explicit", async () => {
    const session = createEditWorkflowDemoSession();
    session.selectFeature(4101);
    session.stageAttachmentAdd("too-large-photo.jpg");
    const partial = await session.submitDraft();

    expect(partial.status).toBe("partial");
    expect(partial.failures[0]).toMatchObject({
      kind: "transport",
      operation: "attachment-add",
      code: 413,
    });

    const unsupported = await session.runUnsupportedCheck();
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.failures.map((failure) => failure.kind)).toEqual(["capability", "capability"]);
    expect(session.readiness().find((entry) => entry.sourceId === session.readonlySourceId)?.state).toBe("unsupported");

    session.dispose();
  });

  it("creates and deletes features while preserving saved workspace diagnostics", async () => {
    const session = createEditWorkflowDemoSession();
    session.startCreateDraft();
    session.updateDraftValue("asset_name", "Ala Moana temporary generator");
    session.updateDraftValue("priority", "high");
    session.applySketchGeometry("circle", session.draft().geometry);
    expect(session.sketchSnapshot().sketch.status).toBe("unsupported");
    session.applySketchGeometry("rectangle", { ...session.draft().geometry, x: -157.872 });
    expect(session.undoSketchEdit()).toBe(true);
    expect(session.redoSketchEdit()).toBe(true);

    const created = await session.submitDraft();
    expect(created.status).toBe("succeeded");
    expect(created.committedFeatureId).toBe(4104);

    const deleted = await session.deleteSelected();
    expect(deleted.status).toBe("succeeded");
    expect(session.visibleFeatures().map((feature) => feature.id)).not.toContain(4104);

    const exported = JSON.parse(session.exportWorkspace());
    expect(exported.kind).toBe("honua.saved-workspace");
    expect(exported.metadata.demo).toBe("edit-workflow");
    expect(exported.metadata.sketchDirty).toBe(false);
    expect(exported.project.metadata.persistedAnnotations).toContain("annotation:4104:create");
    expect(exported.sources.map((source: { id: string }) => source.id)).toContain(session.sourceId);

    session.dispose();
  });
});
