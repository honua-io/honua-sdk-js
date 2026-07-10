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
selection, candidate rows/row groups, verified probe bytes/ranges, result rows,
memory ceiling, cache identity, SDK planning time, network probe time, combined
engine/source time, and progressive rendering time.

## Safety Contract

Every query requires:

- an ordered CRS84 AOI no larger than 1 square degree
- at most five projected columns
- a result limit from 1 to 200
- a 256 MiB DuckDB memory ceiling
- a 30-second engine deadline
- a GeoParquet `bbox` covering predicate

The result is streamed as Arrow record batches and painted in batches of 25.
`Query.signal` cancels DuckDB work; the UI also terminates the active runtime so
stale batches cannot render. Result caching is bounded to three entries and the
key includes release, object ETag, AOI, CRS, projection, category, row limit,
memory policy, and engine deadline.

Unsafe AOIs, projection/row overages, missing STAC intersections, unsupported
HTTP ranges, engine failures, and deadline overruns stop explicitly. There is
no full-object fallback.

## What the Live Lane Proves

The pinned source is Overture release `2026-06-17.0`, schema `v1.17.0`, places
item `00000`:

```text
https://stac.overturemaps.org/2026-06-17.0/places/place/00000/00000.json
https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/theme=places/type=place/part-00000-6c973aba-862d-590f-a178-70bcd31cde1c-c000.zstd.parquet
```

The item contains 4,717,270 candidate rows in 256 row groups and is 656,568,610
bytes. Its STAC bbox intersects the Oahu AOI, so the catalog selects 1 of 16
place files. The browser verifies `206 Partial Content` for a one-byte header
probe and a 64 KiB footer probe before starting DuckDB.

The current DuckDB-WASM driver does **not** expose its internal HTTP byte/range
requests, rows scanned, or row groups pruned. Those fields are deliberately
shown as unverified. A live audit on 2026-07-10 verified both AWS range probes
but the engine did not return the bounded Oahu result inside 30 seconds, so the
worker was terminated and live evidence was recorded as failed. The sample does
not claim successful row-group pruning until scheduled evidence proves it.

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
