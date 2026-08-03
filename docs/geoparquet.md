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

// The same stable Query envelope runs against a FeatureServer source:
const result = await places.query({
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

## Lossless JSON results

GeoParquet keeps its historical result behavior by default: DuckDB `bigint`
values are converted to JavaScript `number`. Applications that need exact,
portable JSON can opt in for a source directly or for every source built by a
resolver:

```ts doc-test=skip reason="partial excerpt requires application host context"
const geoparquet = geoparquetResolver({ resultEncoding: "lossless-json" });

// Equivalent direct-source option:
const source = geoparquetSource(descriptor, {
  runtime,
  resultEncoding: "lossless-json",
});
```

The opt-in applies consistently to `query()`, `queryAll()`, `stream()`, and
`queryAggregate()`:

| Effective DuckDB type | JSON-safe value |
| --- | --- |
| `BIGINT`, `UBIGINT`, `HUGEINT`, `UHUGEINT` | exact canonical decimal string |
| `DECIMAL` / `NUMERIC` | exact fixed-scale decimal string |
| `DATE`, `TIME`, `TIMESTAMP*` | deterministic ISO-style string at the declared precision |
| `BLOB`, `BINARY`, `VARBINARY`, `BYTEA` | padded standard base64 string |
| `LIST`, `ARRAY`, `STRUCT`, `MAP` | recursively normalized JSON arrays/objects (`MAP` is an array of `{ key, value }`) |
| safe integers, finite floating point, booleans, text, null | native JSON scalar |

Aggregate decoding uses DuckDB's **output** types, not its input column types:
`count` is `BIGINT`, integer `sum` through `UBIGINT` is `HUGEINT`, decimal
`sum` is `DECIMAL(38, scale)`, and grouped keys retain their source types.
DuckDB's `sum(UHUGEINT)` exception is a `DOUBLE` and is decoded as that
effective result type. Consequently, exact counts and exact widened sums are
strings in lossless mode, even when their current values happen to fit in a
JavaScript safe integer.

The source casts exact root scalars to text in an outer projection over the
already-compiled query. This prevents Arrow from rounding a value first and
does not add another `read_parquet` scan. Nested Arrow values are decoded at a
bounded, accessor-free boundary; ambiguous wrappers, unsafe numbers, cycles,
or excessive depth/width throw `DuckDbLosslessDecodeError` instead of silently
changing data. The bounded compiled-decoder cache is tied to both the effective
`DESCRIBE` profile and the optional `SourceSchemaV2` fingerprint and is cleared
when either identity changes. `Query.signal` is checked around profile, query,
batch, and row decoding boundaries; aborting one caller stops its wait without
cancelling a shared profile build needed by other sources.

Lossless mode guarantees that `JSON.stringify(result)` does not encounter a
`bigint`, typed array, `Map`, or `Date`. It does not change geometry output or
the raw `source.protocol("geoparquet").sql(...)` escape hatch. Opaque query-plan
execution does not currently carry the effective DuckDB field types needed for
lossless decoding. A source configured for lossless results therefore rejects
that internal path with `GEOPARQUET_LOSSLESS_SCHEMA_REQUIRED` before executing
the resolved relation instead of silently returning legacy, precision-losing
values.

## How the Query compiles to SQL

| `Query` field | DuckDB SQL |
| --- | --- |
| `outFields` | quoted identifier projection; geometry projected as `ST_AsGeoJSON(...)` |
| `where` | validated as a single boolean expression, then wrapped in `( … )` (see [SQL-injection safety](#sql-injection-safety)) |
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

`Query.where` is the one raw-text lane: it is caller-authored filter SQL, so it
cannot be escaped like a value. It is instead **contained** by
`validateWhereExpression` before it is embedded, and a rejected expression
throws a typed `GeoParquetWhereClauseError` carrying a fixed
`GEOPARQUET_WHERE_*` code (the message never echoes the offending text). The
planner surfaces the same rejection as `HonuaQueryPlanningError`
(`code: "invalid-query"`).

Rejected: statement separators (`;`) and multi-statement input; SQL line and
block comments (including the trailing `--` that would otherwise swallow the
compiler's own `AND (<spatial predicate>)`); unterminated string or
quoted-identifier literals (`x' OR 1=1`); unbalanced parentheses, so the
wrapping `( … )` cannot be closed early to re-associate or append clauses;
`SELECT` / `FROM` / `UNION` and other statement, set-operation, or
table-context keywords, so a filter cannot become a subquery or UNION probe
against other tables and files registered in the same DuckDB session;
parameter markers (`?`, `$1`, `$name`), which this lane never binds; and
control characters other than tab / newline / carriage return.

Accepted unchanged: ordinary comparisons, `AND`/`OR`/`NOT`, `IN` value lists,
`BETWEEN`, `LIKE`, `CASE … END`, scalar function calls, struct/field paths, and
string literals containing any of the above characters as data (`note = 'a ;
b -- c'`). A column whose name collides with a rejected keyword stays
addressable by quoting it (`"union" = 1`), because quoted identifiers are
skipped by the validator.

This is containment, not a semantic parser. Accepted text is still executed by
DuckDB: it can reference any column in the scanned files, call any scalar
function the session exposes, and cost arbitrary CPU. Applications that forward
end-user input (a filter box, a URL parameter) should build the expression from
typed inputs and treat the validator as a backstop; the typed, parameterized
semantic compiler (`compileSemanticDuckDbQuery`) removes the raw-text lane
entirely. `source.protocol("geoparquet").sql(...)` remains an explicit, opt-in
raw-SQL escape hatch and is deliberately not covered by this validation. The
compiler is covered by snapshot and rejection tests in
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
  `preloadExtensions` to keep Parquet execution self-hosted. A covering is
  detected either from declared GeoParquet 1.1 `covering.bbox` paths or, for
  files with no `geo` metadata, from a struct column named `bbox`. Both paths
  require the exact member set (`xmin`/`ymin`/`xmax`/`ymax`, plus `zmin`/`zmax`
  in 3D), one numeric type shared by every member, and the same repetition as
  the geometry column — but **never a particular member order**, since the
  compiled predicate addresses members by name. Overture Maps, for example,
  declares a conforming covering over
  `STRUCT(xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE)`. Without a
  detected covering the compiler falls back to `ST_Intersects(...)`, which
  requires the spatial extension.
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
`npm run geoparquet:fixtures` (which drives DuckDB-WASM's Node bindings). They
include the two spatial fixture styles plus exact wide integer, decimal,
temporal, binary, and nested values. Only run the generator when a fixture
schema changes.
