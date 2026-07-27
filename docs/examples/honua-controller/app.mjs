import * as maplibregl from "maplibre-gl";

import { HonuaClient } from "@honua/sdk-js";
import { createHonuaController } from "@honua/sdk-js/app-controller";
import { loadMapPackage } from "@honua/sdk-js/runtime";

const client = new HonuaClient({ baseUrl: "https://honua.example.com" });
const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
});
const mapPackage = await fetch("/api/map-package").then((response) => response.json());

const runtime = await loadMapPackage(mapPackage, map, { client });
const controller = createHonuaController({
  runtime,
  layerGroups: {
    operations: ["incident-points", "unit-lines"],
  },
});

controller.onViewportMoveEnd(({ viewport }) => {
  updateViewportReadout(viewport);
});

controller.onSelectionChange(({ selection }) => {
  renderSelectionPanel(selection);
});

controller.onVisibilityChange(({ visibility }) => {
  renderLayerToggles(visibility);
});

document.querySelector("#zoom-to-response")?.addEventListener("click", () => {
  controller.fitBounds([-159, 19, -155, 22], { padding: 48, animate: true });
});

document.querySelector("#hide-operations")?.addEventListener("click", () => {
  controller.setLayerGroupVisibility({ hide: ["operations"] });
});

document.querySelector("#show-operations")?.addEventListener("click", () => {
  controller.setLayerGroupVisibility({ show: ["operations"] });
});

document.querySelector("#mark-staging")?.addEventListener("click", () => {
  controller.addOverlay({
    id: "staging-area",
    kind: "polygon",
    rings: [
      [
        [-157.9, 21.29],
        [-157.78, 21.29],
        [-157.78, 21.36],
        [-157.9, 21.36],
        [-157.9, 21.29],
      ],
    ],
  });
  controller.addAnnotation({
    id: "staging-note",
    kind: "text",
    coordinate: [-157.84, 21.33],
    text: "Temporary staging area",
  });
});

function updateViewportReadout(viewport) {
  console.log("viewport", viewport);
}

function renderSelectionPanel(selection) {
  console.log("selection", selection);
}

function renderLayerToggles(visibility) {
  console.log("visibility", visibility);
}
