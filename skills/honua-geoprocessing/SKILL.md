---
name: honua-geoprocessing
description: Use when an agent must discover, execute, poll, cancel, and consume a Honua geoprocessing task — the Esri-compatible MCP GP roster, the native dataset-reference MCP verb, and the SDK's OGC API Processes / GPServer runners, including job polling to a terminal state and turning a result artifact into something a map can bind. Covers 2026.1 zero-to-map stage 3 (geoprocessing).
release: "2026.1"
stages: [geoprocessing]
---

# GP discovery, execution, wait/cancel, and result use (stage 3: `geoprocessing`)

Honua's server owns one process catalog and execution engine. Everything below
is an adapter over it — the SDK does **not** federate to an external ArcGIS
Server (`docs/geoprocessing.md`).

There are three surfaces. Pick one deliberately.

## A. Esri-compatible MCP roster (the AI-facing path)

Three tools, used in order:

1. `honua_esri_gp_list_tasks` — the GP task catalog. Discover; never hardcode.
2. `honua_esri_gp_describe_task` with `{ "taskName": "Buffer" }` — resolves the
   Esri alias to the canonical process. For `Buffer` that is
   `processId: "geometry.buffer"`. Read the advertised parameters here rather
   than assuming Esri parameter names.
3. `honua_esri_gp_execute_task`:

```json
{
  "serviceId": "analysis",
  "taskName": "Buffer",
  "parameters": { "wkb": { "...esri feature set..." }, "distance": 0.00025 },
  "idempotencyKey": "<stable key for this logical run>"
}
```

Always pass an `idempotencyKey`. Retrying without one submits a second job.

The alias is *name* compatibility, not a second parameter translator. Send the
task's advertised inputs.

## B. Native MCP dataset verb

`honua_buffer_features` is the dataset-reference verb — it takes a published
source, not inline geometry:

```json
{
  "source": { "serviceId": "zero-to-map", "layerId": "<parcelsLayerId>" },
  "distance": 25, "unit": "meters", "dissolve": false, "outSrid": 4326
}
```

Note the unit difference from `geometry.buffer`, which is **planar**: an
EPSG:4326 distance there is in *degrees*, not metres. Mixing these up is the
usual cause of a buffer that is either invisible or the size of a county.

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
- The job carries a `resultsUri`. Read it to get `resultPackageId` and
  `artifacts[].artifactId`. **Join the artifact to the job**: do not treat a
  `Succeeded` status as the result.
- Retain `artifactId`. Stage 4 binds it as `honua://artifacts/<artifactId>`
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
- `docs/zero-to-map-release-journey.md` — why the GP story is dual-surface.
- `examples/geoprocessing-job-runner/` — a runnable job-runner demo
  (`npm run demo:gp-runner:typecheck`).
