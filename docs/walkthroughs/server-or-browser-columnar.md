# Choose server pushdown or bounded browser execution

Use this walkthrough when the same analysis may begin with a Honua feature layer or a direct GeoParquet object. The plan tells you where filtering happens before bytes move.

## 1. Define a hard budget

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
  decodeServerResponse: createApacheArrowResponseDecoder({ geometryKind: "point" }),
  budgets: {
    maxRows: 25_000,
    maxBatches: 32,
    maxTransferBytes: 16 * 1024 * 1024,
    maxBackingBytes: 32 * 1024 * 1024,
  },
});
```

## 2. Plan a bounded subset

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
console.log(plan.execution, plan.pushdown, plan.boundedBy);
```

Expected outcome: `execution` is `server-pushdown`; the URL or POST body contains the bounded query. Planning does not assert that a deployment serves Arrow or Parquet. Check the server capability manifest before executing.

## 3. Stream with backpressure and cancellation

Install Apache Arrow as the optional peer and pass `createApacheArrowResponseDecoder()` only when the deployment advertises Arrow IPC. The built-in Honua bridge decodes a bounded GeoArrow WKB subset: Binary/LargeBinary Point, LineString, or Polygon in XY/XYZ, plus one object-id, one UTF-8/dictionary field, and one timestamp field. BinaryView, multi-geometries, GeometryCollection, M/ZM coordinates, ambiguous fields, and additional fields require a custom `decodeServerResponse`; the bridge fails closed rather than dropping data. `geometryKind` is needed only when an empty or all-null response cannot declare its kind. Each loop iteration requests the next decoded batch only after your handler completes.

```ts doc-test=skip reason="Requires an advertised live Honua Arrow endpoint and application renderBatch implementation."
for await (const { batch, evidence } of session.stream({
  columns: ["name", "created"],
  bbox: [-158.1, 21.2, -157.6, 21.8],
  limit: 5_000,
  signal: controller.signal,
})) {
  renderBatch(batch);
  console.table(evidence);
}
```

Expected outcome: evidence reports cumulative rows, batches, bytes, elapsed time, peak backing bytes, and the governing ceilings. An exceeded ceiling, unsupported WKB/schema layout, or abort is a typed `ColumnarWorkflowError`, not partial success. The checked-in interoperability fixture was emitted by Honua Server commit `fd1c651efa7078c269742152a2777298e3b1c4d4`; it is fixture evidence, not a live deployment claim. The built-in decoder does not decode `f=parquet` responses.

## 4. Switch to a direct GeoParquet object

Use the same query shape with a `direct-geoparquet` source. DuckDB-WASM performs bounded projection, filtering, bbox selection, and limit in the browser. Inspect first rather than guessing from a suffix.

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

Expected outcome: `execution` is `browser-bounded`. Use server pushdown when it materially reduces bytes; use direct browser execution when the object is the product boundary. Record emitted evidence either way.

## 5. Pick an explicit handoff

Use `table` for a small decoded preview, `worker` for a transferable batch descriptor, `render` for a deck.gl-oriented zero-copy descriptor, or `download` to preserve the exact bounded server request. Worker operation names are application-owned, so `worker(batch, "projection")` can address a registered `createGeoArrowProjectionOperation()` without pretending the handoff itself executes it. Existing columnar primitives perform aggregation and concrete deck.gl binding.
