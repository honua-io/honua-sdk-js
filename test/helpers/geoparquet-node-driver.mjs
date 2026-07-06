// Node test driver for the GeoParquet Source, built on the DuckDB WASM
// synchronous Node bindings (`duckdb-node-blocking.cjs`). This mirrors the
// production `DuckDbDriver` surface so unit tests exercise the real engine
// (real `read_parquet`, real `spatial` extension) without a browser or worker.
//
// This file lives under test/ (excluded from tsc/biome) and is imported by the
// geoparquet vitest specs and by the fixture-generation script.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let modulePromise;
function loadDuck() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const duckdb = require("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
      const DIST = require.resolve("@duckdb/duckdb-wasm").replace(/dist\/.*/, "dist/");
      const bundles = {
        mvp: { mainModule: DIST + "duckdb-mvp.wasm", mainWorker: DIST + "duckdb-node-mvp.worker.cjs" },
        eh: { mainModule: DIST + "duckdb-eh.wasm", mainWorker: DIST + "duckdb-node-eh.worker.cjs" },
      };
      const logger = { log() {} };
      const db = await duckdb.createDuckDB(bundles, logger, duckdb.NODE_RUNTIME);
      await db.instantiate(() => {});
      return { db };
    })();
  }
  return modulePromise;
}

/** Create a fresh Node-backed DuckDbDriver. Loads the spatial extension. */
export async function createNodeDuckDbDriver() {
  const { db } = await loadDuck();
  const conn = db.connect();
  conn.query("INSTALL spatial; LOAD spatial;");
  return {
    async run(sql) {
      conn.query(sql);
    },
    async query(sql) {
      const table = conn.query(sql);
      return table.toArray().map((row) => row.toJSON());
    },
    async registerFileBuffer(name, bytes) {
      db.registerFileBuffer(name, bytes);
    },
    async close() {
      conn.close();
    },
    // Test-only escape hatch for fixture generation (copy a virtual file out).
    __copyFileToBuffer(name) {
      return db.copyFileToBuffer(name);
    },
    __db: db,
    __conn: conn,
  };
}
