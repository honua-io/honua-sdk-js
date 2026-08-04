# Columnar batch transfer contract

`@honua/sdk-js/query-planner` includes the first bounded data-plane slice for large query
results. It defines a dependency-free Honua batch envelope, an ownership
transfer primitive, a normative GeoArrow 0.2 mapping, and a lazy bounded
worker-session protocol. The GeoArrow mapping is independently interpretable
without loading an Arrow implementation; the optional Apache Arrow adapter is
loaded only when explicitly requested.
It does not decode Arrow or ship built-in filter/reprojection/aggregation
operators. Applications register those operations in their worker module.

The entrypoint is experimental while the broader planner, streaming, renderer,
and realtime work in issue #394 is completed.

## Normative GeoArrow batches

`createGeoArrowBatch()` maps nullable Point, LineString, or Polygon values to
the official GeoArrow 0.2 extension names and memory shapes. Both recommended
separated coordinates and interleaved coordinates are supported. List and ring
offsets are signed 32-bit values, coordinate values are float64, temporal
columns are signed 64-bit Arrow timestamps, and string attributes use int32
dictionary indices plus UTF-8 values.

Every normative batch carries source, plan, schema, authorization-scope,
ordering, and freshness identity. `authorizationScope` must be a non-secret
fingerprint—never a token or credential. Identity is normalized with the batch,
survives structured-clone ownership transfer, and prevents a cache or renderer
from treating results produced under different source/auth/order contracts as
equivalent.

```ts doc-test=compile
import { createGeoArrowBatch, decodeGeoArrowBatch } from "@honua/sdk-js/query-planner";

const schemaId = "incidents@7";
const { batch, metrics } = createGeoArrowBatch({
  id: "incidents:0",
  sequence: 0,
  schemaId,
  identity: {
    sourceId: "incidents-live",
    sourceVersion: "42",
    schemaVersion: schemaId,
    planId: "plan:sha256:abc",
    authorizationScope: "auth-scope:sha256:def",
    ordering: {
      stable: true,
      keys: [{ field: "feature_id", direction: "ascending", nulls: "last" }],
    },
    freshness: { observedAt: "2026-07-15T12:00:00Z" },
  },
  geometry: {
    kind: "point",
    coordinateLayout: "interleaved",
    crs: "OGC:CRS84",
    values: [[-157.86, 21.31], null],
  },
  temporal: { field: "observed_at", unit: "millisecond", timezone: "UTC", values: [1n, null] },
  dictionary: { field: "status", values: ["open", null] },
  featureIds: { field: "feature_id", values: new Uint32Array([101, 102]) },
});

console.log(metrics.copiedBytes); // exact semantic-to-buffer allocation
console.log(decodeGeoArrowBatch(batch, { maxRows: 100 }).metrics.materializedRows); // 2
```

Semantic conversion is always bounded by rows, vertices, rings, unique
dictionary values, descriptor bytes, backing bytes, and exact copied payload
bytes. `inspectGeoArrowBatch()` returns typed-array views that alias the batch
buffers and reports `copiedBytes: 0`. Object rows are created only by the
explicit `decodeGeoArrowBatch()` call, which applies the same ceilings and
reports `materializedRows`; there is no unbounded conversion mode.

### Versioned persistence

`serializeGeoArrowBatch()` and `deserializeGeoArrowBatch()` provide a bounded,
dependency-free persistence envelope for the normative GeoArrow mapping. The
envelope carries a `honua.geoarrow.batch` kind and `1.0` version, deduplicates
shared backing buffers, and restores the original batch identity and metadata.
Deserialization re-runs the GeoArrow layout validator, so malformed or future
version data fails instead of silently changing layout semantics. This is not
an Arrow IPC file; applications needing Arrow IPC can use the optional adapter
after restoring the validated batch.

```ts doc-test=compile
import { createGeoArrowBatch, deserializeGeoArrowBatch, serializeGeoArrowBatch } from "@honua/sdk-js/query-planner";

const { batch } = createGeoArrowBatch({
  id: "incidents:0",
  sequence: 0,
  schemaId: "incidents@1",
  identity: {
    sourceId: "incidents-live",
    sourceVersion: "42",
    schemaVersion: "incidents@1",
    planId: "plan:sha256:abc",
    authorizationScope: "auth-scope:sha256:def",
    ordering: { stable: true, keys: [] },
    freshness: { observedAt: "2026-07-15T12:00:00Z" },
  },
  geometry: { kind: "point", values: [[-157.86, 21.31]] },
});

const persisted = serializeGeoArrowBatch(batch, { maxSerializedBytes: 16 * 1024 * 1024 });
const restored = deserializeGeoArrowBatch(persisted, {
  maxSerializedBytes: 16 * 1024 * 1024,
  maxBackingBytes: 8 * 1024 * 1024,
});
console.log(restored.metrics.serializedBytes);
```

There is no unbounded mode: callers should set a persistence ceiling suitable
for their cache. Unsupported envelope kinds or versions throw
`HonuaGeoArrowError` rather than silently migrating layout semantics.

### Optional Apache Arrow adapter

Install `apache-arrow` only in applications that exchange real Arrow
`RecordBatch` objects. The peer is dynamically imported and is absent from the
SDK root/static dependency graph:

```sh
npm install apache-arrow
```

```ts doc-test=compile
import type { ColumnarBatchV1 } from "@honua/sdk-js/query-planner";
import {
  fromApacheArrowRecordBatch,
  toApacheArrowRecordBatch,
} from "@honua/sdk-js/query-planner";

declare const batch: ColumnarBatchV1;

const { recordBatch, metrics: arrowMetrics } = await toApacheArrowRecordBatch(batch);
const { batch: restored, metrics: restoredMetrics } = fromApacheArrowRecordBatch(recordBatch);

console.log(arrowMetrics.copiedBytes, restoredMetrics.copiedBytes); // 0 0
console.log(restored.identity?.planId); // plan:sha256:abc
```

The adapter constructs the official nested Arrow shapes and retains the batch's
coordinate, offset, validity, timestamp, dictionary, and id buffers by
identity when each backing contains only the imported batch. Arrow IPC commonly
pads views and shares the complete stream allocation across record batches. The
reverse adapter narrows every logical view, then performs an explicit bounded
isolation copy when transferring the original backing could disclose unrelated
batch bytes; `metrics.copiedBytes` reports the exact cost. Slices that cannot be
interpreted losslessly still fail with `HonuaGeoArrowError`.

A standards-compliant GeoArrow batch without Honua's private transport metadata
is also accepted for the same supported field layout when the caller supplies
`id`, `schemaId`, and full batch `identity` import options. Those values cannot
be inferred safely from Arrow alone. `loadApacheArrow()` supports an injected
importer and reports code `missing-peer` with `{ package: "apache-arrow" }` when
unavailable.

## Create a batch without copying payload bytes

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createColumnarBatch, leaseColumnarBatch } from "@honua/sdk-js/query-planner";

const coordinates = new Float64Array([21.31, -157.86, 21.44, -157.77]);
const batch = createColumnarBatch({
  id: "places:0",
  sequence: 0,
  rowCount: 2,
  schema: {
    id: "places-schema-v1",
    fields: [
      {
        name: "geometry",
        type: { name: "geoarrow.point", parameters: { dimensions: 2 } },
        nullable: false,
        metadata: { "ARROW:extension:name": "geoarrow.point" },
      },
    ],
    metadata: { crs: "EPSG:4326" },
  },
  buffers: [
    {
      id: "geometry.values",
      field: "geometry",
      role: "geometry",
      data: coordinates.buffer,
      byteOffset: coordinates.byteOffset,
      byteLength: coordinates.byteLength,
    },
  ],
});

const lease = leaseColumnarBatch(batch);
const receipt = await lease.transfer((message, transfer) => {
  worker.postMessage(message, { transfer: [...transfer] });
});

console.log(receipt.metrics);
// { rows: 2, logicalBytes: 32, backingBytes: 32,
//   transferBytes: 32, copiedBytes: 0, ... }
```

Payload bytes are never copied. Schema and metadata descriptors are normalized
and frozen, while batch creation retains each caller-provided `ArrayBuffer`.
Multiple views over one buffer produce one transfer-list entry. Zero-byte
backing buffers are valid; detached buffers are rejected using an attachment
check that distinguishes the two cases.

## Memory ceilings

Creation and transfer default to at most 1,000,000 rows and 64 MiB of unique
backing allocations per batch. Descriptor normalization also defaults to at
most 4,096 total schema fields, 8,192 metadata/type-parameter entries, 16,384
buffer views, and 1 MiB of UTF-8 descriptor identifiers, keys, and string
values. The corresponding `maxRows`, `maxBackingBytes`, `maxSchemaNodes`,
`maxMetadataEntries`, `maxBufferViews`, and `maxStringBytes` limits may be
lowered or explicitly raised; there is no unbounded mode.

Array widths are checked from one captured length before element access, and
metadata keys are accumulated only to the configured bound. Normalization
therefore fails before copying an oversized schema or descriptor list. Empty
views and many views sharing one small backing allocation still count against
`maxBufferViews`; they cannot bypass the CPU/heap ceiling by keeping
`backingBytes` low.

Limits supplied when a lease is created remain its transfer defaults, so a
deliberately raised ceiling is not accidentally replaced by the global default.
A transfer may tighten either ceiling; a pre-handoff limit failure leaves the
lease owned and invokes no target.

`backingBytes` sums `ArrayBuffer.byteLength` for every unique backing allocation.
It does not claim operating-system resident or physical memory usage.
This intentionally rejects a tiny view backed by an unexpectedly large buffer.
`logicalBytes` is the sum of described view lengths and can differ when views
overlap or share memory. `copiedBytes` is always zero for this API.

## Ownership, cancellation, and acknowledgement

A `ColumnarBatchLease` starts in `owned` and can be transferred once. Live
leases reserve their unique backing buffers, so the same batch—or another batch
sharing one buffer—cannot be leased concurrently. Disposal releases the
reservation.

The SDK checks an `AbortSignal`, then performs a structured-clone ownership
transfer itself before invoking the consumer. The original buffers are detached,
the lease becomes `transferred`, and the consumer receives the SDK-owned clone
plus its exact transfer list for an optional subsequent worker/port handoff. The
optional promise returned by the consumer is an acknowledgement and
backpressure boundary.

Cancellation only applies before ownership handoff. If the consumer throws or
acknowledgement fails, the error is `transport-failed`, but the lease stays
`transferred`: the original buffers are already detached and retrying them would
be unsafe. A limit or structured-clone failure before handoff leaves the lease
owned.

`dispose()` is idempotent for an owned or transferred lease and releases the
lease's references. It cannot revoke other references held by the caller.

## Lazy worker execution

### Host-owned CRS reprojection

`createGeoArrowReprojectOperation()` adds a bounded reprojection step to the
same worker host. The SDK traverses Point, LineString, and Polygon coordinates,
preserves temporal, dictionary, and feature-id columns, validates that the
transform returns finite coordinates with the original dimensionality, and
writes the target CRS into the output geometry metadata. CRS math stays
application-owned, so this operation does not import a projection library or
make a network request.

```ts doc-test=skip reason="worker-host transform and identity are application-owned"
const reproject = createGeoArrowReprojectOperation({
  schemaId: "parcels@2:epsg3857",
  identity: projectedIdentity,
  targetCrs: "EPSG:3857",
  project: ([x, y]) => [webMercatorX(x), webMercatorY(y)],
});

startColumnarWorkerHost({ transport, operations: { reproject } });
```

The transform is a worker-host dependency and must be deterministic for a
given position. Callers must supply a new schema and batch identity whenever
the output CRS or semantics change. The operation remains bounded by the
normal GeoArrow conversion ceilings and reports `decode`, `reproject`, and
`complete` progress stages.

`createColumnarWorkerSession()` supplies the lifecycle missing from a raw
`postMessage` call: lazy worker creation, a bounded serial queue, exact request
correlation, monotonic progress, cross-thread cancellation, returned-batch
validation, typed failures, and deterministic teardown. The SDK does not import
or construct a browser or Node worker. The application injects a small
`ColumnarWorkerTransport`, so its worker URL, CSP policy, credentials, module
type, and bundler remain explicit.

```ts doc-test=skip reason="browser Worker URL and worker module are application-owned"
import { createColumnarWorkerSession } from "@honua/sdk-js/query-planner";

const session = createColumnarWorkerSession({
  maxPendingRequests: 8,
  createWorker: () => {
    const worker = new Worker(new URL("./columnar.worker.js", import.meta.url), {
      type: "module",
    });
    return {
      postMessage: (message, transfer) => worker.postMessage(message, [...transfer]),
      addEventListener: worker.addEventListener.bind(worker),
      removeEventListener: worker.removeEventListener.bind(worker),
      dispose: () => worker.terminate(),
    };
  },
});

const result = await session.execute("filter-active", batch, {
  signal: abortController.signal,
  onProgress: ({ fraction, stage }) => updateProgress(fraction, stage),
});

// result.batch now owns the buffers returned by the worker.
session.dispose();
```

The worker module registers application-owned operations against its transport:

```ts doc-test=skip reason="worker global transport wrapper is application-owned"
import { startColumnarWorkerHost } from "@honua/sdk-js/query-planner";

startColumnarWorkerHost({
  transport: wrapDedicatedWorkerGlobal(self),
  operations: {
    async "filter-active"(input, { signal, reportProgress }) {
      signal.throwIfAborted();
      reportProgress(0.25, "filter");
      const output = await filterActiveRows(input, { signal });
      reportProgress(1, "complete");
      return output;
    },
  },
});
```

Only one request is transferred to a session worker at a time. Queued batches
remain owned by the caller until dispatch, and `maxPendingRequests` (16 by
default) includes the active request. There is no unbounded mode. An
acknowledged result is validated against the same batch ceilings before the
next request starts.

Cancellation before dispatch removes the request without transferring its
buffers. Cancellation after dispatch sends the versioned cancel message and
retires the worker transport; queued work resumes on a newly created worker.
This makes cancellation deterministic even when an application operator fails
to observe its `AbortSignal`. Worker operators should still poll the signal so
worker-local resources are released promptly. Late or duplicate messages from
a retired worker cannot settle another request.

The main session and worker host both fail closed on protocol-version drift,
unknown operations, batch/metric disagreement, invalid or decreasing progress,
transport faults, and malformed results. Progress callbacks are observational:
an exception thrown by a callback cannot corrupt ownership or settlement.
Worker factories and hosts snapshot transport methods and batch ceilings before
the first asynchronous boundary; later mutation of the caller-owned options
object cannot redirect transferred buffers. Abort signals are accessed through
a failure-contained listener/read seam, so a throwing foreign signal settles
the request instead of losing it. A closed host transport can prevent a response
from being delivered, but that delivery failure is contained and the host still
releases its active-request slot without an unhandled rejection.

## Bounded conversion to object `Result`s

`columnarBatchToResult` converts a bounded, contiguous row window of a batch
into the protocol-neutral `Result` the rest of the SDK speaks, and
`resultToColumnarBatch` converts one back. They exist so the columnar plane is
opt-in rather than all-or-nothing: a popup, a table page, an export, or a
`Result`-shaped assertion no longer forces an application to abandon the
columnar path and re-execute its query on the object path.

Both directions require an explicit `maxFeatures` ceiling. The ceiling is the
point of the API, not a guard rail on it: feature objects cost roughly two
orders of magnitude more memory per row than the packed columns they are read
from, so an unbounded conversion is exactly the silent materialization the
columnar plane exists to avoid. There is no sentinel, no `Infinity`, and no
options object that disables it — `maxFeatures` must be a positive safe
integer, and a window larger than it throws `HonuaGeoArrowError` with code
`row-limit-exceeded` naming both the ceiling and the requested count. The
ceiling is checked against plain counts before the batch is inspected, so a
refused conversion allocates no feature object and reads no payload.

`DEFAULT_COLUMNAR_RESULT_MAX_FEATURES` (100,000) is exported as a documented
conservative starting point. It is deliberately **not** applied implicitly:
`maxFeatures` is always written at the call site so the cost of materialization
stays visible in the calling code.

`offset` and `limit` select the window; they default to the whole batch, which
the ceiling then bounds. Conversion cost is proportional to the window rather
than to the batch, so a thousand-row page off a million-row batch does not pay
for the batch: the per-row payload validation that the unbounded
`inspectGeoArrowBatch` performs over every coordinate, dictionary index, and
dictionary value is performed here only for the rows actually materialized.

Geometry becomes GeoJSON, preserving point, linestring, and polygon kinds,
null geometry, empty geometry, coordinate order, and `xy`/`xyz` dimensions.
`xym` and `xyzm` batches are refused with `unsupported-layout` rather than
silently stripped, because GeoJSON has no representation for an M coordinate.
The batch's declared CRS is surfaced on the returned `Result` as `crs`, as
either a serialized CRS string or a PROJJSON object; when the batch declares
none, `crs` is undefined and consumers must not assume EPSG:4326.

Feature-id, timestamp, and dictionary columns become attributes under their
declared column names. A timestamp attribute is the Arrow value as a `bigint`
in the column's declared unit — never a `Date` and never epoch milliseconds —
so microsecond and nanosecond batches round-trip exactly. A dictionary
attribute carries the decoded string. A null timestamp or dictionary value
becomes an explicit `null` attribute, never an omitted key and never a zero. A
feature-id column is not nullable. The returned `Result.fields` declares the
attribute schema.

The returned `Result` also carries a `columnar` provenance block holding the
source batch's id, schema, sequence, window bounds, geometry layout, attribute
bindings, and its full `ColumnarBatchIdentityV1`. The identity is copied and
never re-observed, so a bounded object view can never look fresher, differently
ordered, or differently scoped than the batch it was cut from.
`resultToColumnarBatch` defaults every layout and identity option from that
block, so a round trip needs only a ceiling. A plain object-path `Result` must
instead supply `id`, `schemaId`, `identity`, and any attribute binding it wants
lifted into a typed column.

```ts doc-test=skip reason="the source batch is produced by an application's own query execution"
const page = columnarBatchToResult(batch, { offset: 0, limit: 100, maxFeatures: 500 });
page.features[0].geometry; // { type: "Point", coordinates: [-157.8, 21.3] }
page.crs; // "EPSG:3857" | PROJJSON | undefined
page.columnar.identity.freshness; // the batch's own freshness, not a new observation

const roundTripped = resultToColumnarBatch(page, { maxFeatures: 500 });
```

### Nothing is dropped quietly

The forward direction is complete by construction: a normative GeoArrow batch
carries exactly a geometry column plus optional temporal, dictionary, and
feature-id columns, and every one of them lands on the converted feature. There
is no loss to report because there is no loss.

The inverse direction is where an object `Result` can carry more than a columnar
batch can hold, so `resultToColumnarBatch` **fails closed** with
`unsupported-layout` on any attribute no column binding covers, naming the
attribute and the feature index. `unmappedAttributes: "drop"` is the only way
past it, and even then every dropped name comes back sorted on
`droppedAttributes`, so the loss is stated rather than assumed. A conversion
that never sets the option can treat its result as lossless without checking.

The same discipline governs the rest of the inverse direction: `xym`/`xyzm`
geometry is refused rather than stripped of its M coordinate, a geometry type
outside point/linestring/polygon is refused rather than approximated, a window
mixing geometry kinds is refused rather than split, and an Esri geometry
envelope is refused rather than guessed at.

### Streaming a whole batch

`columnarBatchToResultPages` walks a batch as a sequence of bounded pages. It is
how a caller converts more of a batch than one window without raising the
ceiling: each page is a complete, independently valid `Result` bounded by
`maxFeatures`, and only the page a consumer is holding is live, so streaming a
million-row batch to a file retains one page rather than a million features.

```ts doc-test=skip reason="the source batch and the row sink are application-owned"
for await (const page of columnarBatchToResultPages(batch, {
  pageSize: 1_000,
  maxFeatures: 1_000,
  signal: controller.signal,
})) {
  await writeRows(page.features);
}
```

Pages are emitted in ascending row order, contiguous and non-overlapping, so
concatenating every page's `features` reproduces exactly the sequence a single
window over the same range would have produced. An empty range yields no pages
rather than one empty page.

Cancellation is cooperative and real rather than decorative. `signal` is checked
before each page and every 1,024 rows inside one, and — because a synchronous
loop in a single-threaded runtime can never observe an abort no matter how often
it polls — the traversal hands control back to the host task queue every 16,384
rows and between pages. That is what gives the poll something to find when the
abort is raised by a task: a worker message, a timer, or a user gesture. An
aborted traversal rejects with an `AbortError` `DOMException` and never
materializes the remaining pages. An already-aborted signal is refused before
the batch is inspected at all.

Conversion is derived and is not cached. The
`columnar.result.bounded-window` benchmark-lab scenario carries the memory and
throughput budgets for both directions; see
[`bench/README.md`](../bench/README.md).

## Typed errors

`HonuaColumnarTransferError.code` is one of:

- `invalid-batch`
- `row-limit-exceeded`
- `memory-limit-exceeded`
- `schema-limit-exceeded`
- `metadata-limit-exceeded`
- `buffer-view-limit-exceeded`
- `string-limit-exceeded`
- `already-leased`
- `aborted`
- `already-transferred`
- `disposed`
- `transport-failed`

`HonuaColumnarWorkerError.code` is one of:

- `invalid-request`
- `invalid-response`
- `unknown-operation`
- `queue-full`
- `aborted`
- `operation-failed`
- `worker-failed`
- `disposed`

## Deliberate remaining scope

This slice does not claim the full #394 workstream. Arrow IPC decoding, built-in
filter/projection/reprojection/aggregation operators, multi-batch streaming
across more than one in-flight worker, planner integration, renderer
consumption, batch cache identity, realtime patches, and application-specific
CSP worker URL policy remain separate work.
