import "../../../examples/shared/maplibre-vite-worker.js";
import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { HonuaOnlineBasemapBinding } from "../../../src/runtime/online-basemap.js";

const map = new maplibregl.Map({ container: "map", style: { version: 8, sources: {}, layers: [] }, center: [0, 0], zoom: 3, attributionControl: { compact: true } });
const status = document.getElementById("status")!;
const binding = new HonuaOnlineBasemapBinding(map, { onError: (message) => { status.textContent = message; }, onReady: () => { status.textContent = "ready"; } });
map.once("load", async () => {
  map.addSource("operational", { type: "geojson", data: { type: "FeatureCollection", features: [{ type: "Feature", id: 1, geometry: { type: "Point", coordinates: [0, 0] }, properties: { priority: "high" } }] }, attribution: "Operational fixture contributor" });
  map.addLayer({ id: "operational", source: "operational", type: "circle", filter: ["==", ["get", "priority"], "high"], paint: { "circle-radius": 9, "circle-color": ["case", ["boolean", ["feature-state", "selected"], false], "red", "blue"] } });
  map.setFeatureState({ source: "operational", id: 1 }, { selected: true });
  const popup = new maplibregl.Popup({ closeOnClick: false }).setLngLat([0, 0]).setText("Selected operational feature").addTo(map);
  const operationalSource = map.getSource("operational");
  const activate = (theme: string) => binding.activate({ styleUrl: `/test/fixtures/online-basemap/styles/${theme}.json` });
  Object.assign(window, { __HONUA_BASEMAP_FIXTURE__: { map, popup, operationalSource, activate, binding } });
  await activate("light");
});
