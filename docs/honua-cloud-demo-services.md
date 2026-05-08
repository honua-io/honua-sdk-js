# Honua Cloud Demo Services

Issue #128 promotes the fixture-backed sample portfolio toward seeded Honua
Cloud demo services. This document is the JS-repo contract for the sample
configuration surface. It does not replace platform seeding or reset
automation; it makes the expected service ids, env vars, fallback states, smoke
commands, and cache boundaries explicit.

The machine-readable source is
[`examples/cloud-demo-services.json`](../examples/cloud-demo-services.json).
The matching env template is
[`examples/cloud-demo.env.example`](../examples/cloud-demo.env.example).

## Local Fixture Baseline

All listed samples keep a fixture fallback. When the cloud base URL, service
ids, stream URL, or credentials are missing, the sample state is
`fixture-degraded`. That state means:

- the app is suitable for deterministic local review and fixture smoke tests
- feature rows, realtime incidents, edits, and materialized exports are not
  authoritative Honua Cloud data
- metadata cache badges can describe fixture metadata, but they do not imply
  live feature freshness

The fixture fallback is intentional. It keeps the sample portfolio usable while
seeded cloud services are provisioned, reset, or temporarily unavailable.

## Shared Env

Use these env vars for scheduled smoke and cross-sample cloud configuration:

| Env var | Purpose |
| --- | --- |
| `HONUA_CLOUD_DEMO_BASE_URL` | Honua Cloud base URL used by scheduled cloud smoke. Default contract: `https://cloud.honua.io`. |
| `HONUA_CLOUD_DEMO_API_KEY` | Optional API key for cloud smoke and non-browser service checks. |
| `HONUA_CLOUD_DEMO_BEARER_TOKEN` | Optional bearer token for cloud smoke and non-browser service checks. |
| `HONUA_CLOUD_DEMO_METADATA_TTL_MS` | Metadata freshness budget used by demos that expose cache state. Default: `900000`. |
| `HONUA_CLOUD_DEMO_SUMMARY_FILE` | Optional JSON summary path for scheduled cloud smoke output. |

Browser samples keep sample-specific `VITE_*` variables because Vite only
exposes those names to client code.

## Seeded Profiles

| Profile | Sample | Seeded resource contract | Fixture fallback | Smoke |
| --- | --- | --- | --- | --- |
| `quickstart-feature-readonly` | `examples/maplibre-quickstart` | FeatureServer `natural-earth`, layer `0`, bounded read-only query through `VITE_HONUA_QUICKSTART_BASE_URL`, `VITE_HONUA_QUICKSTART_SERVICE_ID`, `VITE_HONUA_QUICKSTART_LAYER_ID`, `VITE_HONUA_QUICKSTART_WHERE`, and `VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT`. | Same-origin fixture via `npm run demo:quickstart:mock`. | Fixture: `npm run test:playwright:quickstart`; cloud scaffold: `npm run test:cloud-demo:staging`. |
| `service-explorer-feature-readonly` | `examples/service-explorer` | FeatureServer `natural-earth`, layer `0`, source discovery and linked query through `VITE_HONUA_SERVICE_EXPLORER_BASE_URL`, `VITE_HONUA_SERVICE_EXPLORER_MODE`, `VITE_HONUA_SERVICE_EXPLORER_SERVICE_ID`, and `VITE_HONUA_SERVICE_EXPLORER_LAYER_ID`. | `auto` mode falls back to fixtures without credentials; fixture server: `npm run demo:service-explorer:mock`. | Fixture: `npm run test:playwright:service-explorer`; cloud scaffold: `npm run test:cloud-demo:staging`. |
| `storytelling-25d-readonly` | `examples/storytelling-25d-map` | OGC collection ids `story-25d-assets`, `story-25d-route`, and `story-25d-stops` through `VITE_HONUA_25D_BASE_URL`, `VITE_HONUA_25D_ASSETS_COLLECTION`, `VITE_HONUA_25D_ROUTE_COLLECTION`, and `VITE_HONUA_25D_STOPS_COLLECTION`. | Same-origin collection fixtures via `npm run demo:25d:mock`. | Fixture: `npm run test:playwright:25d`; cloud scaffold: `npm run test:cloud-demo:staging`. |
| `kepler-analytics-materialized` | `examples/kepler-analytics` | FeatureServer `ops-analytics` layers `0`, `1`, and `2` for incidents, unit tracks, and coverage zones through `HONUA_DEMO_BASE_URL`, `HONUA_DEMO_INCIDENTS_SERVICE_ID`, `HONUA_DEMO_INCIDENTS_LAYER_ID`, `HONUA_DEMO_UNIT_TRACKS_SERVICE_ID`, `HONUA_DEMO_UNIT_TRACKS_LAYER_ID`, `HONUA_DEMO_COVERAGE_ZONES_SERVICE_ID`, and `HONUA_DEMO_COVERAGE_ZONES_LAYER_ID`. | Committed GeoJSON export fixtures via `npm run demo:kepler:smoke`. | Fixture: `npm run demo:kepler:smoke`; cloud scaffold: `npm run test:cloud-demo:staging`. |
| `incident-realtime-stream` | `examples/realtime-incident-dashboard` | SSE realtime incident stream through `VITE_HONUA_INCIDENT_TRANSPORT=cloud` and `VITE_HONUA_INCIDENT_STREAM_URL`. The stream is the authority for incident feature state. | Scripted realtime fixture via `npm run demo:incident:mock`. | Fixture: `npm run test:playwright:incident`; cloud scaffold: `npm run test:cloud-demo:staging`. |
| `edit-workflow-writable-guarded` | `examples/edit-workflow-demo` | Guarded FeatureServer `field-inspections-demo-writable`, layer `0`, plus read-only comparison service `field-inspections-demo-readonly`. The reserved live-lane env vars are `VITE_HONUA_EDIT_WORKFLOW_BASE_URL`, `VITE_HONUA_EDIT_WORKFLOW_SERVICE_ID`, `VITE_HONUA_EDIT_WORKFLOW_LAYER_ID`, and `VITE_HONUA_EDIT_WORKFLOW_READONLY_SERVICE_ID`. | Local edit-session fixture via `npm run test:playwright:edit-workflow`. | Fixture: `npm run test:playwright:edit-workflow`; cloud scaffold: `npm run test:cloud-demo:staging`. |

The service and collection ids above are the JS sample seed contract. A cloud
tenant that has not provisioned those resources should fail the scheduled cloud
smoke rather than silently substituting unrelated data.

## Writable Safeguards

Writable demo traffic must fail closed. Scheduled smoke may enable writes only
when all safeguards are present:

| Env var | Requirement |
| --- | --- |
| `HONUA_CLOUD_DEMO_ALLOW_WRITES` | Must be exactly `true` before any writable smoke step runs. |
| `HONUA_CLOUD_DEMO_WRITE_TOKEN` | Write credential for the guarded service. This must be separate from browser read credentials where the platform supports that split. |
| `HONUA_CLOUD_DEMO_RESET_TOKEN` | Reset credential for the seeded writable data. It must not be exposed to browser samples. |
| `HONUA_CLOUD_DEMO_RESET_URL` | Reset endpoint for restoring the service to `seeded-clean` state. |

Reset calls, edit submissions, and attachment mutations are uncached user
actions. Scheduled writable smoke must reset before and after a run. If reset is
missing or fails, the smoke should stop before issuing edits.

The current edit workflow browser app remains fixture-first. The env names in
this contract reserve the live writable lane so platform seeding, reset
automation, and future app wiring use one shared vocabulary.

## Realtime Authority

The incident operations dashboard is realtime by default. In cloud mode,
`VITE_HONUA_INCIDENT_STREAM_URL` points at the seeded SSE endpoint and
`VITE_HONUA_INCIDENT_TRANSPORT=cloud` selects the cloud transport.

Incident rows, geometries, counts, and actions are authoritative only when they
come from:

- realtime deltas
- cursor or watermark replay
- an explicit fresh snapshot inside its freshness budget

Feature-result caches are never authoritative incident state. If the stream is
stale or offline, the UI may keep the last reconciled in-memory features visible
as read-only context with an explicit stale/offline state.

## Cache Boundaries

Metadata is cacheable by default when scoped by source/config version and auth
scope. That includes service lists, layer descriptors, fields, domains,
capabilities, renderers, and legends.

These operations remain uncached unless a separate materialization workflow
owns the result:

- realtime incident feature snapshots, cursors, watermarks, and deltas
- edit submissions, attachment mutations, and writable reset calls
- ad hoc spatial requests driven by viewport, drawn geometry, or user filters

Materialized analytics exports, including the kepler GeoJSON bundle, must be
labeled as materialized outputs with provenance. They are not a replacement for
live incident state or edit-state freshness.

See [`docs/metadata-caching-strategy.md`](./metadata-caching-strategy.md) for
the broader SDK and MCP metadata cache policy.

## Smoke Commands

Config and documentation shape validation does not require live credentials:

```bash
npm run test:cloud-demo:config
```

Credential-gated cloud smoke is scaffolded separately:

```bash
npm run test:cloud-demo:staging
```

Without `HONUA_CLOUD_DEMO_BASE_URL`, the cloud smoke skips. With
`HONUA_CLOUD_DEMO_BASE_URL` set, it validates the base URL, credentials shape,
manifest profiles, and `GET /api/v1/admin/capabilities`. If
`HONUA_CLOUD_DEMO_ALLOW_WRITES=true`, it also requires the write token, reset
token, and reset URL before any future writable smoke can run.

## Remaining Platform Work

This JS-repo slice defines and tests the configuration contract. It does not
provision Honua Cloud services, implement server-side reset endpoints, or wire
the edit workflow browser app to perform live writes. Those remain the
implementation gaps for issue #128 and the parent seeded-demo epic.
