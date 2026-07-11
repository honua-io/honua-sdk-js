# GeoParquet / DuckDB-WASM source

`@honua/sdk-js/geoparquet` adds a `Source` that runs the **same
protocol-neutral `Query`** you use against a FeatureServer or an OGC API
Features collection — but against GeoParquet files, in the browser, via
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) and its `spatial`
extension. The query compiles to SQL over `read_parquet(...)` and returns the
standard `Result` (GeoJSON features + schema), so results render through the
same query-tiles runtime path as any other source.

This is the "query Overture GeoParquet in the browser via DuckDB-WASM" reference
architecture, slotted directly into the `Dataset → Source → Query → Result`
contract.

## Install

`@duckdb/duckdb-wasm` is an **optional peer dependency** — it is not bundled and
not pulled into the `/contract` or `/honua` entrypoints. Install it (and its
`apache-arrow` peer) only when you use this source:

```bash
npm i @duckdb/duckdb-wasm apache-arrow
```

The engine is reached through a dynamic `import()`, so there is no static
dependency edge from the core SDK. If the peer is missing, constructing a query
throws a clear "install `@duckdb/duckdb-wasm`" error rather than failing
opaquely.

## Quickstart

Wire the resolver into `createDataset`. One `GeoparquetRuntime` — one shared
DuckDB Web Worker — backs every geoparquet source in the dataset.

```ts doc-test=compile
import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { geoparquetResolver } from "@honua/sdk-js/geoparquet";
import { envelope } from "@honua/sdk-js";
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });
const geoparquet = geoparquetResolver();

const dataset = createDataset({
  id: "overture",
  client,
  capabilityPolicy: "degraded",
  resolveSource: geoparquet,
  sources: [
    {
      id: "places",
      protocol: "geoparquet",
      // A single file, or a hive-partitioned glob (e.g. an Overture theme):
      locator: { url: "https://example.com/overture/theme=places/**/*.parquet" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
    },
  ],
});

const places = dataset.source("places")!;

// The SAME Query object shape that runs against a FeatureServer source:
const result = await places.query({
  where: "categories.primary = 'restaurant'",
  spatialFilter: envelope(-158.5, 21.2, -157.6, 21.7),
  outFields: ["id", "names", "categories"],
  pagination: { limit: 500 },
  returnGeometry: true,
});

for (const feature of result.features) {
  console.log(feature.attributes.id /* GERS id preserved */, feature.geometry);
}

// Tear down the shared worker when the client is disposed:
await geoparquet.dispose();
```

You can also construct a source directly with `geoparquetSource(descriptor,
{ runtime })` if you are not using `createDataset`.

## How the Query compiles to SQL

| `Query` field | DuckDB SQL |
| --- | --- |
| `outFields` | quoted identifier projection; geometry projected as `ST_AsGeoJSON(...)` |
| `where` | passed through verbatim, wrapped in `( … )` (caller-authored SQL, like GeoServices `where`) |
| `spatialFilter` (envelope) | `ST_Intersects(<geom>, ST_MakeEnvelope(xmin, ymin, xmax, ymax))`, or a GeoParquet 1.1 `bbox` covering-column comparison (row-group prune) |
| `spatialFilter` (point/polyline/polygon) | reduced to its bounding box; reported in `Result.degraded` as an approximation |
| `orderBy` | `ORDER BY "field" ASC|DESC` |
| `pagination` | `LIMIT` / `OFFSET` |
| `aggregation` | `GROUP BY` with `count/sum/avg/min/max/stddev_samp/var_samp` metrics |
| `returnGeometry: false` | geometry omitted from the projection |

### SQL-injection safety

Every value the compiler interpolates is escaped:

- **Identifiers** (`outFields`, `orderBy`, `groupBy`, geometry column):
  double-quoted with embedded quotes doubled; control characters rejected.
- **String literals** (parquet URLs): single-quoted with embedded quotes
  doubled; NUL rejected.
- **Numeric literals** (bbox, limit, offset): validated finite / non-negative.

The one deliberate exception is `Query.where`, which — exactly like the
GeoServices and OGC adapters — is caller-authored filter SQL passed through
verbatim. The trust boundary on `where` is the caller's, identical to a
GeoServices `where` clause. The compiler is covered by snapshot tests in
`test/geoparquet-sql.test.ts`.

## Both metadata styles

The source handles both geometry storage conventions, detected from the parquet
footer and cached per source-URL set:

1. **GeoParquet 1.0 / 1.1 metadata files** — the `geo` key-value JSON is parsed
   for the primary geometry column, CRS, and (1.1) the `bbox` covering column.
2. **Parquet-native geometry** — a `GEOMETRY` / `GEOGRAPHY` column type
   (Parquet 2.11, March 2025), a raw WKB `BLOB`, or a GeoJSON string column,
   inferred from the DuckDB column type and conventional geometry column names.

The physical encoding (`GEOMETRY` used directly, `BLOB` wrapped in
`ST_GeomFromWKB`, string wrapped in `ST_GeomFromGeoJSON`) is keyed off the type
DuckDB actually returns, so both styles produce an identical `Result` shape.

## `describe()`

Reach the metadata through the typed escape hatch:

```ts doc-test=skip reason="partial excerpt requires application host context"
const handle = places.protocol("geoparquet")!;
const description = await handle.describe();
// { schema: HonuaFieldInfo[], geometryColumns: ["geometry"],
//   geometryEncoding: "wkb" | "native" | "geojson", crs: "OGC:CRS84",
//   rowEstimate: 12345 }  ← rowEstimate from the parquet footer, no table scan

const rows = await handle.sql("SELECT count(*) FROM read_parquet('...')"); // raw escape hatch
```

## Aggregation

```ts doc-test=skip reason="partial excerpt requires application host context"
const summary = await places.queryAggregate({
  aggregation: {
    groupBy: ["categories.primary"],
    metrics: [{ fn: "count", field: "*", alias: "n" }],
  },
});
// summary.aggregateRows: [{ "categories.primary": "restaurant", n: 812 }, …]
```

## Lifecycle & memory ceiling

- A `GeoparquetRuntime` owns **exactly one** DuckDB instance and one Web Worker,
  created lazily on the first query and shared across every source it backs
  (NFR-001: single shared worker per client).
- Call `resolver.dispose()` / `runtime.dispose()` when the owning client is torn
  down to terminate the worker. Disposal is idempotent.
- DuckDB-WASM runs inside a single WASM linear memory with a **~4 GiB ceiling**
  (32-bit addressing). In practice keep the working set — scanned columns ×
  matched rows, plus the spatial index — well under ~2 GiB. Prefer narrow
  `outFields`, push a `spatialFilter` down, and bound results with
  `pagination.limit` on large Overture extracts.
- Parquet footers / row-group metadata are cached per source-URL set **inside
  the runtime**; there is no on-disk persistence.
- `Source.stream()` uses DuckDB-WASM Arrow record batches when the driver
  supports them; `Source.query()` intentionally materializes its bounded result.
  `Query.signal` is forwarded to the browser driver's `cancelSent()` path.
- Browser deployments can set `loadSpatial: false` when a GeoParquet `bbox`
  covering is sufficient, and can pin `extensionRepository` plus
  `preloadExtensions` to keep Parquet execution self-hosted.
- Browser deployments reading large remote objects can set
  `filesystem: { reliableHeadRequests: true, allowFullHttpReads: false }` to
  require range-capable HTTP I/O and fail closed instead of allowing
  DuckDB-WASM's full-file fallback.

## Capability honesty

`geoparquet` advertises `{ query, queryAggregate, stream }`. Everything else is
an honest miss that throws `HonuaCapabilityNotSupportedError`:
`queryExtent`, `queryObjectIds`, `queryRelated`, `applyEdits`, and
`attachments`. The source is read-only (static files) and exposes no
server-side ids/extent endpoint. There is no realtime path.

## Overture recipe

Overture Maps ships monthly GeoParquet releases. The
[`examples/overture-geoparquet`](../examples/overture-geoparquet/) demo runs
entirely against a **fixture-sized extract committed to the repo** (no Honua
server, CI-deterministic) and preserves GERS ids in results.

For live Overture data, resolve a pinned file from Overture's STAC catalog
before constructing the source. Do not hand a global glob to a browser without
an AOI, projection, result limit, memory budget, cancellation, and file-level
STAC selection:

```ts doc-test=skip reason="partial excerpt requires application host context"
// Overture release layout (see https://docs.overturemaps.org/):
const PINNED_ITEM =
  "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/theme=places/type=place/part-00000-6c973aba-862d-590f-a178-70bcd31cde1c-c000.zstd.parquet";

createDataset({
  id: "overture-live",
  client,
  capabilityPolicy: "degraded",
  resolveSource: geoparquetResolver(),
  sources: [
    {
      id: "places",
      protocol: "geoparquet",
      locator: { url: PINNED_ITEM },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
    },
  ],
});
```

Always send a `spatialFilter`, narrow `outFields`, `pagination.limit`, and
`signal` against live Overture. A bbox predicate creates a pruning opportunity;
it does not by itself prove bytes avoided or row groups skipped. The current
browser driver does not expose its internal HTTP bytes/ranges, rows scanned, or
row-group pruning metrics. The flagship sample reports those as unverified and
uses an explicit execution deadline rather than falling back to full
materialization.

## Regenerating the test fixtures

The tiny committed fixtures under `test/fixtures/geoparquet/` are produced by
`npm run geoparquet:fixtures` (which drives DuckDB-WASM's Node bindings). Only
run it when the fixture schema changes.
