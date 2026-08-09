# GeoParquet and GeoArrow workflow capability matrix

The `@honua/sdk-js/columnar-workflow` session joins existing GeoParquet and GeoArrow primitives into one bounded workflow. Status is split by execution surface so fixture-backed client behavior is not presented as live Honua server evidence.

| Capability | Client | Honua server | End to end | Evidence |
| --- | --- | --- | --- | --- |
| Inspect direct GeoParquet schema, geometry encoding, CRS, bbox, row estimate, and row-group metadata | Experimental | Not applicable | Fixture contract | `test/columnar-workflow.test.ts` and existing GeoParquet fixtures |
| Push columns, filter, bbox, limit, offset, order, and aggregations into direct GeoParquet execution | Experimental | Not applicable | Fixture contract | Existing GeoParquet query tests plus `test/columnar-workflow.test.ts` |
| Build typed FeatureServer `f=parquet` and `f=arrow` GET/POST queries | Experimental | Server contract required | Fixture contract only | `test/columnar-workflow.test.ts` |
| Decode Arrow IPC as bounded batches | Experimental, optional Apache Arrow peer | Server contract required | Fixture contract only | `createApacheArrowResponseDecoder` and columnar adapter tests |
| Decode Honua Parquet responses | Decoder extension point | Server contract required | Not admitted | No demo-manifest target currently proves the response contract |
| Enforce row, batch, transfer-byte, and backing-memory ceilings | Experimental | Not applicable | Fixture contract | `test/columnar-workflow.test.ts` |
| Cancellation, auth, retry, timeout, and interceptor pipeline | Experimental | Compatible endpoint required | Fixture contract | `HonuaClient.pipelineFetch` contract tests |
| Table, worker, deck.gl, aggregation, and download handoffs | Experimental descriptors; existing columnar primitives execute them | Not applicable | Fixture contract | Columnar and deck.gl contract tests |
| Zarr and NetCDF | Maturity marker only | Maturity marker only | Not implemented | No executable claim |

No row, byte, latency, or memory result in this matrix is a live-server claim. A live status requires a pinned demo-manifest target and the same semantic verification used by the samples gallery.
