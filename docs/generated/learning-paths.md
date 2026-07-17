# Learn the Honua SDK by task

Choose the outcome you need, then follow the linked guide and runnable implementation. The examples are the canonical executable source; this guide deliberately contains no copied implementation snippets.

API reference is SDK-owned at [https://honua-io.github.io/honua-sdk-js/api/](https://honua-io.github.io/honua-sdk-js/api/); the task narrative and deployed sample catalog are site-owned at [https://honua.io/samples](https://honua.io/samples).

These paths describe the SDK version in [`package.json`](../../package.json). Sample track, support, lifecycle, data, provenance, freshness, and degradation metadata comes from the [versioned sample catalog](../../samples/contract/v2/README.md); use the [installation and compatibility guide](../../INSTALL.md) when reading docs for another release.

## Execution labels

- **Fixture** (`fixture`): Deterministic committed data; no live-service claim.
- **Public live** (`public-live`): Reads a public standards endpoint without a Honua account.
- **Demo live** (`demo-live`): Can read the deployed demo.honua.io service when configured and reports availability and freshness.
- **Authenticated** (`authenticated`): Requires caller-supplied credentials; documentation never embeds a secret.
- **Degraded** (`degraded`): A reduced capability remains visible with a structured reason and recovery path.
- **Experimental** (`experimental`): Uses a pre-1.0 surface that may change in a minor release.

## Learning paths

### 1. Start with a public map

Open a public GeoServices endpoint and render useful data without an account.

Labels: `fixture` · `public-live`

- Guide: [docs/quickstart.md](../quickstart.md)
- Runnable example: [maplibre-quickstart](../../examples/maplibre-quickstart)
- Executable entry: [examples/maplibre-quickstart/src/workflow.ts](../../examples/maplibre-quickstart/src/workflow.ts)
- Example notes: [examples/maplibre-quickstart/README.md](../../examples/maplibre-quickstart/README.md)
- Compile check: `npm run demo:quickstart:typecheck`
- Sample contract: `golden` · `supported` · `active`
- Data and auth: `hybrid` · `anonymous`
- Provenance: Versioned First Map fixture scenarios or one configured anonymous public endpoint, with protocol and source identity recorded at runtime.
- Freshness: SDK observation time and cache status are shown; unavailable source validity time is stated explicitly.
- Catalog degradation: Capability misses, plan warnings, and bounded fallback are shown rather than silently returning an empty map.
- Live sample: [sample-expr-builder.html](https://honua.io/sample-expr-builder.html) · [demo.html](https://honua.io/demo.html)
- Supported API imports: `@honua/sdk-js` (`createHonua`); `@honua/sdk-js/runtime` (`maplibreRenderer`)
- honua.io journey: `connect-existing-gis`

### 2. Connect and inspect sources

Discover services, layers, schemas, and capability gaps before choosing a workflow.

Labels: `fixture` · `demo-live` · `authenticated` · `degraded`

- Guide: [docs/shared-client-contract.md](../shared-client-contract.md)
- Runnable example: [service-explorer](../../examples/service-explorer)
- Executable entry: [examples/service-explorer/src/data.ts](../../examples/service-explorer/src/data.ts)
- Example notes: [examples/service-explorer/README.md](../../examples/service-explorer/README.md)
- Compile check: `npm run demo:service-explorer:typecheck`
- Sample contract: `lab` · `supported` · `rework`
- Data and auth: `hybrid` · `api-key`
- Provenance: Committed multi-protocol catalog or configured Honua catalog.
- Freshness: Metadata cache and live observation timestamps.
- Catalog degradation: Unavailable admin metadata falls back to service discovery with a visible diagnostic.
- Live sample: [sample-service-explorer.html](https://honua.io/sample-service-explorer.html)
- Supported API imports: `@honua/sdk-js/contract` (`createDataset`); `@honua/sdk-js/honua` (`HonuaClient`)
- honua.io journey: `connect-existing-gis`
- Degradation: The current shell still uses the 0.1.x app-workspace compatibility shim; #399 owns its supported-import migration.

### 3. Query from Node or browser code

Issue bounded queries, inspect typed results, and keep capability failures explicit.

Labels: `fixture` · `demo-live` · `authenticated` · `degraded`

- Guide: [docs/composition.md](../composition.md)
- Runnable example: [node-backend-quickstart](../../examples/node-backend-quickstart)
- Executable entry: [examples/node-backend-quickstart/src/server.ts](../../examples/node-backend-quickstart/src/server.ts)
- Example notes: [examples/node-backend-quickstart/README.md](../../examples/node-backend-quickstart/README.md)
- Compile check: `npm run demo:node-backend:typecheck`
- Sample contract: `recipe` · `supported` · `active`
- Data and auth: `hybrid` · `api-key`
- Provenance: Committed mock responses or configured Honua endpoint.
- Freshness: Fixture replay or live query observation time.
- Catalog degradation: The recipe fails explicitly when required server capabilities are absent.
- Supported API imports: `@honua/sdk-js/honua` (`HonuaClient`, `QueryBuilder`)
- honua.io journey: `query-map-style`
- Degradation: The live endpoint may omit requested query capabilities; the sample keeps the typed capability error visible.

### 4. Connect, explain, and map query results

Connect, discover, explain, query, and mount one source with linked MapLibre views and visible runtime evidence.

Labels: `fixture` · `public-live`

- Guide: [docs/quickstart.md](../quickstart.md)
- Runnable example: [maplibre-quickstart](../../examples/maplibre-quickstart)
- Executable entry: [examples/maplibre-quickstart/src/workflow.ts](../../examples/maplibre-quickstart/src/workflow.ts)
- Example notes: [examples/maplibre-quickstart/README.md](../../examples/maplibre-quickstart/README.md)
- Compile check: `npm run demo:quickstart:typecheck`
- Sample contract: `golden` · `supported` · `active`
- Data and auth: `hybrid` · `anonymous`
- Provenance: Versioned First Map fixture scenarios or one configured anonymous public endpoint, with protocol and source identity recorded at runtime.
- Freshness: SDK observation time and cache status are shown; unavailable source validity time is stated explicitly.
- Catalog degradation: Capability misses, plan warnings, and bounded fallback are shown rather than silently returning an empty map.
- Live sample: [sample-expr-builder.html](https://honua.io/sample-expr-builder.html) · [demo.html](https://honua.io/demo.html)
- Supported API imports: `@honua/sdk-js` (`createHonua`); `@honua/sdk-js/runtime` (`maplibreRenderer`)
- honua.io journey: `query-map-style`

### 5. Analyze linked spatial views

Keep map, table, chart, and spatial aggregation state aligned with visible fallback evidence.

Labels: `fixture` · `experimental` · `degraded`

- Guide: [docs/warehouse-analytics-sources.md](../warehouse-analytics-sources.md)
- Runnable example: [spatial-analytics-workbench](../../examples/spatial-analytics-workbench)
- Executable entry: [examples/spatial-analytics-workbench/src/main.ts](../../examples/spatial-analytics-workbench/src/main.ts)
- Example notes: [examples/spatial-analytics-workbench/README.md](../../examples/spatial-analytics-workbench/README.md)
- Compile check: `npm run demo:spatial-analytics:typecheck`
- Sample contract: `lab` · `experimental` · `rework`
- Data and auth: `hybrid` · `anonymous`
- Provenance: Committed analysis fixtures or a configured public GeoServices source.
- Freshness: Fixture replay uses a fixed observation; configured live execution records its observation time.
- Catalog degradation: Remote fixtures are labeled replayed, bounded-local execution is capped, unsafe materialization is rejected, and OGC/DuckDB planner execution is a structured #389 follow-on.
- Live sample: [demo-analyst-workbench.html](https://honua.io/demo-analyst-workbench.html) · [sample-spatial-analytics.html](https://honua.io/sample-spatial-analytics.html)
- Supported API imports: `@honua/sdk-js/contract` (`resolveSpatialAggregationWidgetSummary`); `@honua/sdk-js/exploration` (`createExplorationContext`)
- honua.io journey: `linked-large-data-analysis`
- Degradation: The current shell still uses the 0.1.x app-workspace compatibility shim; #399 owns its supported-import migration.

### 6. Edit with recovery and capability checks

Apply optimistic edits, attachments, and conflict recovery without hiding unsupported mutations.

Labels: `fixture` · `degraded`

- Guide: [docs/shared-client-contract.md](../shared-client-contract.md)
- Runnable example: [edit-workflow-demo](../../examples/edit-workflow-demo)
- Executable entry: [examples/edit-workflow-demo/src/main.ts](../../examples/edit-workflow-demo/src/main.ts)
- Example notes: [examples/edit-workflow-demo/README.md](../../examples/edit-workflow-demo/README.md)
- Compile check: `npm run demo:edit-workflow:typecheck`
- Sample contract: `recipe` · `supported` · `rework`
- Data and auth: `fixture` · `none`
- Provenance: Committed deterministic edit fixture.
- Freshness: Deterministic fixture replay time.
- Catalog degradation: Editing is read-only when the service does not advertise mutation capability.
- Live sample: [demo-editing.html](https://honua.io/demo-editing.html)
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
- Sample contract: `lab` · `supported` · `active`
- Data and auth: `hybrid` · `anonymous`
- Provenance: Deployed demo stream when advertised; otherwise visibly labeled deterministic replay. Edits are limited to an isolated resettable fixture profile.
- Freshness: Snapshot, observation, and event times plus cursor, sequence, lag, reconnect, deduplication, and reconciliation outcomes.
- Catalog degradation: Unavailable live capability becomes a visibly labeled read-only replay; stale/offline state disables mutation, and live writes fail closed without an isolated resettable profile.
- Live sample: [demo-public-safety.html](https://honua.io/demo-public-safety.html)
- Supported API imports: `@honua/sdk-js/realtime` (`createRealtimeServerSentEventsTransport`)
- honua.io journey: `realtime-operations`
- Degradation: The production offline persistence path is not complete; reconnect and stale-state behavior remains explicit while fixture replay stays deterministic.

### 8. Add terrain and 3D context

Progress from stable 2D map primitives to an explicitly experimental 2.5D/3D experience.

Labels: `fixture` · `authenticated` · `experimental` · `degraded`

- Guide: [docs/scene-workspace.md](../scene-workspace.md)
- Runnable example: [storytelling-25d-map](../../examples/storytelling-25d-map)
- Executable entry: [examples/storytelling-25d-map/src/map.ts](../../examples/storytelling-25d-map/src/map.ts)
- Example notes: [examples/storytelling-25d-map/README.md](../../examples/storytelling-25d-map/README.md)
- Compile check: `npm run demo:25d:typecheck`
- Sample contract: `lab` · `supported` · `merge`
- Data and auth: `hybrid` · `api-key`
- Provenance: Committed Oahu story fixtures or configured Honua services.
- Freshness: Fixture capture or live layer observation time.
- Catalog degradation: Terrain and live overlays fail independently with structured status.
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
- Sample contract: `lab` · `supported` · `active`
- Data and auth: `fixture` · `none`
- Provenance: Committed ArcGIS source fixtures and migration reports.
- Freshness: Versioned with the migration corpus.
- Catalog degradation: Unsupported ArcGIS modules are reported as manual work, never silently removed.
- Live sample: [sample-codemod.html](https://honua.io/sample-codemod.html)
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
- Sample contract: `lab` · `experimental` · `rework`
- Data and auth: `fixture` · `none`
- Provenance: Committed MCP response fixture.
- Freshness: Deterministic fixture replay time.
- Catalog degradation: Write tools are unavailable without host policy and explicit approval.
- Supported API imports: `@honua/sdk-js/agent-tools` (`HONUA_AGENT_TOOL_DEFINITIONS`, `createHonuaAgentToolExecutor`)
- honua.io journey: `safe-agent-automation`
- Degradation: The current assistant shell still uses the app-workspace compatibility surface, and write execution stays disabled without explicit host approval.

## Publication boundary

- Guides link to runnable example source and never maintain a copied implementation snippet.
- Repository documentation uses relative links; canonical API and site narrative links use the declared owners.
- Site consumers join the [learning navigation manifest](../learning-paths.v1.json) to the [static sample projection](../../samples/dist/honua-site-samples.v2.json) by `sampleId`; catalog-owned metadata is not copied into another source file.
- Sample metadata and evidence are owned by [SDK issue #540](https://github.com/honua-io/honua-sdk-js/issues/540); the generated consumer projection is coordinated by [SDK issue #550](https://github.com/honua-io/honua-sdk-js/issues/550).
