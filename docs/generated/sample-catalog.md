# SDK sample catalog

This inventory is generated from [`samples/catalog.v1.json`](../../samples/catalog.v1.json). Do not edit it by hand.

Catalog contract: `honua.sdk.sample-catalog.v1` · SDK: `@honua/sdk-js` (effective version derived from `package.json`) · 29 executable examples

| Sample | Tier | Support | Data | Disposition | Demonstration |
| --- | --- | --- | --- | --- | --- |
| [`ai-spatial-app-builder`](../../examples/ai-spatial-app-builder/README.md) | flagship | experimental | hybrid | keep | Proves typed proposals, shared policy validation, signed single-use approval, bounded execution, refusal, and verified receipt states. |
| [`app-bootstrap-basic`](../../examples/app-bootstrap-basic/README.md) | reference | deprecated | fixture | retire | Bootstraps a minimal application through the legacy app-platform compatibility surface. |
| [`arcgis-source-app`](../../examples/arcgis-source-app/README.md) | reference | internal | fixture | keep | Provides the ArcGIS JavaScript source application used by the migration end-to-end harness. |
| [`edit-workflow-demo`](../../examples/edit-workflow-demo/README.md) | flagship | supported | fixture | rework | Demonstrates optimistic edits, attachments, conflicts, and safe recovery. |
| [`endpoint-to-map`](../../examples/endpoint-to-map/README.md) | recipe | experimental | hybrid | keep | mountSource() turns a public FeatureServer into a styled, interactive MapLibre map in four statements. |
| [`geocoding-quickstart`](../../examples/geocoding-quickstart/README.md) | recipe | supported | hybrid | keep | Runs forward, reverse, and suggestion workflows with map feedback. |
| [`geoprocessing-job-runner`](../../examples/geoprocessing-job-runner/README.md) | advanced | supported | hybrid | merge | Submits, polls, cancels, and inspects asynchronous geoprocessing jobs. |
| [`imagery-cog-quickstart`](../../examples/imagery-cog-quickstart/README.md) | flagship | supported | hybrid | merge | Compares WMS imagery, COG-backed ImageServer tiles, and export previews. |
| [`kepler-analytics`](../../examples/kepler-analytics/README.md) | advanced | experimental | hybrid | rework | Replays operations data through kepler.gl with linked filters and KPI evidence. |
| [`maplibre-quickstart`](../../examples/maplibre-quickstart/README.md) | flagship | supported | hybrid | keep | Connects, discovers, explains, queries, and mounts one source with linked views and inspectable evidence. |
| [`mcp-gis-assistant`](../../examples/mcp-gis-assistant/README.md) | advanced | experimental | fixture | rework | Demonstrates assistant tool discovery and safe SDK-backed spatial operations. |
| [`migration-workbench`](../../docs/migration-honua-maplibre.md) | flagship | supported | fixture | rework | Scans and transforms ArcGIS application source with auditable compatibility results. |
| [`nl-map-control`](../../examples/nl-map-control/README.md) | advanced | experimental | fixture | keep | A recorded fixture LLM compiles a canned instruction into an inspectable plan; read-only plans auto-execute, mutating plans require a signed agent-safety approval, and every execution emits a receipt beside the live map effects. |
| [`node-backend-quickstart`](../../examples/node-backend-quickstart/README.md) | recipe | supported | hybrid | keep | Uses the protocol-neutral client from a Node service without browser dependencies. |
| [`oauth-signin`](../../examples/oauth-signin/README.md) | recipe | supported | fixture | keep | Demonstrates browser authentication and session lifecycle without embedding credentials. |
| [`overture-geoparquet`](../../examples/overture-geoparquet/README.md) | flagship | experimental | hybrid | keep | Plans and executes bounded Overture GeoParquet queries with truthful worker, range, memory, and pruning evidence. |
| [`planning-permitting-workbench`](../../examples/planning-permitting-workbench/README.md) | flagship | supported | fixture | rework | Combines parcels, hazards, sketching, editing, and export in a task-oriented application. |
| [`pmtiles-static`](../../examples/pmtiles-static/README.md) | recipe | supported | fixture | keep | Loads a static PMTiles archive without a Honua server. |
| [`react-quickstart`](../../examples/react-quickstart/README.md) | recipe | supported | hybrid | keep | Uses the React provider, hooks, and map component over the same quickstart contract. |
| [`realtime-incident-dashboard`](../../examples/realtime-incident-dashboard/README.md) | flagship | supported | hybrid | keep | Runs live-first incident command with observable reconciliation and a guarded, resettable edit lab. |
| [`runtime-parity-showcase`](../../examples/runtime-parity-showcase/README.md) | reference | experimental | fixture | replace | Compares supported rendering paths and makes fidelity differences explicit. |
| [`service-explorer`](../../examples/service-explorer/README.md) | flagship | supported | hybrid | rework | Browses heterogeneous spatial services with capability and cache diagnostics. |
| [`spatial-analytics-workbench`](../../examples/spatial-analytics-workbench/README.md) | flagship | experimental | hybrid | rework | Explains and accepts one plan linking AOI, map, table, chart, provenance, and reusable output. |
| [`stac-imagery-browser`](../../examples/stac-imagery-browser/README.md) | advanced | supported | fixture | merge | Discovers STAC collections and previews supported imagery assets. |
| [`standalone-quickstart`](../../examples/standalone-quickstart/README.md) | flagship | supported | hybrid | merge | Connects a public Esri service directly to MapLibre without a Honua server. |
| [`storytelling-25d-map`](../../examples/storytelling-25d-map/README.md) | advanced | supported | hybrid | merge | Combines terrain, extrusion, OGC overlays, and route playback in a guided story. |
| [`terrain-rgb-elevation`](../../examples/terrain-rgb-elevation/README.md) | advanced | supported | hybrid | merge | Reads Terrain-RGB tiles for point elevation and route profiles. |
| [`unified-ops-workspace`](../../examples/unified-ops-workspace/README.md) | advanced | deprecated | fixture | retire | Composes incident command, analysis, and shared workspace state. |
| [`web-components-basic`](../../examples/web-components-basic/README.md) | reference | deprecated | fixture | retire | Demonstrates the SDK custom-element controls against a map. |

The catalog also carries fixture/live commands, endpoint configuration names, provenance, attribution, freshness, validation, and the complete 21-route honua.io migration mapping. The presentation-safe projection is [`samples/dist/honua-site-samples.v1.json`](../../samples/dist/honua-site-samples.v1.json).
