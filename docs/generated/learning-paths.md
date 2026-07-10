# Learn the Honua SDK by task

Choose the outcome you need, then follow the linked guide and runnable implementation. The examples are the canonical executable source; this guide deliberately contains no copied implementation snippets.

API reference is SDK-owned at [https://honua-io.github.io/honua-sdk-js/api/](https://honua-io.github.io/honua-sdk-js/api/); the task narrative and deployed sample catalog are site-owned at [https://honua.io/samples](https://honua.io/samples).

## Execution labels

- **Fixture** (`fixture`): Deterministic committed data; no live-service claim.
- **Public live** (`public-live`): Reads a public standards endpoint without a Honua account.
- **Demo live** (`demo-live`): Reads the deployed demo.honua.io service and reports availability and freshness.
- **Authenticated** (`authenticated`): Requires caller-supplied credentials; documentation never embeds a secret.
- **Degraded** (`degraded`): A reduced capability remains visible with a structured reason and recovery path.
- **Experimental** (`experimental`): Uses a pre-1.0 surface that may change in a minor release.

## Learning paths

### 1. Start with a public map

Open a public GeoServices endpoint and render useful data without an account.

Labels: `fixture` · `public-live`

- Guide: [docs/standalone-quickstart.md](../standalone-quickstart.md)
- Runnable example: [standalone-quickstart](../../examples/standalone-quickstart)
- Executable entry: [examples/standalone-quickstart/src/main.ts](../../examples/standalone-quickstart/src/main.ts)
- Example notes: [examples/standalone-quickstart/README.md](../../examples/standalone-quickstart/README.md)
- Compile check: `npm run demo:standalone:typecheck`
- Supported API imports: `@honua/sdk-js/esri-compat` (`FeatureLayerCompat`); `@honua/sdk-js/honua` (`HonuaClient`); `@honua/sdk-js/map` (`loadHonuaFeatureServiceGeoJson`)
- honua.io journey: `connect-existing-gis`

### 2. Connect and inspect sources

Discover services, layers, schemas, and capability gaps before choosing a workflow.

Labels: `fixture` · `demo-live` · `degraded`

- Guide: [docs/shared-client-contract.md](../shared-client-contract.md)
- Runnable example: [service-explorer](../../examples/service-explorer)
- Executable entry: [examples/service-explorer/src/data.ts](../../examples/service-explorer/src/data.ts)
- Example notes: [examples/service-explorer/README.md](../../examples/service-explorer/README.md)
- Compile check: `npm run demo:service-explorer:typecheck`
- Supported API imports: `@honua/sdk-js/contract` (`createDataset`); `@honua/sdk-js/honua` (`HonuaClient`)
- honua.io journey: `connect-existing-gis`
- Degradation: The current shell still uses the 0.1.x app-workspace compatibility shim; #399 owns its supported-import migration.

### 3. Query from Node or browser code

Issue bounded queries, inspect typed results, and keep capability failures explicit.

Labels: `fixture` · `demo-live` · `degraded`

- Guide: [docs/composition.md](../composition.md)
- Runnable example: [node-backend-quickstart](../../examples/node-backend-quickstart)
- Executable entry: [examples/node-backend-quickstart/src/server.ts](../../examples/node-backend-quickstart/src/server.ts)
- Example notes: [examples/node-backend-quickstart/README.md](../../examples/node-backend-quickstart/README.md)
- Compile check: `npm run demo:node-backend:typecheck`
- Supported API imports: `@honua/sdk-js` (`QueryBuilder`); `@honua/sdk-js/honua` (`HonuaClient`)
- honua.io journey: `query-map-style`
- Degradation: The live endpoint may omit requested query capabilities; the sample keeps the typed capability error visible.

### 4. Map and style query results

Bind queried features to MapLibre with selection, popup, filter, and style behavior.

Labels: `fixture` · `demo-live`

- Guide: [docs/maplibre-runtime.md](../maplibre-runtime.md)
- Runnable example: [maplibre-quickstart](../../examples/maplibre-quickstart)
- Executable entry: [examples/maplibre-quickstart/src/main.ts](../../examples/maplibre-quickstart/src/main.ts)
- Example notes: [examples/maplibre-quickstart/README.md](../../examples/maplibre-quickstart/README.md)
- Compile check: `npm run demo:quickstart:typecheck`
- Supported API imports: `@honua/sdk-js/map` (`HonuaMap`); `@honua/sdk-js/style` (`validateHonuaStyle`)
- honua.io journey: `query-map-style`

### 5. Analyze linked spatial views

Keep map, table, chart, and spatial aggregation state aligned with visible fallback evidence.

Labels: `fixture` · `authenticated` · `degraded`

- Guide: [docs/warehouse-analytics-sources.md](../warehouse-analytics-sources.md)
- Runnable example: [spatial-analytics-workbench](../../examples/spatial-analytics-workbench)
- Executable entry: [examples/spatial-analytics-workbench/src/main.ts](../../examples/spatial-analytics-workbench/src/main.ts)
- Example notes: [examples/spatial-analytics-workbench/README.md](../../examples/spatial-analytics-workbench/README.md)
- Compile check: `npm run demo:spatial-analytics:typecheck`
- Supported API imports: `@honua/sdk-js/contract` (`resolveSpatialAggregationWidgetSummary`); `@honua/sdk-js/exploration` (`createExplorationContext`)
- honua.io journey: `linked-large-data-analysis`
- Degradation: The current shell still uses the 0.1.x app-workspace compatibility shim; #399 owns its supported-import migration.

### 6. Edit with recovery and capability checks

Apply optimistic edits, attachments, and conflict recovery without hiding unsupported mutations.

Labels: `fixture` · `authenticated` · `degraded`

- Guide: [docs/shared-client-contract.md](../shared-client-contract.md)
- Runnable example: [edit-workflow-demo](../../examples/edit-workflow-demo)
- Executable entry: [examples/edit-workflow-demo/src/main.ts](../../examples/edit-workflow-demo/src/main.ts)
- Example notes: [examples/edit-workflow-demo/README.md](../../examples/edit-workflow-demo/README.md)
- Compile check: `npm run demo:edit-workflow:typecheck`
- Supported API imports: `@honua/sdk-js/contract` (`createEditSession`); `@honua/sdk-js/honua` (`HonuaCapabilityNotSupportedError`)
- honua.io journey: `realtime-operations`
- Degradation: The current shell still uses the 0.1.x app-workspace compatibility shim, and mutations become read-only when capability or auth is absent.

### 7. Operate through realtime and offline transitions

Reconcile snapshots and deltas while showing reconnect, staleness, and deterministic fixture fallback.

Labels: `fixture` · `demo-live` · `degraded`

- Guide: [docs/realtime-subscriptions.md](../realtime-subscriptions.md)
- Runnable example: [realtime-incident-dashboard](../../examples/realtime-incident-dashboard)
- Executable entry: [examples/realtime-incident-dashboard/src/realtime-transport.ts](../../examples/realtime-incident-dashboard/src/realtime-transport.ts)
- Example notes: [examples/realtime-incident-dashboard/README.md](../../examples/realtime-incident-dashboard/README.md)
- Compile check: `npm run demo:incident:typecheck`
- Supported API imports: `@honua/sdk-js/realtime` (`createRealtimeServerSentEventsTransport`)
- honua.io journey: `realtime-operations`
- Degradation: The production offline persistence path is not complete; reconnect and stale-state behavior remains explicit while fixture replay stays deterministic.

### 8. Add terrain and 3D context

Progress from stable 2D map primitives to an explicitly experimental 2.5D/3D experience.

Labels: `fixture` · `experimental` · `degraded`

- Guide: [docs/scene-workspace.md](../scene-workspace.md)
- Runnable example: [storytelling-25d-map](../../examples/storytelling-25d-map)
- Executable entry: [examples/storytelling-25d-map/src/map.ts](../../examples/storytelling-25d-map/src/map.ts)
- Example notes: [examples/storytelling-25d-map/README.md](../../examples/storytelling-25d-map/README.md)
- Compile check: `npm run demo:25d:typecheck`
- Supported API imports: `@honua/sdk-js/map` (`HonuaMap`); `@honua/sdk-js/runtime` (`HonuaMapRuntime`)
- honua.io journey: `imagery-terrain-3d`
- Degradation: The runnable 2.5D shell still reaches the scene-workspace compatibility surface; stable map/runtime imports are the taught foundation until #399 migrates it.

### 9. Migrate an ArcGIS application

Scan and transform one file at a time with explicit compatibility evidence and manual gaps.

Labels: `fixture` · `public-live` · `degraded`

- Guide: [docs/migration-honua-maplibre.md](../migration-honua-maplibre.md)
- Runnable example: [migration-workbench](../../examples/migration-workbench)
- Executable entry: [examples/migration-workbench/src/main.ts](../../examples/migration-workbench/src/main.ts)
- Example notes: [docs/migration-honua-maplibre.md](../migration-honua-maplibre.md)
- Compile check: `npm run demo:migration-workbench:typecheck`
- Supported API imports: `@honua/sdk-js/migration` (`runEsriCompatCodemod`, `scanArcGisUsage`)
- honua.io journey: `migrate-arcgis`
- Degradation: Unsupported ArcGIS modules remain manual migration work and are reported rather than removed silently.

### 10. Automate safely with agent tools

Expose bounded map actions with capability explanations while keeping writes behind host approval.

Labels: `fixture` · `experimental` · `degraded`

- Guide: [docs/ai-map-kit.md](../ai-map-kit.md)
- Runnable example: [mcp-gis-assistant](../../examples/mcp-gis-assistant)
- Executable entry: [examples/mcp-gis-assistant/src/assistant.ts](../../examples/mcp-gis-assistant/src/assistant.ts)
- Example notes: [examples/mcp-gis-assistant/README.md](../../examples/mcp-gis-assistant/README.md)
- Compile check: `npm run demo:mcp-gis-assistant:typecheck`
- Supported API imports: `@honua/sdk-js/agent-tools` (`HONUA_AGENT_TOOL_DEFINITIONS`, `createHonuaAgentToolExecutor`)
- honua.io journey: `safe-agent-automation`
- Degradation: The current assistant shell still uses the app-workspace compatibility surface, and write execution stays disabled without explicit host approval.

## Publication boundary

- Guides link to runnable example source and never maintain a copied implementation snippet.
- Repository documentation uses relative links; canonical API and site narrative links use the declared owners.
- Sample metadata/artifact/evidence projection is coordinated by [SDK issue #401](https://github.com/honua-io/honua-sdk-js/issues/401) and [honua-site issue #120](https://github.com/honua-io/honua-site/issues/120).
