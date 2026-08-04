import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibre-vite-worker.js";

import * as maplibregl from "maplibre-gl";

import {
  type EditSketchTool,
  type EditSketchWorkflowSnapshot,
  type SnapResolution,
  createEditSketchWorkflow,
  createSnapIndex,
} from "@honua/sdk-js/contract";
import {
  type TerraDrawSketchController,
  createTerraDrawSketch,
  terraDrawSketchToolCapabilities,
} from "@honua/sdk-js/runtime";

import { FIXTURE_PARCELS, type ParcelAttributes, createFixtureParcelSource } from "./fixture-source.js";

import "./styles.css";

interface SketchEditingDemoSnapshot {
  status: string;
  tool?: string;
  geometryType: string | null;
  undoDepth: number;
  redoDepth: number;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  valid: boolean;
  drawnFeatureCount: number;
  appliedEditCount: number;
}

interface SketchEditingDemoRuntime {
  readonly ready: boolean;
  snapshot(): SketchEditingDemoSnapshot;
  setTool(tool: EditSketchTool): string;
  undo(): boolean;
  redo(): boolean;
  deleteActive(): boolean;
  submit(): Promise<string>;
}

declare global {
  interface Window {
    __HONUA_SKETCH_EDITING_DEMO__?: SketchEditingDemoRuntime;
  }
}

const MAP_CENTER: [number, number] = [-157.8695, 21.3085];

const { source, applied } = createFixtureParcelSource();

const workflow = createEditSketchWorkflow<ParcelAttributes>({
  source,
  kind: "create",
  feature: { attributes: { name: "Field sketch", zone: "survey" } },
  sketchTools: terraDrawSketchToolCapabilities(),
  snapping: { enabled: true, tolerance: 16 },
});

const snapIndex = createSnapIndex();
snapIndex.setSourceFeatures(
  "harbor-parcels",
  FIXTURE_PARCELS.features.map((feature) => ({
    id: feature.id,
    geometry: feature.geometry as unknown as Record<string, unknown>,
  })),
);

let controller: TerraDrawSketchController<ParcelAttributes> | undefined;
let ready = false;
let lastSubmitStatus = "ready";
let lastSnap: SnapResolution | undefined;
const log: string[] = [];

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

function geometryType(snapshot: EditSketchWorkflowSnapshot<ParcelAttributes>): string | null {
  const geometry = snapshot.sketch.geometry;
  if (geometry === null || geometry === undefined) return null;
  return typeof geometry.type === "string" ? geometry.type : "unknown";
}

function appendLog(entry: string): void {
  log.unshift(entry);
  getElement<HTMLElement>("#operation-log").innerHTML = log
    .slice(0, 12)
    .map((line) => `<li>${line}</li>`)
    .join("");
}

function render(): void {
  const snapshot = workflow.snapshot();
  setText("#sketch-status", snapshot.sketch.status);
  setText("#sketch-tool", snapshot.sketch.activeTool ?? snapshot.sketch.tool ?? "none");
  setText("#geometry-type", geometryType(snapshot) ?? "none");
  setText("#undo-depth", String(snapshot.undo.undoDepth));
  setText("#redo-depth", String(snapshot.undo.redoDepth));
  setText("#dirty-state", snapshot.dirty ? "dirty" : "clean");
  setText("#validation-state", snapshot.validation.valid ? "valid" : "invalid");
  setText("#submit-status", lastSubmitStatus);
  setText("#applied-count", String(applied.length));
  setText(
    "#snap-status",
    lastSnap?.candidate
      ? `${lastSnap.candidate.kind} @ ${lastSnap.candidate.position[0].toFixed(5)}, ${lastSnap.candidate.position[1].toFixed(5)}`
      : "no snap target",
  );
  getElement<HTMLButtonElement>("#undo").disabled = !snapshot.undo.canUndo;
  getElement<HTMLButtonElement>("#redo").disabled = !snapshot.undo.canRedo;
}

function demoSnapshot(): SketchEditingDemoSnapshot {
  const snapshot = workflow.snapshot();
  return {
    status: snapshot.sketch.status,
    ...(snapshot.sketch.tool ? { tool: snapshot.sketch.tool } : {}),
    geometryType: geometryType(snapshot),
    undoDepth: snapshot.undo.undoDepth,
    redoDepth: snapshot.undo.redoDepth,
    canUndo: snapshot.undo.canUndo,
    canRedo: snapshot.undo.canRedo,
    dirty: snapshot.dirty,
    valid: snapshot.validation.valid,
    drawnFeatureCount: controller?.draw.getSnapshot().length ?? 0,
    appliedEditCount: applied.length,
  };
}

function setTool(tool: EditSketchTool): string {
  if (!controller) return "unavailable";
  const capability = controller.setTool(tool);
  render();
  return capability.state;
}

function deleteActive(): boolean {
  if (!controller) return false;
  const id = controller.selectedFeatureId ?? controller.activeFeatureId;
  if (id === undefined || !controller.draw.removeFeatures) return false;
  controller.draw.removeFeatures([id]);
  render();
  return true;
}

async function submit(): Promise<string> {
  const result = await workflow.submit();
  lastSubmitStatus = result.status;
  const addCount = result.editResult?.added?.length ?? 0;
  appendLog(`applyEdits → ${result.status} (${addCount} added, source total ${applied.length} envelope(s))`);
  render();
  return result.status;
}

function wireToolbar(): void {
  const tools: ReadonlyArray<[string, EditSketchTool]> = [
    ["#tool-point", "point"],
    ["#tool-line", "line"],
    ["#tool-polygon", "polygon"],
    ["#tool-rectangle", "rectangle"],
    ["#tool-circle", "circle"],
  ];
  for (const [selector, tool] of tools) {
    getElement<HTMLButtonElement>(selector).addEventListener("click", () => setTool(tool));
  }
  getElement<HTMLButtonElement>("#tool-freehand").addEventListener("click", () => {
    // Freehand draws polygons; arm the polygon tool and switch modes directly.
    workflow.startSketch("polygon");
    controller?.draw.setMode("freehand");
    render();
  });
  getElement<HTMLButtonElement>("#tool-select").addEventListener("click", () => {
    controller?.select();
    render();
  });
  getElement<HTMLButtonElement>("#tool-cancel").addEventListener("click", () => {
    controller?.cancel();
    render();
  });
  getElement<HTMLButtonElement>("#undo").addEventListener("click", () => {
    controller?.undo();
    render();
  });
  getElement<HTMLButtonElement>("#redo").addEventListener("click", () => {
    controller?.redo();
    render();
  });
  getElement<HTMLButtonElement>("#delete-feature").addEventListener("click", () => {
    deleteActive();
  });
  getElement<HTMLButtonElement>("#submit-edit").addEventListener("click", () => {
    void submit();
  });
}

const map = new maplibregl.Map({
  container: "map",
  center: MAP_CENTER,
  zoom: 15.5,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      "harbor-parcels": { type: "geojson", data: FIXTURE_PARCELS as never },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0b1d26" } },
      {
        id: "parcel-fill",
        type: "fill",
        source: "harbor-parcels",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#155e75", "fill-opacity": 0.55 },
      },
      {
        id: "parcel-line",
        type: "line",
        source: "harbor-parcels",
        paint: { "line-color": "#67e8f9", "line-width": 2 },
      },
    ],
  },
});

map.on("load", () => {
  void (async () => {
    controller = await createTerraDrawSketch<ParcelAttributes>(map, {
      model: workflow,
      snapping: {
        index: snapIndex,
        model: workflow,
        onResolve: (resolution) => {
          lastSnap = resolution;
          setText(
            "#snap-status",
            resolution.candidate
              ? `${resolution.candidate.kind} @ ${resolution.candidate.position[0].toFixed(5)}, ${resolution.candidate.position[1].toFixed(5)}`
              : "no snap target",
          );
        },
      },
      onFinish: (event) => {
        appendLog(
          `finish ${event.action} (${event.mode}) → ${event.applied ? `applied as ${event.tool}` : "not applied"}`,
        );
        render();
      },
      onDelete: (featureId) => {
        appendLog(`deleted feature ${String(featureId)} → staged null geometry (undoable)`);
        render();
      },
      onSelect: () => render(),
      onDeselect: () => render(),
    });
    wireToolbar();
    render();
    ready = true;
  })();
});

window.__HONUA_SKETCH_EDITING_DEMO__ = {
  get ready() {
    return ready;
  },
  snapshot: demoSnapshot,
  setTool,
  undo() {
    const undone = controller?.undo() ?? false;
    render();
    return undone;
  },
  redo() {
    const redone = controller?.redo() ?? false;
    render();
    return redone;
  },
  deleteActive,
  submit,
};
