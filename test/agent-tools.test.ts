import { describe, expect, it } from "vitest";

import {
  HONUA_AGENT_TOOL_NAMES,
  type HonuaAgentAuditEvent,
  type HonuaAgentRuntime,
  type HonuaAgentViewport,
  convertHonuaAgentToolDefinitions,
  createHonuaAgentMapContext,
  createHonuaAgentToolExecutor,
  createHonuaAiMapKit,
  executeHonuaAgentTool,
  explainHonuaCapabilityGap,
  toHonuaMcpToolDefinitions,
  toHonuaOpenAiToolDefinitions,
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

  it("converts definitions to provider-neutral MCP and OpenAI tool shapes", () => {
    const mcpTools = toHonuaMcpToolDefinitions();
    const openAiTools = toHonuaOpenAiToolDefinitions();

    expect(mcpTools).toHaveLength(HONUA_AGENT_TOOL_NAMES.length);
    expect(mcpTools[0]).toMatchObject({
      name: "inspectMap",
      inputSchema: { type: "object", additionalProperties: false },
    });
    expect(openAiTools[0]).toMatchObject({
      type: "function",
      function: { name: "inspectMap", parameters: { type: "object" } },
    });
    expect(convertHonuaAgentToolDefinitions(undefined, "mcp")).toEqual(mcpTools);
  });

  it("creates an AI map kit with policy guards, provider tools, bounded context, and audits", async () => {
    const runtime = makeRuntime();
    const audit: HonuaAgentAuditEvent[] = [];
    const kit = createHonuaAiMapKit({
      runtime,
      providerFormat: "openai",
      tools: ["inspectMap", "setFilter", "runWidgetQuery", "selectFeature"],
      policy: {
        actor: "kit-agent",
        allowActions: true,
        allowedSourceIds: ["incidents"],
        maxResults: 2,
        now: () => "2026-05-11T00:00:00.000Z",
        onAudit: (event) => audit.push(event),
      },
      context: { now: () => "2026-05-11T00:00:00.000Z" },
    });

    expect(kit.providerTools[0]).toMatchObject({ type: "function" });
    expect(kit.mcpTools.map((tool) => tool.name)).toEqual([
      "inspectMap",
      "setFilter",
      "selectFeature",
      "runWidgetQuery",
    ]);

    const denied = await kit.execute({
      name: "selectFeature",
      args: { sourceId: "restricted", id: "blocked" },
    });
    const widget = await kit.execute({
      name: "runWidgetQuery",
      args: { sourceId: "incidents", kind: "count", limit: 50 },
    });
    const selected = await kit.execute({
      name: "selectFeature",
      args: { sourceId: "incidents", id: 1008 },
    });
    const context = await kit.context({ maxSources: 1, maxLayers: 1, maxSelectionTargets: 1 });
    const prompt = await kit.systemPrompt({ maxSources: 1, maxLayers: 1, maxSelectionTargets: 1 });

    expect(denied.status).toBe("denied");
    expect(widget.status).toBe("ok");
    expect(widget.audit.parameters.limit).toBe(2);
    expect(selected.audit).toMatchObject({
      actor: "kit-agent",
      action: true,
      sourceId: "incidents",
      targetIds: ["1008", "incidents"],
      outcome: "allowed",
    });
    expect(context).toMatchObject({
      appId: "ops",
      snapshotTimestamp: "2026-05-11T00:00:00.000Z",
      omitted: { sources: 0, layers: 0, selection: 0 },
    });
    expect(JSON.stringify(context)).not.toContain("secret");
    expect(prompt).toContain("Semantic map context");
    expect(audit.map((event) => event.outcome)).toEqual(["denied", "allowed", "allowed"]);
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
    expect(audit[1]).toMatchObject({ action: true, targetIds: ["1005", "incidents"], outcome: "allowed" });
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

  it("builds semantic map context without secret metadata", async () => {
    const context = await createHonuaAgentMapContext(makeRuntime(), {
      now: () => "2026-05-11T00:00:00.000Z",
    });

    expect(context.capabilities[0]?.sourceId).toBe("incidents");
    expect(context.capabilities[0]?.capabilities).toContain("query");
    expect(context.staleState).toContain("Snapshot timestamp");
    expect(JSON.stringify(context.sources)).not.toContain("apiKey");
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
      snapshotTimestamp: "2026-05-11T00:00:00.000Z",
      sourceVersion: "fixture:v1",
      viewport,
      sources: [
        {
          id: "incidents",
          protocol: "geoservices-feature-service",
          capabilities: ["query", "queryAggregate", "queryExtent", "queryObjectIds"],
          metadata: { apiKey: "secret", owner: "ops" },
        },
      ],
      layers: [{ id: "incident-points", sourceId: "incidents", type: "circle", visible: true }],
      selection,
      realtime: { mode: "snapshot" },
    }),
    getViewport: () => viewport,
    setViewport: (next) => {
      viewport = next;
    },
    selectFeature: (target, options) => {
      selection = options?.replace === false ? [...selection, target] : [target];
      return selection;
    },
    runWidgetQuery: (request) => ({
      sourceId: request.sourceId,
      kind: request.kind,
      data: { limit: request.limit ?? null },
    }),
  };
}
