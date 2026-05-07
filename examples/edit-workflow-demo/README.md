# Honua Edit Workflow Demo

Fixture-backed browser demo for the shared edit session contract. It models a
Honua Cloud field-inspection layer with metadata-backed forms, coded domains,
related-record metadata, optimistic updates with rollback, conflict surfacing,
attachment add/delete, and explicit unsupported capability states.

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
uncached user actions.
