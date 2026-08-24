# Geoprocessing with OGC API Processes and Esri GPServer

The SDK has two supported HTTP geoprocessing paths. OGC API Processes is the
server-neutral path for Honua and raw Part 1 endpoints. GeoServices GPServer is
the migration path for ArcGIS clients and teams bringing Esri task concepts.
Both adapt to the SDK's canonical `IJobRun<T>` contract, so callers use the same
`results()`, `watch()`, and `cancel()` methods.

Honua's server owns one process catalog and execution engine. OGC Processes and
GPServer are protocol adapters over it; the SDK does not federate to an external
ArcGIS Server or duplicate the server's GP translator.

## Discover and bind the process service

Processes are operation-only: discovery does not invent a protocol-neutral
`Source`. Keep the discovered service root and conformance declaration on the
handle so later calls use the advertised paths and fail closed on capability
gaps.

```ts doc-test=compile
import { HonuaClient, discoverOgcProcesses } from "@honua/sdk-js/honua";

const endpoint = "https://honua.example.com";
const client = new HonuaClient({ baseUrl: endpoint });
const discovery = await discoverOgcProcesses({ endpoint, client });

const processes = client.ogcProcesses({
  basePath: discovery.basePath,
  conformance: discovery,
  pollBudget: { deadlineMs: 60_000 },
});

const catalog = await processes.list();
const description = await processes.describe("geometry.buffer");
console.log(catalog.processes.map((process) => process.id));
console.log(description.inputs, description.outputs, description.jobControlOptions);
```

## Execute GeoJSON synchronously

`mode: "sync"` omits `Prefer`, as required by OGC API Processes Requirement 25,
and is refused before the POST unless `geometry.buffer` advertises
`sync-execute`. A synchronous response is adapted to an already-successful
`IJobRun` with no job resource or polling.

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://honua.example.com" });
const processes = client.ogcProcesses();
const description = await processes.describe("geometry.buffer");
const run = await processes.execute<Record<string, unknown>>({
  processId: "geometry.buffer",
  inputs: {
    geometry: { type: "Point", coordinates: [-157.8583, 21.3069] },
    distance: 100,
  },
  mode: "sync",
  jobControlOptions: description.jobControlOptions,
});

const { outputs } = await run.results();
console.log(outputs);
```

## Execute asynchronously, observe, and cancel

`mode: "async"` sends `Prefer: respond-async`. `results()` polls under a
deadline or attempt budget; it never loops without a bound. `cancel()` is
idempotent and reports the authoritative terminal status if completion races
the dismissal request.

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://honua.example.com" });
const processes = client.ogcProcesses({ pollBudget: { deadlineMs: 60_000 } });
const description = await processes.describe("geometry.buffer");
const run = await processes.execute<Record<string, unknown>>({
  processId: "geometry.buffer",
  inputs: {
    geometry: { type: "Point", coordinates: [-157.8583, 21.3069] },
    distance: 100,
  },
  mode: "async",
  jobControlOptions: description.jobControlOptions,
});

const stopWatching = run.watch((snapshot) => {
  console.log(snapshot.status, snapshot.progress?.percent);
});

try {
  const { outputs } = await run.results({ pollIntervalMs: 500, deadlineMs: 60_000 });
  console.log(outputs);
} finally {
  stopWatching();
}

const cancellation = await run.cancel();
console.log(cancellation);
```

## Run an AI-selected Buffer through GPServer

An agent can select canonical `geometry.buffer` while an Esri-oriented client
addresses the advertised `Buffer` task. The alias is name compatibility, not a
second parameter translator: read task metadata and send the task's advertised
`wkb`, `srid`, and `distance` inputs. The default Honua GP service is
`geoprocessing`, and its async result parameter is `outputFeatureLayer`.

```ts doc-test=compile
import type { IJobRun } from "@honua/sdk-js/honua";
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://honua.example.com" });
const selectedByAi = {
  canonicalProcessId: "geometry.buffer",
  esriTaskName: "Buffer",
  parameters: {
    // POINT(-122.4194 37.7749), base64-encoded WKB
    wkb: "AQEAAABQ/Bhz15pewNDVVuwv40JA",
    srid: 4326,
    // geometry.buffer is planar: EPSG:4326 distances are degrees.
    distance: 0.00025,
  },
  resultNames: ["outputFeatureLayer"] as const,
};

const runner = client.geoprocessingRunner("geoprocessing", selectedByAi.esriTaskName);
const run: IJobRun<Record<string, unknown>> = await runner.execute({
  processId: selectedByAi.canonicalProcessId,
  parameters: selectedByAi.parameters,
  resultNames: selectedByAi.resultNames,
});
const { outputs } = await run.results({ pollIntervalMs: 500, deadlineMs: 60_000 });
console.log(outputs.outputFeatureLayer);
```

This is the same `HonuaProcessRunner` abstraction used by
`client.ogcProcessRunner()`. MCP direct verbs such as `honua_buffer_features`
remain the AI-native dataset-reference path; GPServer is the compatibility path
for ArcGIS-shaped task discovery, `submitJob`, status, result, and cancellation
URLs.

## Capability and failure behavior

- A requested execution mode missing from `jobControlOptions` raises
  `HonuaCapabilityNotSupportedError` before any POST.
- A non-success job makes `results()` throw `HonuaJobFailedError`, preserving
  the job status, server error code, and details.
- Job polling follows same-origin `Location` and results links when advertised,
  then falls back to the Core route templates.
- Cross-origin job links and non-JSON document responses fail closed.

The raw OGC synchronous/GeoJSON candidate receipt remains gated on
honua-server#3268 and honua-demo-infra#68. The SDK's GPServer job/result contract
is covered independently, but a live release run still requires a seeded
`geoprocessing/Buffer` task. When either deployment capability is absent,
release evidence must record an explicit blocked/skip receipt; discovery is not
execution evidence.
