---
name: honua-geoprocessing
description: Use when an agent must validate, execute, poll, and consume a Honua geoprocessing plan — analytics.buffer-aggregate through honua_validate_plan and honua_execute_plan, plus the SDK GPServer runner for geometry.buffer — including job polling to a terminal state and turning a result artifact into something a map can bind. Covers 2026.1 zero-to-map stage 4 (geoprocessing).
release: "2026.1"
stages: [geoprocessing]
---

# Buffer a published layer, then prove geometry.buffer (stage 4: `geoprocessing`)

Honua's server owns one process catalog and execution engine. Everything below
is an adapter over it — the SDK does **not** federate to an external ArcGIS
Server (`docs/geoprocessing.md`).

There are two surfaces. Pick one deliberately. The unshipped Esri GP roster and
the dataset-reference buffer verb are not on this journey.

## A. Published-layer buffer (the journey path)

`analytics.buffer-aggregate` reads a published `layerId`. `geometry.buffer`
accepts one WKB and has no `layerId`, so it cannot read the published parcels.

1. `honua_validate_plan` with a plan whose step `processId` is
   `analytics.buffer-aggregate` and whose inputs include the published parcel
   `layerId`.
2. `honua_execute_plan` with that same plan. Capture `jobId`.

```json
{
  "plan": {
    "planId": "2026.1-zero-to-map-buffer",
    "steps": [
      {
        "stepId": "buffer-parcels",
        "kind": "Geoprocess",
        "processId": "analytics.buffer-aggregate",
        "inputs": { "layerId": "<parcelsLayerId>", "distance": "25", "unit": "meters" }
      }
    ],
    "outputs": ["FeatureLayer"]
  }
}
```

Pass an `idempotencyKey` on execute. Retrying without one submits a second job.

## B. SDK GPServer runner (the separate proof)

`geometry.buffer` is planar: an EPSG:4326 distance is in *degrees*, not metres.
Send WKB. Do not send `layerId`.

## C. SDK runners (in your own code)

`docs/geoprocessing.md` has the compiled examples. Both adapt to the same
`IJobRun<T>` contract, so `results()` / `watch()` / `cancel()` are identical:

- OGC API Processes: `discoverOgcProcesses({ endpoint, client })`, then
  `client.ogcProcesses({ basePath, conformance, pollBudget })` →
  `.list()`, `.describe("geometry.buffer")`.
- GPServer (ArcGIS-shaped): `client.geoprocessingRunner("geoprocessing", "Buffer")`
  → `.execute({ processId, parameters, resultNames })`. The default Honua GP
  service is `geoprocessing` and its async result parameter is
  `outputFeatureLayer`.

`mode: "sync"` is refused before the POST unless the process advertises
`sync-execute`.

## Wait, then read the result — never assume

Execution returns a `jobId`, not an answer. Poll the job resource to a terminal
state:

- Resource `honua://jobs/<jobId>`; wait for `/status` to reach `Succeeded`.
  Terminal states are `Succeeded`, `Failed`, `Cancelled`. The journey polls at
  500 ms with a 120 s deadline — bound your own polling the same way.
- Read `honua://jobs/<jobId>/results` and take `artifacts[].artifactId`.
  **Join the artifact to the job**: do not treat a `Succeeded` status as the
  result.
- Retain `artifactId`. The studio stage binds it as `honua://artifacts/<artifactId>`
  when adding the analysis layer to a Studio draft.

In SDK code the equivalent is `await run.results({ pollIntervalMs, deadlineMs })`
and reading `outputs.outputFeatureLayer`.

## Cancel and fail closed

- `honua_cancel_job` (and `run.cancel()` in the SDK) stops a running job. Cancel
  when the user aborts or the deadline is blown — do not leave orphaned jobs.
- A non-success job makes `results()` throw `HonuaJobFailedError`, preserving
  job status, server error code, and details. Surface that error; do not retry
  a deterministic failure.
- A requested mode missing from `jobControlOptions` raises
  `HonuaCapabilityNotSupportedError` *before* any POST.
- Cross-origin job links and non-JSON job documents fail closed by design.

## Bounds

Geoprocessing is compute the user pays for. Before executing:

- Check cardinality with `honua_count_features` — a buffer over a million rows
  is not a "quick check".
- State the distance, unit, and input layer in the plan before running.
- One job per user request. If a run fails, diagnose it; do not loop.

## Verify

- `docs/geoprocessing.md` — OGC Processes and GPServer, with compiled examples.
- `mcp/release/zero-to-map/journey.v1.json` — stage `geoprocessing`.
- `docs/zero-to-map-release-journey.md` — the buffer stage and the GPServer proof.
- `examples/geoprocessing-job-runner/` — a runnable job-runner demo
  (`npm run demo:gp-runner:typecheck`).
