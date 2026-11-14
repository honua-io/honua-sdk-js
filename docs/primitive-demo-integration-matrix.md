# Primitive Demo Integration Matrix

Tracking issue: https://github.com/honua-io/honua-sdk-js/issues/187

This matrix keeps the primitive gap backlog honest: every primitive issue under
the JS SDK parity epic must appear in at least one runnable demo lane before the
epic closes. Rows can start as planned coverage, but a primitive issue should
not close until its row points at implemented example code, validation commands,
focused smoke coverage where the workflow is interactive, and proof markers
that point at the primitive-specific imports or code paths exercised by that
lane.

## Coverage Matrix

| Issue | Primitive | Demo lanes | Validation commands | Proof markers | Coverage status |
| --- | --- | --- | --- | --- | --- |
| #178 | Controller-level layer and source CRUD primitives | `test/fixtures/packed-app-platform-reference-workbench.mjs` | `npm run verify:split-packages` | `marker:test/fixtures/packed-app-platform-reference-workbench.mjs:createHonuaWebComponentController`<br>`marker:test/fixtures/packed-app-platform-reference-workbench.mjs:controller.setLayerVisibility("incidents", false)` | Implemented packed reference-workbench lane: the published package's controller owns the map layer and toggles its visibility. Source add/remove has no runnable demo lane since the runtime parity showcase retired. |
| #179 | Shared filter and crossfilter registry | `examples/spatial-analytics-workbench` | `npm run demo:spatial-analytics:typecheck`<br>`npm run test:playwright:spatial-analytics` | `import:examples/spatial-analytics-workbench/src/model.ts:@honua/sdk-js/exploration`<br>`marker:examples/spatial-analytics-workbench/src/model.ts:selectLinkedViewQueryProjection` | Implemented linked-view and analytics lane for shared filter/crossfilter state projection with deterministic registry contract coverage. |
| #180 | Renderer-neutral hit-test and pointer primitives | `examples/realtime-incident-dashboard` | `npm run demo:incident:typecheck`<br>`npm run demo:incident:build`<br>`npm run test:playwright:incident` | `import:examples/realtime-incident-dashboard/src/main.ts:@honua/sdk-js/interactions`<br>`marker:examples/realtime-incident-dashboard/src/main.ts:bindMapSelectionToExploration`<br>`marker:examples/realtime-incident-dashboard/src/main.ts:syncFeatureStateSelection` | Implemented incident lane for renderer-neutral map selection handoff and feature-state updates. |
| #181 | Expanded framework-neutral map controls and panels | `test/fixtures/web-components-host` | `npm run demo:web-components:typecheck`<br>`npm run demo:web-components:build`<br>`npm run test:playwright:web-components` | `import:test/fixtures/web-components-host/src/main.ts:@honua/sdk-js/web-components`<br>`marker:test/fixtures/web-components-host/src/main.ts:createHonuaWebComponentController` | Host for map, chart, and table controls and panel coordination. |
| #182 | Sketch, attachments, domains, conflicts, and undo primitives | `examples/sketch-editing` | `npm run demo:sketch-editing:typecheck`<br>`npm run demo:sketch-editing:build`<br>`npm run test:playwright:sketch-editing` | `import:examples/sketch-editing/src/main.ts:@honua/sdk-js/contract`<br>`marker:examples/sketch-editing/src/main.ts:createEditSketchWorkflow` | Implemented fixture lane for sketch, snapping, and undo. Attachments, domains, and conflicts have no runnable demo lane since the conflict-aware edit workflow sample retired; the gRPC editing samples will carry them. |
| #183 | 3D terrain, model, and scene runtime primitives | `examples/imagery-cog-quickstart` | `npm run demo:imagery-cog:typecheck`<br>`npm run test:playwright:imagery-cog` | `import:examples/imagery-cog-quickstart/src/journey.ts:@honua/sdk-js/honua`<br>`marker:examples/imagery-cog-quickstart/src/journey.ts:sampleElevationProfile` | Implemented imagery and terrain lane for Terrain-RGB rendering and elevation profiles. 2.5D extrusions and native 3D engine adapters have no runnable demo lane since the storytelling sample retired. |
| #184 | Warehouse and indexed spatial source primitives | `examples/spatial-analytics-workbench` | `npm run demo:spatial-analytics:typecheck`<br>`npm run demo:spatial-analytics:build`<br>`npm run test:playwright:spatial-analytics` | `import:examples/spatial-analytics-workbench/src/model.ts:@honua/sdk-js/contract`<br>`marker:examples/spatial-analytics-workbench/src/model.ts:assertValidSpatialAggregationRequest` | Implemented analytics lanes for indexed aggregation contracts, warehouse-style source descriptors, deterministic fixture refresh, and export validation. |
| #185 | Provider-ready agentic map and safety primitives | `examples/ai-spatial-app-builder` | `npm run demo:ai-spatial-builder:typecheck`<br>`npm run test:playwright:ai-spatial-builder` | `import:examples/ai-spatial-app-builder/src/safe-agent.ts:@honua/sdk-js/agent-tools`<br>`import:examples/ai-spatial-app-builder/src/safe-agent.ts:@honua/sdk-js/agent-safety`<br>`marker:examples/ai-spatial-app-builder/src/safe-agent.ts:verifyAgentStepAuthorization` | Implemented a fixture-backed typed-tool, signed/atomic safe-agent workflow. Provider live integration remains host-mediated and outside deterministic demo proof. |
| #186 | Control-plane SDK handoff for hosted maps, workspaces, imports, tokens, and connections | `examples/service-explorer`<br>`examples/node-backend-quickstart` | `npm run demo:service-explorer:typecheck`<br>`npm run demo:node-backend:typecheck`<br>`npm run demo:node-backend:smoke`<br>`npm run test:playwright:service-explorer` | `marker:examples/service-explorer/README.md:createHonuaControlPlane`<br>`marker:examples/node-backend-quickstart/README.md:createHonuaControlPlane`<br>`script:demo:node-backend:smoke` | Implemented documented control-plane handoff and backend smoke lane for hosted map/workspace/import/token/connection SDK usage. Live seeded-cloud acceptance remains tracked by #128. |

## Closure Rules

- A primitive row is complete only when the listed demo lane contains code that
  exercises the primitive directly, not just adjacent existing behavior.
- Interactive primitives need Playwright coverage unless the primitive is
  strictly non-browser. Non-browser primitives need an equivalent fixture or
  smoke command in the validation column.
- Fixture-mode demos must stay deterministic and must not require live
  credentials. Live/staging variants may exist, but they cannot be the only
  proof for a primitive row.
- New demo lanes must be added to `npm run demo:examples:typecheck`,
  `npm run demo:examples:build`, and the matrix before their primitive issue
  closes.
- Every row must include proof markers in `import:<file>:<module>`,
  `marker:<file>:<text>`, or `script:<package-script>` form so
  `npm run demo:primitive-matrix` can fail stale or overstated coverage.
- The final closure comment for #176 should paste or link this matrix with the
  implemented coverage status for each primitive.
