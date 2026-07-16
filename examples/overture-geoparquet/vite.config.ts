import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Plugin, defineConfig } from "vite";

import {
  PARQUET_EXTENSION_PROVENANCE,
  readPinnedParquetExtension,
  resolveParquetExtensionCachePath,
} from "./extension-cache.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

// DuckDB-WASM assets are large (34 MB .wasm) so they are NOT committed. This
// plugin serves the package-locked main module and worker from node_modules in
// dev and copies them into the build output under /duckdb/. The SHA-256-pinned Parquet
// extension is prepared separately into an ignored, digest-checked cache and
// then served from the same origin; no executable artifact is committed.
const duckdbDist = path.resolve(repoRoot, "node_modules/@duckdb/duckdb-wasm/dist");
const DUCKDB_ASSETS = ["duckdb-eh.wasm", "duckdb-browser-eh.worker.js"];
const PARQUET_EXTENSION_PATH = `${PARQUET_EXTENSION_PROVENANCE.engineVersion}/${PARQUET_EXTENSION_PROVENANCE.platform}/${PARQUET_EXTENSION_PROVENANCE.fileName}`;
const parquetExtensionCachePath = resolveParquetExtensionCachePath({ repoRoot });

function selfHostDuckDb(): Plugin {
  return {
    name: "self-host-duckdb-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = DUCKDB_ASSETS.find((asset) => req.url === `/duckdb/${asset}`);
        const extensionMatch = req.url === `/duckdb/extensions/${PARQUET_EXTENSION_PATH}`;
        if (!match && !extensionMatch) return next();
        if (match) {
          res.setHeader("content-type", match.endsWith(".wasm") ? "application/wasm" : "text/javascript");
          fs.createReadStream(path.join(duckdbDist, match)).pipe(res);
          return;
        }
        void readPinnedParquetExtension({ cachePath: parquetExtensionCachePath })
          .then(({ bytes }) => {
            res.setHeader("content-type", "application/wasm");
            res.end(bytes);
          })
          .catch(next);
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
      const { bytes } = await readPinnedParquetExtension({ cachePath: parquetExtensionCachePath });
      fs.writeFileSync(extensionTarget, bytes);
    },
  };
}

export default defineConfig(async () => {
  try {
    await readPinnedParquetExtension({ cachePath: parquetExtensionCachePath });
  } catch (cause) {
    throw new Error("Pinned DuckDB Parquet extension is not prepared; run npm run demo:overture:prepare first.", {
      cause,
    });
  }
  return {
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
  };
});
