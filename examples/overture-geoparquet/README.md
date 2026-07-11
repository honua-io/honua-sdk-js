# Overture Columnar Lab

Honua's large-data browser sample runs a protocol-neutral spatial query through
DuckDB-WASM's worker with one bounded policy in two lanes:

- `fixture` uses a committed 1.9 KB GeoParquet file and self-hosted DuckDB,
  worker, and Parquet extension assets. Required CI makes no cross-origin
  requests.
- `live` is opt-in and targets a pinned item from Overture's official STAC
  catalog and public AWS Open Data bucket without credentials.

The UI separates measured evidence from plans and estimates. It shows release,
schema, object key, ETag, last modification, observation time, STAC file
selection, selected-object rows/row groups, verified probe bytes/ranges, result rows,
memory ceiling, cache identity, SDK planning time, network probe time, combined
engine/source time, and progressive rendering time.

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

The result is streamed as Arrow record batches and painted in batches of 25.
`Query.signal` cancels DuckDB work; the UI also terminates the active runtime so
stale batches cannot render. Result caching is bounded to three entries and the
key includes release, object ETag, AOI, CRS, projection, category, row limit,
memory/output policy, source deadline, and engine deadline.

Unsafe AOIs, projection/row overages, missing STAC intersections, unsupported
HTTP ranges, oversized/truncated probe bodies, engine failures, and deadline
overruns stop explicitly. The application never retries with a full-object
download, and DuckDB-WASM is opened with `allowFullHTTPReads: false` so its
browser filesystem cannot fall back to full materialization. The scheduled
Playwright evidence observes every AWS request and rejects any un-ranged GET.
DuckDB does not expose rows scanned or a row-group-pruned counter, so the sample
does not claim those engine metrics were verified.

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
npm run demo:overture
npm run demo:overture:fixture     # regenerate the deterministic fixture
```

Append `?lane=live` to opt into AWS. No live request occurs by default.

## Validate

```bash
npm run demo:overture:typecheck
npm run demo:overture:build
npx vitest run test/overture-large-data.test.ts test/geoparquet-source.test.ts test/geoparquet-sql.test.ts
npm run test:playwright:overture
npm run samples:verify
```

Scheduled/manual evidence only:

```bash
HONUA_OVERTURE_LIVE_ENABLED=true npm run evidence:overture:live -- --strict
```

That command writes `honua.sdk.sample-evidence.v1`. Required pull-request CI is
fixture-only and never depends on AWS availability.
