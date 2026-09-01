# OGC API Client

Status: implemented in `src/core/ogc-tiles.ts`, `src/core/ogc-maps.ts`,
`src/core/ogc-processes.ts`, `src/core/ogc-records.ts`,
`src/core/stac.ts`, and (for OGC API Features) `src/core/surfaces.ts`.

This document is the developer reference for the first-party OGC API
adapter. It complements the design notes in
[`shared-client-contract.md`](./shared-client-contract.md) and the
capability matrix in [`protocol-capability-matrix.md`](./protocol-capability-matrix.md).

Canonical OGC API Features queries can be explained before execution through
`@honua/sdk-js/query-planner`. The deterministic
`ogc-api-features-query-v1` output exposes the collection, CQL2 text filter,
extension-shaped properties/sort/offset fields, bbox, CRS, and paging request
without fetching metadata or rows. That v1 surface is source-native
compatibility, not a claim that projection, sorting, or numeric offset belong to
OGC API Features Core. The typed `compileSemanticOgcApiFeaturesQuery()` path is
standards-strict: it preserves Core `limit`, rejects `select`, `sort`, and
caller-supplied offset without extension evidence, and requires explicit Part 2
CRS conformance plus collection CRS metadata only when a non-default filter or
output CRS must be transmitted. Exact Core default output/filter CRS requests
are satisfied without emitting extension parameters. See
[Deterministic query planner](./query-planner.md#remote-pushdown).

## Conformance areas covered

| Area | Surface | Source protocol | Notes |
| --- | --- | --- | --- |
| OGC API Features | `client.ogcFeatures()` | `ogc-features` | landing → collections → items, CQL2 filtering, transactions where the server advertises them |
| OGC API Tiles | `client.ogcTiles()` | `ogc-tiles` | tileset discovery, vector + raster tiles on the canonical `/collections/{id}/tiles/{tms}/…` route (styled tiles deferred — see below) |
| OGC API Maps | `client.ogcMaps()` | `ogc-maps` | dataset / collection map renders, styled access |
| OGC API Processes | `client.ogcProcesses()` | (none — job runner) | discovery, synchronous + asynchronous execution against a raw Part 1 (Core) server, `IJobRun<T>` surface |
| OGC API Records | `client.ogcRecords()` | `ogc-records` | metadata/catalog discovery, record search, record detail, raw response access |
| STAC API | `client.stac()` | `stac` | landing, collections, items, cross-collection search |

OGC conformance class identifiers (e.g.
`http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter`) are
**not** primary SDK types. `negotiateOgcCapabilities(protocol, conformance)`
translates a `/conformance` response into a canonical `Capabilities` set;
`hasOgcConformanceClass(conformance, substring)` is the explicit
substring gate for callers that want to branch on a specific extension.

## Getting started

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const baseUrl = "https://your-honua-server.example";
const client = new HonuaClient({ baseUrl });
```

### OGC API Features (already shipped)

```ts doc-test=skip reason="partial excerpt requires application host context"
const ogc = client.ogcFeatures();
const items = await ogc.collection("parcels").items({ limit: 50, filter: "STATUS = 'ACTIVE'" });
```

### OGC API Tiles

```ts doc-test=skip reason="partial excerpt requires application host context"
const tiles = client.ogcTiles();

// 1) Discover tilesets the server advertises for a collection
const tilesets = await tiles.tilesets({ collectionId: "parcels" });

// 2) Bind to one tileset and fetch a tile
const tileset = tiles.tileset("parcels", "WebMercatorQuad");
const tile = await tileset.tile({ tileMatrix: 5, tileRow: 9, tileCol: 12 });
console.log(tile.contentType); // "application/vnd.mapbox-vector-tile"
console.log(tile.bytes.byteLength);

// Raster tiles use the same route and rely on the `Accept` header to
// negotiate the output media type.
const png = await tileset.tile({ tileMatrix: 4, tileRow: 2, tileCol: 3, accept: "image/png" });
```

Styled-tile access (the OGC `/styles/{styleId}/tiles/…` route) is part of
the OGC API Tiles standard but is not currently exposed by the Honua
server. The SDK intentionally does not synthesize that path today; it
will be added when the server endpoint ships.

### OGC API Maps

```ts doc-test=skip reason="partial excerpt requires application host context"
const maps = client.ogcMaps();

// Dataset-level render across multiple collections
const map = await maps.map({
  width: 1024,
  height: 1024,
  bbox: [-122, 37, -120, 38],
  collections: ["parcels", "roads"],
  format: "png", // short-name token; `image/png` also accepted and normalized
});

// Collection-level styled render
const styled = await maps.collection("parcels", "topographic").map({
  width: 512,
  height: 512,
});
```

The `format` option is serialized to the server's `f` query parameter
as a short-name token (`png`, `jpeg`, `jpg`, `tiff`, `tif`); the SDK
normalizes `image/…` media-type aliases for ergonomics and sends a
media-type `Accept` header regardless. The request envelope intentionally
has no `filter` field — honua-server's Maps request model has no matching
property, so a CQL2 filter would be silently ignored. Callers who need a
custom query parameter can still pass one through `extraParams`.

### OGC API Processes

For the end-to-end discover, describe, synchronous/asynchronous execute,
results, and cancellation workflow—and the equivalent `IJobRun` lifecycle for
Esri-compatible GPServer tasks—see the dedicated
[geoprocessing guide](./geoprocessing.md).

```ts doc-test=skip reason="partial excerpt requires application host context"
import type { IJobRun } from "@honua/sdk-js/honua";

const processes = client.ogcProcesses();

const job: IJobRun<{ result: GeoJSON.Feature }> = await processes.execute({
  processId: "buffer",
  inputs: { feature: somePoint, distance: 500 },
  mode: "async",
});

const unwatch = job.watch((snap) => {
  console.log("status=", snap.status, "progress=", snap.progress?.percent);
});

try {
  const { outputs } = await job.results();
  console.log("result feature:", outputs.result);
} catch (error) {
  // HonuaJobFailedError carries status, errorCode, details
  console.error(error);
} finally {
  unwatch();
}
```

`IJobRun` is the canonical async-operation surface. It is reused for
every long-running operation in the SDK; the OGC Processes runner is
just one implementation. `cancel()` is idempotent against the documented
404 / terminal-race paths but does not silently swallow other failures:

- `404` ("job already gone"): return the cached status.
- `409 "Cannot dismiss completed job"` (honua-server's
  `JobEndpoints` terminal-state pre-check / post-apply / durable
  conflict — the job raced the caller into a terminal state): re-poll
  the job and return the authoritative terminal status if the poll
  confirms it. If the poll surfaces a non-terminal status, the original
  409 is rethrown so the caller is not lied to.
- `409 "Dismiss could not be confirmed"` (backend dismissal request
  unconfirmed) and `409 "Cancellation not supported"` (backend lacks
  dismissal capability): rethrow the `HonuaHttpError` so the caller
  can branch or retry. Discrimination is by RFC 7807 problem-details
  `title` (and `detail` substring fallback).

Terminal-failure snapshots populate `JobError` from `statusInfo.exception`
when the server provides it, and fall back to `statusInfo.message`
otherwise (honua-server's `StatusInfo` DTO only emits `message`). The
resulting `HonuaJobFailedError.message` carries the server's reason text.

#### Executing against a raw Processes server

No Honua Server is required. `discoverOgcProcesses()` returns the
service-root `basePath` and the verbatim `conformsTo` list; handing both
to `client.ogcProcesses()` binds every describe / execute / job route to
the discovered root and gates the calls on what that server declares.

```ts doc-test=skip reason="partial excerpt requires a live third-party Processes endpoint"
const discovery = await discoverOgcProcesses({ endpoint: "https://demo.pygeoapi.io/master" });

const processes = client.ogcProcesses({
  basePath: discovery.basePath,
  conformance: discovery, // the server's own /conformance list
  pollBudget: { deadlineMs: 60_000 },
});

// describe() teaches the handle this process's jobControlOptions, so the
// mode gate below costs no extra round trip.
await processes.describe("hello-world");

const run = await processes.execute<{ echo: string }>({
  processId: "hello-world",
  inputs: { name: "honua" },
  mode: "sync", // refused up front unless the process declares sync-execute
});

const { outputs } = await run.results();
```

Four properties hold whichever server is on the other end:

- **Both Core response shapes.** `mode: "async"` sends
  `Prefer: respond-async` and expects `201` + `Location`; `mode: "sync"`
  and `mode: "auto"` omit `Prefer`, following OGC API Processes Requirement 25;
  `mode: "auto"` (the default) accepts either. The client also accepts either
  response shape after `respond-async`, whether or not the optional
  `Preference-Applied` header is present. A synchronous execution
  still returns an `IJobRun` — an already-terminal one with `id === ""`,
  since Core assigns no job identifier — so caller code is identical.
- **Links over templates.** The job lifecycle follows the `Location`
  header and the `self` / `http://www.opengis.net/def/rel/ogc/1.0/results`
  link relations the server publishes, falling back to the Core
  `/jobs/{jobId}[/results]` template only when it publishes none. A link
  that leaves the client's configured origin is never followed.
- **Fail-closed capability gating.** An undeclared `sync-execute`,
  `async-execute`, or `dismiss` raises `HonuaCapabilityNotSupportedError`
  before any request is issued. The refusal's `context` carries
  `missingClass` (the conformance-class URI) or `construct`, so callers
  can branch without parsing messages. `capabilityPolicy: "strict"`
  additionally resolves conformance and the process description first and
  refuses a job whose status or results route was never advertised.
  Silence is a refusal, not a wildcard: a description or process summary
  this handle has read that carries no `jobControlOptions` advertises no
  execution mode, so an explicit `mode` against it is refused (pass
  `jobControlOptions` on the request to speak for a server that publishes
  its modes somewhere else). Sources are ranked rather than merged: a full
  description outranks a listing summary, which Core lets omit members the
  description carries, so refreshing the process list never downgrades a
  mode `describe()` already established. Under `"strict"` a `/conformance` document
  that declares no Core class refuses execution, and cancellation refuses
  unless something actually declared `dismiss`. Conformance URIs are
  matched as whole classes, so an unrecognised neighbour such as
  `…/conf/dismiss-disabled` never widens what the client will send.
- **Bounded, cancellable polling.** `results()` runs under the caller's
  `JobResultsOptions`, then the handle's `pollBudget`, then a default
  10-minute deadline — never an unbounded loop — and stops immediately
  when the supplied `AbortSignal` fires.

#### Exact-candidate qualification

`npm run qualification:ogc-processes:candidate` is the mutation-gated release
qualification lane. It must be run from an installed, packed SDK against a
locally bound candidate and requires
`HONUA_OGC_PROCESSES_QUALIFICATION_ENABLED=true`. The runner discovers and
describes `geometry.buffer`, validates its declared inputs and outputs, and
then exercises only the sync, async, and dismiss modes advertised by that
candidate. Undeclared modes are retained as typed `unsupported` observations,
never skips or inferred passes.

Result validation and the cancellation probe run on separate async executions.
Dismissal drives a job to the terminal `dismissed` state, and `IJobRun.results()`
rejects on any non-success terminal, so awaiting results on the run that was just
cancelled would fail the lane exactly when the candidate demonstrates dismissal
correctly. When `dismiss` is declared, the probe requires the job to settle at
`dismissed` and then requires that dismissed job to refuse to yield results; a
job that reached its own terminal before the DELETE landed is recorded as a
`terminal-race` and is never reported as a dismissal proof. When `dismiss` is not
declared, `cancel()` must refuse locally before issuing a DELETE — which is why
the negative also needs a live job, since `cancel()` short-circuits on an
already-terminal run and would never reach the capability check.

A bounded invalid-input execution proves the failure path, and only two outcomes
satisfy it: an `HonuaHttpError` carrying 400 or 422, or an `HonuaJobFailedError`
whose terminal status is `failed`. Any other error — a local capability refusal,
a 401/403, a 5xx, a poll timeout — fails the lane rather than being recorded as a
rejection, so the run can never report `result: "passed"` for a candidate that
never validated the governed input.

The generated JSON records the installed package version and integrity, SDK
and server source SHAs, server image digest, manifest revision, and fixture
digest. Request observations retain only method, path, status, and the standard
`Prefer: respond-async` value; the API key and all authorization headers are
excluded and a final redaction gate rejects credential-shaped output. This is
candidate qualification input for the at-cut release join, not that release
receipt itself.

At the release join, `npm run certify:installed-ogc-processes` supplies the SDK
package root from the shared installed-package certification harness rather
than accepting a caller-selected tree. The joined receipt therefore binds the
same observed operations to the registry integrity, sealed SDK source SHA,
server image digest/source SHA, and manifest revision. Operations outside this
slice retain their shared per-operation `blockedBy` coordinates; an unavailable
sync or dismiss mode remains an `unsupported` observation in the detailed OGC
receipt.

### STAC API

```ts doc-test=skip reason="partial excerpt requires application host context"
const stac = client.stac();

// GET /search
const page = await stac.search({
  bbox: [-122, 37, -120, 38],
  collections: ["sentinel-2"],
  filter: "cloud_cover < 10",
  filterLang: "cql2-text",
  limit: 50,
  offset: 0,
});

// GET /search with intersects + fields selection
const filtered = await stac.search({
  intersects: somePolygon,
  fields: { include: ["id", "properties.datetime"], exclude: ["assets.thumbnail"] },
});

// POST /search (large filter bodies, big intersects geometries, etc.)
const post = await stac.search({
  usePost: true,
  intersects: somePolygon,
  collections: ["sentinel-2"],
});

// Drain across pages — advances via the rel=next link's `?offset=N`
const everything = await stac.searchAll({ collections: ["sentinel-2"] });
```

`StacSearchRequest.offset` is honua-server's canonical paging token: its
`/stac/search` GET handler binds `[FromQuery] int? offset` and emits a
`rel=next` link whose `href` carries `?offset=N`. `searchAll` /
`searchStream` follow that link verbatim. `next` is kept as optional
support for non-Honua STAC servers that advertise an opaque `?next=…`
token instead. Any other cursor is followed opaquely: the query string of
a GET `rel=next` link (pgstac / stac-fastapi `?token=next:…`) is replayed
verbatim, and a POST `rel=next` link's `body` (`{"token":"next:…"}` with
`"merge": true`) is merged over the next POST body. `intersects` and
`fields` are serialized onto the GET query (intersects as JSON; fields as
`id,properties.datetime,-assets.thumbnail`) in addition to the POST body.

`usePost` forces the POST path on the raw `HonuaStacSearch` surface. The
canonical `Source.query()` does not need it: the STAC adapter reads the
landing page's `rel="search"` links and posts when the API advertises
`method: "POST"`, falling back to `GET /search` when it does not (or when
an advertised POST is refused on the first attempt).

### OGC API Records

```ts doc-test=skip reason="partial excerpt requires application host context"
const records = client.ogcRecords();

// Discover available metadata catalogs.
const catalogs = await records.collections();

// Search one catalog. Records query parameters are catalog metadata
// filters, not STAC item-search filters.
const page = await records.collection("catalog").search({
  q: ["roads", "parcels"],
  type: ["service", "collection"],
  externalIds: ["FeatureServer:transportation"],
  bbox: [-158, 21, -157, 22],
  datetime: "2025-01-01/2025-12-31",
  limit: 25,
  offset: 0,
});

const detail = await records.collection("catalog").record({ recordId: "service-transportation" });

// Raw response access keeps the shared auth/interceptor/retry pipeline but
// leaves body decoding to the caller.
const html = await records.collection("catalog").rawRecord({
  recordId: "service-transportation",
  responseFormat: "html",
  accept: "text/html",
});
```

Records and STAC are intentionally separate surfaces. STAC describes
spatiotemporal assets and collection/item search for imagery/data assets.
Records describes metadata about resources: services, layers,
collections, maps, scenes, styles, STAC collections, source descriptors,
and other catalog entries. Honua admin metadata and migration inventory
remain Honua-specific control-plane/read-model APIs; Records is the
standards-facing public catalog view over stable metadata.

`OgcRecordsSearchRequest` supports the Records core search parameters
`bbox`, `datetime`, `limit`, `q`, `ids`, `type`, and `externalIds`, plus
optional `filter` / `filter-lang` / `filter-crs` when the server
advertises the Records filtering conformance class. `searchAll` and
`searchStream` follow `rel=next` links that carry `?offset=N`.

## Canonical Source registration

Source-shaped OGC adapters register through the shared client contract
from `@honua/sdk-js/contract`. Cross-protocol code consumes them through
the same `Dataset` / `Source` vocabulary as GeoServices / OData:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";

const dataset = createDataset({
  id: "parcels",
  client,
  sources: [
    {
      id: "parcels-ogc",
      protocol: "ogc-features",
      locator: { url: baseUrl, collectionId: "parcels" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    },
    {
      id: "parcels-tiles",
      protocol: "ogc-tiles",
      locator: { url: baseUrl, collectionId: "parcels", tileMatrixSetId: "WebMercatorQuad" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"],
    },
    {
      id: "parcels-map",
      protocol: "ogc-maps",
      locator: { url: baseUrl, collectionId: "parcels", styleId: "topographic" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-maps"],
    },
    {
      id: "parcels-stac",
      protocol: "stac",
      locator: { url: baseUrl, collectionId: "parcels" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
    },
    {
      id: "catalog-records",
      protocol: "ogc-records",
      locator: { url: baseUrl, collectionId: "catalog" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-records"],
    },
  ],
});

const features = await dataset.source("parcels-ogc")!.query({ pagination: { limit: 100 } });
const stacItems = await dataset.source("parcels-stac")!.query({ pagination: { limit: 100 } });
const catalogRecords = await dataset.source("catalog-records")!.query({ pagination: { limit: 100 } });
const tileset = dataset.source("parcels-tiles")!.adapter("ogc-tiles"); // HonuaOgcTileset
const map = dataset.source("parcels-map")!.adapter("ogc-maps"); // HonuaOgcCollectionMap
const recordsCatalog = dataset.source("catalog-records")!.adapter("ogc-records"); // HonuaOgcRecordCollection
```

OGC API Tiles and OGC API Maps are render-only; their `Source.query*`
methods throw `HonuaCapabilityNotSupportedError`. Renderers always
reach the underlying class through `Source.adapter("ogc-tiles")` /
`Source.adapter("ogc-maps")`.

## Capability negotiation and graceful degradation

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";
import { negotiateOgcCapabilities, hasOgcConformanceClass } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://example.test" });
const conformance = await client.getOgcFeaturesConformance();
const caps = negotiateOgcCapabilities("ogc-features", conformance);
if (caps.has("queryAggregate")) {
  // server advertises ogcapi-features-3/conf/filter; a strict Source can allow
  // the adapter's documented client-side aggregation fallback.
}
if (hasOgcConformanceClass(conformance, "features-4/1.0/conf/create-replace-delete")) {
  // server advertises Part 4 transactions
}
```

Under `capabilityPolicy: "degraded"`, OGC API Features falls back to
client-side aggregation and metadata-bbox extent (see
[`protocol-capability-matrix.md`](./protocol-capability-matrix.md) for
the per-protocol coverage). All other adapters honour the strict
behaviour: a missing capability throws `HonuaCapabilityNotSupportedError`.

## Conformance fixtures

The repo ships parametrized conformance suites under `test/contract/`:

- `ogc-tiles.test.ts` — tileset discovery + tile fetch + Source adapter
- `ogc-maps.test.ts` — dataset / collection / styled map renders
- `ogc-processes.test.ts` — `IJobRun` lifecycle, cancel, error paths
- `ogc-records.test.ts` — Records query params, paging, raw access, Source adapter
- `stac.test.ts` — GET / POST search + Source adapter
- `ogc-conformance.test.ts` — conformance-class negotiation

These run against mock fetch responders and are the regression baseline
for "passes against Honua Server's current OGC parity matrix" (Features
CITE-certified, Tiles CITE-certified, Maps, Processes async).
