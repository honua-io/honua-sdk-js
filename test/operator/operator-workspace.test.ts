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
  HonuaOperatorApprovalError,
  HonuaOperatorExecutionError,
  OPERATOR_EXECUTION_OUTPUT_KEY,
  type OperatorClient,
  OperatorWorkspace,
  type WorkspaceEvent,
} from "@honua/sdk-js/operator";
// Subpath import — also acts as a regression for the Vitest alias
// resolving `@honua/sdk-js/operator/i18n` to a file that exists
// rather than `src/operator/index.ts/i18n`.
import { DEFAULT_MESSAGES, resolveMessage } from "@honua/sdk-js/operator/i18n";
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
      async revisePlan(intentId) {
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

async function waitForEvent(
  events: ReadonlyArray<WorkspaceEvent>,
  kind: WorkspaceEvent["kind"],
  maxTicks = 50,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (events.some((event) => event.kind === kind)) return;
    await Promise.resolve();
  }
  throw new Error(`event "${kind}" not observed within ${maxTicks} ticks`);
}

async function waitForAsyncEvent(
  events: ReadonlyArray<WorkspaceEvent>,
  kind: WorkspaceEvent["kind"],
  maxTicks = 50,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (events.some((event) => event.kind === kind)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`event "${kind}" not observed within ${maxTicks} event-loop ticks`);
}

class DismissingJobRun implements IJobRun<ExecutionResult> {
  public readonly id = "op-dismiss";
  public readonly type = "operator-plan";
  public status: JobStatus = "accepted";
  public progress: JobProgress | undefined;

  public async poll(): Promise<JobSnapshot<ExecutionResult>> {
    return { status: this.status, progress: this.progress };
  }

  public watch(listener: JobSnapshotListener<ExecutionResult>): () => void {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      this.status = "running";
      listener({ status: this.status });
      if (!active) return;
      this.status = "dismissed";
      listener({ status: this.status });
    });
    return () => {
      active = false;
    };
  }

  public async results(): Promise<{ outputs: Record<string, ExecutionResult> }> {
    return { outputs: {} };
  }

  public async cancel(): Promise<JobStatus> {
    this.status = "dismissed";
    return this.status;
  }
}

function makeDismissingClient(): OperatorClient {
  const intent = makeIntent(false);
  return {
    operator: {
      async *chat(): AsyncIterable<ChatChunk> {
        yield { turnId: "agent-1", delta: "ok", done: true, intentDraft: intent };
      },
      async clarify() {
        return intent;
      },
      async getPlan(intentId) {
        return makePlan(intentId);
      },
      async revisePlan(intentId) {
        return makePlan(intentId);
      },
      async submitPlan() {
        return new DismissingJobRun();
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

    // Workspace orchestrates the documented chat → clarification →
    // plan-load → execution-start chain; the test must not call
    // planReview.load or execution.start manually or the orchestration
    // path goes untested.
    await waitForEvent(events, "plan-loaded");
    workspace.planReview.accept();
    await waitForEvent(events, "execution-terminal");
    await waitForAsyncEvent(events, "map-loaded");

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

  it("emits execution-dismissed on the workspace event stream when a run is cancelled", async () => {
    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({ client: makeDismissingClient() });
    workspace.on((event) => events.push(event));

    const plan = makePlan("intent-2");
    await workspace.execution.start(plan);
    await flushMicrotasks();

    const dismissed = events.find((event) => event.kind === "execution-dismissed");
    expect(dismissed).toBeDefined();
    expect(dismissed?.kind === "execution-dismissed" && dismissed.executionId).toBe("op-dismiss");
    expect(events.some((event) => event.kind === "execution-terminal")).toBe(false);

    workspace.dispose();
  });

  it("drives passive IJobRun polling so watch-only adapters reach a terminal snapshot", async () => {
    const result: ExecutionResult = { kind: "analysis", summary: "passive" };
    const run = new PassiveJobRun(result);
    const workspace = new OperatorWorkspace({ client: makeClientWithRun(run) });
    const events: WorkspaceEvent[] = [];
    workspace.on((event) => events.push(event));

    await workspace.execution.start(makePlan("intent-passive"));
    await waitForEvent(events, "execution-terminal");

    expect(run.resultsCalls).toBe(1);
    expect(workspace.execution.snapshot?.status).toBe("successful");

    workspace.dispose();
  });

  it("wraps submitPlan failures in HonuaOperatorExecutionError and routes them through the workspace error stream", async () => {
    const failure = new Error("transport down");
    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({ client: makeFailingSubmitClient(failure) });
    workspace.on((event) => events.push(event));

    await expect(workspace.execution.start(makePlan("intent-3"))).rejects.toBeInstanceOf(HonuaOperatorExecutionError);

    const errorEvent = events.find((event) => event.kind === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.kind !== "error") throw new Error("expected error event");
    expect(errorEvent.error).toBeInstanceOf(HonuaOperatorExecutionError);
    expect(errorEvent.error.cause).toBe(failure);

    workspace.dispose();
  });

  it("recreates ExplorationContext on map refinement when datasetId or sourceIds change", async () => {
    const map = makeMockMap();
    const refined: HonuaMapPackage = {
      mapPackageId: "operator-map-v2",
      format: HONUA_MAP_PACKAGE_FORMAT_V1,
      sourceBindings: [
        {
          sourceId: "vector-tiles",
          protocol: "raster_tile",
          locator: { url: "https://tiles.example.test/v2/{z}/{x}/{y}.png" },
        },
      ],
      mapSpec: {
        version: 8,
        sources: {},
        layers: [{ id: "vector-tiles", type: "raster", source: "vector-tiles" }],
      },
      initialView: { center: [-157.85, 21.3], zoom: 9 },
    };
    const workspace = new OperatorWorkspace({
      client: makeRefiningClient(refined),
      mapFactory: () => ({ map }),
      mapLoadOptions: {
        client: new HonuaClient({
          baseUrl: "https://honua.example.test",
          fetchFn: async () => new Response("not used", { status: 200 }),
        }),
        skipCompatibilityCheck: true,
      },
    });

    workspace.map?.bindIntent("intent-refine");
    await workspace.map!.loadPackage(makeMapPackage());
    expect(workspace.map?.exploration?.datasetId).toBe("operator-map");
    expect(workspace.map?.exploration?.sourceIds).toEqual(["tiles"]);

    await workspace.map!.refine("switch source");
    expect(workspace.map?.exploration?.datasetId).toBe("operator-map-v2");
    expect(workspace.map?.exploration?.sourceIds).toEqual(["vector-tiles"]);

    workspace.dispose();
  });

  it("forwards plan revision notes through OperatorClient.revisePlan", async () => {
    const captured: Array<{ intentId: string; notes: string | undefined }> = [];
    const client: OperatorClient = {
      operator: {
        async *chat(): AsyncIterable<ChatChunk> {
          yield { turnId: "agent-1", delta: "ok", done: true };
        },
        async clarify() {
          return makeIntent(false);
        },
        async getPlan(intentId) {
          return makePlan(intentId);
        },
        async revisePlan(intentId, notes) {
          captured.push({ intentId, notes });
          return { ...makePlan(intentId), id: "plan-revised" };
        },
        async submitPlan() {
          return new FakeJobRun({ kind: "analysis" });
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
    const workspace = new OperatorWorkspace({ client });

    await workspace.planReview.load("intent-rev");
    await workspace.planReview.revise({ intentId: "intent-rev", notes: "use vector tiles" });

    expect(captured).toEqual([{ intentId: "intent-rev", notes: "use vector tiles" }]);
    expect(workspace.planReview.plan?.id).toBe("plan-revised");

    workspace.dispose();
  });

  it("surfaces map factory failures as HonuaOperatorMapError on the workspace error stream", async () => {
    const factoryFailure = new Error("WebGL unavailable");
    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({
      client: makeOperatorClient(),
      mapFactory: () => {
        throw factoryFailure;
      },
      mapLoadOptions: {
        client: new HonuaClient({
          baseUrl: "https://honua.example.test",
          fetchFn: async () => new Response("not used", { status: 200 }),
        }),
        skipCompatibilityCheck: true,
      },
    });
    workspace.on((event) => events.push(event));

    workspace.map?.bindIntent("intent-factory");
    await expect(workspace.map!.loadPackage(makeMapPackage())).rejects.toMatchObject({
      name: "HonuaOperatorMapError",
      cause: factoryFailure,
    });

    workspace.dispose();
  });

  it("propagates host map factory failures through the workspace event stream when execution loads a map", async () => {
    const factoryFailure = new Error("factory boom");
    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({
      client: makeOperatorClient(),
      mapFactory: () => {
        throw factoryFailure;
      },
      mapLoadOptions: {
        client: new HonuaClient({
          baseUrl: "https://honua.example.test",
          fetchFn: async () => new Response("not used", { status: 200 }),
        }),
        skipCompatibilityCheck: true,
      },
    });
    workspace.on((event) => events.push(event));

    await workspace.chat.send("draft");
    workspace.clarification.setAnswer("area", "Honolulu");
    await workspace.clarification.submit();
    await waitForEvent(events, "plan-loaded");
    workspace.planReview.accept();
    await waitForEvent(events, "execution-terminal");
    await waitForEvent(events, "error");

    const errorEvent = events.find((event) => event.kind === "error");
    if (errorEvent?.kind !== "error") throw new Error("expected error event");
    expect(errorEvent.error.name).toBe("HonuaOperatorMapError");
    expect(errorEvent.error.cause).toBe(factoryFailure);

    workspace.dispose();
  });

  it("does not let an in-flight chat send overwrite a newer send's intent", async () => {
    let resolveSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    const slowIntent: AnalysisIntent = { ...makeIntent(false), id: "intent-slow" };
    const fastIntent: AnalysisIntent = { ...makeIntent(false), id: "intent-fast" };
    let sendIndex = 0;

    const client: OperatorClient = {
      operator: {
        async *chat(): AsyncIterable<ChatChunk> {
          sendIndex += 1;
          const ownIndex = sendIndex;
          if (ownIndex === 1) {
            await slowGate;
            yield { turnId: "agent-slow", delta: "slow", done: true, intentDraft: slowIntent };
          } else {
            yield { turnId: "agent-fast", delta: "fast", done: true, intentDraft: fastIntent };
          }
        },
        async clarify() {
          return fastIntent;
        },
        async getPlan(intentId) {
          return makePlan(intentId);
        },
        async revisePlan(intentId) {
          return makePlan(intentId);
        },
        async submitPlan() {
          return new FakeJobRun({ kind: "analysis" });
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

    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({ client });
    workspace.on((event) => events.push(event));

    const slow = workspace.chat.send("first").catch(() => undefined);
    const fast = workspace.chat.send("second");

    await fast;
    resolveSlow();
    await slow;
    await flushMicrotasks();

    const intentEvents = events.filter((event) => event.kind === "intent-drafted");
    expect(intentEvents).toHaveLength(1);
    if (intentEvents[0]?.kind !== "intent-drafted") throw new Error("expected intent-drafted");
    expect(intentEvents[0].intent.id).toBe("intent-fast");
    expect(workspace.activeIntentId).toBe("intent-fast");

    workspace.dispose();
  });

  it("does not let a slow clarification submit revive a superseded intent", async () => {
    let releaseSlow!: (intent: AnalysisIntent) => void;
    const slowClarify = new Promise<AnalysisIntent>((resolve) => {
      releaseSlow = resolve;
    });
    const intentA: AnalysisIntent = {
      id: "intent-A",
      kind: "analysis",
      request: "first",
      clarifications: [{ id: "area", label: "Area", type: "text", required: true }],
    };
    const intentB: AnalysisIntent = {
      id: "intent-B",
      kind: "analysis",
      request: "second",
      clarifications: [],
    };
    const revivedA: AnalysisIntent = { ...intentA, clarifications: [] };

    const client: OperatorClient = {
      operator: {
        async *chat(): AsyncIterable<ChatChunk> {
          yield { turnId: "agent-1", delta: "ok", done: true };
        },
        async clarify() {
          return slowClarify;
        },
        async getPlan(intentId) {
          return makePlan(intentId);
        },
        async revisePlan(intentId) {
          return makePlan(intentId);
        },
        async submitPlan() {
          return new FakeJobRun({ kind: "analysis" });
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

    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({ client });
    workspace.on((event) => events.push(event));

    workspace.clarification.load(intentA);
    workspace.clarification.setAnswer("area", "Honolulu");
    const submission = workspace.clarification.submit();
    expect(workspace.clarification.state.submitting).toBe(true);
    workspace.clarification.load(intentB);
    expect(workspace.clarification.state.submitting).toBe(false);
    releaseSlow(revivedA);
    await submission;
    await flushMicrotasks();

    expect(workspace.clarification.state.intent?.id).toBe("intent-B");
    expect(workspace.clarification.state.submitting).toBe(false);
    expect(events.some((event) => event.kind === "clarification-answered")).toBe(false);

    workspace.dispose();
  });

  it("drops out-of-order plan loads so accept executes the latest intent's plan", async () => {
    const planA: AnalysisPlan = { ...makePlan("intent-A"), id: "plan-A" };
    const planB: AnalysisPlan = { ...makePlan("intent-B"), id: "plan-B" };
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const client: OperatorClient = {
      operator: {
        async *chat(): AsyncIterable<ChatChunk> {
          yield { turnId: "agent-1", delta: "ok", done: true };
        },
        async clarify() {
          return makeIntent(false);
        },
        async getPlan(intentId) {
          if (intentId === "intent-A") {
            await aGate;
            return planA;
          }
          return planB;
        },
        async revisePlan(intentId) {
          return makePlan(intentId);
        },
        async submitPlan() {
          return new FakeJobRun({ kind: "analysis" });
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

    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({ client });
    workspace.on((event) => events.push(event));

    const slowLoad = workspace.planReview.load("intent-A").catch(() => undefined);
    const fastLoad = workspace.planReview.load("intent-B");
    const fastResult = await fastLoad;
    expect(fastResult.id).toBe("plan-B");
    expect(workspace.planReview.plan?.id).toBe("plan-B");

    releaseA();
    await slowLoad;
    await flushMicrotasks();

    expect(workspace.planReview.plan?.id).toBe("plan-B");
    const planLoadedEvents = events.filter((event) => event.kind === "plan-loaded");
    expect(planLoadedEvents).toHaveLength(1);
    if (planLoadedEvents[0]?.kind !== "plan-loaded") throw new Error("expected plan-loaded");
    expect(planLoadedEvents[0].plan.id).toBe("plan-B");

    workspace.dispose();
  });

  it("cancels an older submitPlan that resolves after a newer start has taken ownership", async () => {
    let releaseSlow!: (run: IJobRun<ExecutionResult>) => void;
    const slowSubmit = new Promise<IJobRun<ExecutionResult>>((resolve) => {
      releaseSlow = resolve;
    });
    const slowResult: ExecutionResult = { kind: "analysis", summary: "slow" };
    const fastResult: ExecutionResult = { kind: "analysis", summary: "fast" };
    const slowRun = new FakeJobRun(slowResult);
    let cancelCalls = 0;
    const originalCancel = slowRun.cancel.bind(slowRun);
    slowRun.cancel = async () => {
      cancelCalls += 1;
      return originalCancel();
    };

    let submitCount = 0;
    const client: OperatorClient = {
      operator: {
        async *chat(): AsyncIterable<ChatChunk> {
          yield { turnId: "agent-1", delta: "ok", done: true };
        },
        async clarify() {
          return makeIntent(false);
        },
        async getPlan(intentId) {
          return makePlan(intentId);
        },
        async revisePlan(intentId) {
          return makePlan(intentId);
        },
        async submitPlan() {
          submitCount += 1;
          if (submitCount === 1) return slowSubmit;
          return new FakeJobRun(fastResult);
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

    const workspace = new OperatorWorkspace({ client });

    const slowStart = workspace.execution.start(makePlan("intent-slow")).catch((error: unknown) => error);
    const fastStart = workspace.execution.start(makePlan("intent-fast"));
    const fastRun = await fastStart;
    expect(fastRun.id).toBe("op-1");
    expect(workspace.execution.run).toBe(fastRun);

    releaseSlow(slowRun);
    const slowOutcome = await slowStart;
    expect(slowOutcome).toBeInstanceOf(HonuaOperatorExecutionError);
    expect(workspace.execution.run).toBe(fastRun);
    expect(cancelCalls).toBe(1);

    workspace.dispose();
  });

  it("does not let a slow map loadPackage overwrite a newer load's runtime", async () => {
    const mapA = makeMockMap();
    const mapB = makeMockMap();
    const pkgA: HonuaMapPackage = { ...makeMapPackage(), mapPackageId: "pkg-A" };
    const pkgB: HonuaMapPackage = {
      mapPackageId: "pkg-B",
      format: HONUA_MAP_PACKAGE_FORMAT_V1,
      sourceBindings: [
        {
          sourceId: "vector",
          protocol: "raster_tile",
          locator: { url: "https://tiles.example.test/v2/{z}/{x}/{y}.png" },
        },
      ],
      mapSpec: {
        version: 8,
        sources: {},
        layers: [{ id: "vector", type: "raster", source: "vector" }],
      },
      initialView: { center: [-157.85, 21.3], zoom: 9 },
    };
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let factoryCall = 0;
    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({
      client: makeOperatorClient(),
      mapFactory: async () => {
        factoryCall += 1;
        if (factoryCall === 1) {
          await aGate;
          return { map: mapA };
        }
        return { map: mapB };
      },
      mapLoadOptions: {
        client: new HonuaClient({
          baseUrl: "https://honua.example.test",
          fetchFn: async () => new Response("not used", { status: 200 }),
        }),
        skipCompatibilityCheck: true,
      },
    });
    workspace.on((event) => events.push(event));
    workspace.map?.bindIntent("intent-1");

    const slow = workspace.map!.loadPackage(pkgA).catch((error: unknown) => error);
    const fast = workspace.map!.loadPackage(pkgB);
    const fastRuntime = await fast;
    expect(workspace.map?.exploration?.datasetId).toBe("pkg-B");
    expect(workspace.map?.runtime).toBe(fastRuntime);

    releaseA();
    await slow;
    await flushMicrotasks();

    expect(workspace.map?.exploration?.datasetId).toBe("pkg-B");
    expect(workspace.map?.runtime).toBe(fastRuntime);
    const mapLoadedEvents = events.filter((event) => event.kind === "map-loaded");
    expect(mapLoadedEvents).toHaveLength(1);
    if (mapLoadedEvents[0]?.kind !== "map-loaded") throw new Error("expected map-loaded");
    expect(mapLoadedEvents[0].pkg.mapPackageId).toBe("pkg-B");

    workspace.dispose();
  });

  it("does not let a slow approval load overwrite the active decision", async () => {
    let releaseA!: (decision: ApprovalDecision) => void;
    const aGate = new Promise<ApprovalDecision>((resolve) => {
      releaseA = resolve;
    });
    const decisionA: ApprovalDecision = {
      operationId: "op-A",
      state: "denied",
      scope: "publish-map",
      reasons: ["policy denied"],
      requiredRoles: ["operator-admin"],
      audit: [{ at: 1, actor: "policy", action: "denied" }],
    };
    const decisionB: ApprovalDecision = {
      operationId: "op-B",
      state: "pending",
      scope: "publish-map",
      reasons: [],
      requiredRoles: ["operator-admin"],
      audit: [{ at: 2, actor: "policy", action: "pending" }],
    };

    const client: OperatorClient = {
      operator: {
        async *chat(): AsyncIterable<ChatChunk> {
          yield { turnId: "agent-1", delta: "ok", done: true };
        },
        async clarify() {
          return makeIntent(false);
        },
        async getPlan(intentId) {
          return makePlan(intentId);
        },
        async revisePlan(intentId) {
          return makePlan(intentId);
        },
        async submitPlan() {
          return new FakeJobRun({ kind: "analysis" });
        },
        async refineMap() {
          return makeMapPackage();
        },
        async refineApp() {
          return makeAppPackage();
        },
        async getApproval(operationId) {
          if (operationId === "op-A") return aGate;
          return decisionB;
        },
        async confirmApproval() {
          return decisionB;
        },
      },
    };

    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({ client });
    workspace.on((event) => events.push(event));

    const slowLoad = workspace.approval.load("op-A").catch(() => undefined);
    const fast = await workspace.approval.load("op-B");
    expect(fast.operationId).toBe("op-B");
    expect(workspace.approval.decision?.operationId).toBe("op-B");

    releaseA(decisionA);
    await slowLoad;
    await flushMicrotasks();

    expect(workspace.approval.decision?.operationId).toBe("op-B");
    const approvalEvents = events.filter(
      (event) => event.kind === "approval-required" || event.kind === "approval-resolved",
    );
    for (const event of approvalEvents) {
      if (event.kind !== "approval-required" && event.kind !== "approval-resolved") {
        throw new Error("unexpected approval event kind");
      }
      expect(event.decision.operationId).toBe("op-B");
    }

    workspace.dispose();
  });

  it("clears the bound map when an app-only execution result is loaded", async () => {
    const map = makeMockMap();
    const firstResult: ExecutionResult = {
      kind: "analysis",
      summary: "first",
      mapPackage: makeMapPackage(),
      appPackage: makeAppPackage(),
    };
    const secondAppPkg: AppPackage = { ...makeAppPackage(), id: "app-2" };
    const secondResult: ExecutionResult = {
      kind: "analysis",
      summary: "second (app-only)",
      appPackage: secondAppPkg,
    };
    const firstRun = new FakeJobRun(firstResult);
    const secondRun = new FakeJobRun(secondResult);
    let runIndex = 0;
    const client: OperatorClient = {
      operator: {
        async *chat(): AsyncIterable<ChatChunk> {
          yield { turnId: "agent-1", delta: "ok", done: true };
        },
        async clarify() {
          return makeIntent(false);
        },
        async getPlan(intentId) {
          return makePlan(intentId);
        },
        async revisePlan(intentId) {
          return makePlan(intentId);
        },
        async submitPlan() {
          runIndex += 1;
          return runIndex === 1 ? firstRun : secondRun;
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
    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({
      client,
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
    workspace.builder.bindIntent("intent-1");
    workspace.map?.bindIntent("intent-1");

    await workspace.execution.start(makePlan("intent-1"));
    await waitForEvent(events, "execution-terminal");
    await flushMicrotasks();
    expect(workspace.builder.preview().mapPackage?.mapPackageId).toBe("operator-map");

    await workspace.execution.start(makePlan("intent-1"));
    await waitForEvent(events.slice(events.findIndex((event) => event.kind === "app-loaded") + 1), "app-loaded");
    await flushMicrotasks();
    expect(workspace.builder.appPackage?.id).toBe("app-2");
    expect(workspace.builder.preview().mapPackage).toBeUndefined();

    workspace.dispose();
  });

  it("emits execution-dismissed when a passive run reports dismissed only via cancel()", async () => {
    const passiveRun = new SilentDismissJobRun();
    const events: WorkspaceEvent[] = [];
    const workspace = new OperatorWorkspace({ client: makeClientWithRun(passiveRun) });
    workspace.on((event) => events.push(event));

    await workspace.execution.start(makePlan("intent-passive"));
    await flushMicrotasks();

    await workspace.execution.cancel();
    await flushMicrotasks();

    const dismissedEvents = events.filter((event) => event.kind === "execution-dismissed");
    expect(dismissedEvents).toHaveLength(1);
    if (dismissedEvents[0]?.kind !== "execution-dismissed") throw new Error("expected execution-dismissed");
    expect(workspace.execution.snapshot?.status).toBe("dismissed");

    workspace.dispose();
  });

  it("preserves typed approval errors thrown by the client", async () => {
    const typedError = new HonuaOperatorApprovalError("policy gate refused the load", {
      detail: { operationId: "op-typed", reason: "PolicyDenied" },
    });
    const client: OperatorClient = {
      operator: {
        async *chat(): AsyncIterable<ChatChunk> {
          yield { turnId: "agent-1", delta: "ok", done: true };
        },
        async clarify() {
          return makeIntent(false);
        },
        async getPlan(intentId) {
          return makePlan(intentId);
        },
        async revisePlan(intentId) {
          return makePlan(intentId);
        },
        async submitPlan() {
          return new FakeJobRun({ kind: "analysis" });
        },
        async refineMap() {
          return makeMapPackage();
        },
        async refineApp() {
          return makeAppPackage();
        },
        async getApproval() {
          throw typedError;
        },
        async confirmApproval() {
          throw typedError;
        },
      },
    };
    const workspace = new OperatorWorkspace({ client });

    await expect(workspace.approval.load("op-typed")).rejects.toBe(typedError);

    workspace.dispose();
  });

  it("disposes the host map when loadMapPackage rejects after the factory has built it", async () => {
    const map = makeMockMap();
    // Sabotage setStyle so loadMapPackage rejects after the factory
    // already returned a host map. Without the leak fix the
    // factory's dispose() would never run.
    map.setStyle = () => {
      throw new Error("style apply failed");
    };
    let factoryDisposed = 0;
    const workspace = new OperatorWorkspace({
      client: makeOperatorClient(),
      mapFactory: () => ({
        map,
        dispose: () => {
          factoryDisposed += 1;
        },
      }),
      mapLoadOptions: {
        client: new HonuaClient({
          baseUrl: "https://honua.example.test",
          fetchFn: async () => new Response("not used", { status: 200 }),
        }),
        skipCompatibilityCheck: true,
      },
    });
    workspace.map?.bindIntent("intent-leak");

    await expect(workspace.map!.loadPackage(makeMapPackage())).rejects.toMatchObject({
      name: "HonuaOperatorMapError",
    });
    expect(factoryDisposed).toBe(1);

    workspace.dispose();
    // dispose() must not double-dispose the already-released factory.
    expect(factoryDisposed).toBe(1);
  });

  it("substitutes the {amount} placeholder in plan.estimatedCost", () => {
    expect(resolveMessage(undefined, "plan.estimatedCost", { amount: "12.50" })).toBe("Estimated cost: 12.50");
    expect(DEFAULT_MESSAGES["plan.estimatedCost"]).toBe("Estimated cost: {amount}");
  });

  it("aborts an in-flight chat stream when the workspace is disposed", async () => {
    let observedAbort = false;
    let resolveSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    const client: OperatorClient = {
      operator: {
        async *chat(_text, signal): AsyncIterable<ChatChunk> {
          if (signal) {
            signal.addEventListener("abort", () => {
              observedAbort = true;
              resolveSlow();
            });
          }
          await slowGate;
          if (signal?.aborted) return;
          yield { turnId: "agent-1", delta: "late", done: true };
        },
        async clarify() {
          return makeIntent(false);
        },
        async getPlan(intentId) {
          return makePlan(intentId);
        },
        async revisePlan(intentId) {
          return makePlan(intentId);
        },
        async submitPlan() {
          return new FakeJobRun({ kind: "analysis" });
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
    const workspace = new OperatorWorkspace({ client });
    const send = workspace.chat.send("hello").catch(() => undefined);

    workspace.dispose();
    await send;

    expect(observedAbort).toBe(true);
  });
});

class PassiveJobRun implements IJobRun<ExecutionResult> {
  public readonly id = "op-passive";
  public readonly type = "operator-plan";
  public status: JobStatus = "accepted";
  public progress: JobProgress | undefined;
  public resultsCalls = 0;

  readonly #terminal: ExecutionResult;
  readonly #listeners = new Set<JobSnapshotListener<ExecutionResult>>();

  public constructor(terminal: ExecutionResult) {
    this.#terminal = terminal;
  }

  public async poll(): Promise<JobSnapshot<ExecutionResult>> {
    return { status: this.status, progress: this.progress };
  }

  // Passive: registers the listener but never drives snapshots on its own.
  // Mirrors `HonuaOgcProcessJobRun.watch`, which only adds the listener and
  // relies on `results()` / `runUntilTerminal` to perform the polling loop.
  public watch(listener: JobSnapshotListener<ExecutionResult>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async results(): Promise<{ outputs: Record<string, ExecutionResult> }> {
    this.resultsCalls += 1;
    this.status = "running";
    for (const listener of [...this.#listeners]) {
      listener({ status: this.status, progress: { percent: 25 } });
    }
    this.status = "successful";
    const outputs = { [OPERATOR_EXECUTION_OUTPUT_KEY]: this.#terminal };
    for (const listener of [...this.#listeners]) {
      listener({ status: this.status, result: { outputs } });
    }
    return { outputs };
  }

  public async cancel(): Promise<JobStatus> {
    this.status = "dismissed";
    return this.status;
  }
}

// Models a conforming `IJobRun` that satisfies the contract minimum:
// `cancel()` flips status to "dismissed" but `watch()` listeners are
// never invoked. Lets the cancel-terminal test prove the controller
// surfaces the dismissed event without relying on watcher delivery.
class SilentDismissJobRun implements IJobRun<ExecutionResult> {
  public readonly id = "op-silent-dismiss";
  public readonly type = "operator-plan";
  public status: JobStatus = "accepted";
  public progress: JobProgress | undefined;

  public async poll(): Promise<JobSnapshot<ExecutionResult>> {
    return { status: this.status, progress: this.progress };
  }

  public watch(): () => void {
    // Conforming-but-passive: never delivers a snapshot.
    return () => {};
  }

  public async results(): Promise<{ outputs: Record<string, ExecutionResult> }> {
    // Hold open until cancel() flips us terminal so results() never
    // resolves on its own; the test drives termination via cancel().
    await new Promise<void>(() => {
      // Resolves only when the surrounding test disposes; the unresolved
      // promise keeps the polling path quiet during the cancel window.
    });
    return { outputs: {} };
  }

  public async cancel(): Promise<JobStatus> {
    this.status = "dismissed";
    return this.status;
  }
}

function makeClientWithRun(run: IJobRun<ExecutionResult>): OperatorClient {
  return {
    operator: {
      async *chat(): AsyncIterable<ChatChunk> {
        yield { turnId: "agent-1", delta: "ok", done: true };
      },
      async clarify() {
        return makeIntent(false);
      },
      async getPlan(intentId) {
        return makePlan(intentId);
      },
      async revisePlan(intentId) {
        return makePlan(intentId);
      },
      async submitPlan() {
        return run;
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

function makeFailingSubmitClient(failure: Error): OperatorClient {
  return {
    operator: {
      async *chat(): AsyncIterable<ChatChunk> {
        yield { turnId: "agent-1", delta: "ok", done: true };
      },
      async clarify() {
        return makeIntent(false);
      },
      async getPlan(intentId) {
        return makePlan(intentId);
      },
      async revisePlan(intentId) {
        return makePlan(intentId);
      },
      async submitPlan() {
        throw failure;
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

function makeRefiningClient(refined: HonuaMapPackage): OperatorClient {
  return {
    operator: {
      async *chat(): AsyncIterable<ChatChunk> {
        yield { turnId: "agent-1", delta: "ok", done: true };
      },
      async clarify() {
        return makeIntent(false);
      },
      async getPlan(intentId) {
        return makePlan(intentId);
      },
      async revisePlan(intentId) {
        return makePlan(intentId);
      },
      async submitPlan() {
        return new FakeJobRun({ kind: "analysis" });
      },
      async refineMap() {
        return refined;
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
