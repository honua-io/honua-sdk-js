# Vendored DuckDB extension

`extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm` is DuckDB's official
Parquet extension for DuckDB-WASM 1.4.3 (`wasm_eh`). It is vendored so required
fixture CI never downloads executable code from an extension CDN.

- Source: `https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`
- SHA-256: `22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55`
- Upstream project: [duckdb/duckdb](https://github.com/duckdb/duckdb)
- License: [MIT](https://github.com/duckdb/duckdb/blob/v1.4.3/LICENSE)

The digest is enforced by `test/overture-large-data.test.ts`. Update the path,
digest, provenance, and browser test together when the pinned DuckDB version
changes.
