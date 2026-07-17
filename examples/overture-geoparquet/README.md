# Overture Columnar Lab

Honua's large-data browser sample runs a protocol-neutral spatial query through
DuckDB-WASM's worker with one bounded policy in two lanes:

- `fixture` uses a committed 2.1 KB GeoParquet file, the package-locked DuckDB
  main module and worker, and a SHA-256-pinned Parquet extension prepared into an
  ignored cache. Every browser asset is self-hosted; required CI makes no
  cross-origin requests.
- `live` is opt-in and targets a pinned item from Overture's official STAC
  catalog and public AWS Open Data bucket without credentials.

The UI separates measured evidence from plans and estimates. It shows release,
schema, object key, ETag, last modification, observation time, STAC file
selection, selected-object rows/row groups, verified probe bytes/ranges, result rows,
memory ceiling, cache identity, SDK planning time, network probe time, engine
time, and MapLibre/DOM rendering time. It also exposes the accepted artifact and
presentation receipts as JSON.

## Safety Contract

Every query requires:

- an ordered CRS84 AOI no larger than 1 square degree
- at most five projected columns
- a result limit from 1 to 200
- a 256 MiB DuckDB memory ceiling
- a 1 MiB incrementally enforced JavaScript result ceiling
- a 10-second source-probe deadline
- a 30-second engine deadline
- a GeoParquet `bbox` covering predicate

S1 materializes one SDK `Result` only after the planner and engine enforce their
bounds. S2 then validates and freezes one linked artifact and paints its table
rows in batches of 25. `Query.signal` cancels DuckDB work; the UI also terminates
the active runtime so stale batches cannot render. Result caching is bounded to
three immutable artifacts and the key includes release, object ETag, AOI, CRS,
projection, category, row limit, memory/output policy, source deadline, and
engine deadline plus the caller-declared, package-pinned DuckDB version.

Unsafe AOIs, projection/row overages, missing STAC intersections, unsupported
HTTP ranges, oversized/truncated probe bodies, engine failures, and deadline
overruns stop explicitly. The application never retries with a full-object
download, and DuckDB-WASM is opened with `allowFullHTTPReads: false` so its
browser filesystem cannot fall back to full materialization. The scheduled
Playwright evidence observes every AWS request and rejects any un-ranged GET.
DuckDB does not expose rows scanned or a row-group-pruned counter, so the sample
does not claim those engine metrics were verified.

## Headless S1 Workflow

`src/cloud-native-analysis.ts` is the renderer-free golden-journey slice. It
uses the public `@honua/sdk-js/query-planner` v2 opaque-resource planner and
executor with a public GeoParquet `Source`; it does not own SQL compilation or
query evaluation. The same `OvertureQueryPlan`, AOI query, pinned manifest, and
materialization policy drive the fixture and live lanes.

`runCloudNativeAnalysis()` returns one SDK `Result` plus
`honua.sdk.cloud-native-analysis-evidence.v1`. That typed receipt records the
opaque accepted-plan fingerprint and cache identity, exact range bytes and
requests from the supplied bounded source stage, selected-file metadata,
returned rows, materialized result bytes, configured ceilings, separated stage
timings, and completed worker cleanup. It deliberately classifies rows scanned,
row groups pruned, and observed peak memory as `unsupported`. Candidate object
rows and row groups are labeled as pinned metadata rather than engine
observations. Adapter degradation is surfaced as `approximate`, never silently
promoted to exact.

The runner rejects unsupported range transport, manifest/object identity drift,
row overflow, or result-byte overflow and still disposes its caller-owned
runtime. It has no renderer adapter: direct GeoArrow/deck.gl presentation stays
explicitly unsupported in S1 pending the renderer and bounded-transfer
contracts. S2 consumes that returned `Result` without introducing a second
query or engine path.

## Linked S2 Workflow

`src/linked-analysis-workflow.ts` consumes the exact `Result` and evidence from
`runCloudNativeAnalysis()`. It creates
`honua.sdk.cloud-native-linked-analysis.v1`, one immutable artifact containing:

- bounded normalized rows for the table
- the same rows projected to a bounded MapLibre GeoJSON point collection
- bounded category/chart buckets carrying the same feature identities
- the complete S1 source, query-plan, engine, provenance, fidelity, cache, and
  worker-cleanup receipt
- explicit row, geometry, chart-bucket, and derived-byte ceilings

Missing or non-string identities, duplicate identities, invalid coordinates,
confidence outside 0–1, receipt/result drift, and any row, geometry, chart, or
byte overflow fail before a view can commit. Empty and approximate results keep
separate `empty` and `degraded` states. A generation-bound coordinator makes
new intent latest-wins; cancellation clears the pending artifact and terminates
the worker. Keyboard-operable table, map-result, and chart buttons publish one
selection identity back to every surface, and the layout remains bounded at a
mobile viewport.

`honua.sdk.cloud-native-presentation.v1` keeps presentation truth separate. It
records immutable artifact-production timing independently from current
delivery timing, including distinct source, engine, SDK, and renderer fields.
A UI artifact-cache hit reports zero SDK/source/engine work for that delivery
while retaining the labeled production receipt. The engine cache remains
`bypass` and `execution-only`; a UI cache hit never becomes an engine-cache
claim.

MapLibre is explicitly a bounded object/GeoJSON fallback. Direct GeoArrow and
deck.gl remain gated by #536 and the bounded #388 slice, and
`kepler-analytics` remains an optional recipe rather than a second execution
contract. Public-object qualification, published evidence/matrix coverage, and
duplicate-demo redirects remain S3.

The fixture is `fixture-places-v2` / `fixture-v2`. Its numeric analysis fields
are physically `DOUBLE` so browser and Node Arrow readers preserve their
documented values instead of exposing unscaled decimal storage integers. One
point has a valid conservative bbox that crosses a narrow AOI boundary; the
browser gate proves the materialized bbox center remains visible by fitting the
MapLibre viewport to the bounded union of the AOI and returned coordinates.

## What the Live Lane Proves

The pinned source is Overture release `2026-06-17.0`, schema `v1.17.0`, places
item `00000`:

```text
https://stac.overturemaps.org/2026-06-17.0/places/place/00000/00000.json
https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/theme=places/type=place/part-00000-6c973aba-862d-590f-a178-70bcd31cde1c-c000.zstd.parquet
```

The selected object contains 4,717,270 rows in 256 row groups and is 656,568,610
bytes. The committed manifest pins identity and bbox metadata for all 16 STAC
items; exactly item `00000` intersects the Oahu AOI. The browser requires exact
`206 Partial Content` intervals for a one-byte header probe and a 64 KiB footer
probe, streams both through hard body-byte caps, and sends no credentials
before starting DuckDB.

DuckDB-WASM's connection API does **not** expose HTTP byte/range requests, rows
scanned, or row groups pruned to the in-page UI. Scheduled Playwright evidence
can observe browser network requests independently. A strict live audit on
2026-07-11 returned 100 Oahu rows in 11.9 seconds using 32 HTTP range requests
and 7,135,813 response bytes, with zero un-ranged GETs. Of that total, the two
explicit preflight probes accounted for 65,537 bytes and the engine accounted
for 7,070,276 bytes. An independent Parquet-footer audit found three bbox-stat
candidate row groups (68–70), 55,591 candidate rows, and about 2.84 MB of
compressed projected columns. That metadata establishes the pruning
opportunity, not the engine's actual pruned-row-group count; the latter remains
unverified.

Official source references:

- [Overture STAC catalog](https://stac.overturemaps.org/)
- [Overture places data guide](https://docs.overturemaps.org/guides/places/)
- [Overture release calendar](https://docs.overturemaps.org/release-calendar/)
- [Overture in the Registry of Open Data on AWS](https://registry.opendata.aws/overture/)

Overture retains only recent public releases. Scheduled evidence therefore
fails visibly when a pinned object expires; updating the manifest requires a
new verified object identity and regenerated evidence.

## Run

```bash
npm run demo:overture:prepare # verify or acquire the pinned DuckDB extension
npm run demo:overture
npm run demo:overture:fixture     # regenerate the deterministic fixture
```

Append `?lane=live` to opt into AWS. No live request occurs by default.

## DuckDB Artifact Preparation

No DuckDB executable is stored in Git. `@duckdb/duckdb-wasm@1.32.0` supplies
the package-locked main module and worker. DuckDB-WASM loads Parquet dynamically,
so a cold `demo:overture:prepare` makes one request to the exact official URL
`https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`.
The preparation command rejects redirects, alternate URLs, unexpected content
types, wrong byte length, invalid WebAssembly magic, or a SHA-256 other than
`22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55`.
Build and dev commands run preparation first, then Vite revalidates and serves
the cache from the demo origin. Browser runtime never falls back to DuckDB's
public extension repository or a JavaScript CDN. The acquisition request is a
credential-free `GET` with redirects, referrers, ambient credentials, and HTTP
cache reuse disabled; it accepts only an exact `200` response from the pinned
URL with an `application/wasm` content type.

The cache file is
`node_modules/.cache/honua-sdk-js/duckdb-extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`.
For an offline or air-gapped build, pre-seed that exact path after dependency
installation, then require validation without network access:

```bash
npm run demo:overture:prepare -- --offline
npm run demo:overture:build:offline
```

Missing or corrupt offline bytes fail closed. Online preparation atomically
replaces a corrupt cache only after the newly acquired bytes pass every
identity check. Required CI names the cold acquisition separately, then proves
the build from the validated cache with the offline command. The Security
workflow rejects executable signatures and extensions from the Git tree, while
publish-surface verification applies the same policy to the root and split npm
tarballs.

## Validate

```bash
npm run demo:overture:typecheck
npm run demo:overture:build
npx vitest run test/cloud-native-spatial-analysis.test.ts test/cloud-native-linked-analysis.test.ts test/overture-extension-cache.test.ts test/overture-large-data.test.ts test/geoparquet-source.test.ts test/geoparquet-sql.test.ts
npm run test:playwright:overture
npm run samples:verify
npm run samples:run -- build --sample overture-geoparquet --sdk-mode source
npm run samples:run -- build --sample overture-geoparquet --sdk-mode packed
```

Scheduled/manual evidence only:

```bash
HONUA_OVERTURE_LIVE_ENABLED=true npm run evidence:overture:live -- --strict
```

That command writes `honua.sdk.sample-evidence.v1`. Required pull-request CI is
fixture-only and never depends on AWS availability.
