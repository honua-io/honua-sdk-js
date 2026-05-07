# Unified Operational Intelligence Workspace

Fixture-backed shell for issue `#73`. It composes incident command, analysis
review, and field editing modules over one `HonuaAppWorkspace` plus one linked
`ExplorationContext`.

## Commands

```sh
npm run demo:unified-ops
npm run demo:unified-ops:build
npm run demo:unified-ops:typecheck
npm run test:playwright:unified-ops
```

## Coverage

- Shared map/table/chart/filter/detail context through the SDK linked-view
  bindings.
- Realtime fixture deltas reconciled into app workspace state.
- AI/MCP proposals staged as reviewable drafts before applying linked-context
  changes.
- Field inspection edits staged through the edit-workflow demo and reconciled
  back into the shared realtime/detail context.
- Saved workspace document round trip with snapshot diagnostics.
