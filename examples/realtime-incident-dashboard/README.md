# Honua Realtime Incident Operations Dashboard

Fixture-backed demo for the Honua JS SDK realtime feature store and linked exploration context.

The app starts from a deterministic incident snapshot, applies scripted realtime create/update/resolve/archive events, and keeps the map, filters, queue, summary metrics, event log, and detail panel synchronized through `@honua/sdk-js/exploration`.

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
