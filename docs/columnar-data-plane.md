# Columnar batch transfer contract

`@honua/sdk-js/query-planner` includes the first bounded data-plane slice for large query
results. It defines a dependency-free Honua batch envelope and an ownership
transfer primitive. Arrow/GeoArrow adapters may populate its buffers and
metadata, but the envelope does not define a standalone Arrow layout and is not
independently interoperable without the originating adapter's layout contract.
It does not decode Arrow, execute queries, or create workers.

The entrypoint is experimental while the broader planner, streaming, renderer,
and realtime work in issue #394 is completed.

## Create a batch without copying payload bytes

```ts
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

## Deliberate remaining scope

This slice does not claim the full #394 workstream. Arrow IPC decoding,
filter/projection/reprojection/aggregation workers, multi-batch streaming,
planner integration, renderer consumption, batch cache identity, realtime
patches, CSP worker factories, and bounded conversion back to feature objects
remain separate work.
