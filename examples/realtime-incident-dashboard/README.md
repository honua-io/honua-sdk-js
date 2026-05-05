# Honua Realtime Incident Operations Dashboard

Fixture-backed demo for the Honua JS SDK realtime feature store and linked exploration context.

The app starts from a deterministic incident snapshot, applies scripted realtime create/update/resolve/archive events, and keeps the map, filters, queue, summary metrics, event log, and detail panel synchronized through `@honua/sdk-js/exploration`.

## Live State Authority

Incident rows, geometry, counts, and detail actions are authoritative only when
feature state comes from the realtime delta stream, cursor/watermark replay, or
an explicit fresh snapshot. Metadata cache state for schemas, renderers,
legends, and domains is shown separately and does not make incident feature
state fresh.

When the stream is stale, offline, or a feature-result cache is offered as the
feature source, the dashboard keeps the last reconciled incidents visible for
read-only context and disables actions that require authoritative live state.

## Run

```sh
npm run demo:incident
```

## Validate

```sh
npm run demo:incident:typecheck
npm run demo:incident:build
npm run test:playwright:incident
```
