import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";
import type { HonuaAgentWidgetQueryRequest } from "@honua/sdk-js/agent-tools";
import {
  type AskMapState,
  createAskMapSession,
  createNlMapControl,
  mountAskMapControl,
} from "@honua/sdk-js/nl-map-control";
import * as maplibregl from "maplibre-gl";
import { createBrowserDuckDbDriver } from "../../../src/geoparquet/driver.js";
import { FIXTURE_VERSION, INCIDENTS, ORIGIN, SCHEMA, geographic, incidentsGeoJson, projected } from "./fixture.js";
import { type QueryResult, createIncidentRuntime, initializeFixture, reviewQuery } from "./map-runtime.js";
import { SUGGESTIONS, authenticatedLiveModel, groundedModel, recordedModel } from "./model.js";
import { type IncidentQuery, type QueryContext, describeQuery } from "./query.js";
import "./styles.css";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing ${id}`);
  return value as T;
}
const startup = element("startup");
const mode = element<HTMLSelectElement>("mode");
const results = element("results");
const groupResults = element("groups");
const location = element("location");
const map = new maplibregl.Map({
  container: "map",
  attributionControl: false,
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#d9e7df" } }],
  },
  center: geographic(...ORIGIN),
  zoom: 14,
});
/** Read-only observation for sample evidence; IDs come from rendered MapLibre features. */
export function observeDisplayedIncidentIds(): number[] {
  return [
    ...new Set(
      map.queryRenderedFeatures({ layers: ["incidents-circles"] }).map((feature) => Number(feature.properties?.id)),
    ),
  ].sort((a, b) => a - b);
}
let previousQuery: IncidentQuery | undefined;
let selectedLocation: readonly [number, number] | undefined;
let selectedId: number | undefined;
let mounted: ReturnType<typeof mountAskMapControl> | undefined;
const context = (): QueryContext => {
  const bounds = map.getBounds();
  const southwest = projected(bounds.getWest(), bounds.getSouth());
  const northeast = projected(bounds.getEast(), bounds.getNorth());
  return {
    sourceId: "incidents",
    sourceVersion: FIXTURE_VERSION,
    schemaFingerprint: SCHEMA.fingerprint,
    authorizationContextId: "public-fixture",
    viewport: [...southwest, ...northeast],
    ...(selectedLocation ? { selectedLocation } : {}),
    ...(previousQuery ? { previousQuery } : {}),
    mode: mode.value as "recorded" | "live",
  };
};
async function start(): Promise<void> {
  await new Promise<void>((resolve) => map.on("load", () => resolve()));
  map.addSource("incidents", { type: "geojson", data: incidentsGeoJson() });
  map.addLayer({
    id: "incidents-circles",
    type: "circle",
    source: "incidents",
    paint: {
      "circle-radius": 9,
      "circle-color": ["match", ["get", "status"], "open", "#db452d", "#288598"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
  element("full-view").addEventListener("click", () => map.jumpTo({ center: geographic(...ORIGIN), zoom: 14 }));
  element("empty-view").addEventListener("click", () =>
    map.jumpTo({ center: geographic(ORIGIN[0] + 20000, ORIGIN[1]), zoom: 14 }),
  );
  const driver = await createBrowserDuckDbDriver({
    bundle: {
      mainModule: new URL("duckdb/duckdb-eh.wasm", document.baseURI).href,
      mainWorker: new URL("duckdb/duckdb-browser-eh.worker.js", document.baseURI).href,
    },
    extensionRepository: new URL("duckdb/extensions", document.baseURI).href,
    preloadExtensions: ["parquet"],
    loadSpatial: true,
  });
  await initializeFixture(driver);
  const session = createAskMapSession({
    context,
    createControl(snapshot, signal) {
      return createNlMapControl({
        tools: {
          runtime: createIncidentRuntime(driver, snapshot, signal),
          tools: ["runWidgetQuery"],
          context: { includeSafeExamples: false },
        },
        llm: groundedModel(snapshot, snapshot.mode === "recorded" ? recordedModel(snapshot) : authenticatedLiveModel()),
        policy: { maxSelfCorrections: 2, maxPlanSteps: 1 },
        validateStep(call) {
          try {
            if (call.name !== "runWidgetQuery") throw new Error("Only read-only incident queries are admitted.");
            reviewQuery(call.args);
            return [];
          } catch (error) {
            return [{ code: "capability-gap", message: error instanceof Error ? error.message : String(error) }];
          }
        },
      });
    },
    review(plan, snapshot) {
      const call = plan.steps[0]?.call;
      if (call?.name !== "runWidgetQuery") throw new Error("Missing query.");
      const { compiled, featureQuery } = reviewQuery(call.args);
      return {
        summary: `Review ${compiled.query.kind === "aggregate" ? "grouped counts and matching features" : "matching incidents"} on ${FIXTURE_VERSION}: ${describeQuery(compiled.query)}. Captured viewport: ${snapshot.viewport.map((value) => value.toFixed(1)).join(", ")} in EPSG:3857. Distances are planar projected metres, not ground/geodesic metres. Moving the map invalidates this proposal.`,
        details: {
          dialect: "duckdb-sql",
          executedResource: "ask-map-incidents.parquet",
          query: compiled.query,
          queries: [compiled.artifact, ...(compiled.query.kind === "aggregate" ? [featureQuery.artifact] : [])],
        },
      };
    },
    apply(execution) {
      const data = execution.results[0]?.data as { data?: QueryResult } | undefined;
      const result = data?.data;
      if (!result || !Array.isArray(result.features)) throw new Error("Missing bounded feature results.");
      const ids = result.features.map((row) => row.id);
      map.setFilter("incidents-circles", ["in", ["get", "id"], ["literal", ids]]);
      results.replaceChildren();
      for (const feature of result.features) {
        const row = document.createElement("tr");
        row.dataset.featureId = String(feature.id);
        row.dataset.selected = String(feature.id === selectedId);
        for (const value of [feature.id, feature.status, feature.kind]) {
          const cell = document.createElement("td");
          cell.textContent = String(value);
          row.append(cell);
        }
        const cell = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Select incident ${feature.id}`;
        button.setAttribute("aria-pressed", String(feature.id === selectedId));
        button.addEventListener("click", () => select(feature.id));
        cell.append(button);
        row.append(cell);
        results.append(row);
      }
      groupResults.textContent =
        result.groups?.map((row) => `${String(row.kind)}: ${String(row.count)}`).join(" · ") ?? "No grouping";
      // The accepted plan remains the source of refinement context; receipt data never rewrites it.
      if (lastState.plan?.steps[0]?.call.name === "runWidgetQuery")
        previousQuery = reviewQuery(lastState.plan.steps[0].call.args as HonuaAgentWidgetQueryRequest).compiled.query;
      return { count: ids.length };
    },
    onState(state) {
      lastState = state;
      mounted?.render(state);
    },
    timeoutMs: 15_000,
  });
  let lastState: AskMapState = session.state;
  function select(id: number) {
    const feature = INCIDENTS.find((row) => row.id === id);
    if (!feature) return;
    selectedId = id;
    selectedLocation = [ORIGIN[0] + feature.x, ORIGIN[1] + feature.y];
    for (const row of results.querySelectorAll<HTMLTableRowElement>("tr[data-feature-id]")) {
      const selected = row.dataset.featureId === String(id);
      row.dataset.selected = String(selected);
      row.querySelector("button")?.setAttribute("aria-pressed", String(selected));
    }
    location.textContent = `Selected incident ${id}; EPSG:3857 ${selectedLocation.join(", ")}.`;
    map.setPaintProperty("incidents-circles", "circle-stroke-color", [
      "case",
      ["==", ["get", "id"], id],
      "#000",
      "#fff",
    ]);
    session.invalidate();
  }
  map.on("click", "incidents-circles", (event) => {
    const id = event.features?.[0]?.properties?.id;
    if (typeof id === "number") select(id);
  });
  map.on("movestart", () => {
    previousQuery = undefined;
    session.invalidate();
  });
  function mount() {
    mounted = mountAskMapControl({
      container: element("ask-control"),
      session,
      suggestions: SUGGESTIONS,
      mode: mode.value as "recorded" | "live",
    });
    mounted.render(session.state);
  }
  mode.addEventListener("change", () => {
    mounted?.dispose();
    mount();
  });
  mount();
  startup.textContent =
    "Ready. Recorded mode uses exact suggestions; live mode requires a signed-in server-side model adapter.";
  window.addEventListener(
    "pagehide",
    () => {
      session.cancel();
      void driver.close();
    },
    { once: true },
  );
}
start().catch((error: unknown) => {
  startup.textContent = `Initialization failed: ${error instanceof Error ? error.message : String(error)}`;
});
