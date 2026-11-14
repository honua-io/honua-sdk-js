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
- Provenance: Governed first-map/v2 fixture derived from the exact SHA-256-pinned 2025 U.S. Census Bureau TIGER/Line Hawaii tract archive, or the separate manifest-advertised anonymous live layer https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1; the live lane is not represented as Census-governed.
- Freshness: The immutable fixture records its 2025-01-01 source vintage; live SDK observation time and cache status are shown separately.
- Catalog degradation: Capability misses, plan warnings, and bounded fallback are shown rather than silently returning an empty map.
- Live sample: [sample-expr-builder.html](https://honua.io/sample-expr-builder.html) · [demo.html](https://honua.io/demo.html)
- Supported API imports: `@honua/sdk-js` (`createHonua`); `@honua/sdk-js/runtime` (`maplibreRenderer`)
- honua.io journey: `connect-existing-gis`

### 2. Connect and inspect sources

Discover services, layers, schemas, and capability gaps before choosing a workflow.

Labels: `fixture` · `public-live` · `degraded`

- Guide: [docs/shared-client-contract.md](../shared-client-contract.md)
- Runnable example: [service-explorer](../../examples/service-explorer)
- Executable entry: [examples/service-explorer/src/main.ts](../../examples/service-explorer/src/main.ts)
- Example notes: [examples/service-explorer/README.md](../../examples/service-explorer/README.md)
- Compile check: `npm run demo:service-explorer:typecheck`
- Sample contract: `golden` · `supported` · `active`
- Data and auth: `hybrid` · `anonymous`
- Provenance: Same-origin deterministic GeoServices and OGC fixtures, or a reviewed credential-free dual-protocol public producer when explicitly enabled.
- Freshness: Fixture replay is deterministic; a future scheduled public envelope records its observation time without changing feature-cache semantics.
- Catalog degradation: Partial discovery and unsupported source actions remain visible with structured state, code, and reason; the sample does not synthesize success.
- Live sample: [sample-service-explorer.html](https://honua.io/sample-service-explorer.html) · [demo-two-protocols.html](https://honua.io/demo-two-protocols.html)
- Supported API imports: `@honua/sdk-js` (`createHonua`, `executeQueryPlan`, `explainQuery`); `@honua/sdk-js/contract` (`PROTOCOLS`); `@honua/sdk-js/map` (`explainAutomaticSourceToMapLibre`, `projectSourceToMapLibre`)
- honua.io journey: `connect-existing-gis`
- Degradation: Partial discovery and unsupported source actions remain visible with structured state, code, and reason; the sample does not synthesize success.

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
- Provenance: Governed first-map/v2 fixture derived from the exact SHA-256-pinned 2025 U.S. Census Bureau TIGER/Line Hawaii tract archive, or the separate manifest-advertised anonymous live layer https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1; the live lane is not represented as Census-governed.
- Freshness: The immutable fixture records its 2025-01-01 source vintage; live SDK observation time and cache status are shown separately.
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
- Sample contract: `lab` · `experimental` · `active`
- Data and auth: `hybrid` · `anonymous`
- Provenance: Committed analysis fixtures or a configured public GeoServices source.
- Freshness: Fixture replay uses a fixed observation; configured live execution records its observation time.
- Catalog degradation: Remote fixtures are labeled replayed, bounded-local execution is capped, unsafe materialization is rejected, and OGC/DuckDB planner execution is a structured #389 follow-on.
- Live sample: [demo-analyst-workbench.html](https://honua.io/demo-analyst-workbench.html) · [demo-geoprocessing.html](https://honua.io/demo-geoprocessing.html) · [sample-spatial-analytics.html](https://honua.io/sample-spatial-analytics.html)
- Supported API imports: `@honua/sdk-js/contract` (`resolveSpatialAggregationWidgetSummary`); `@honua/sdk-js/exploration` (`createExplorationContext`)
- honua.io journey: `linked-large-data-analysis`
- Degradation: The current shell still uses the app-workspace compatibility shim retained through 0.3.x and removed in 0.4.0; #399 owns its supported-import migration.

### 6. Edit with sketching, snapping, and undo

Draw, snap, undo, and submit edits through the SDK sketch workflow without hiding unsupported operations.

Labels: `fixture` · `experimental` · `degraded`

- Guide: [docs/terra-draw-sketch.md](../terra-draw-sketch.md)
- Runnable example: [sketch-editing](../../examples/sketch-editing)
- Executable entry: [examples/sketch-editing/src/main.ts](../../examples/sketch-editing/src/main.ts)
- Example notes: [examples/sketch-editing/README.md](../../examples/sketch-editing/README.md)
- Compile check: `npm run demo:sketch-editing:typecheck`
- Sample contract: `recipe` · `experimental` · `active`
- Data and auth: `fixture` · `none`
- Provenance: Committed deterministic harbor-parcel fixture.
- Freshness: Deterministic fixture replay time.
- Catalog degradation: Sketch tools report unsupported capabilities when terra-draw is not installed; the SDK works without the optional peer.
- Live sample: [demo-editing.html](https://honua.io/demo-editing.html)
- Supported API imports: `@honua/sdk-js/contract` (`createEditSketchWorkflow`, `createSnapIndex`); `@honua/sdk-js/runtime` (`createTerraDrawSketch`)
- honua.io journey: `query-map-style`
- Degradation: The sketch workflow edits a committed fixture parcel source; deterministic fixture output is never presented as live evidence.

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

### 8. Add imagery and terrain context

Progress from stable 2D map primitives to STAC imagery, bounded COG windows, and terrain elevation profiles.

Labels: `fixture` · `authenticated` · `experimental` · `degraded`

- Guide: [docs/cog.md](../cog.md)
- Runnable example: [imagery-cog-quickstart](../../examples/imagery-cog-quickstart)
- Executable entry: [examples/imagery-cog-quickstart/src/main.ts](../../examples/imagery-cog-quickstart/src/main.ts)
- Example notes: [examples/imagery-cog-quickstart/README.md](../../examples/imagery-cog-quickstart/README.md)
- Compile check: `npm run demo:imagery-cog:typecheck`
- Sample contract: `golden` · `supported` · `active`
- Data and auth: `hybrid` · `host-mediated`
- Provenance: Committed STAC, bounded COG range/decoded-window, imagery, and terrain fixtures; a configured same-origin Honua service; or the scheduled pinned Element 84 Earth Search Sentinel-2 item.
- Freshness: Fixture acquisition/version metadata, configured-service response observation time, or the scheduled pinned-item observation time.
- Catalog degradation: Credential-bearing URLs, CORS, missing or oversized range responses, unsupported CRS/format, and nodata return structured outcomes while published imagery remains usable. Public live proof covers classified COG inspection and a bounded decoded window in EPSG:32621; browser-side UTM reprojection and a georeferenced live MapLibre mount remain explicitly unclaimed.
- Live sample: [demo-imagery-terrain.html](https://honua.io/demo-imagery-terrain.html) · [demo-maui-3d.html](https://honua.io/demo-maui-3d.html) · [sample-raster-overlay.html](https://honua.io/sample-raster-overlay.html)
- Supported API imports: `@honua/sdk-js/cog` (`mountStacCogAssetToMapLibre`, `openStacCogAsset`); `@honua/sdk-js/honua` (`HonuaImageService`)
- honua.io journey: `imagery-terrain-3d`
- Degradation: The default build replays pinned COG and terrain fixtures; live imagery needs a host-mediated endpoint.

### 9. Migrate an ArcGIS application

Scan and transform one file at a time with explicit compatibility evidence and manual gaps.

Labels: `fixture` · `public-live` · `degraded`

- Guide: [docs/migration-honua-maplibre.md](../migration-honua-maplibre.md)
- Runnable example: [migration-workbench](../../examples/migration-workbench)
- Executable entry: [examples/migration-workbench/src/main.ts](../../examples/migration-workbench/src/main.ts)
- Example notes: [docs/migration-honua-maplibre.md](../migration-honua-maplibre.md)
- Compile check: `npm run demo:migration-workbench:typecheck`
- Sample contract: `golden` · `supported` · `active`
- Data and auth: `fixture` · `none`
- Provenance: Committed ArcGIS source fixtures and migration reports.
- Freshness: Versioned with the migration corpus.
- Catalog degradation: Unsupported ArcGIS modules are reported as manual work, never silently removed.
- Live sample: [sample-codemod.html](https://honua.io/sample-codemod.html)
- Supported API imports: `@honua/sdk-js/migration` (`runEsriCompatCodemod`, `scanArcGisUsage`)
- honua.io journey: `migrate-arcgis`
- Degradation: Unsupported ArcGIS modules remain manual migration work and are reported rather than removed silently.

### 10. Automate safely with agent tools

Dry-run, approve, and verify bounded agent map actions with signed receipts, keeping writes behind host approval.

Labels: `fixture` · `authenticated` · `experimental` · `degraded`

- Guide: [docs/agent-safety.md](../agent-safety.md)
- Runnable example: [ai-spatial-app-builder](../../examples/ai-spatial-app-builder)
- Executable entry: [examples/ai-spatial-app-builder/src/safe-agent.ts](../../examples/ai-spatial-app-builder/src/safe-agent.ts)
- Example notes: [examples/ai-spatial-app-builder/README.md](../../examples/ai-spatial-app-builder/README.md)
- Compile check: `npm run demo:ai-spatial-builder:typecheck`
- Sample contract: `lab` · `experimental` · `active`
- Data and auth: `hybrid` · `host-mediated`
- Provenance: Committed parcel fixture plus optional host-mediated proposal and live-data endpoints.
- Freshness: Fixture snapshot 2026-07-10; optional live lane records its observation time.
- Catalog degradation: Missing host endpoints produce a structured skip; mutation, realtime, and generated-app effects stay disabled without separate host policy.
- Supported API imports: `@honua/sdk-js/agent-safety` (`dryRunAgentPlan`, `issueAgentApproval`); `@honua/sdk-js/agent-tools` (`HONUA_AGENT_TOOL_NAMES`)
- honua.io journey: `safe-agent-automation`
- Degradation: The builder dry-runs agent plans over fixtures by default, and write execution stays disabled without explicit host approval.

## Publication boundary

- Guides link to runnable example source and never maintain a copied implementation snippet.
- Repository documentation uses relative links; canonical API and site narrative links use the declared owners.
- Site consumers join the [learning navigation manifest](../learning-paths.v1.json) to the [static sample projection](../../samples/dist/honua-site-samples.v2.json) by `sampleId`; catalog-owned metadata is not copied into another source file.
- Sample metadata and evidence are owned by [SDK issue #540](https://github.com/honua-io/honua-sdk-js/issues/540); the generated consumer projection is coordinated by [SDK issue #550](https://github.com/honua-io/honua-sdk-js/issues/550).
