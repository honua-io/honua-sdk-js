import { describe, expect, it } from "vitest";

import {
  HONUA_AGENT_TOOL_NAMES,
  type HonuaAgentAuditEvent,
  type HonuaAgentRuntime,
  type HonuaAgentToolCall,
  type HonuaAgentViewport,
  convertHonuaAgentToolDefinitions,
  createHonuaAgentMapContext,
  createHonuaAgentToolExecutor,
  createHonuaAiMapKit,
  executeHonuaAgentTool,
  explainHonuaCapabilityGap,
  getHonuaAgentToolDefinition,
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
      "setLayerStyle",
      "addWidget",
      "removeWidget",
      "bindInteraction",
      "removeInteraction",
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

  it("redacts secret metadata from inspectMap and listSources tool results", async () => {
    const runtime = makeRuntime();

    const inspect = await executeHonuaAgentTool(runtime, { name: "inspectMap", args: {} });
    expect(inspect.status).toBe("ok");
    expect(JSON.stringify(inspect)).not.toContain("secret");
    // Non-secret metadata is preserved.
    expect(JSON.stringify(inspect)).toContain("owner");

    const list = await executeHonuaAgentTool(runtime, { name: "listSources", args: {} });
    expect(list.status).toBe("ok");
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(JSON.stringify(list)).toContain("owner");
  });

  it("deeply redacts connection strings and nested credentials from tool results", async () => {
    const runtime = makeRuntime();
    const inspect = await executeHonuaAgentTool(runtime, { name: "inspectMap", args: {} });
    expect(inspect.status).toBe("ok");
    const serialized = JSON.stringify(inspect);

    // Top-level connection string is dropped.
    expect(serialized).not.toContain("connectionString");
    expect(serialized).not.toContain("hunter2");
    // Nested credential objects are dropped, not copied whole.
    expect(serialized).not.toContain("p4ss");
    expect(serialized).not.toContain("tok_abc123");
    // Non-secret nested fields survive the recursion.
    expect(serialized).toContain("db.internal");
  });

  describe("composition verbs", () => {
    const interaction = {
      id: "select-parcel-filters-chart",
      on: { ref: "layer:parcels", event: "featureSelect" },
      do: { ref: "widget:area-chart", verb: "setFilter", args: { field: "parcelId", value: "$event.featureId" } },
    } as const;

    it("declares all five as action tools requiring opt-in", () => {
      for (const name of [
        "setLayerStyle",
        "addWidget",
        "removeWidget",
        "bindInteraction",
        "removeInteraction",
      ] as const) {
        expect(getHonuaAgentToolDefinition(name)).toMatchObject({ mode: "action", requiresOptIn: true });
      }
    });

    it("publishes the standard's closed event and verb sets in the bindInteraction schema", () => {
      const schema = getHonuaAgentToolDefinition("bindInteraction").inputSchema;
      const shape = schema.properties?.interaction;
      expect(shape?.properties?.on?.properties?.event?.enum).toEqual([
        "featureSelect",
        "featureHover",
        "selection",
        "change",
        "viewportChange",
      ]);
      expect(shape?.properties?.do?.properties?.verb?.enum).toEqual([
        "setFilter",
        "setViewport",
        "selectFeature",
        "runWidgetQuery",
        "setVisibility",
      ]);
    });

    it("denies each verb without action opt-in and dry-runs each with it", async () => {
      const runtime = makeCompositionRuntime();
      const calls: HonuaAgentToolCall[] = [
        { name: "setLayerStyle", args: { layerId: "parcels", styleRef: "style:parcels-choropleth" } },
        { name: "addWidget", args: { widget: { id: "area-chart", kind: "chart", sourceId: "incidents" } } },
        { name: "removeWidget", args: { widgetId: "area-chart" } },
        { name: "bindInteraction", args: { interaction } },
        { name: "removeInteraction", args: { interactionId: interaction.id } },
      ];

      for (const call of calls) {
        const denied = await executeHonuaAgentTool(runtime, call);
        expect(denied.status).toBe("denied");
        expect(denied.deniedReason).toContain("requires allowActions=true or dryRun=true");

        const dry = await executeHonuaAgentTool(runtime, {
          ...call,
          args: { ...(call as unknown as { args: Record<string, unknown> }).args, dryRun: true },
        } as HonuaAgentToolCall);
        expect(dry.status).toBe("dry-run");
      }
      expect(runtime.log).toEqual([]);
    });

    it("executes each verb against a runtime that implements it and audits the target ids", async () => {
      const runtime = makeCompositionRuntime();
      const audit: HonuaAgentAuditEvent[] = [];
      const execute = createHonuaAgentToolExecutor(runtime, {
        allowActions: true,
        onAudit: (event) => audit.push(event),
      });

      const style = await execute({
        name: "setLayerStyle",
        args: { layerId: "parcels", styleRef: "style:choropleth" },
      });
      const added = await execute({
        name: "addWidget",
        args: { widget: { id: "area-chart", kind: "chart", sourceId: "incidents" } },
      });
      const removed = await execute({ name: "removeWidget", args: { widgetId: "area-chart" } });
      const bound = await execute({ name: "bindInteraction", args: { interaction } });
      const unbound = await execute({ name: "removeInteraction", args: { interactionId: interaction.id } });

      expect([style, added, removed, bound, unbound].map((result) => result.status)).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
      ]);
      expect(runtime.log).toEqual([
        "setLayerStyle:parcels:style:choropleth",
        "addWidget:area-chart",
        "removeWidget:area-chart",
        `bindInteraction:${interaction.id}`,
        `removeInteraction:${interaction.id}`,
      ]);
      expect(audit.map((event) => [event.tool, event.action, event.targetIds])).toEqual([
        ["setLayerStyle", true, ["parcels"]],
        ["addWidget", true, ["area-chart", "incidents"]],
        ["removeWidget", true, ["area-chart"]],
        ["bindInteraction", true, [interaction.id]],
        ["removeInteraction", true, [interaction.id]],
      ]);
    });

    it("returns the structured error envelope when the runtime lacks the capability, never a raw throw", async () => {
      // A runtime with none of the five optional composition methods.
      const bare = makeRuntime();
      for (const call of [
        { name: "setLayerStyle", args: { layerId: "parcels", styleRef: "s" } },
        { name: "addWidget", args: { widget: { id: "w", kind: "chart" } } },
        { name: "removeWidget", args: { widgetId: "w" } },
        { name: "bindInteraction", args: { interaction } },
        { name: "removeInteraction", args: { interactionId: interaction.id } },
      ] as HonuaAgentToolCall[]) {
        const result = await executeHonuaAgentTool(bare, call, { allowActions: true });
        expect(result.status).toBe("error");
        expect(result.audit.outcome).toBe("error");
        expect(result.data).toMatchObject({ message: expect.stringContaining("does not implement tool") });
      }
    });

    it("rejects an interaction that breaks the standard before the runtime sees it", async () => {
      const runtime = makeCompositionRuntime();
      const badVerb = await executeHonuaAgentTool(
        runtime,
        {
          name: "bindInteraction",
          args: {
            interaction: {
              id: "bad",
              on: { ref: "layer:parcels", event: "featureSelect" },
              // `zoomTo` is not in the standard's closed verb set.
              do: { ref: "map", verb: "zoomTo" },
            },
          },
        } as unknown as HonuaAgentToolCall,
        { allowActions: true },
      );
      const badArgs = await executeHonuaAgentTool(
        runtime,
        {
          name: "bindInteraction",
          args: {
            interaction: {
              id: "bad-args",
              on: { ref: "layer:parcels", event: "featureSelect" },
              // No expression language: `$event.a + 1` is not a substitution path.
              do: { ref: "widget:chart", verb: "setFilter", args: { value: "$event.a + 1" } },
            },
          },
        } as unknown as HonuaAgentToolCall,
        { allowActions: true },
      );

      expect(badVerb.status).toBe("error");
      expect((badVerb.data as { issues: Array<{ code: string }> }).issues[0]?.code).toBe("unknown-verb");
      expect(badArgs.status).toBe("error");
      expect((badArgs.data as { issues: Array<{ code: string }> }).issues[0]?.code).toBe("invalid-event-path");
      expect(runtime.log).toEqual([]);
    });

    it("gates addWidget on the widget's nested sourceId", async () => {
      const runtime = makeCompositionRuntime();
      const execute = createHonuaAgentToolExecutor(runtime, {
        allowActions: true,
        allowedSourceIds: ["incidents"],
      });

      const blocked = await execute({
        name: "addWidget",
        args: { widget: { id: "leak", kind: "chart", sourceId: "restricted" } },
      });

      expect(blocked.status).toBe("denied");
      expect(blocked.deniedReason).toContain('Source "restricted"');
      expect(runtime.log).toEqual([]);
    });
  });
});

interface CompositionRuntime extends HonuaAgentRuntime {
  readonly log: string[];
}

function makeCompositionRuntime(): CompositionRuntime {
  const log: string[] = [];
  return {
    ...makeRuntime(),
    log,
    setLayerStyle: (layerId, style) => {
      log.push(`setLayerStyle:${layerId}:${style.styleRef ?? "inline"}`);
      return { layerId, ...style };
    },
    addWidget: (widget) => {
      log.push(`addWidget:${widget.id}`);
      return widget;
    },
    removeWidget: (widgetId) => {
      log.push(`removeWidget:${widgetId}`);
      return { widgetId };
    },
    bindInteraction: (interaction) => {
      log.push(`bindInteraction:${interaction.id}`);
      return interaction;
    },
    removeInteraction: (interactionId) => {
      log.push(`removeInteraction:${interactionId}`);
      return { interactionId };
    },
  };
}

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
          metadata: {
            apiKey: "secret",
            owner: "ops",
            // Top-level connection string and nested secret-bearing objects
            // must both be scrubbed before the snapshot reaches an LLM.
            connectionString: "postgres://admin:hunter2@db.internal/incidents",
            database: { connectionString: "postgres://svc:p4ss@db/incidents", host: "db.internal" },
            auth: { bearer: "tok_abc123", scopes: ["read"] },
          },
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
