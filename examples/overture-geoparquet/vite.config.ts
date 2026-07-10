import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

// DuckDB-WASM assets are large (34 MB .wasm) so they are NOT committed. This
// plugin serves them from node_modules in dev and copies them into the build
// output under /duckdb/, keeping the demo fully self-hosted and offline (no
// jsDelivr CDN fetch — CI-deterministic).
const duckdbDist = path.resolve(repoRoot, "node_modules/@duckdb/duckdb-wasm/dist");
const DUCKDB_ASSETS = ["duckdb-eh.wasm", "duckdb-browser-eh.worker.js"];
const extensionRoot = path.join(exampleRoot, "vendor", "extensions");
const PARQUET_EXTENSION_PATH = "v1.4.3/wasm_eh/parquet.duckdb_extension.wasm";

function selfHostDuckDb(): Plugin {
  return {
    name: "self-host-duckdb-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = DUCKDB_ASSETS.find((asset) => req.url === `/duckdb/${asset}`);
        const extensionMatch = req.url === `/duckdb/extensions/${PARQUET_EXTENSION_PATH}`;
        if (!match && !extensionMatch) return next();
        const file = match ? path.join(duckdbDist, match) : path.join(extensionRoot, PARQUET_EXTENSION_PATH);
        res.setHeader("content-type", match && !match.endsWith(".wasm") ? "text/javascript" : "application/wasm");
        fs.createReadStream(file).pipe(res);
      });
    },
    async writeBundle(options) {
      const outDir = options.dir ?? path.join(exampleRoot, "dist");
      const target = path.join(outDir, "duckdb");
      fs.mkdirSync(target, { recursive: true });
      for (const asset of DUCKDB_ASSETS) {
        fs.copyFileSync(path.join(duckdbDist, asset), path.join(target, asset));
      }
      const extensionTarget = path.join(target, "extensions", PARQUET_EXTENSION_PATH);
      fs.mkdirSync(path.dirname(extensionTarget), { recursive: true });
      fs.copyFileSync(path.join(extensionRoot, PARQUET_EXTENSION_PATH), extensionTarget);
    },
  };
}

export default defineConfig({
  root: exampleRoot,
  plugins: [selfHostDuckDb()],
  resolve: {
    alias: [
      { find: "@honua/sdk-js/geoparquet", replacement: path.resolve(repoRoot, "src/geoparquet/index.ts") },
      { find: "@honua/sdk-js/contract", replacement: path.resolve(repoRoot, "src/contract/index.ts") },
      { find: "@honua/sdk-js/honua", replacement: path.resolve(repoRoot, "src/honua.ts") },
      { find: "@honua/sdk-js", replacement: path.resolve(repoRoot, "src/index.ts") },
    ],
  },
  optimizeDeps: {
    // duckdb-wasm ships its own worker; let Vite pre-bundle the main module.
    include: ["@duckdb/duckdb-wasm"],
  },
  server: {
    host: "127.0.0.1",
    fs: { allow: [repoRoot] },
  },
  preview: {
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
