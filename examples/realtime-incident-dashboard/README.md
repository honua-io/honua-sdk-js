# Honua Realtime Incident Operations Dashboard

The flagship Honua JS realtime sample prefers the deployed Honua stream, then
falls back visibly to a deterministic, read-only replay when the server does not
advertise streaming. The map, filters, queue, metrics, event log, and detail
panel share one linked exploration context.

The dashboard makes snapshot time, observation time, event time, lag, cursor,
sequence, duplicate/reordered-event rejection, reconnect attempt, backoff,
resume, stale-cursor recovery, and reconciliation outcome observable. It never
presents replay as live data.

Snapshot and delta delivery passes through the public
`createResumableRealtimeSubscription` gate before reaching the public realtime
feature store. Duplicate and reordered data receive deterministic rejection
receipts. Cursor expiry makes the last state stale and read-only until an
explicit replacement snapshot is accepted; a heartbeat or `live` status alone
cannot restore authority. Session disposal closes both the transport and gate
and emits a cancellation receipt.

## Live State Authority

Incident rows, geometry, counts, and detail actions are authoritative only when
feature state comes from the realtime delta stream, cursor/watermark replay, or
an explicit fresh snapshot. Metadata cache state for schemas, renderers,
legends, and domains is shown separately and does not make incident feature
state fresh.

When the stream is stale, awaiting a replacement snapshot, offline, or a
feature-result cache is offered as the feature source, the dashboard keeps the
last reconciled incidents visible for read-only context and disables mutations
that require authoritative live state.

## Safe Editing

The required browser test uses `fixture-edit`, an isolated and resettable lane
containing only one writable record (`DEMO-EDIT-0001`). Edits require an
expected revision and idempotency key. The journey demonstrates a successful
update, repeat-request deduplication, a simulated concurrent revision conflict,
realtime reconciliation, and reset.

All other records are mutation-disabled. Replay is always read-only. The live
lane also fails closed until the server advertises the dedicated
`maui-incidents-demo-edits` profile with authorization and reset support; no
browser credential is embedded in this sample.

## Run

```sh
npm run demo:incident
```

The default `auto` mode probes `https://demo.honua.io` and uses the Honua server
SSE adapter when realtime is available. Force a configured live endpoint with:

Current deployment status: the canonical incident realtime endpoint returns
HTTP 404, so it is unavailable and `auto` enters the visibly labeled,
read-only replay lane. The opt-in evidence probe records that failure rather
than treating the separate successful AWS Earth Search STAC probe as incident
realtime evidence.

```sh
VITE_HONUA_INCIDENT_TRANSPORT=live \
VITE_HONUA_INCIDENT_BASE_URL=https://honua.example \
VITE_HONUA_INCIDENT_STREAM_URL=https://honua.example/api/v1/streaming/features \
npm run demo:incident
```

or append `?transport=live&baseUrl=<origin>&streamUrl=<sse-url>` in the
browser. Supported public configuration names are:

- `VITE_HONUA_INCIDENT_BASE_URL`
- `VITE_HONUA_INCIDENT_CAPABILITIES_URL`
- `VITE_HONUA_INCIDENT_STREAM_URL`
- `VITE_HONUA_INCIDENT_SOURCE_ID`
- `VITE_HONUA_INCIDENT_LAYER_ID`
- `VITE_HONUA_INCIDENT_TRANSPORT` (`auto`, `live`, `replay`, or `fixture-edit`)

Endpoint URLs must use HTTP(S), must not contain embedded credentials, and
reject credential-like query parameters.

The seeded service and current platform blockers are tracked in
[`docs/honua-cloud-demo-services.md`](../../docs/honua-cloud-demo-services.md).
The stream is the authority for incident feature state; metadata cache state is
only startup context.

## Validate

```sh
npm run demo:incident:typecheck
npm run demo:incident:build
npx vitest run test/realtime-incident-dashboard.test.ts
npm run test:playwright:incident
npm run samples:verify
npm run prepare:test-sdk
npm run samples:run -- typecheck --sample realtime-incident-dashboard --sdk-mode packed
npm run samples:run -- build --sample realtime-incident-dashboard --sdk-mode packed
```

Required PR checks are deterministic and make no network requests. Scheduled
live evidence uses `npm run bench:live`; failures remain explicit evidence and
never cause the app to silently claim a live execution.

The catalog publishes the latest validated per-sample envelope at
[`evidence/live-skipped.v1.json`](./evidence/live-skipped.v1.json). It includes
snapshot, cursor, lag, observation-window, and reconnect fields even when the
live capability is unavailable; fixture data is never substituted into that
lane.

The live lane skips for two distinct, separately coded reasons. When the demo
server reports realtime feature streams as unavailable, the skip code is
`realtime-capability-disabled` and the reconnect outcome is
`not-attempted-capability-unavailable`. When the capability is enabled but the
demo incident feature service returns a well-formed snapshot with zero features,
the skip code is `incident-demo-dataset-empty` and the reconnect outcome is
`not-attempted-demo-dataset-empty`, because a snapshot-plus-delta journey cannot
be demonstrated against an empty dataset. Seeding that dataset is tracked in
[honua-sdk-js#812](https://github.com/honua-io/honua-sdk-js/issues/812). Errors,
timeouts, and responses that do not match the protocol are never skips; they
remain recorded failures. The taxonomy is documented in
[`docs/benchmark-methodology.md`](../../docs/benchmark-methodology.md).
