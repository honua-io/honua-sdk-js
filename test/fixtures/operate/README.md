# Operate Observability Contract Fixtures

These fixtures document the experimental `/api/v1/operate` SDK contract for the
Console / MCP / Studio "Operate" surfaces (server telemetry, event/log viewers,
alerts and realtime alert rules, geofences, delivery channels, investigations,
and the job viewer). They let Console Operate screens be built and tested before
live endpoints land. Each file is a `{ request, response }` pair keyed by
`schemaVersion`.

Telemetry status:

- `telemetry-status-healthy.v1.json` — healthy server with OTLP/logs/alerts providers and metrics, plus `ETag`/`Last-Modified` validators.
- `telemetry-status-degraded.v1.json` — degraded health with a disconnected metrics provider.
- `telemetry-disabled.v1.json` — `telemetryEnabled: false` (no OTLP pipeline configured); distinct from a failing target.

Alerts and rules:

- `alert-critical-active.v1.json` — firing critical alert page with explicit `availableActions` (action availability is state/policy-driven, not inferred).
- `alert-suppressed.v1.json` — suppressed alert carrying the suppression reason/window and reduced action set.
- `alert-rule-geofence.v1.json` — realtime geofence alert rule referencing a geofence zone and a Slack channel binding.
- `delivery-failure.v1.json` — realtime rate rule whose webhook channel binding reports an explicit `lastError` delivery-channel error.

Job viewer:

- `job-running.v1.json` — running job with stages and progress; only `cancel` is available.
- `job-failed.v1.json` — failed job with a stage-level problem; `retry`/`rerun` available.
- `job-retried.v1.json` — retry run (`state: retrying`) linked to the prior run via `retryOfRunId`.
- `job-artifacts.v1.json` — artifact listing page for an artifact-producing job.

Investigations:

- `investigation-timeline.v1.json` — investigation with a pinned alert and a mixed (alert/note/job) timeline.

Capability gaps (typed degraded results, not empty data):

- `unsupported-logs.v1.json` — `501` when no log store is configured.
- `unsupported-investigations.v1.json` — `404` when no investigation store is provisioned.

Operational events/logs distinguish audit records from operational ones via the
event `category` field; secret-bearing values must never appear in fixtures.
