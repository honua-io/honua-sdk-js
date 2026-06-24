# Planning & Permitting Workbench

Flagship aggregate demo for issue `#289` (parent epic `#288`). One cohesive
gov/AEC workbench over the seeded Maui datasets that composes many SDK
capabilities into a single linked application, in contrast to the single-purpose
quickstart demos.

It mirrors a real planning workflow: a planner opens the map (parcels + zoning +
flood hazard + permits), searches/geocodes to a parcel, runs a zoning/flood
query that drives a linked map/table/chart, sketches a proposed footprint and
checks it against the flood overlay, edits a permit on a writable layer, then
prints/exports the result.

## Commands

```sh
npm run demo:planning-workbench
npm run demo:planning-workbench:build
npm run demo:planning-workbench:typecheck
npm run test:playwright:planning-workbench
```

## Aggregated SDK capabilities (NFR-001: >= 5)

1. `HonuaAppWorkspace` (`@honua/sdk-js/app-workspace`) holds layout, sources,
   realtime records, and the saved-workspace document used for print/export.
2. `ExplorationContext` + linked-view bindings (`@honua/sdk-js/exploration`,
   `@honua/sdk-js/interactions`) keep the map, parcel table, zoning chart,
   filter controls, and detail panel in one shared query context.
3. Query & expressions: zoning + regulated-flood filters and a drawn AOI extent
   drive a linked map/table/chart projection (REQ-002).
4. Editing lane via `createEditSession` (`@honua/sdk-js/contract`) against a
   writable OData-style permit `Source`, including version-conflict surfacing,
   and graceful **local-optimistic** degradation when writes are not licensed
   (REQ-003).
5. Sketch + measure + flood-overlay check, and print/export of a workspace
   manifest (REQ-004).

## Graceful degraded states (NFR-001)

- Sources are labeled by tier (`community` / `pro`) and writability. When the
  permit source is read-only or rejects with
  `HonuaCapabilityNotSupportedError`, the editor applies a local-optimistic
  update and the form clearly flags the degraded write.
- Version conflicts on the writable source are surfaced as a failed save rather
  than being silently dropped.

## Layout

- `src/types.ts` — domain types (parcels, zoning, flood, permits, projections).
- `src/fixtures.ts` — Maui seed data, zoning/flood domains, map presets.
- `src/model.ts` — workspace wiring, linked-view query projection, editable
  permit `Source`, sketch/measure, and print/export.
- `src/main.ts` — DOM rendering and control bindings for the three modules.

## Validation

- Browser smoke: `npm run test:playwright:planning-workbench` (asserts no JS
  errors on load and walks query -> select -> sketch/measure -> print ->
  edit/conflict).
- Typecheck/build run in the `demo:examples:typecheck` and
  `demo:examples:build` CI lanes.
