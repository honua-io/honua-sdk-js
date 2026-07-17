# Honua Edit Workflow Demo

> Portfolio status: replacement planned for `0.2.0-beta.0`. The maintained
> `planning-permitting-workbench` journey now owns the complete metadata-backed
> search, bounded analysis, edit, attachment, conflict, recovery, and export
> workflow. This deterministic application remains temporarily available as a
> compatibility sample, while the former editing site route resolves to the
> planning journey.

Fixture-backed browser demo for the shared edit session contract. It models a
Honua Cloud field-inspection layer with metadata-backed forms, coded domains,
related-record metadata, optimistic updates with rollback, conflict surfacing,
attachment add/delete, reusable sketch/undo primitives, annotation persistence
hooks, and explicit unsupported capability states.

## Run

```sh
npm run demo:edit-workflow
```

## Validate

```sh
npm run demo:edit-workflow:typecheck
npm run demo:edit-workflow:build
npm run test:playwright:edit-workflow
```

The sample uses only deterministic fixtures. Metadata is treated as cacheable
per source/config version, while edit submissions and attachment mutations are
uncached user actions. Sketch state is owned by `createEditSketchWorkflow`, so
the point/rectangle controls, dirty tracking, undo/redo, unsupported circle
state, and persisted annotation diagnostics can be tested without coupling them
to this demo UI.

The seeded Honua Cloud writable service contract is documented as the
`edit-workflow-writable-guarded` profile in
[`docs/honua-cloud-demo-services.md`](../../docs/honua-cloud-demo-services.md).
Live writable smoke must remain fail-closed unless the allow-writes flag, write
token, reset token, and reset URL are all present.
