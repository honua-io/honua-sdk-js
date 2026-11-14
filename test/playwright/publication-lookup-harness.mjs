// Browser harness for paired-publication lookups: one origin serves the page,
// the bundled SDK and the self-hosted DuckDB-WASM engine; a second origin
// serves the publication artifacts, so every artifact read is a real
// cross-origin HTTP range request.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import {
  PARQUET_EXTENSION_PROVENANCE,
  ensurePinnedParquetExtension,
  resolveParquetExtensionCachePath,
} from "../../examples/overture-geoparquet/extension-cache.mjs";
import { startStaticRangeServer } from "../helpers/static-range-server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const duckdbDist = path.join(repoRoot, "node_modules/@duckdb/duckdb-wasm/dist");
const extensionPath = `/duckdb/extensions/${PARQUET_EXTENSION_PROVENANCE.engineVersion}/${PARQUET_EXTENSION_PROVENANCE.platform}/${PARQUET_EXTENSION_PROVENANCE.fileName}`;

const PAGE_SCRIPT = `
import { queryFilter } from "./src/contract/query-filter.ts";
import { GeoparquetRuntime } from "./src/geoparquet/index.ts";
import {
  PUBLICATION_LOOKUP_BUDGET,
  openPublication,
  publicationDriverFactory,
  publicationSource,
} from "./src/publication/index.ts";

const status = document.querySelector("#status");
let runtime;
let source;
let controller;

const engine = publicationDriverFactory({
  bundle: {
    mainModule: location.origin + "/duckdb/duckdb-eh.wasm",
    mainWorker: location.origin + "/duckdb/duckdb-browser-eh.worker.js",
  },
  extensionRepository: location.origin + "/duckdb/extensions",
  preloadExtensions: ["parquet"],
  loadSpatial: false,
});

window.publicationHarness = {
  budget: PUBLICATION_LOOKUP_BUDGET,
  async open(descriptorUrl, options = {}) {
    runtime = new GeoparquetRuntime({ driverFactory: engine });
    const publication = await openPublication(descriptorUrl);
    const serverSource = options.liveFeature
      ? { query: async () => ({ features: [options.liveFeature], exceededTransferLimit: false }) }
      : undefined;
    source = publicationSource(publication, {
      runtime,
      ...(options.budget ? { budget: options.budget } : {}),
      ...(serverSource ? { serverSource } : {}),
    });
    return publication.freshness;
  },
  async lookup(identity) {
    controller = new AbortController();
    const started = performance.now();
    try {
      const found = await source.lookup(identity, { signal: controller.signal });
      const feature = found.result.features[0];
      status.textContent = found.limit ? found.limit.message : "Found " + identity;
      return {
        ok: true,
        ms: performance.now() - started,
        answeredBy: found.answeredBy,
        plan: found.plan,
        limit: found.limit ?? null,
        attributes: feature?.attributes ?? null,
        geometryType: feature?.geometry?.type ?? null,
        parts: feature?.geometry?.coordinates?.length ?? 0,
        jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      };
    } catch (error) {
      status.textContent = error.message;
      return { ok: false, name: error.name, code: error.code ?? null, message: error.message, ms: performance.now() - started };
    }
  },
  async filter(field, value) {
    const started = performance.now();
    try {
      const result = await source.query({ filter: queryFilter.eq(field, value), returnGeometry: false, pagination: { limit: 100 } });
      return { ok: true, ms: performance.now() - started, returnedFeatures: result.features.length };
    } catch (error) {
      return { ok: false, code: error.code ?? null, message: error.message, ms: performance.now() - started };
    }
  },
  cancel() {
    controller?.abort();
  },
  async dispose() {
    await runtime?.dispose();
  },
};
`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Publication lookup</title></head>
<body><main><h1>Parcel lookup</h1><p id="status" role="status">Idle</p></main><script src="/harness.js"></script></body></html>`;

async function bundlePage(directory) {
  const output = path.join(directory, "harness.js");
  await build({
    stdin: { contents: PAGE_SCRIPT, resolveDir: repoRoot, loader: "js" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: output,
    external: ["@duckdb/node-api", "node:*"],
    logLevel: "silent",
  });
  return output;
}

/**
 * @param {{ artifacts: Record<string, string>, workDirectory: string, artifactDelayMs?: number, artifactCors?: boolean, artifactCacheControl?: string, artifactRangeSupport?: "full" | "get-only" | "none" }} options
 *   artifacts maps a URL path on the artifact origin to a file on disk.
 */
export async function startPublicationHarness({
  artifacts,
  workDirectory,
  artifactDelayMs = 0,
  artifactCors = true,
  artifactCacheControl = "no-cache",
  artifactRangeSupport = "full",
}) {
  const extensionCache = resolveParquetExtensionCachePath({ repoRoot });
  await ensurePinnedParquetExtension({ cachePath: extensionCache });
  const pageFile = path.join(workDirectory, "index.html");
  writeFileSync(pageFile, PAGE);
  const harnessScript = await bundlePage(workDirectory);
  const app = await startStaticRangeServer({
    files: {
      "/": pageFile,
      "/harness.js": harnessScript,
      "/duckdb/duckdb-eh.wasm": path.join(duckdbDist, "duckdb-eh.wasm"),
      "/duckdb/duckdb-browser-eh.worker.js": path.join(duckdbDist, "duckdb-browser-eh.worker.js"),
      [extensionPath]: extensionCache,
    },
  });
  const data = await startStaticRangeServer({
    files: artifacts,
    delayMs: artifactDelayMs,
    cors: artifactCors,
    cacheControl: artifactCacheControl,
    rangeSupport: artifactRangeSupport,
  });
  return {
    app,
    data,
    engineRequests: () => app.requests.filter((entry) => entry.path.startsWith("/duckdb/")),
    async close() {
      await Promise.all([app.close(), data.close()]);
    },
  };
}
