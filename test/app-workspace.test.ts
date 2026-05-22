import { describe, expect, it } from "vitest";

import type {
  IJobRun,
  JobProgress,
  JobResult,
  JobSnapshot,
  JobSnapshotListener,
  JobStatus,
} from "../src/contract/index.js";
import { createExplorationContext, sourceFeatureSelectionTarget } from "../src/exploration/index.js";
import {
  HonuaAppWorkspace,
  bindHonuaAppWorkspaceSelector,
  createHonuaAppWorkspace,
  createHonuaAppWorkspaceFromSavedDocument,
  createHonuaSavedWorkspaceDocument,
  hydrateHonuaSavedWorkspaceState,
  reattachHonuaSavedWorkspaceArtifacts,
  selectHonuaAppWorkspaceChartModel,
  selectHonuaAppWorkspaceDetailModel,
  selectHonuaAppWorkspaceDrafts,
  selectHonuaAppWorkspaceFilterModel,
  selectHonuaAppWorkspaceJobModel,
  selectHonuaAppWorkspaceMapModel,
  selectHonuaAppWorkspaceMetadataCacheModel,
  selectHonuaAppWorkspaceRealtimeModel,
  selectHonuaAppWorkspaceTableModel,
  summarizeHonuaSavedWorkspaceForMcp,
  validateHonuaSavedWorkspaceDocument,
} from "../src/app-workspace/index.js";

describe("HonuaAppWorkspace", () => {
  it("notifies narrow slice subscribers only for changed slices", () => {
    const workspace = createHonuaAppWorkspace();
    const sourceEvents: string[] = [];
    const layoutEvents: string[] = [];

    workspace.subscribe("sources", (event) => sourceEvents.push([...event.changedSlices].join(",")));
    workspace.subscribe("layout", (event) => layoutEvents.push([...event.changedSlices].join(",")));

    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId: "incidents",
      status: "loading",
      updatedAt: 1,
    });
    workspace.dispatch({ kind: "set-active-view", viewId: "map" });

    expect(sourceEvents).toEqual(["sources"]);
    expect(layoutEvents).toEqual(["layout"]);
  });

  it("suppresses selector notifications when equality reports no change", () => {
    const workspace = createHonuaAppWorkspace();
    const statuses: string[] = [];

    workspace.subscribeSelector(
      (state) => state.sources.entries.incidents?.status,
      (status) => statuses.push(status ?? "missing"),
    );

    workspace.dispatch({ kind: "set-active-view", viewId: "map" });
    workspace.dispatch({ kind: "set-source-metadata", sourceId: "incidents", status: "loading" });
    workspace.dispatch({ kind: "set-source-metadata", sourceId: "incidents", status: "loading", updatedAt: 2 });
    workspace.dispatch({ kind: "set-source-metadata", sourceId: "incidents", status: "ready", updatedAt: 3 });

    expect(statuses).toEqual(["loading", "ready"]);
  });

  it("round-trips snapshot and restore without aliasing live state", () => {
    const workspace = new HonuaAppWorkspace({
      initialState: {
        layout: { activeViewId: "map", panels: { table: { visible: true, size: 320 } } },
      },
    });

    const saved = workspace.snapshot();
    workspace.dispatch({ kind: "update-panel", panelId: "table", panel: { visible: false } });
    expect(workspace.state.layout.panels.table?.visible).toBe(false);

    workspace.restore(saved);
    expect(workspace.state.layout.panels.table).toEqual({ visible: true, size: 320 });

    workspace.dispatch({ kind: "update-panel", panelId: "table", panel: { size: 480 } });
    expect(saved.state.layout.panels.table).toEqual({ visible: true, size: 320 });
  });

  it("serializes and reloads a framework-neutral saved workspace document", () => {
    const workspace = createHonuaAppWorkspace<{ status: string }, { title: string }, { count: number }>();
    const exploration = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"] });

    exploration.dispatch({
      kind: "set-filter",
      id: "status",
      clause: { field: "STATUS", operator: "=", value: "open", appliesTo: ["incidents"] },
    });
    exploration.dispatch({
      kind: "select",
      replace: true,
      ids: [sourceFeatureSelectionTarget("incidents", 7)],
    });
    workspace.dispatch({
      kind: "set-exploration",
      reference: { datasetId: exploration.datasetId, sourceIds: exploration.sourceIds },
      snapshot: exploration.snapshot(),
    });
    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId: "incidents",
      status: "ready",
      metadata: { title: "Incidents" },
    });
    workspace.dispatch({
      kind: "set-job-snapshot",
      jobId: "job-1",
      type: "summarize",
      snapshot: { status: "successful", result: { outputs: { total: { count: 1 } } } },
    });

    const saved = createHonuaSavedWorkspaceDocument({
      project: { id: "ops", title: "Operations" },
      session: { id: "session-1", activeViewId: "map" },
      snapshot: workspace.snapshot(),
      savedAt: "2026-05-05T00:00:00.000Z",
      sources: [
        {
          id: "incidents",
          protocol: "ogc-features",
          title: "Incidents",
          status: "ready",
          metadata: { title: "Incidents" },
        },
      ],
      layers: [{ id: "incident-layer", sourceId: "incidents", title: "Incidents", visible: true, styleId: "open" }],
      styles: [{ id: "open", layerId: "incident-layer", name: "Open incidents", spec: { color: "#d33" } }],
      savedQueries: [
        {
          id: "open-incidents",
          label: "Open incidents",
          sourceIds: ["incidents"],
          filters: { status: { field: "STATUS", operator: "=", value: "open", appliesTo: ["incidents"] } },
        },
      ],
      analysisOutputs: [{ id: "total", jobId: "job-1", type: "metric", label: "Incident total", data: { count: 1 } }],
    });

    const wireFixture = JSON.parse(JSON.stringify(saved)) as unknown;
    const validation = validateHonuaSavedWorkspaceDocument(wireFixture);
    expect(validation.ok).toBe(true);

    const reloaded = createHonuaAppWorkspaceFromSavedDocument<{ status: string }, { title: string }, { count: number }>(
      wireFixture,
    );
    expect(reloaded.state.sources.entries.incidents?.metadata).toEqual({ title: "Incidents" });
    expect(selectHonuaAppWorkspaceFilterModel(reloaded.state).filters.status?.value).toBe("open");
    expect(selectHonuaAppWorkspaceDetailModel(reloaded.state).selection).toEqual([
      sourceFeatureSelectionTarget("incidents", 7),
    ]);
    expect(reloaded.state.jobs.entries["job-1"]?.snapshot.result?.outputs.total).toEqual({ count: 1 });
  });

  it("validates saved workspace documents before hydration", () => {
    const invalid = {
      kind: "honua.saved-workspace",
      version: 99,
      migration: { schemaVersion: 99 },
      project: {},
      sources: [{ id: "" }],
      layers: [],
      styles: [],
      filters: {},
      savedQueries: [],
      selectedFeatures: [{ id: null }],
      jobs: [{ id: "job-1", type: "summarize", status: "waiting" }],
      analysisOutputs: [],
    };

    const validation = validateHonuaSavedWorkspaceDocument(invalid);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors.map((error) => error.path)).toContain("$.version");
      expect(validation.errors.map((error) => error.path)).toContain("$.project.id");
      expect(validation.errors.map((error) => error.path)).toContain("$.jobs[0].status");
    }
    expect(() => hydrateHonuaSavedWorkspaceState(invalid)).toThrow(/Invalid Honua saved workspace document/);
  });

  it("reattaches jobs and materialized analysis outputs by id", () => {
    const workspace = createHonuaAppWorkspace<unknown, unknown, { href: string }>();
    workspace.dispatch({
      kind: "set-job-snapshot",
      jobId: "job-1",
      type: "hotspots",
      snapshot: { status: "running" },
    });
    const saved = createHonuaSavedWorkspaceDocument({
      project: { id: "ops" },
      savedAt: "2026-05-05T00:00:00.000Z",
      snapshot: workspace.snapshot(),
      sources: [],
      layers: [],
      styles: [],
      savedQueries: [],
      jobs: [{ id: "job-1", type: "hotspots", status: "running" }],
      analysisOutputs: [{ id: "heatmap", jobId: "job-1", type: "geojson", href: "honua://old" }],
    });

    const reattached = reattachHonuaSavedWorkspaceArtifacts(saved, {
      jobsById: {
        "job-1": {
          status: "successful",
          result: { outputs: { heatmap: { href: "honua://workspace/artifacts/heatmap" } } },
        },
      },
      analysisOutputsById: {
        heatmap: {
          id: "heatmap",
          jobId: "job-1",
          type: "geojson",
          href: "honua://workspace/artifacts/heatmap",
        },
      },
    });
    const state = hydrateHonuaSavedWorkspaceState<unknown, unknown, { href: string }>(reattached);

    expect(reattached.jobs[0]?.status).toBe("successful");
    expect(reattached.analysisOutputs[0]?.href).toBe("honua://workspace/artifacts/heatmap");
    expect(state.jobs.entries["job-1"]?.snapshot.result?.outputs.heatmap).toEqual({
      href: "honua://workspace/artifacts/heatmap",
    });
  });

  it("projects saved workspaces into MCP-readable summaries", () => {
    const saved = createHonuaSavedWorkspaceDocument({
      project: { id: "ops", title: "Operations" },
      savedAt: "2026-05-05T00:00:00.000Z",
      sources: [{ id: "incidents", protocol: "ogc-features", title: "Incidents", status: "ready" }],
      layers: [{ id: "incident-layer", sourceId: "incidents", visible: true }],
      styles: [],
      savedQueries: [{ id: "open", sourceIds: ["incidents"], filters: {} }],
      jobs: [{ id: "job-1", type: "summarize", status: "successful", outputIds: ["summary"] }],
      analysisOutputs: [{ id: "summary", jobId: "job-1", type: "markdown", label: "Summary" }],
    });

    const summary = summarizeHonuaSavedWorkspaceForMcp(saved);

    expect(summary).toMatchObject({
      kind: "honua.workspace.summary",
      workspaceId: "ops",
      sourceCount: 1,
      layerCount: 1,
      savedQueryCount: 1,
      analysisOutputCount: 1,
    });
    expect(summary.sources[0]).toEqual({
      id: "incidents",
      protocol: "ogc-features",
      title: "Incidents",
      status: "ready",
    });
    expect(summary.jobs[0]?.outputIds).toEqual(["summary"]);
  });

  it("updates realtime, job, and source cache state through typed intents", () => {
    const workspace = createHonuaAppWorkspace<{ status: string }, { title: string }, { count: number }>();

    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId: "incidents",
      status: "ready",
      metadata: { title: "Incidents" },
    });
    workspace.dispatch({
      kind: "apply-realtime-event",
      event: {
        type: "snapshot",
        cursor: "c1",
        receivedAt: 10,
        features: [{ id: 7, sourceId: "incidents", feature: { status: "open" } }],
      },
    });
    workspace.dispatch({
      kind: "set-job-snapshot",
      jobId: "job-1",
      type: "summarize",
      snapshot: { status: "successful", result: { outputs: { total: { count: 1 } } } },
    });

    expect(workspace.state.sources.entries.incidents?.metadata).toEqual({ title: "Incidents" });
    expect(workspace.state.realtime.features.cursor).toBe("c1");
    expect(workspace.state.realtime.features.records["incidents:7"]?.feature).toEqual({ status: "open" });
    expect(workspace.state.jobs.entries["job-1"]?.snapshot.result?.outputs.total).toEqual({ count: 1 });
  });

  it("derives map, table, detail, filter, chart, job, realtime, and metadata models", () => {
    const workspace = createHonuaAppWorkspace<{ status: string }, { title: string }, { count: number }>();
    const exploration = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"] });
    const selected = sourceFeatureSelectionTarget("incidents", 7);

    exploration.dispatch({
      kind: "set-filter",
      id: "status",
      clause: { field: "STATUS", operator: "=", value: "open", appliesTo: ["incidents"] },
    });
    exploration.dispatch({ kind: "set-grouping", grouping: ["SEVERITY"] });
    exploration.dispatch({ kind: "select", ids: [selected], replace: true });
    workspace.dispatch({
      kind: "set-exploration",
      reference: { datasetId: exploration.datasetId, sourceIds: exploration.sourceIds },
      snapshot: exploration.snapshot(),
    });
    workspace.dispatch({
      kind: "set-source-metadata",
      sourceId: "incidents",
      status: "ready",
      metadata: { title: "Incidents" },
    });
    workspace.dispatch({
      kind: "apply-realtime-event",
      event: {
        type: "snapshot",
        cursor: "c1",
        receivedAt: 10,
        features: [{ id: 7, sourceId: "incidents", feature: { status: "open" } }],
      },
    });
    workspace.dispatch({
      kind: "set-job-snapshot",
      jobId: "running-job",
      type: "summarize",
      snapshot: { status: "running", progress: { percent: 25 } },
    });
    workspace.dispatch({
      kind: "set-job-snapshot",
      jobId: "done-job",
      type: "summarize",
      snapshot: { status: "successful", result: { outputs: { total: { count: 1 } } } },
    });

    expect(selectHonuaAppWorkspaceMapModel(workspace.state, { sourceId: "incidents" }).query.filters.status).toEqual({
      field: "STATUS",
      operator: "=",
      value: "open",
      appliesTo: ["incidents"],
    });
    expect(selectHonuaAppWorkspaceTableModel(workspace.state, { sourceId: "incidents" }).records).toHaveLength(1);
    expect(selectHonuaAppWorkspaceDetailModel(workspace.state).selectedRecords[0]?.id).toBe(7);
    expect(selectHonuaAppWorkspaceFilterModel(workspace.state).filters.status?.value).toBe("open");
    expect(selectHonuaAppWorkspaceChartModel(workspace.state).grouping).toEqual(["SEVERITY"]);
    expect(selectHonuaAppWorkspaceRealtimeModel(workspace.state, { sourceId: "incidents" }).cursor).toBe("c1");
    expect(selectHonuaAppWorkspaceJobModel(workspace.state).running.map((entry) => entry.id)).toEqual(["running-job"]);
    expect(selectHonuaAppWorkspaceJobModel(workspace.state).terminal.map((entry) => entry.id)).toEqual(["done-job"]);
    expect(selectHonuaAppWorkspaceMetadataCacheModel(workspace.state).ready[0]?.metadata).toEqual({
      title: "Incidents",
    });
  });

  it("stages MCP or AI output as reviewable drafts before mutating visible state", () => {
    const workspace = createHonuaAppWorkspace<unknown, { title: string }>();

    workspace.dispatch({
      kind: "stage-draft",
      activate: true,
      draft: {
        id: "draft-1",
        source: "mcp",
        label: "Use incidents layer",
        proposedIntent: {
          kind: "set-source-metadata",
          sourceId: "incidents",
          status: "ready",
          metadata: { title: "Incidents" },
        },
      },
    });

    expect(workspace.state.sources.entries.incidents).toBeUndefined();
    expect(selectHonuaAppWorkspaceDrafts(workspace.state).activeDraftId).toBe("draft-1");

    workspace.applyDraft("draft-1");

    expect(workspace.state.sources.entries.incidents?.metadata).toEqual({ title: "Incidents" });
    expect(selectHonuaAppWorkspaceDrafts(workspace.state).entries).toEqual({});
  });

  it("binds derived models with an optional initial notification", () => {
    const workspace = createHonuaAppWorkspace({
      initialState: { layout: { activeViewId: "map", panels: {} } },
    });
    const activeViews: string[] = [];

    const unsubscribe = bindHonuaAppWorkspaceSelector(
      workspace,
      (state) => state.layout.activeViewId,
      (viewId) => activeViews.push(viewId ?? "none"),
      { fireImmediately: true },
    );
    workspace.dispatch({ kind: "set-active-view", viewId: "table" });
    unsubscribe();
    workspace.dispatch({ kind: "set-active-view", viewId: "map" });

    expect(activeViews).toEqual(["map", "table"]);
  });

  it("attaches existing exploration contexts and job runs as composed surfaces", async () => {
    const workspace = createHonuaAppWorkspace<unknown, unknown, { count: number }>();
    const exploration = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"] });
    const job = new MockJobRun<{ count: number }>("job-2", "summarize");
    const explorationSnapshots: number[] = [];
    const jobStatuses: JobStatus[] = [];

    workspace.subscribe("exploration", (event) => {
      explorationSnapshots.push(event.state.exploration.snapshot?.state.selection.length ?? 0);
    });
    workspace.subscribe("jobs", (event) => {
      jobStatuses.push(event.state.jobs.entries["job-2"]?.snapshot.status ?? "accepted");
    });

    workspace.dispatch({ kind: "attach-exploration-context", context: exploration });
    workspace.dispatch({ kind: "attach-job", job });
    exploration.dispatch({
      kind: "select",
      replace: true,
      ids: [sourceFeatureSelectionTarget("incidents", 7)],
    });
    await Promise.resolve();
    job.emit({ status: "running", progress: { percent: 50 } });
    job.emit({ status: "successful", result: { outputs: { total: { count: 1 } } } });

    expect(explorationSnapshots).toEqual([0, 1]);
    expect(jobStatuses).toEqual(["accepted", "running", "successful"]);
  });

  it("lets components coordinate through workspace intents instead of imperative component references", () => {
    const workspace = createHonuaAppWorkspace();

    const mapComponent = {
      selectIncident(id: number): void {
        workspace.dispatch({
          kind: "apply-realtime-event",
          event: {
            type: "upsert",
            receivedAt: 5,
            feature: { id, sourceId: "incidents", feature: { selected: true } },
          },
        });
      },
    };
    const detailComponent = {
      selectedIds: [] as number[],
      mount(): () => void {
        return workspace.subscribeSelector(
          (state) => Object.values(state.realtime.features.records).map((record) => Number(record.id)),
          (ids) => {
            this.selectedIds = ids;
          },
          (a, b) => a.length === b.length && a.every((value, index) => value === b[index]),
        );
      },
    };

    const unmount = detailComponent.mount();
    mapComponent.selectIncident(7);
    unmount();
    mapComponent.selectIncident(8);

    expect(detailComponent.selectedIds).toEqual([7]);
  });

  it("clears subscriptions and external attachments on dispose", () => {
    const workspace = createHonuaAppWorkspace();
    const job = new MockJobRun("job-3", "summarize");
    let events = 0;

    workspace.subscribe("jobs", () => events++);
    workspace.dispatch({ kind: "attach-job", job });
    workspace.dispose();
    job.emit({ status: "running" });

    expect(events).toBe(1);
    expect(() => workspace.dispatch({ kind: "set-active-view", viewId: "map" })).toThrow(/dispose/);
  });
});

class MockJobRun<T = unknown> implements IJobRun<T> {
  public status: JobStatus = "accepted";
  public progress: JobProgress | undefined;
  readonly #listeners = new Set<JobSnapshotListener<T>>();

  public constructor(
    public readonly id: string,
    public readonly type: string,
  ) {}

  public async poll(): Promise<JobSnapshot<T>> {
    return { status: this.status, progress: this.progress };
  }

  public watch(listener: JobSnapshotListener<T>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public async results(): Promise<JobResult<T>> {
    return { outputs: {} };
  }

  public async cancel(): Promise<JobStatus> {
    this.status = "dismissed";
    return this.status;
  }

  public emit(snapshot: JobSnapshot<T>): void {
    this.status = snapshot.status;
    this.progress = snapshot.progress;
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}
