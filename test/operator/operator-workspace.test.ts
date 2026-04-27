import { describe, expect, it } from "vitest";

import {
  HonuaClient,
  type IJobRun,
  type JobProgress,
  type JobSnapshot,
  type JobSnapshotListener,
  type JobStatus,
} from "@honua/sdk-js";
import {
  type AnalysisIntent,
  type AnalysisPlan,
  type AppPackage,
  type ApprovalDecision,
  type ChatChunk,
  type ExecutionResult,
  OPERATOR_EXECUTION_OUTPUT_KEY,
  type OperatorClient,
  OperatorWorkspace,
  type WorkspaceEvent,
} from "@honua/sdk-js/operator";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage, type MaplibreMap } from "@honua/sdk-js/runtime";

interface MockCall {
  method: string;
  args: unknown[];
}

interface MockMap extends MaplibreMap {
  calls: MockCall[];
  style: unknown;
}

function makeMockMap(): MockMap {
  const calls: MockCall[] = [];
  const state = new Map<string, Record<string, unknown>>();
  const map: MockMap = {
    calls,
    style: {},
    setStyle(next) {
      calls.push({ method: "setStyle", args: [next] });
      map.style = next;
    },
    getStyle() {
      return map.style;
    },
    addSource(id, source) {
      calls.push({ method: "addSource", args: [id, source] });
    },
    removeSource(id) {
      calls.push({ method: "removeSource", args: [id] });
    },
    addLayer(layer, beforeId) {
      calls.push({ method: "addLayer", args: [layer, beforeId] });
    },
    removeLayer(id) {
      calls.push({ method: "removeLayer", args: [id] });
    },
    getLayer(id) {
      calls.push({ method: "getLayer", args: [id] });
      return undefined;
    },
    setLayoutProperty(layerId, name, value) {
      calls.push({ method: "setLayoutProperty", args: [layerId, name, value] });
    },
    setPaintProperty(layerId, name, value) {
      calls.push({ method: "setPaintProperty", args: [layerId, name, value] });
    },
    setFilter(layerId, filter) {
      calls.push({ method: "setFilter", args: [layerId, filter] });
    },
    getSource(id) {
      calls.push({ method: "getSource", args: [id] });
      return undefined;
    },
    fitBounds(bounds, options) {
      calls.push({ method: "fitBounds", args: [bounds, options] });
    },
    jumpTo(options) {
      calls.push({ method: "jumpTo", args: [options] });
    },
    easeTo(options) {
      calls.push({ method: "easeTo", args: [options] });
    },
    flyTo(options) {
      calls.push({ method: "flyTo", args: [options] });
    },
    setFeatureState(target, next) {
      state.set(`${target.source}:${target.id}`, { ...(state.get(`${target.source}:${target.id}`) ?? {}), ...next });
    },
    getFeatureState(target) {
      return state.get(`${target.source}:${target.id}`) ?? {};
    },
    removeFeatureState(target) {
      state.delete(`${target.source}:${target.id}`);
    },
    on() {
      // The workspace fixture does not exercise popup handlers.
    },
    off() {
      // The workspace fixture does not exercise popup handlers.
    },
  };
  return map;
}

class FakeJobRun implements IJobRun<ExecutionResult> {
  public readonly id = "op-1";
  public readonly type = "operator-plan";
  public status: JobStatus = "accepted";
  public progress: JobProgress | undefined;

  readonly #terminal: ExecutionResult;

  public constructor(terminal: ExecutionResult) {
    this.#terminal = terminal;
  }

  public async poll(): Promise<JobSnapshot<ExecutionResult>> {
    return { status: this.status, progress: this.progress };
  }

  public watch(listener: JobSnapshotListener<ExecutionResult>): () => void {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      this.status = "running";
      this.progress = { percent: 50, message: "composing package" };
      listener({ status: this.status, progress: this.progress });
      if (!active) return;
      this.status = "successful";
      listener({
        status: this.status,
        result: { outputs: { [OPERATOR_EXECUTION_OUTPUT_KEY]: this.#terminal } },
      });
    });
    return () => {
      active = false;
    };
  }

  public async results(): Promise<{ outputs: Record<string, ExecutionResult> }> {
    return { outputs: { [OPERATOR_EXECUTION_OUTPUT_KEY]: this.#terminal } };
  }

  public async cancel(): Promise<JobStatus> {
    this.status = "dismissed";
    return this.status;
  }
}

function makeMapPackage(): HonuaMapPackage {
  return {
    mapPackageId: "operator-map",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [
      {
        sourceId: "tiles",
        protocol: "raster_tile",
        locator: { url: "https://tiles.example.test/{z}/{x}/{y}.png" },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [{ id: "tiles", type: "raster", source: "tiles" }],
    },
    initialView: { center: [-157.85, 21.3], zoom: 9 },
  };
}

function makeAppPackage(): AppPackage {
  return {
    id: "app-1",
    version: "1",
    assets: [{ id: "bundle", kind: "app-package", url: "https://apps.example.test/operator/app.js" }],
  };
}

function makeIntent(withClarification = true): AnalysisIntent {
  return {
    id: withClarification ? "intent-1" : "intent-2",
    kind: "analysis",
    request: "map emergency shelters near Honolulu",
    clarifications: withClarification ? [{ id: "area", label: "Area", type: "text", required: true }] : [],
  };
}

function makePlan(intentId: string): AnalysisPlan {
  return {
    id: "plan-1",
    intentId,
    kind: "analysis",
    steps: [
      { id: "collect", kind: "query", label: "Collect shelter points" },
      { id: "compose", kind: "map", label: "Compose operator map", requiresApproval: true },
    ],
  };
}

function makeDecision(state: ApprovalDecision["state"]): ApprovalDecision {
  return {
    operationId: "op-1",
    state,
    scope: "publish-map",
    reasons: state === "denied" ? ["policy denied"] : [],
    requiredRoles: ["operator-admin"],
    audit: [{ at: 1, actor: "policy", action: state }],
  };
}

function makeOperatorClient(): OperatorClient {
  const clarified = makeIntent(false);
  const result: ExecutionResult = {
    kind: "analysis",
    summary: "Shelter map composed",
    mapPackage: makeMapPackage(),
    appPackage: makeAppPackage(),
  };
  return {
    operator: {
      async *chat(): AsyncIterable<ChatChunk> {
        yield { turnId: "agent-1", delta: "I need the area.", done: false };
        yield { turnId: "agent-1", delta: " Drafting the workflow.", done: true, intentDraft: makeIntent(true) };
      },
      async clarify() {
        return clarified;
      },
      async getPlan(intentId) {
        return makePlan(intentId);
      },
      async submitPlan() {
        return new FakeJobRun(result);
      },
      async refineMap() {
        return makeMapPackage();
      },
      async refineApp() {
        return makeAppPackage();
      },
      async getApproval() {
        return makeDecision("pending");
      },
      async confirmApproval() {
        return makeDecision("granted");
      },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("OperatorWorkspace", () => {
  it("assembles the operator flow from composable controllers and package runtime primitives", async () => {
    const map = makeMockMap();
    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({
      client: makeOperatorClient(),
      mapFactory: () => ({ map }),
      mapLoadOptions: {
        client: new HonuaClient({
          baseUrl: "https://honua.example.test",
          fetchFn: async () => new Response("not used", { status: 200 }),
        }),
        skipCompatibilityCheck: true,
      },
    });
    workspace.on((event) => events.push(event));

    await workspace.chat.send("Map emergency shelters near Honolulu");
    expect(events.some((event) => event.kind === "intent-drafted")).toBe(true);
    expect(events.some((event) => event.kind === "clarification-needed")).toBe(true);

    workspace.clarification.setAnswer("area", "Honolulu");
    const clarified = await workspace.clarification.submit();
    expect(clarified.clarifications).toEqual([]);
    expect(events.some((event) => event.kind === "clarification-answered")).toBe(true);

    const plan = await workspace.planReview.load(clarified.id);
    workspace.planReview.accept();
    await workspace.execution.start(plan);
    await flushMicrotasks();

    const pending = await workspace.approval.load("op-1");
    const granted = await workspace.approval.confirm("op-1");

    expect(pending.state).toBe("pending");
    expect(granted.state).toBe("granted");
    expect(workspace.builder.preview().url).toBe("https://apps.example.test/operator/app.js");
    expect(workspace.map?.exploration?.datasetId).toBe("operator-map");
    expect(map.calls.some((call) => call.method === "setStyle")).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "plan-loaded",
        "plan-accepted",
        "execution-started",
        "execution-progress",
        "execution-terminal",
        "map-loaded",
        "app-loaded",
        "approval-required",
        "approval-resolved",
      ]),
    );

    workspace.dispose();
  });
});
