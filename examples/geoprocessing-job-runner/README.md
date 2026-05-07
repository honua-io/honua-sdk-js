# Geometry and Geoprocessing Job Runner

Fixture-backed sample for issue #129. It demonstrates a user-facing process workflow on the shared app workspace:

- AOI and process selection.
- Unified process submission through `HonuaProcessRunner`.
- geospatial-grpc `ProcessService` lifecycle normalization onto `IJobRun`.
- Explicit unsupported capability, cancellation, and failed-job diagnostics.
- Materialized result layers synchronized across map, table, chart, filters, and detail.

Caching policy:

- Process definitions, source metadata, schemas, and materialized output metadata are cacheable by source/config/job fingerprint.
- Job status, progress, cancellation, and terminal error state are never treated as cache-authoritative.
- Materialized outputs are cacheable only when the provenance inputs, plan id, AOI, and job id are visible.

Run locally:

```sh
npm run demo:gp-runner
```

Fixture mode is the default. To rehearse against a deployed Honua
geospatial-grpc ProcessService exposed through Connect/JSON, set:

```sh
VITE_HONUA_PROCESS_SERVICE_URL=https://<honua-host> npm run demo:gp-runner
```

Add `VITE_HONUA_PROCESS_SERVICE_TOKEN` when the endpoint expects a bearer
token. The sample still owns workspace materialization locally so linked
map/table/chart/detail behavior remains deterministic while the job lifecycle
comes from the configured cloud endpoint.

Build and smoke:

```sh
npm run demo:gp-runner:build
npm run test:playwright:gp-runner
```
