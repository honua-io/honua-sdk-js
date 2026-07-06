import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "@honua/sdk-js/contract";
import type { Query } from "@honua/sdk-js/contract";
import { GeoparquetRuntime, createBrowserDuckDbDriver, geoparquetResolver } from "@honua/sdk-js/geoparquet";

const FIXTURE_URL = "/overture-places.parquet";
const FIXTURE_NAME = "overture-places.parquet";

// Self-hosted DuckDB-WASM bundle (see vite.config.ts). The exception-handling
// (`eh`) bundle needs no cross-origin isolation / SharedArrayBuffer.
const DUCKDB_BUNDLE = {
  mainModule: "/duckdb/duckdb-eh.wasm",
  mainWorker: "/duckdb/duckdb-browser-eh.worker.js",
};

interface OverturePlace {
  id: string;
  name: string;
  category: string;
  confidence: number;
}

interface ExplorerApi {
  ready: boolean;
  error?: string;
  lastCount: number;
  rowEstimate?: number;
  runQuery(category: string, aoi: [number, number, number, number]): Promise<void>;
}

const engineState = document.querySelector<HTMLSpanElement>("#engine-state")!;
const schemaState = document.querySelector<HTMLSpanElement>("#schema-state")!;
const crsState = document.querySelector<HTMLSpanElement>("#crs-state")!;
const rowsState = document.querySelector<HTMLSpanElement>("#rows-state")!;
const resultSummary = document.querySelector<HTMLParagraphElement>("#result-summary")!;
const resultBody = document.querySelector<HTMLTableSectionElement>("#result-body")!;
const form = document.querySelector<HTMLFormElement>("#query-form")!;
const categorySelect = document.querySelector<HTMLSelectElement>("#category")!;
const aoiInput = document.querySelector<HTMLInputElement>("#aoi")!;

function parseAoi(value: string): [number, number, number, number] {
  const parts = value.split(",").map((v) => Number.parseFloat(v.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return [-180, -90, 180, 90];
  }
  return parts as [number, number, number, number];
}

// Minimal Esri-shaped envelope spatial filter (mirrors `envelope()` from the
// SDK root, kept inline so the demo only imports the geoparquet + contract
// entrypoints).
function envelope(xmin: number, ymin: number, xmax: number, ymax: number) {
  return {
    geometry: { xmin, ymin, xmax, ymax },
    geometryType: "esriGeometryEnvelope" as const,
    spatialRel: "esriSpatialRelIntersects" as const,
  };
}

async function bootstrap(): Promise<void> {
  const api: ExplorerApi = {
    ready: false,
    lastCount: 0,
    async runQuery() {
      /* replaced below */
    },
  };
  (window as unknown as { __HONUA_OVERTURE__: ExplorerApi }).__HONUA_OVERTURE__ = api;

  try {
    const runtime = new GeoparquetRuntime({
      driverFactory: () => createBrowserDuckDbDriver({ bundle: DUCKDB_BUNDLE, logLevel: "ERROR" }),
    });

    // Fetch the committed fixture and register it as an in-memory DuckDB file.
    const bytes = new Uint8Array(await (await fetch(FIXTURE_URL)).arrayBuffer());
    await runtime.registerFileBuffer(FIXTURE_NAME, bytes);

    const resolver = geoparquetResolver({ runtime });
    const dataset = createDataset({
      id: "overture",
      // No server: the geoparquet source never touches the client. A stub keeps
      // the contract types honest; compatibility check is skipped.
      client: {} as never,
      skipCompatibilityCheck: true,
      capabilityPolicy: "degraded",
      resolveSource: resolver,
      sources: [
        {
          id: "places",
          protocol: "geoparquet",
          locator: { url: FIXTURE_NAME },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
        },
      ],
    });

    const source = dataset.source<OverturePlace>("places")!;
    const handle = source.protocol("geoparquet")!;
    const description = await handle.describe();
    api.rowEstimate = description.rowEstimate;

    schemaState.innerHTML = `Schema: <strong>${description.schema.map((f) => f.name).join(", ")}</strong>`;
    crsState.innerHTML = `CRS: <strong>${description.crs ?? "n/a"}</strong> (${description.geometryEncoding})`;
    rowsState.innerHTML = `Footer rows: <strong>${description.rowEstimate ?? "?"}</strong>`;
    engineState.textContent = "DuckDB-WASM ready";

    api.runQuery = async (category, aoi) => {
      const query: Query<OverturePlace> = {
        spatialFilter: envelope(...aoi),
        outFields: ["id", "name", "category", "confidence"],
        orderBy: [{ field: "confidence", direction: "desc" }],
        returnGeometry: true,
      };
      if (category !== "all") query.where = `category = '${category.replace(/'/g, "''")}'`;

      const result = await source.query(query);
      api.lastCount = result.features.length;

      resultBody.replaceChildren();
      for (const feature of result.features) {
        const [lon, lat] = (feature.geometry as { coordinates: [number, number] }).coordinates;
        const row = document.createElement("tr");
        row.innerHTML =
          `<td><code>${feature.attributes.id}</code></td>` +
          `<td>${feature.attributes.name}</td>` +
          `<td>${feature.attributes.category}</td>` +
          `<td>${feature.attributes.confidence}</td>` +
          `<td>${lon.toFixed(4)}, ${lat.toFixed(4)}</td>`;
        resultBody.append(row);
      }
      const degraded = result.degraded?.length ? " (bbox-approximated)" : "";
      resultSummary.textContent = `${result.features.length} place(s) matched${degraded}. GERS ids preserved.`;
    };

    api.ready = true;

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void api.runQuery(categorySelect.value, parseAoi(aoiInput.value));
    });

    // Initial render.
    await api.runQuery("all", parseAoi(aoiInput.value));
  } catch (error) {
    api.error = error instanceof Error ? error.message : String(error);
    engineState.textContent = `Failed to start: ${api.error}`;
  }
}

void bootstrap();
