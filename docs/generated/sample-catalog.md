# SDK sample catalog

This inventory is generated from [`samples/catalog.v2.json`](../../samples/catalog.v2.json). Do not edit it by hand.

Catalog contract: `honua.sdk.sample-catalog.v2` · SDK: `@honua/sdk-js` (effective version derived from `package.json`) · 34 executable examples

## Golden journey readiness

Journey IDs are stable roadmap slots. `planned` candidates remain recipes or labs until their golden quality profile and evidence are satisfied; only `qualified` candidates use the golden track.

| Journey | Status | Candidate sample |
| --- | --- | --- |
| `first-map` | planned | [`maplibre-quickstart`](#maplibre-quickstart) |
| `service-explorer` | planned | [`service-explorer`](#service-explorer) |
| `planning-permitting` | planned | [`planning-permitting-workbench`](#planning-permitting-workbench) |
| `incident-operations` | planned | [`realtime-incident-dashboard`](#realtime-incident-dashboard) |
| `imagery-terrain` | planned | [`imagery-cog-quickstart`](#imagery-cog-quickstart) |
| `cloud-native-analysis` | planned | [`spatial-analytics-workbench`](#spatial-analytics-workbench) |
| `arcgis-migration` | planned | [`migration-workbench`](#migration-workbench) |

## Executable samples

| Sample | Track | Journey candidate | Support | Lifecycle | Quality profile | Data | Configuration | Demonstration |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| <a id="ai-spatial-app-builder"></a>[`ai-spatial-app-builder`](../../examples/ai-spatial-app-builder/README.md) | lab | - | experimental | active | browser-lab | hybrid | approved | Proves typed proposals, shared policy validation, signed single-use approval, bounded execution, refusal, and verified receipt states. |
| <a id="app-bootstrap-basic"></a>[`app-bootstrap-basic`](../../examples/app-bootstrap-basic/README.md) | lab | - | deprecated | retire | browser-lab | fixture | not-required | Bootstraps a minimal application through the legacy app-platform compatibility surface. |
| <a id="arcgis-source-app"></a>[`arcgis-source-app`](../../examples/arcgis-source-app/README.md) | fixture | - | internal | active | internal-fixture | fixture | not-required | Provides the ArcGIS JavaScript source application used by the migration end-to-end harness. |
| <a id="automatic-source-workflow"></a>[`automatic-source-workflow`](../../docs/examples/automatic-source-workflow/README.md) | fixture | - | internal | active | browser-fixture | fixture | not-required | Exercises automatic MapLibre strategy selection, interaction state, refresh, and disposal against deterministic browser fixtures. |
| <a id="cesium-route-playback"></a>[`cesium-route-playback`](../../docs/examples/cesium-route-playback/README.md) | lab | - | experimental | rework | browser-lab | hybrid | legacy-unsafe | Explores bounded route playback and elevation context through an optional Cesium consumer integration. |
| <a id="edit-workflow-demo"></a>[`edit-workflow-demo`](../../examples/edit-workflow-demo/README.md) | recipe | - | supported | rework | browser-recipe | fixture | not-required | Demonstrates optimistic edits, attachments, conflicts, and safe recovery. |
| <a id="endpoint-to-map"></a>[`endpoint-to-map`](../../examples/endpoint-to-map/README.md) | recipe | - | experimental | active | browser-recipe | hybrid | approved | mountSource() turns a public FeatureServer into a styled, interactive MapLibre map in four statements. |
| <a id="geocoding-quickstart"></a>[`geocoding-quickstart`](../../examples/geocoding-quickstart/README.md) | recipe | - | supported | rework | browser-recipe | hybrid | legacy-unsafe | Runs forward, reverse, and suggestion workflows with map feedback. |
| <a id="geoprocessing-job-runner"></a>[`geoprocessing-job-runner`](../../examples/geoprocessing-job-runner/README.md) | recipe | - | supported | merge | browser-recipe | hybrid | legacy-unsafe | Submits, polls, cancels, and inspects asynchronous geoprocessing jobs. |
| <a id="imagery-cog-quickstart"></a>[`imagery-cog-quickstart`](../../examples/imagery-cog-quickstart/README.md) | recipe | imagery-terrain | supported | rework | browser-recipe | hybrid | legacy-unsafe | Compares WMS imagery, COG-backed ImageServer tiles, and export previews. |
| <a id="kepler-analytics"></a>[`kepler-analytics`](../../examples/kepler-analytics/README.md) | lab | - | experimental | rework | browser-lab | hybrid | legacy-unsafe | Replays operations data through kepler.gl with linked filters and KPI evidence. |
| <a id="maplibre-quickstart"></a>[`maplibre-quickstart`](../../examples/maplibre-quickstart/README.md) | recipe | first-map | supported | rework | browser-recipe | hybrid | legacy-unsafe | Connects, discovers, explains, queries, and mounts one source with linked views and inspectable evidence. |
| <a id="mcp-gis-assistant"></a>[`mcp-gis-assistant`](../../examples/mcp-gis-assistant/README.md) | lab | - | experimental | rework | browser-lab | fixture | not-required | Demonstrates assistant tool discovery and safe SDK-backed spatial operations. |
| <a id="migration-workbench"></a>[`migration-workbench`](../../docs/migration-honua-maplibre.md) | lab | arcgis-migration | supported | active | browser-lab | fixture | not-required | Scans and transforms ArcGIS application source with auditable compatibility results. |
| <a id="nl-map-control"></a>[`nl-map-control`](../../examples/nl-map-control/README.md) | lab | - | experimental | active | browser-lab | fixture | not-required | A recorded fixture LLM compiles a canned instruction into an inspectable plan; read-only plans auto-execute, mutating plans require a signed agent-safety approval, and every execution emits a receipt beside the live map effects. |
| <a id="node-backend-quickstart"></a>[`node-backend-quickstart`](../../examples/node-backend-quickstart/README.md) | recipe | - | supported | active | headless-recipe | hybrid | approved | Uses the protocol-neutral client from a Node service without browser dependencies. |
| <a id="oauth-signin"></a>[`oauth-signin`](../../examples/oauth-signin/README.md) | recipe | - | supported | active | browser-recipe | fixture | not-required | Demonstrates browser authentication and session lifecycle without embedding credentials. |
| <a id="overture-geoparquet"></a>[`overture-geoparquet`](../../examples/overture-geoparquet/README.md) | lab | - | experimental | active | browser-lab | hybrid | not-required | Executes one bounded GeoParquet result and links its MapLibre map, table, chart, selection, and truthful receipts. |
| <a id="planning-permitting-workbench"></a>[`planning-permitting-workbench`](../../examples/planning-permitting-workbench/README.md) | lab | planning-permitting | supported | rework | browser-lab | fixture | not-required | Combines parcels, hazards, sketching, editing, and export in a task-oriented application. |
| <a id="pmtiles-static"></a>[`pmtiles-static`](../../examples/pmtiles-static/README.md) | recipe | - | supported | active | browser-recipe | fixture | not-required | Loads a static PMTiles archive without a Honua server. |
| <a id="react-quickstart"></a>[`react-quickstart`](../../examples/react-quickstart/README.md) | recipe | - | supported | active | browser-recipe | hybrid | approved | Uses the React provider, hooks, and map component over the same quickstart contract. |
| <a id="realtime-incident-dashboard"></a>[`realtime-incident-dashboard`](../../examples/realtime-incident-dashboard/README.md) | lab | incident-operations | supported | active | browser-lab | hybrid | approved | Runs live-first incident command with observable reconciliation and a guarded, resettable edit lab. |
| <a id="runtime-parity-showcase"></a>[`runtime-parity-showcase`](../../examples/runtime-parity-showcase/README.md) | lab | - | experimental | replace | browser-lab | fixture | not-required | Compares supported rendering paths and makes fidelity differences explicit. |
| <a id="service-explorer"></a>[`service-explorer`](../../examples/service-explorer/README.md) | lab | service-explorer | supported | rework | browser-lab | hybrid | legacy-unsafe | Browses heterogeneous spatial services with capability and cache diagnostics. |
| <a id="shared-renderer-state"></a>[`shared-renderer-state`](../../docs/examples/shared-renderer-state/README.md) | lab | - | experimental | active | browser-lab | fixture | not-required | Exercises loop-safe camera, selection, filter, and time synchronization across MapLibre and Cesium. |
| <a id="sketch-editing"></a>[`sketch-editing`](../../examples/sketch-editing/README.md) | recipe | - | experimental | active | browser-recipe | fixture | not-required | terra-draw draw modes drive the edit-sketch workflow: undo/redo, snapping, and applyEdits submission. |
| <a id="spatial-analytics-workbench"></a>[`spatial-analytics-workbench`](../../examples/spatial-analytics-workbench/README.md) | lab | cloud-native-analysis | experimental | rework | browser-lab | hybrid | approved | Explains and accepts one plan linking AOI, map, table, chart, provenance, and reusable output. |
| <a id="stac-imagery-browser"></a>[`stac-imagery-browser`](../../examples/stac-imagery-browser/README.md) | recipe | - | supported | merge | browser-recipe | fixture | not-required | Discovers STAC collections and previews supported imagery assets. |
| <a id="standalone-quickstart"></a>[`standalone-quickstart`](../../examples/standalone-quickstart/README.md) | recipe | - | supported | merge | browser-recipe | hybrid | approved | Connects a public Esri service directly to MapLibre without a Honua server. |
| <a id="storytelling-25d-map"></a>[`storytelling-25d-map`](../../examples/storytelling-25d-map/README.md) | lab | - | supported | merge | browser-lab | hybrid | legacy-unsafe | Combines terrain, extrusion, OGC overlays, and route playback in a guided story. |
| <a id="temporal-playback"></a>[`temporal-playback`](../../examples/temporal-playback/README.md) | recipe | - | experimental | active | browser-recipe | fixture | not-required | Animates a month of seeded synthetic seismic events with createTemporalPlayback, styled by a first-class classBreaksRenderer whose legend derives from renderer.legendItems(). |
| <a id="terrain-rgb-elevation"></a>[`terrain-rgb-elevation`](../../examples/terrain-rgb-elevation/README.md) | recipe | - | supported | merge | browser-recipe | hybrid | legacy-unsafe | Reads Terrain-RGB tiles for point elevation and route profiles. |
| <a id="unified-ops-workspace"></a>[`unified-ops-workspace`](../../examples/unified-ops-workspace/README.md) | lab | - | deprecated | retire | browser-lab | fixture | not-required | Composes incident command, analysis, and shared workspace state. |
| <a id="web-components-basic"></a>[`web-components-basic`](../../examples/web-components-basic/README.md) | lab | - | deprecated | retire | browser-lab | fixture | not-required | Demonstrates the SDK custom-element controls against a map. |

The catalog also carries fixture/live evidence, evidence expiry, endpoint configuration names, provenance, attribution, freshness, lifecycle targets, validation profiles, and the complete 21-route honua.io migration mapping. The presentation-safe projection is [`samples/dist/honua-site-samples.v2.json`](../../samples/dist/honua-site-samples.v2.json).
