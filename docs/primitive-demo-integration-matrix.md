# Primitive Demo Integration Matrix

Tracking issue: https://github.com/honua-io/honua-sdk-js/issues/187

This matrix keeps the primitive gap backlog honest: every primitive issue under
the JS SDK parity epic must appear in at least one runnable demo lane before the
epic closes. Rows can start as planned coverage, but a primitive issue should
not close until its row points at implemented example code, validation commands,
and focused smoke coverage where the workflow is interactive.

## Coverage Matrix

| Issue | Primitive | Demo lanes | Validation commands | Coverage status |
| --- | --- | --- | --- | --- |
| #177 | One-call app bootstrap and embed primitive | `examples/runtime-parity-showcase` | `npm run demo:runtime-parity:typecheck`<br>`npm run demo:runtime-parity:build`<br>`npm run test:playwright:runtime-parity` | Planned target lane; primitive-specific integration lands with #177. |
| #178 | Controller-level layer and source CRUD primitives | `examples/runtime-parity-showcase` | `npm run demo:runtime-parity:typecheck`<br>`npm run demo:runtime-parity:build`<br>`npm run test:playwright:runtime-parity` | Planned target lane; primitive-specific integration lands with #178. |
| #179 | Shared filter and crossfilter registry | `examples/runtime-parity-showcase`<br>`examples/spatial-analytics-workbench` | `npm run demo:runtime-parity:typecheck`<br>`npm run demo:spatial-analytics:typecheck`<br>`npm run test:playwright:spatial-analytics` | Planned target lanes; primitive-specific integration lands with #179. |
| #180 | Renderer-neutral hit-test and pointer primitives | `examples/runtime-parity-showcase` | `npm run demo:runtime-parity:typecheck`<br>`npm run demo:runtime-parity:build`<br>`npm run test:playwright:runtime-parity` | Planned target lane; primitive-specific integration lands with #180. |
| #181 | Expanded framework-neutral map controls and panels | `examples/web-components-basic` | `npm run demo:web-components:typecheck`<br>`npm run demo:web-components:build`<br>`npm run test:playwright:web-components` | Planned target lane; primitive-specific integration lands with #181. |
| #182 | Sketch, attachments, domains, conflicts, and undo primitives | `examples/edit-workflow-demo` | `npm run demo:edit-workflow:typecheck`<br>`npm run demo:edit-workflow:build`<br>`npm run test:playwright:edit-workflow` | Planned target lane; primitive-specific integration lands with #182. |
| #183 | 3D terrain, model, and scene runtime primitives | `examples/storytelling-25d-map`<br>`examples/terrain-rgb-elevation` | `npm run demo:25d:typecheck`<br>`npm run demo:terrain-elevation:typecheck`<br>`npm run test:playwright:25d`<br>`npm run test:playwright:terrain-elevation` | Planned target lanes; primitive-specific integration lands with #183. |
| #184 | Warehouse and indexed spatial source primitives | `examples/spatial-analytics-workbench`<br>`examples/kepler-analytics` | `npm run demo:spatial-analytics:typecheck`<br>`npm run demo:spatial-analytics:build`<br>`npm run demo:kepler:build`<br>`npm run test:playwright:spatial-analytics` | Planned target lanes; primitive-specific integration lands with #184. |
| #185 | Provider-ready agentic map kit primitives | `examples/ai-spatial-app-builder`<br>`examples/mcp-gis-assistant` | `npm run demo:ai-spatial-builder:typecheck`<br>`npm run demo:mcp-gis-assistant:typecheck`<br>`npm run test:playwright:ai-spatial-builder`<br>`npm run test:playwright:mcp-gis-assistant` | Planned target lanes; primitive-specific integration lands with #185. |
| #186 | Control-plane SDK handoff for hosted maps, workspaces, imports, tokens, and connections | `examples/service-explorer`<br>`examples/node-backend-quickstart` | `npm run demo:service-explorer:typecheck`<br>`npm run demo:node-backend:typecheck`<br>`npm run demo:node-backend:smoke`<br>`npm run test:playwright:service-explorer` | Planned target lanes; primitive-specific integration lands with #186. |

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
- The final closure comment for #176 should paste or link this matrix with the
  implemented coverage status for each primitive.
