import { ColumnarWorkflowError } from "@honua/sdk-js/columnar-workflow";
import { Map, Marker, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import "./maplibre-vite-worker.js";
import { COLUMNAR_BUDGETS, COLUMNAR_QUERY, createFixtureWorkflow } from "./workflow.js";
import "./style.css";

interface MappedRow {
  readonly featureId: number | undefined;
  readonly name: string;
  readonly coordinate: [number, number];
  readonly timestamp: string | null;
}

interface RunOutcome {
  readonly status: "ready" | "cancelled" | "failed";
  readonly rows: number;
}

interface ColumnarQuickstartRuntime {
  ready: boolean;
  running: boolean;
  status: RunOutcome["status"] | "loading";
  completedRuns: number;
  cancelledRuns: number;
  featureCount: number;
  lastEvidence?: {
    readonly rows: number;
    readonly batches: number;
    readonly transferBytes: number;
    readonly peakBackingBytes: number;
    readonly elapsedMs: number;
    readonly ceilings: typeof COLUMNAR_BUDGETS;
  };
  lastPlan: ReturnType<ReturnType<typeof createFixtureWorkflow>["session"]["plan"]>;
  lastRequest?: { readonly method: string; readonly url: string };
  lastRows: readonly MappedRow[];
  run(): Promise<RunOutcome>;
  cancel(): void;
  sourceFeatureCount(): number;
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    __HONUA_COLUMNAR_QUERY_QUICKSTART__?: ColumnarQuickstartRuntime;
  }
}

const element = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
};

const setText = (selector: string, value: string): void => {
  element<HTMLElement>(selector).textContent = value;
};

const formatBytes = (value: number): string =>
  value < 1024 ? `${value.toLocaleString()} B` : `${(value / 1024).toFixed(1)} KiB`;

const map = new Map({
  container: "map",
  attributionControl: false,
  center: [-157.8583, 21.3069],
  zoom: 11.8,
  minZoom: 8,
  maxZoom: 17,
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "water", type: "background", paint: { "background-color": "#093b49" } }],
  },
});
map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

const mapReady = new Promise<void>((resolve) => {
  map.once("load", () => {
    map.addSource("query-aoi", {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-158.25, 21.2],
            [-157.65, 21.2],
            [-157.65, 21.75],
            [-158.25, 21.75],
            [-158.25, 21.2],
          ]],
        },
      },
    });
    map.addLayer({
      id: "query-aoi-fill",
      type: "fill",
      source: "query-aoi",
      paint: { "fill-color": "#46d6bd", "fill-opacity": 0.06 },
    });
    map.addLayer({
      id: "query-aoi-line",
      type: "line",
      source: "query-aoi",
      paint: { "line-color": "#7fe8d5", "line-opacity": 0.6, "line-width": 1.5, "line-dasharray": [2, 2] },
    });
    map.addSource("columnar-results", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "result-halo",
      type: "circle",
      source: "columnar-results",
      paint: {
        "circle-radius": 24,
        "circle-color": "#f3a84f",
        "circle-opacity": 0.2,
        "circle-stroke-color": "#ffd29a",
        "circle-stroke-opacity": 0.55,
        "circle-stroke-width": 1,
      },
    });
    map.addLayer({
      id: "result-point",
      type: "circle",
      source: "columnar-results",
      paint: {
        "circle-radius": 8,
        "circle-color": "#ffb34f",
        "circle-stroke-color": "#fff6df",
        "circle-stroke-width": 3,
      },
    });
    resolve();
  });
});

const workflow = createFixtureWorkflow();
const plan = workflow.session.plan(COLUMNAR_QUERY);
let activeAbort: AbortController | undefined;
let activeMarker: Marker | undefined;
let generation = 0;

const runtime: ColumnarQuickstartRuntime = {
  ready: false,
  running: false,
  status: "loading",
  completedRuns: 0,
  cancelledRuns: 0,
  featureCount: 0,
  lastPlan: plan,
  lastRows: [],
  run,
  cancel,
  sourceFeatureCount,
  dispose,
};
window.__HONUA_COLUMNAR_QUERY_QUICKSTART__ = runtime;

setText("#server-plan", plan.pushdown.join(" / "));
setText(
  "#plan-json",
  JSON.stringify(
    {
      execution: plan.execution,
      pushedToServer: plan.pushdown,
      browserAfterResponse: ["bounded GeoArrow WKB decode", "table handoff", "MapLibre render"],
      ceilings: plan.boundedBy,
      canonicalRequest: plan.request,
      fixtureTransport: "in-memory exact server artifact; no live endpoint claimed",
    },
    null,
    2,
  ),
);

element<HTMLButtonElement>("#run-query").addEventListener("click", () => void run());
element<HTMLButtonElement>("#cancel-query").addEventListener("click", cancel);

function setRunning(running: boolean): void {
  runtime.running = running;
  element<HTMLButtonElement>("#run-query").disabled = running;
  element<HTMLButtonElement>("#cancel-query").disabled = !running;
}

function sourceFeatureCount(): number {
  if (!map.getSource("columnar-results")) return 0;
  return map.querySourceFeatures("columnar-results").length;
}

function clearResultPresentation(): void {
  runtime.lastRows = [];
  runtime.featureCount = 0;
  delete runtime.lastEvidence;
  delete runtime.lastRequest;
  activeMarker?.remove();
  activeMarker = undefined;
  const source = map.getSource("columnar-results") as GeoJSONSource | undefined;
  source?.setData({ type: "FeatureCollection", features: [] });
  setText("#metric-rows", "-");
  setText("#metric-transfer", "-");
  setText("#metric-backing", "-");
  setText("#metric-elapsed", "-");
  setText("#result-title", "Waiting for one bounded batch");
  setText("#result-id", "-");
  setText("#result-coordinate", "-");
}

function renderRows(rows: readonly MappedRow[]): void {
  const source = map.getSource("columnar-results") as GeoJSONSource;
  source.setData({
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature",
      properties: { featureId: row.featureId ?? null, name: row.name },
      geometry: { type: "Point", coordinates: [...row.coordinate] },
    })),
  });
  activeMarker?.remove();
  activeMarker = undefined;
  const first = rows[0];
  if (!first) return;
  const label = document.createElement("div");
  label.className = "result-label";
  label.textContent = first.name;
  label.setAttribute("aria-label", `${first.name}, mapped Arrow result`);
  activeMarker = new Marker({ element: label, anchor: "bottom", offset: [0, -16] })
    .setLngLat(first.coordinate)
    .addTo(map);
  map.easeTo({ center: first.coordinate, zoom: 12.4, duration: 500 });
}

async function run(): Promise<RunOutcome> {
  const currentGeneration = ++generation;
  activeAbort?.abort(new DOMException("Superseded by a newer query.", "AbortError"));
  const controller = new AbortController();
  activeAbort = controller;
  runtime.ready = false;
  runtime.status = "loading";
  clearResultPresentation();
  setRunning(true);
  setText("#status", "Executing the bounded f=arrow request...");
  const stateChip = element<HTMLElement>("#map-state");
  stateChip.dataset.state = "loading";
  stateChip.textContent = "Decoding Arrow";

  try {
    await mapReady;
    const rows: MappedRow[] = [];
    for await (const result of workflow.session.stream({ ...COLUMNAR_QUERY, signal: controller.signal })) {
      const handoff = workflow.session.table(result.batch, COLUMNAR_QUERY.limit);
      for (const row of handoff.rows) {
        const coordinate = row.geometry;
        if (
          !Array.isArray(coordinate) ||
          coordinate.length < 2 ||
          !Number.isFinite(coordinate[0]) ||
          !Number.isFinite(coordinate[1])
        ) {
          throw new Error("The point fixture did not decode to a finite XY coordinate.");
        }
        rows.push({
          featureId: row.featureId,
          name: row.dictionaryValue ?? "Unnamed result",
          coordinate: [coordinate[0], coordinate[1]],
          timestamp: row.timestamp === undefined || row.timestamp === null ? null : row.timestamp.toString(),
        });
      }
      runtime.lastEvidence = {
        rows: result.evidence.rows,
        batches: result.evidence.batches,
        transferBytes: result.evidence.transferBytes,
        peakBackingBytes: result.evidence.peakBackingBytes,
        elapsedMs: result.evidence.elapsedMs,
        ceilings: COLUMNAR_BUDGETS,
      };
    }
    if (currentGeneration !== generation) return { status: "cancelled", rows: 0 };
    if (rows.length === 0 || !runtime.lastEvidence) throw new Error("The bounded query emitted no rows.");

    runtime.lastRows = rows;
    runtime.featureCount = rows.length;
    runtime.lastRequest = workflow.lastRequest;
    runtime.completedRuns += 1;
    runtime.ready = true;
    runtime.status = "ready";
    renderRows(rows);
    const first = rows[0]!;
    setText("#metric-rows", runtime.lastEvidence.rows.toLocaleString());
    setText("#metric-transfer", formatBytes(runtime.lastEvidence.transferBytes));
    setText("#metric-backing", formatBytes(runtime.lastEvidence.peakBackingBytes));
    setText("#metric-elapsed", `${runtime.lastEvidence.elapsedMs.toFixed(1)} ms`);
    setText("#result-title", first.name);
    setText("#result-id", String(first.featureId ?? "not present"));
    setText("#result-coordinate", `${first.coordinate[0].toFixed(4)}, ${first.coordinate[1].toFixed(4)}`);
    setText(
      "#status",
      `Ready: ${runtime.lastEvidence.rows} row and ${runtime.lastEvidence.transferBytes.toLocaleString()} admitted payload bytes.`,
    );
    stateChip.dataset.state = "ready";
    stateChip.textContent = "Budget passed";
    return { status: "ready", rows: rows.length };
  } catch (error) {
    const cancelled =
      controller.signal.aborted || (error instanceof ColumnarWorkflowError && error.code === "ABORTED");
    if (cancelled) {
      if (currentGeneration === generation) {
        runtime.status = "cancelled";
        runtime.cancelledRuns += 1;
        setText("#status", "Cancelled before the Arrow batch was admitted. No stale result rendered.");
        stateChip.dataset.state = "cancelled";
        stateChip.textContent = "Cancelled cleanly";
      }
      return { status: "cancelled", rows: 0 };
    }
    runtime.status = "failed";
    runtime.ready = false;
    const message = error instanceof Error ? error.message : String(error);
    setText("#status", `Stopped explicitly: ${message}`);
    stateChip.dataset.state = "failed";
    stateChip.textContent = "Stopped explicitly";
    return { status: "failed", rows: 0 };
  } finally {
    if (currentGeneration === generation) {
      activeAbort = undefined;
      setRunning(false);
    }
  }
}

function cancel(): void {
  activeAbort?.abort(new DOMException("Cancelled by the user.", "AbortError"));
}

async function dispose(): Promise<void> {
  generation += 1;
  cancel();
  activeMarker?.remove();
  activeMarker = undefined;
  map.remove();
  await workflow.session.dispose();
  runtime.ready = false;
  runtime.running = false;
}

void run();
