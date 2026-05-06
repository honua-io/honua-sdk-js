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

The fixture transport is the default. To exercise a Honua cloud/server
realtime endpoint that emits SDK `RealtimeFeatureEvent` JSON over SSE, start the
demo with either:

```sh
VITE_HONUA_INCIDENT_TRANSPORT=cloud \
VITE_HONUA_INCIDENT_STREAM_URL=https://honua.example/api/v1/realtime/events \
npm run demo:incident
```

or append `?transport=cloud&streamUrl=<sse-url>` in the browser.

## Validate

```sh
npm run demo:incident:typecheck
npm run demo:incident:build
npm run test:playwright:incident
```
