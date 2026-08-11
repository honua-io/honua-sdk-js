# Choose server pushdown or bounded browser execution

Use this walkthrough when the same map workflow may begin with a Honua feature layer or a direct GeoParquet object. Make the execution boundary and ceilings visible before bytes move, then compare measured evidence rather than assuming the server or browser is cheaper.

## Outcome

| Lane | Work pushed down | Browser work | Evidence boundary |
| --- | --- | --- | --- |
| Honua Arrow query | columns, filter, bbox, ordering, limit | bounded Arrow IPC and WKB decode, map/table handoff | exact response rows, bytes, batches, elapsed time, and peak backing memory |
| Direct GeoParquet | object and row-group selection where the engine supports it | bounded DuckDB-WASM scan, Arrow batches, progressive map render | observed HTTP ranges/bytes plus result rows and memory ceiling; rows scanned and row groups pruned remain unverified |

The runnable [Map a bounded Arrow result](../../examples/columnar-query-quickstart/README.md) produces this deterministic fixture outcome:

```text
execution             server-pushdown
rows / batches        1 / 1
admitted payload      1,336 bytes
row ceiling           25
transfer ceiling      16,384 bytes
backing ceiling       65,536 bytes
cancel outcome        no batch admitted; next run succeeds
```

The complete [Overture Columnar Lab project](https://github.com/honua-io/honua-sdk-js/tree/trunk/examples/overture-geoparquet) applies the browser lane to a pinned 656,568,610-byte public object without permitting full-object HTTP fallback.

## 1. Define hard budgets before opening the source

```ts doc-test=compile
import { createApacheArrowResponseDecoder, openColumnarSession } from "@honua/sdk-js/columnar-workflow";

const session = openColumnarSession({
  kind: "honua-feature-query",
  id: "bounded-parcels",
  baseUrl: "https://example.invalid/",
  serviceId: "Parcels",
  layerId: 0,
  format: "arrow",
  sourceVersion: "deployment-v1",
  schemaVersion: "layer-v1",
  authorizationScope: "user",
}, {
  decodeServerResponse: createApacheArrowResponseDecoder({
    geometryKind: "point",
    importModule: () => import("apache-arrow"),
  }),
  budgets: {
    maxRows: 25_000,
    maxBatches: 32,
    maxTransferBytes: 16 * 1024 * 1024,
    maxBackingBytes: 32 * 1024 * 1024,
  },
});
```

These are enforced ceilings, not telemetry labels. A response stops before emission when any ceiling is crossed.

## 2. Plan a server-pushdown subset

```ts doc-test=skip reason="Continues with the session declared in the previous independently compiled snippet."
const plan = session.plan({
  columns: ["name", "created"],
  bbox: [-158.1, 21.2, -157.6, 21.8],
  filter: {
    kind: "comparison",
    operator: "gte",
    left: { kind: "property", name: "objectid" },
    right: { kind: "literal", value: 1 },
  },
  orderBy: [{ field: "created", direction: "desc" }],
  limit: 5_000,
});
console.log(plan.execution, plan.pushdown, plan.boundedBy, plan.request);
```

Expected outcome: `execution` is `server-pushdown`, and the URL or POST body contains the bounded query. Planning alone does not prove a deployment serves Arrow or Parquet. Check its capability manifest before execution.

## 3. Stream, map, and cancel with backpressure

Install Apache Arrow as the optional peer and pass `createApacheArrowResponseDecoder()` only when the deployment advertises Arrow IPC. In browser builds, inject a literal `() => import("apache-arrow")` so the bundler can resolve the optional peer; Node applications may use the default loader. Each loop requests the next decoded batch only after the handler completes.

```ts doc-test=skip reason="Requires an advertised live Honua Arrow endpoint and application mapBatch implementation."
for await (const { batch, evidence } of session.stream({
  columns: ["name", "created"],
  bbox: [-158.1, 21.2, -157.6, 21.8],
  limit: 5_000,
  signal: controller.signal,
})) {
  const rows = session.table(batch, 5_000).rows;
  mapBatch(rows);
  console.table(evidence);
}
```

Expected outcome: evidence reports cumulative rows, batches, admitted payload bytes, elapsed time, peak backing bytes, and governing ceilings. Cancellation, an exceeded ceiling, or an unsupported layout is a typed `ColumnarWorkflowError`, never partial success.

The built-in bridge decodes a bounded GeoArrow 0.2 WKB subset: Binary/LargeBinary Point, LineString, or Polygon in XY/XYZ, plus one object-id, one UTF-8/dictionary field, and one timestamp field. It ignores embedded EWKB SRIDs and preserves only validated optional column-level `crs`/`crs_type` metadata. It never invents a CRS84 default. BinaryView, multi-geometries, GeometryCollection, M/ZM coordinates, ambiguous or additional fields, and Parquet responses require an application decoder and fail closed otherwise.

The checked-in interoperability fixture was emitted by Honua Server commit `fd1c651efa7078c269742152a2777298e3b1c4d4`. It is fixture evidence, not a live deployment claim.

## 4. Switch to direct GeoParquet for browser analysis

Use the same bounded query shape with a `direct-geoparquet` source. DuckDB-WASM performs projection, filtering, bbox selection, and limit in the browser. Inspect metadata first rather than guessing from a suffix.

```ts doc-test=skip reason="Requires a pinned GeoParquet fixture URL and DuckDB-WASM runtime assets."
const direct = openColumnarSession({
  kind: "direct-geoparquet",
  id: "parcel-object",
  url: fixtureUrl,
  sourceVersion: fixtureEtag,
  schemaVersion: "geo-1.1",
  authorizationScope: "public",
});
console.log(await direct.inspect());
```

Expected outcome: `execution` is `browser-bounded`. A bbox query requires an explicitly declared WGS84 longitude/latitude CRS. Use server pushdown when it materially reduces bytes; use direct browser execution when the object itself is the product boundary.

The Overture project adds the production controls needed for a large object: a one-square-degree AOI maximum, five projected columns, a 200-row limit, a 256 MiB DuckDB ceiling, a 1 MiB JavaScript result ceiling, source and engine deadlines, range-only HTTP, a three-entry versioned cache, progressive rendering, and runtime termination on cancellation. Scheduled evidence rejects every un-ranged `GET`. DuckDB does not expose actual rows scanned or row groups pruned, so the project does not claim those metrics.

## 5. Pick an explicit handoff

Use `table` for a small decoded preview, `worker` for a transferable batch descriptor, `render` for a deck.gl-oriented zero-copy descriptor, or `download` to preserve the exact bounded server request. Worker operation names are application-owned, so `worker(batch, "projection")` can address a registered operation without pretending the handoff itself executes it.

## Troubleshooting

- `DECODER_REQUIRED`: the server response needs an application decoder, or the deployment did not advertise a supported Arrow contract.
- `TRANSFER_LIMIT_EXCEEDED` or `BACKING_LIMIT_EXCEEDED`: narrow the AOI, projection, or limit; never raise ceilings without measuring the resulting product budget.
- `INVALID_QUERY` for a direct bbox: the GeoParquet metadata did not explicitly establish WGS84 longitude/latitude coordinates.
- Browser range fallback: stop. Do not allow a convenience retry that downloads the full object.
- Live Arrow unavailable: run the exact fixture example and retain fixture-only maturity rather than converting it into a live claim.
