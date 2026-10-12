import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PARQUET_EXTENSION_PROVENANCE,
  ensurePinnedParquetExtension,
  readPinnedParquetExtension,
} from "../overture-geoparquet/extension-cache.mjs";
import { evidenceIdentity } from "./evidence-identity.mjs";

export const SPATIAL_EXTENSION = Object.freeze({
  engineVersion: "v1.4.3",
  platform: "wasm_eh",
  fileName: "spatial.duckdb_extension.wasm",
  sourceUrl: "https://extensions.duckdb.org/v1.4.3/wasm_eh/spatial.duckdb_extension.wasm",
  bytes: 23469719,
  sha256: "04b776946da64a15a7b14501790c75093e38f876acc46b2922f0daeb6aaa1d60",
  wasmMagic: Object.freeze([0, 97, 115, 109]),
});
const root = path.dirname(fileURLToPath(import.meta.url));
const extensions = [PARQUET_EXTENSION_PROVENANCE, SPATIAL_EXTENSION];
const cachePath = (provenance) => path.join(root, "node_modules/.cache/duckdb", provenance.fileName);
const extensionPath = (provenance) =>
  `extensions/${provenance.engineVersion}/${provenance.platform}/${provenance.fileName}`;
const assets = ["duckdb-eh.wasm", "duckdb-browser-eh.worker.js"];
export async function queryEngineAssets() {
  for (const provenance of extensions)
    await ensurePinnedParquetExtension({ cachePath: cachePath(provenance), provenance });
  const identity = evidenceIdentity();
  const dist = path.resolve(root, "../../node_modules/@duckdb/duckdb-wasm/dist");
  return {
    name: "ask-map-pinned-query-engine",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url === "/ask-map-source.json") {
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          response.end(JSON.stringify(identity));
          return;
        }
        const asset = assets.find((entry) => request.url === `/duckdb/${entry}`);
        const extension = extensions.find((entry) => request.url === `/duckdb/${extensionPath(entry)}`);
        if (asset) {
          response.setHeader("content-type", asset.endsWith(".wasm") ? "application/wasm" : "text/javascript");
          fs.createReadStream(path.join(dist, asset)).pipe(response);
        } else if (extension)
          void readPinnedParquetExtension({ cachePath: cachePath(extension), provenance: extension })
            .then(({ bytes }) => {
              response.setHeader("content-type", "application/wasm");
              response.end(bytes);
            })
            .catch(next);
        else next();
      });
    },
    async writeBundle(options) {
      const target = path.join(options.dir ?? path.join(root, "dist"), "duckdb");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "../ask-map-source.json"), JSON.stringify(identity));
      for (const asset of assets) fs.copyFileSync(path.join(dist, asset), path.join(target, asset));
      for (const provenance of extensions) {
        const destination = path.join(target, extensionPath(provenance));
        const { bytes } = await readPinnedParquetExtension({ cachePath: cachePath(provenance), provenance });
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes);
      }
    },
  };
}
