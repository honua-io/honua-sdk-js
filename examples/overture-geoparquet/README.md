# Overture GeoParquet Explorer

Queries a committed, fixture-sized Overture `places` extract entirely in the
browser via DuckDB-WASM — no Honua server. It demonstrates that the same
protocol-neutral `Query` (`where` / `spatialFilter` / `outFields` / `orderBy`)
that runs against a FeatureServer compiles to SQL over `read_parquet(...)` and
returns the standard `Result`, with **GERS ids preserved** in every row.

See [`docs/geoparquet.md`](../../docs/geoparquet.md) for the full source docs and
the live-Overture recipe.

## Run

```bash
npm run demo:overture           # dev server (Vite)
npm run demo:overture:build     # production build
npm run demo:overture:typecheck
```

## How it stays offline / CI-deterministic

- The fixture (`public/overture-places.parquet`, ~1.4 KB) is committed. Regenerate
  the test fixtures with `npm run geoparquet:fixtures`.
- DuckDB-WASM's `.wasm` + worker are **self-hosted** under `/duckdb/` (served
  from `node_modules` in dev, copied into `dist/` at build) — no jsDelivr CDN
  fetch. The exception-handling (`eh`) bundle needs no cross-origin isolation.
- The fixture is registered as an in-memory DuckDB file, so no network I/O
  happens at query time.

## Going live

Swap the fixture registration for an Overture release URL and let DuckDB read it
directly over HTTP(S):

```ts
locator: {
  url: "https://overturemaps-us-west-2.s3.amazonaws.com/release/2025-06-25.0/theme=places/type=place/*.parquet",
}
```

Always send a `spatialFilter` (and narrow `outFields`) so only the row groups
intersecting your area of interest are scanned.
