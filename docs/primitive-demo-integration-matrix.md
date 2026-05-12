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
| #177 | One-call app bootstrap and embed primitive | `examples/app-bootstrap-basic` | `npm run demo:app-bootstrap:typecheck`<br>`npm run demo:app-bootstrap:build`<br>`npm run test:playwright:app-bootstrap` | `import:examples/app-bootstrap-basic/src/main.ts:@honua/sdk-js/app`<br>`marker:examples/app-bootstrap-basic/src/main.ts:createHonuaApp({` | Implemented focused demo lane for `createHonuaApp()` bootstrap and renderer injection. |
| #178 | Controller-level layer and source CRUD primitives | `examples/runtime-parity-showcase` | `npm run demo:runtime-parity:typecheck`<br>`npm run demo:runtime-parity:build`<br>`npm run test:playwright:runtime-parity` | `import:examples/runtime-parity-showcase/src/main.ts:@honua/sdk-js/app-controller`<br>`marker:examples/runtime-parity-showcase/src/main.ts:setLayerVisibility(layerId, visible)` | Implemented runtime parity lane for controller-owned layer visibility, source-backed package state, selection, and feature-state updates. |
| #179 | Shared filter and crossfilter registry | `examples/runtime-parity-showcase`<br>`examples/spatial-analytics-workbench` | `npm run demo:runtime-parity:typecheck`<br>`npm run demo:spatial-analytics:typecheck`<br>`npm run test:playwright:spatial-analytics` | `import:examples/spatial-analytics-workbench/src/model.ts:@honua/sdk-js/exploration`<br>`marker:examples/spatial-analytics-workbench/src/model.ts:selectLinkedViewQueryProjection` | Implemented linked-view and analytics lanes for shared filter/crossfilter state projection with deterministic registry contract coverage. |
| #180 | Renderer-neutral hit-test and pointer primitives | `examples/runtime-parity-showcase` | `npm run demo:runtime-parity:typecheck`<br>`npm run demo:runtime-parity:build`<br>`npm run test:playwright:runtime-parity` | `import:examples/runtime-parity-showcase/src/main.ts:@honua/sdk-js/interactions`<br>`marker:examples/runtime-parity-showcase/src/main.ts:runtime.setFeatureStateForTarget` | Implemented runtime parity lane for renderer-neutral hit-test/selection handoff and feature-state updates. |
| #181 | Expanded framework-neutral map controls and panels | `examples/web-components-basic` | `npm run demo:web-components:typecheck`<br>`npm run demo:web-components:build`<br>`npm run test:playwright:web-components` | `import:examples/web-components-basic/src/main.ts:@honua/sdk-js/web-components`<br>`marker:examples/web-components-basic/src/main.ts:createHonuaWebComponentController` | Implemented focused web-components lane for map/chart/table controls and panel coordination. |
| #182 | Sketch, attachments, domains, conflicts, and undo primitives | `examples/edit-workflow-demo` | `npm run demo:edit-workflow:typecheck`<br>`npm run demo:edit-workflow:build`<br>`npm run test:playwright:edit-workflow` | `import:examples/edit-workflow-demo/src/model.ts:@honua/sdk-js/contract`<br>`marker:examples/edit-workflow-demo/src/model.ts:createEditSketchWorkflow`<br>`marker:examples/edit-workflow-demo/src/model.ts:stageAttachmentAdd` | Implemented focused fixture lane for sketch, attachment, domain, conflict, rollback, and undo workflows. |
| #183 | 3D terrain, model, and scene runtime primitives | `examples/storytelling-25d-map`<br>`examples/terrain-rgb-elevation` | `npm run demo:25d:typecheck`<br>`npm run demo:terrain-elevation:typecheck`<br>`npm run test:playwright:25d`<br>`npm run test:playwright:terrain-elevation` | `import:examples/terrain-rgb-elevation/src/main.ts:@honua/sdk-js/honua`<br>`marker:examples/terrain-rgb-elevation/src/main.ts:applyMapLibreScenePrimitives`<br>`marker:examples/storytelling-25d-map/src/map.ts:toMapLibreExtrusionLayer` | Implemented scene lanes for 2.5D extrusions, Terrain-RGB diagnostics, and renderer-degraded scene primitives. Native 3D engine adapters remain separate future work. |
| #184 | Warehouse and indexed spatial source primitives | `examples/spatial-analytics-workbench`<br>`examples/kepler-analytics` | `npm run demo:spatial-analytics:typecheck`<br>`npm run demo:spatial-analytics:build`<br>`npm run demo:kepler:build`<br>`npm run test:playwright:spatial-analytics` | `import:examples/spatial-analytics-workbench/src/model.ts:@honua/sdk-js/contract`<br>`marker:examples/spatial-analytics-workbench/src/model.ts:assertValidSpatialAggregationRequest`<br>`marker:examples/kepler-analytics/scripts/refresh-fixture.mjs:queryFeaturesAll` | Implemented analytics lanes for indexed aggregation contracts, warehouse-style source descriptors, deterministic fixture refresh, and export validation. |
| #185 | Provider-ready agentic map kit primitives | `examples/ai-spatial-app-builder`<br>`examples/mcp-gis-assistant` | `npm run demo:ai-spatial-builder:typecheck`<br>`npm run demo:mcp-gis-assistant:typecheck`<br>`npm run test:playwright:ai-spatial-builder`<br>`npm run test:playwright:mcp-gis-assistant` | `import:examples/ai-spatial-app-builder/src/model.ts:@honua/sdk-js/agent-tools`<br>`marker:examples/ai-spatial-app-builder/src/model.ts:createHonuaAiMapKit`<br>`marker:examples/mcp-gis-assistant/src/assistant.ts:createHonuaAppWorkspace` | Implemented fixture-backed agentic map kit and MCP-style assistant lanes. Provider live integration remains outside deterministic demo proof. |
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
