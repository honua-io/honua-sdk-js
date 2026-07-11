# Honua AI Map Kit

`@honua/sdk-js/agent-tools` exposes a provider-ready AI map kit for bounded
map assistants. It reuses the existing Honua agent tool schemas and executor,
then adds:

- `createHonuaAiMapKit` factory for runtime, `HonuaController`, or generated-app runtime bindings.
- MCP-compatible and OpenAI-compatible JSON Schema tool converters.
- semantic map context and system prompt helpers.
- policy controls for read-only/dry-run mode, allowed tools, source/layer allowlists, max result limits, and audit sinks.

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createHonuaAiMapKit } from "@honua/sdk-js/agent-tools";

const kit = createHonuaAiMapKit({
  controller,
  providerFormat: "mcp",
  policy: {
    actor: "planning-agent",
    allowActions: true,
    allowedTools: ["inspectMap", "setFilter", "selectFeature", "runWidgetQuery"],
    allowedSourceIds: ["incidents"],
    maxResults: 25,
    onAudit: (event) => auditLog.write(event),
  },
});

const tools = kit.providerTools;
const systemPrompt = await kit.systemPrompt();
const result = await kit.execute({
  name: "setFilter",
  args: {
    id: "status",
    clause: { field: "status", operator: "=", value: "open", appliesTo: ["incidents"] },
  },
});
```

Action tools require `allowActions: true` unless a tool call or policy uses
`dryRun: true`. Every call emits an audit event with actor, tool, action/dry-run
state, source/layer/target ids when available, and an allowed/denied/dry-run/error
outcome.

Semantic context is bounded by default and omits secret-like metadata keys. When
realtime or snapshot metadata is present, context includes the snapshot timestamp
and source version so agents do not treat stale state as current.
