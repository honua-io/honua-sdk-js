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
const maplibreWorker = path.join(repoRoot, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs");
const extensionPath = `/duckdb/extensions/${PARQUET_EXTENSION_PROVENANCE.engineVersion}/${PARQUET_EXTENSION_PROVENANCE.platform}/${PARQUET_EXTENSION_PROVENANCE.fileName}`;

const PAGE_SCRIPT = `
import * as maplibregl from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import { queryFilter } from "./src/contract/query-filter.ts";
import { GeoparquetRuntime } from "./src/geoparquet/index.ts";
import {
  PUBLICATION_LOOKUP_BUDGET,
  openExport,
  openPublication,
  publicationDriverFactory,
  publicationSource,
  verifyPmtilesArtifact,
} from "./src/export/index.ts";

const status = document.querySelector("#status");
let runtime;
let source;
let controller;
let map;
let pmtilesProtocol;

const engine = publicationDriverFactory({
  bundle: {
    mainModule: location.origin + "/duckdb/duckdb-eh.wasm",
    mainWorker: location.origin + "/duckdb/duckdb-browser-eh.worker.js",
  },
  extensionRepository: location.origin + "/duckdb/extensions",
  preloadExtensions: ["parquet"],
  loadSpatial: false,
});

function ensurePmtilesProtocol() {
  if (!pmtilesProtocol) {
    maplibregl.setWorkerUrl(location.origin + "/maplibre-gl-worker.mjs");
    pmtilesProtocol = new Protocol();
    maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);
  }
}

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
  async openExport(collectionUrl, options = {}) {
    runtime = new GeoparquetRuntime({ driverFactory: engine });
    const opened = await openExport(collectionUrl);
    if (!opened.publication) {
      throw new Error("Expected a Honua Export with a paired publication view.");
    }
    await verifyPmtilesArtifact(opened.publication, { PMTiles });
    source = publicationSource(opened.publication, {
      runtime,
      ...(options.budget ? { budget: options.budget } : {}),
    });
    return {
      id: opened.collection.id,
      renderPath: opened.renderPath,
      display: opened.display,
      freshness: opened.publication.freshness,
      publicFields: opened.publication.publicFields.map((field) => [field.name, field.type]),
    };
  },
  async renderExportMap(display) {
    ensurePmtilesProtocol();
    map?.remove();
    const started = performance.now();
    const [west, south, east, north] = display.bounds;
    const center = [(west + east) / 2, (south + north) / 2];
    map = new maplibregl.Map({
      container: "map",
      center,
      zoom: 13,
      style: {
        version: 8,
        sources: {
          export: {
            type: "vector",
            url: "pmtiles://" + display.pmtilesUrl,
            promoteId: display.promoteId,
          },
        },
        layers: [
          {
            id: "export-fill",
            type: "fill",
            source: "export",
            "source-layer": display.sourceLayer,
            paint: { "fill-color": "#2563eb", "fill-opacity": 0.4 },
          },
        ],
      },
    });
    await new Promise((resolve, reject) => {
      map.once("error", (event) => reject(event.error ?? new Error("MapLibre error")));
      map.once("idle", () => resolve());
    });
    const rendered = map.queryRenderedFeatures({ layers: ["export-fill"] });
    const seen = new Set();
    const features = [];
    for (const feature of rendered) {
      const id = feature.properties?.[display.promoteId];
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        features.push({ properties: { ...feature.properties } });
      }
    }
    return {
      ms: performance.now() - started,
      renderedCount: rendered.length,
      distinctCount: features.length,
      features: features.slice(0, 4),
    };
  },
  async select(feature) {
    controller = new AbortController();
    const started = performance.now();
    try {
      const found = await source.select(feature, { signal: controller.signal });
      const record = found.result.features[0];
      status.textContent = "Selected " + String(record?.attributes?.[source.publication.identity.field] ?? "");
      return {
        ok: true,
        ms: performance.now() - started,
        answeredBy: found.answeredBy,
        plan: found.plan,
        attributes: record?.attributes ?? null,
        geometryType: record?.geometry?.type ?? null,
      };
    } catch (error) {
      status.textContent = error.message;
      return { ok: false, name: error.name, code: error.code ?? null, message: error.message, ms: performance.now() - started };
    }
  },
  async queryBbox(bbox) {
    controller = new AbortController();
    const started = performance.now();
    try {
      const found = await source.queryBbox(bbox, { signal: controller.signal });
      return {
        ok: true,
        ms: performance.now() - started,
        answeredBy: found.answeredBy,
        plan: found.plan,
        featureCount: found.result.features.length,
      };
    } catch (error) {
      return { ok: false, name: error.name, code: error.code ?? null, message: error.message, ms: performance.now() - started };
    }
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
    map?.remove();
    map = undefined;
    await runtime?.dispose();
  },
};
`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Publication lookup</title></head>
<body><main><h1>Parcel lookup</h1><p id="status" role="status">Idle</p><div id="map" style="width:640px;height:480px"></div></main><script src="/harness.js"></script></body></html>`;

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
 * @param {{ artifacts: Record<string, string>, workDirectory: string, artifactDelayMs?: number, artifactCors?: boolean, artifactCacheControl?: string, artifactRangeSupport?: "full" | "get-only" | "none", artifactHead?: boolean }} options
 *   artifacts maps a URL path on the artifact origin to a file on disk.
 */
export async function startPublicationHarness({
  artifacts,
  workDirectory,
  artifactDelayMs = 0,
  artifactCors = true,
  artifactCacheControl = "no-cache",
  artifactRangeSupport = "full",
  artifactHead = true,
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
      "/maplibre-gl-worker.mjs": maplibreWorker,
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
    head: artifactHead,
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
