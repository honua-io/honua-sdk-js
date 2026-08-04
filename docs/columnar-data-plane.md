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
envelope carries a `honua.geoarrow.batch` kind and a `1.1` version, deduplicates
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

### Envelope migration ladder

An envelope written by an older SDK is migrated forward on read through an
ordered registry of `fromVersion` → `toVersion` steps
(`GEOARROW_ENVELOPE_MIGRATIONS`), and the applied chain is reported in the
deserialization metrics. The shipped ladder carries `1.0 → 1.1`, which derives
each backing's decoded length from its base64 length and stamps the GeoArrow
layout version that `1.0` left implicit, so backing ceilings are now enforced
before a single byte is decoded.

Version resolution happens on the envelope header, before any payload is read.
An unknown version, a version from a future build, and a version the ladder
cannot carry to the current one all throw `unsupported-serialization` with a
stable message; nothing is decoded and nothing is guessed. A migration step
receives only the parsed envelope — never the caller's serialization options —
so migrating an old entry can never widen a bound the caller set.

```ts doc-test=compile
import {
  deserializeGeoArrowBatch,
  planGeoArrowEnvelopeMigration,
  readableGeoArrowEnvelopeVersions,
} from "@honua/sdk-js/query-planner";

// Which persisted layouts this build can still read.
console.log(readableGeoArrowEnvelopeVersions()); // ["1.0", "1.1"]

const plan = planGeoArrowEnvelopeMigration("1.0");
if (!plan.applicable) throw new Error(`unreadable envelope: ${plan.reason}`);

declare const persisted: Uint8Array;
const restored = deserializeGeoArrowBatch(persisted);
console.log(restored.metrics.envelopeVersion, restored.metrics.migrations); // "1.1" ["1.0->1.1"]
```

### Persistent batch cache

**The default is no cache.** Nothing in the SDK persists a batch: an application
opts in by creating a store, choosing a backend, and writing to it. When it
does, `createColumnarBatchCache()` binds five properties that a hand-rolled
cache would have to get right on its own.

1. **Identity-bound keys.** `columnarBatchCacheKey(identity)` digests source id,
   source version, schema version, plan id, the ordering contract, the freshness
   validators (`validator`, `generation`), and a **digest** of the authorization
   scope. The raw scope never appears in the key or in a persisted record, and a
   change to any keyed component addresses a different entry. `observedAt` and
   `staleAfter` are deliberately not keyed — they describe when a producer
   looked, not what was asked for — so expiry is enforced on read instead.
2. **Scope isolation.** A batch written under one authorization scope is never
   returned to a reader holding another, and a record whose recorded scope digest
   disagrees with the reader's is deleted rather than served.
3. **Freshness.** A read past the record's `staleAfter`, or past the store's
   `maxAgeMs`, returns an explicit `stale` outcome carrying the record, so a
   caller can revalidate instead of silently receiving expired data.
4. **Integrity.** Every read recomputes the SHA-256 of the stored envelope and
   compares it to the digest written with it. A mismatch is a miss *and* a
   delete; unverified bytes are never served.
5. **Bounded storage.** An explicit byte quota and record cap are enforced by a
   deterministic oldest-first eviction plan, applied together with the write in
   one atomic backend operation.

The store itself holds no IndexedDB, filesystem, or Node reference, so
`/query-planner` stays SSR- and worker-safe. `createIndexedDbColumnarBatchCacheStorage()`
is the browser backend; `createMemoryColumnarBatchCacheStorage()` is the
in-process one with identical semantics, and
`runColumnarBatchCacheConformance()` is the shared suite both must pass.

```ts doc-test=compile
import {
  createColumnarBatchCache,
  createIndexedDbColumnarBatchCacheStorage,
} from "@honua/sdk-js/query-planner";
import type { ColumnarBatchIdentityV1, ColumnarBatchV1 } from "@honua/sdk-js/query-planner";

const cache = createColumnarBatchCache(createIndexedDbColumnarBatchCacheStorage(), {
  quotaBytes: 32 * 1024 * 1024,
  maxRecords: 32,
  maxAgeMs: 15 * 60 * 1000,
  onDiagnostic: (diagnostic) => console.warn(diagnostic.operation, diagnostic.reason),
});

declare const identity: ColumnarBatchIdentityV1;
declare const batch: ColumnarBatchV1;

const read = await cache.read(identity);
if (read.outcome === "hit") {
  console.log(read.batch.rowCount, read.metrics.migrations);
} else if (read.outcome === "stale") {
  console.log("revalidate", read.record.freshness.validator);
} else {
  const written = await cache.write(batch);
  if (written.outcome === "refused") console.warn(written.reason, written.detail);
}
```

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
consumption, realtime patches (which must invalidate or re-version their cached
base batch), application-specific CSP worker URL policy, and bounded conversion
back to feature objects remain separate work.
