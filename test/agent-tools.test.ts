import { describe, expect, it } from "vitest";

import {
  HONUA_AGENT_TOOL_NAMES,
  type HonuaAgentAuditEvent,
  type HonuaAgentRuntime,
  type HonuaAgentViewport,
  createHonuaAgentToolExecutor,
  executeHonuaAgentTool,
  explainHonuaCapabilityGap,
} from "../src/agent-tools/index.js";
import { type FeatureSelectionTarget, sourceFeatureSelectionTarget } from "../src/exploration/index.js";

describe("@honua/sdk-js/agent-tools", () => {
  it("exports stable JSON-schema compatible tool definitions", () => {
    expect(HONUA_AGENT_TOOL_NAMES).toEqual([
      "inspectMap",
      "listSources",
      "listCapabilities",
      "setViewport",
      "addLayer",
      "setFilter",
      "selectFeature",
      "summarizeSelection",
      "runWidgetQuery",
      "explainCapabilityGap",
    ]);
  });

  it("runs read-only map inspection and capability tools without action opt-in", async () => {
    const runtime = makeRuntime();
    const execute = createHonuaAgentToolExecutor(runtime, {
      actor: "test-agent",
      now: () => "2026-05-11T00:00:00.000Z",
    });

    const snapshot = await execute({ name: "inspectMap", args: { includeSelection: true } });
    const capabilities = await execute({ name: "listCapabilities", args: { sourceId: "incidents" } });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.data).toMatchObject({
      appId: "ops",
      sources: [{ id: "incidents", protocol: "geoservices-feature-service" }],
      selection: [{ sourceId: "incidents", id: 1001 }],
    });
    expect(capabilities.data).toEqual([
      {
        sourceId: "incidents",
        protocol: "geoservices-feature-service",
        capabilities: ["query", "queryAggregate", "queryExtent", "queryObjectIds"],
      },
    ]);
  });

  it("denies mutating tools by default but allows dry-run", async () => {
    const runtime = makeRuntime();

    const denied = await executeHonuaAgentTool(runtime, {
      name: "setViewport",
      args: { center: [1, 2], zoom: 8 },
    });
    const dryRun = await executeHonuaAgentTool(runtime, {
      name: "setViewport",
      args: { center: [1, 2], zoom: 8, dryRun: true },
    });

    expect(denied).toMatchObject({
      status: "denied",
      deniedReason: 'Tool "setViewport" mutates runtime state and requires allowActions=true or dryRun=true.',
    });
    expect(dryRun).toMatchObject({
      status: "dry-run",
      data: { viewport: { center: [1, 2], zoom: 8 } },
    });
    expect(runtime.getViewport?.()).toEqual({ center: [0, 0], zoom: 4 });
  });

  it("executes allowed actions and emits audit events", async () => {
    const runtime = makeRuntime();
    const audit: HonuaAgentAuditEvent[] = [];
    const execute = createHonuaAgentToolExecutor(runtime, {
      actor: "planner",
      allowActions: true,
      now: () => "2026-05-11T00:00:00.000Z",
      onAudit: (event) => audit.push(event),
    });

    const viewport = await execute({ name: "setViewport", args: { bbox: [-1, -2, 3, 4] } });
    const selection = await execute({ name: "selectFeature", args: { sourceId: "incidents", id: 1005 } });

    expect(viewport.status).toBe("ok");
    expect(runtime.getViewport?.()).toEqual({ bbox: [-1, -2, 3, 4] });
    expect(selection.status).toBe("ok");
    expect(selection.data).toEqual([{ sourceId: "incidents", id: 1005 }]);
    expect(audit.map((event) => [event.tool, event.status, event.actor])).toEqual([
      ["setViewport", "ok", "planner"],
      ["selectFeature", "ok", "planner"],
    ]);
  });

  it("summarizes source-qualified and unqualified selections", async () => {
    const runtime = makeRuntime({
      selection: [sourceFeatureSelectionTarget("incidents", 1001), 2002, sourceFeatureSelectionTarget("assets", "A-1")],
    });

    const summary = await executeHonuaAgentTool(runtime, { name: "summarizeSelection", args: {} });

    expect(summary.data).toEqual({
      count: 3,
      bySource: [
        { sourceId: "incidents", count: 1 },
        { sourceId: "unqualified", count: 1 },
        { sourceId: "assets", count: 1 },
      ],
      targets: [{ sourceId: "incidents", id: 1001 }, 2002, { sourceId: "assets", id: "A-1" }],
    });
  });

  it("explains capability gaps from protocol defaults or source-declared capabilities", async () => {
    expect(explainHonuaCapabilityGap({ protocol: "wmts", capability: "query" })).toMatchObject({
      supported: false,
      protocol: "wmts",
      capability: "query",
    });
    expect(
      explainHonuaCapabilityGap({
        sourceId: "parcels",
        capability: "query",
        declaredCapabilities: ["query", "queryExtent"],
      }),
    ).toMatchObject({
      supported: true,
      sourceId: "parcels",
      capabilities: ["query", "queryExtent"],
    });
  });
});

function makeRuntime(
  overrides: {
    readonly selection?: ReadonlyArray<FeatureSelectionTarget>;
  } = {},
): HonuaAgentRuntime {
  let viewport: HonuaAgentViewport = { center: [0, 0], zoom: 4 };
  let selection = overrides.selection ?? [sourceFeatureSelectionTarget("incidents", 1001)];
  return {
    id: "ops",
    snapshot: () => ({
      appId: "ops",
      viewport,
      sources: [
        {
          id: "incidents",
          protocol: "geoservices-feature-service",
          capabilities: ["query", "queryAggregate", "queryExtent", "queryObjectIds"],
        },
      ],
      layers: [{ id: "incident-points", sourceId: "incidents", type: "circle", visible: true }],
      selection,
    }),
    getViewport: () => viewport,
    setViewport: (next) => {
      viewport = next;
    },
    selectFeature: (target, options) => {
      selection = options?.replace === false ? [...selection, target] : [target];
      return selection;
    },
  };
}
