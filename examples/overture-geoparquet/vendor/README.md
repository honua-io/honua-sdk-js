# DuckDB executable provenance

This directory intentionally contains no executable artifacts. The demo copies
its DuckDB main module and worker from the package-locked dependency and prepares
the SHA-256-pinned Parquet extension into an ignored cache; generated `.wasm` and worker
files stay outside Git.

- npm package: `@duckdb/duckdb-wasm@1.32.0`
- npm integrity: `sha512-IewXTNYEjsZCPE9weUWgtjGxUlMRo7qhX0GF6tq/KjK8bnY+RAl4cyUdYUfcdzbyb4b9ZxPC+FOsCcxgaKFWMg==`
- embedded DuckDB engine: `v1.4.3`
- main module SHA-256: `4c221bfa59c11f24dbd750e70c90b9252eca6eec5633936e6a2ec766e55fd879`
- worker SHA-256: `f8ab72b6b90b3ad83077d47426d4a99d5d9a4c7e07cba1a2be37d655adc7c1ab`
- Parquet extension source: `https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`
- Parquet extension bytes: `3045039`
- Parquet extension SHA-256: `22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55`
- upstream project: [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm)
- license: [MIT](https://github.com/duckdb/duckdb-wasm/blob/v1.32.0/LICENSE)

The Parquet extension was removed from Git because generated executables are not
reviewable source. `demo:overture:prepare` now acquires that one pinned artifact
before Vite starts, validates its URL, size, WebAssembly magic, and digest, and
stores it outside the repository source tree. The Playwright journey executes
both `parquet_scan` and `read_parquet` while blocking external extension/CDN
requests; `test/overture-large-data.test.ts` pins the package asset digests.
