import "maplibre-gl/dist/maplibre-gl.css";

import { createHonua } from "@honua/sdk-js";
import type { ConnectProtocolHint } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";

import { FIXTURE_LAYER_PATH } from "./fixture-endpoint.js";
import "./styles.css";

/** Offline basemap: the starter never fetches third-party tiles on its default lane. */
const BASEMAP_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#0e1a17" } }],
};

const MAP_OPTIONS = { center: [-157.873, 21.2985], zoom: 11.4, attributionControl: false };

/** Bounded row budget. Honua never mounts a truncated result silently. */
const MAX_FEATURES = 250;

const configuredEndpoint = import.meta.env.VITE_HONUA_ENDPOINT?.trim();
const configuredProtocol = import.meta.env.VITE_HONUA_PROTOCOL?.trim();

const endpoint =
  configuredEndpoint && configuredEndpoint.length > 0
    ? configuredEndpoint
    : new URL(FIXTURE_LAYER_PATH, window.location.origin).toString();
const protocol = (
  configuredProtocol && configuredProtocol.length > 0 ? configuredProtocol : "geoservices-feature-service"
) as ConnectProtocolHint;
const dataLane = configuredEndpoint && configuredEndpoint.length > 0 ? "Live endpoint" : "Committed fixture";

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} element`);
  return found;
}

function fact(name: string, value: string): void {
  element(`fact-${name}`).textContent = value;
}

function stage(name: string, state: "running" | "done" | "failed", detail: string): void {
  const item = document.querySelector<HTMLElement>(`[data-stage="${name}"]`);
  if (!item) return;
  item.dataset["state"] = state;
  const label = item.querySelector<HTMLElement>(".stage-state");
  if (label) label.textContent = detail;
}

async function run(): Promise<void> {
  fact("mode", dataLane);
  fact("endpoint", endpoint);

  const honua = createHonua();
  try {
    stage("connect", "running", "connecting");
    const connection = await honua.connect(
      { url: endpoint, protocol },
      { authorizationScopeFingerprint: "anonymous-public" },
    );
    stage("connect", "done", "connected");

    stage("inspect", "running", "discovering");
    const inspection = await connection.inspect();
    const sourceId = inspection.defaultSourceId ?? inspection.sources[0]?.descriptor.id;
    if (!sourceId) throw new Error("The endpoint advertised no queryable source.");
    fact("protocol", inspection.protocol);
    fact("source", sourceId);
    stage("inspect", "done", `${inspection.sources.length} source(s)`);

    stage("explain", "running", "planning");
    const plan = await connection.explain(
      {
        returnGeometry: true,
        pagination: { limit: MAX_FEATURES },
        ...(inspection.protocol === "geoservices-feature-service" ? { outSr: 4326 } : {}),
      },
      { sourceId },
    );
    stage("explain", "done", "plan accepted");

    stage("query", "running", "executing");
    const result = await connection.query(plan);
    fact("features", `${result.features.length}${result.exceededTransferLimit ? " (truncated)" : ""}`);
    stage("query", "done", `${result.features.length} feature(s)`);

    stage("mount", "running", "rendering");
    // A selector or element target makes the SDK own the map's lifecycle; pass
    // an existing `maplibregl.Map` instead to keep ownership in the app.
    const mounted = await connection.mount(element("map"), {
      renderer: maplibreRenderer(maplibregl),
      query: plan,
      sourceId,
      style: BASEMAP_STYLE,
      rendererOptions: { mapOptions: MAP_OPTIONS },
    });
    await mounted.ready;
    stage("mount", "done", "mounted");
    element("status").textContent = "The accepted plan is mounted. Every stage above ran through the public SDK API.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    element("status").textContent = `The workflow stopped: ${message}`;
    for (const item of document.querySelectorAll<HTMLElement>("[data-stage]")) {
      if (item.dataset["state"] === "running") stage(item.dataset["stage"] ?? "", "failed", "failed");
    }
    await honua.dispose();
  }
}

void run();
