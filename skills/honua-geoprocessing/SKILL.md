---
name: honua-geoprocessing
description: Use when an agent must validate, execute, poll, and consume a Honua geoprocessing plan — the bounded geometry.buffer process through discovered server tools or SDK process runners — including job polling to a terminal state and turning a result artifact into something a map can bind. Covers 2026.1 zero-to-map stage 4 (geoprocessing).
release: "2026.1"
stages: [geoprocessing]
---

# Execute the bounded geometry.buffer process

Honua's server owns one process catalog and execution engine. The SDK runners
are adapters over it; they do not federate to an external ArcGIS Server.

The 2026.1 release journey requires the existing `geometry.buffer` process.
`analytics.buffer-aggregate`, dataset-reference buffer verbs, the full analysis
profile, and the unshipped Esri GP roster are not prerequisites. A broader
legacy repository driver exercising another process does not replace this
bounded proof.

## Discover, validate, execute

1. Discover the candidate's bounded workflow view and the actual
   `geometry.buffer` input/output schema. Missing membership is an actionable
   qualification failure; do not guess a profile switch or substitute a verb.
2. Select a bounded geometry from the authorized fixture or published layer.
   The process accepts geometry input, not a published `layerId`. For the
   advertised GPServer task, encode that geometry as WKB and supply its `srid`
   and `distance`. Preserve the input identity, CRS, and process parameters.
3. When using server plan tools, build the `geometry.buffer` step from the
   discovered schema, call `honua_validate_plan`, then `honua_execute_plan`
   with that same plan and an `idempotencyKey`. Do not copy the older
   `analytics.buffer-aggregate` plan's `layerId` or `unit` fields.
4. Capture the returned job identity and read its terminal result. A submitted
   job or a process name in the catalog is not execution evidence.

`geometry.buffer` is planar: an EPSG:4326 distance is in degrees, not metres.
Use the candidate's advertised geometry encoding; SDK protocol examples are
not a promise that every server accepts every encoding.

## SDK runners (in your own code)

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

- If selecting input from a layer, check cardinality with `honua_count_features`
  and select a bounded fixture geometry; do not silently buffer the whole layer.
- State the distance, unit, and input layer in the plan before running.
- One job per user request. If a run fails, diagnose it; do not loop.

## Verify

- `docs/geoprocessing.md` — OGC Processes and GPServer, with compiled examples.
- `mcp/release/zero-to-map/journey.v1.json` — broader legacy engineering contract,
  not the current bounded release acceptance definition.
- `docs/zero-to-map-release-journey.md` — the buffer stage and the GPServer proof.
- `examples/geoprocessing-job-runner/` — a runnable job-runner demo
  (`npm run demo:gp-runner:typecheck`).
