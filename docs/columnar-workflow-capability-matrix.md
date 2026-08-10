# GeoParquet and GeoArrow workflow capability matrix

The `@honua/sdk-js/columnar-workflow` session joins existing GeoParquet and GeoArrow primitives into one bounded workflow. Status is split by execution surface so fixture-backed client behavior is not presented as live Honua server evidence.

| Capability | Client | Honua server | End to end | Evidence |
| --- | --- | --- | --- | --- |
| Inspect direct GeoParquet schema, geometry encoding, CRS, bbox, row estimate, and row-group metadata | Experimental | Not applicable | Fixture contract | `test/columnar-workflow.test.ts` and existing GeoParquet fixtures |
| Push filter, explicitly WGS84 bbox, limit, offset, and order into direct GeoParquet execution | Experimental | Not applicable | Fixture contract | Existing GeoParquet query tests plus `test/columnar-workflow.test.ts` |
| Direct attribute projection and aggregation | Projection rejected; aggregation is an explicit bounded worker handoff | Not applicable | Not admitted as direct pushdown | `test/columnar-workflow.test.ts` |
| Build typed FeatureServer `f=parquet` and `f=arrow` GET/POST queries | Experimental | Server contract required | Fixture contract only | `test/columnar-workflow.test.ts` |
| Decode Honua `geoarrow.wkb` Arrow IPC into bounded batches | Experimental GeoArrow 0.2 WKB subset with optional Apache Arrow peer; Binary/LargeBinary Point, LineString, or Polygon in XY/XYZ plus one object-id, one UTF-8/dictionary field, and one timestamp field. Embedded EWKB SRIDs are ignored; only validated optional `crs`/`crs_type` extension metadata is preserved. | Current FeatureServer `f=arrow` contract | Exact server-produced fixture only | `test/fixtures/columnar/honua-server-geoarrow-wkb.manifest.json` and `test/columnar-workflow-honua-arrow.test.ts` |
| Decode BinaryView, broader Arrow schemas, multi-geometries, GeometryCollection, or M/ZM coordinates | Decoder extension point | Server contract available | Not admitted | The pinned Arrow JS peer does not expose BinaryView; the built-in bridge fails closed rather than dropping fields or geometry parts |
| Decode Honua Parquet responses | Decoder extension point | Server contract required | Not admitted | No demo-manifest target currently proves the response contract |
| Enforce row, batch, transfer-byte, and backing-memory ceilings | Experimental | Not applicable | Fixture contract | `test/columnar-workflow.test.ts` |
| Cancellation, auth, retry, timeout, and interceptor pipeline | Experimental | Compatible endpoint required | Fixture contract | `HonuaClient.pipelineFetch` contract tests |
| Table, worker, deck.gl, aggregation, and download handoffs | Experimental descriptors; existing columnar primitives execute them | Not applicable | Fixture contract | Columnar and deck.gl contract tests |
| Zarr and NetCDF | Maturity marker only | Maturity marker only | Not implemented | No executable claim |

No row, byte, latency, or memory result in this matrix is a live-server claim. The WKB interop artifact is bound to Honua Server commit `fd1c651efa7078c269742152a2777298e3b1c4d4` and proves serialization compatibility only. A live status requires a pinned demo-manifest target and the same semantic verification used by the samples gallery.
