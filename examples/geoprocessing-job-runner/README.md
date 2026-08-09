# Run a buffer job and collect the result

This public walkthrough uses the JavaScript SDK's real OGC API Processes surface:

```ts
const job = await client.ogcProcesses().execute({
  processId: "geometry.buffer",
  inputs: { wkb, srid: 3857, distance: 350 },
  mode: "async",
});
const result = await job.results({ deadlineMs: 2_500 });
```

The first viewport leads with a deterministic map of Honolulu Hale. The point input and verified polygon output remain available as an accessible table. One primary control replays the job, becomes a cancel control while the job is active, and becomes a restart control after dismissal or failure.

## Pinned contract

[`fixture.json`](./fixture.json) is the single source of truth for:

- Process: `geometry.buffer`.
- Inputs: base64 WKB point, `srid: 3857`, and planar `distance: 350`.
- Lifecycle: `accepted -> running -> successful`.
- Four success-path exchanges: execute, two status reads, and results.
- Output: server-shaped OGC artifact reference containing inline GeoJSON.
- Geometry SHA-256: `7694a78db36e259510c879e9fdaaac548f03a0c98792d7acf2a1f397740532df`.
- Cancellation: `DELETE /ogc/processes/jobs/{jobId}` returns `dismissed`.
- Error: non-matching inputs return a structured `422` problem document.

The fixture server is same-origin and does not read credentials. The sample does **not** claim public-live or authenticated-live execution. A live demo remains blocked until the demo manifest advertises a governed `geometry.buffer` process/canary with browser-safe admission.

## Run and validate

```sh
npm run demo:gp-runner
npm run demo:gp-runner:typecheck
npx vitest run test/geoprocessing-job-runner.test.ts
npm run demo:gp-runner:build
npm run test:playwright:gp-runner
```
