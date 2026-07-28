import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

import { type PmtilesArchiveDescription, describePmtilesArchive } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js/honua";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  isPmtilesProtocolRegistered,
  loadMapPackage,
} from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";

import "./styles.css";

interface PmtilesStaticRuntime {
  readonly ready: boolean;
  readonly protocolRegistered: boolean;
  readonly hasSource: boolean;
  readonly archive: PmtilesArchiveDescription | undefined;
}

declare global {
  interface Window {
    __HONUA_PMTILES_STATIC_DEMO__?: PmtilesStaticRuntime;
  }
}

// The archive is a plain static asset served next to the app (see `public/`).
// A PMTiles URL for MapLibre is the archive URL prefixed with `pmtiles://`.
const archiveUrl = new URL("basemap.pmtiles", window.location.href).toString();
const pmtilesUrl = `pmtiles://${archiveUrl}`;

const state: {
  ready: boolean;
  archive: PmtilesArchiveDescription | undefined;
} = { ready: false, archive: undefined };

function text(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderArchive(info: PmtilesArchiveDescription): void {
  text("archive-name", String(info.metadata.name ?? "PMTiles archive"));
  text("tilekind-state", info.tileKind.toUpperCase());
  text("zoom-state", `z${info.minZoom}–z${info.maxZoom}`);
  const [west, south, east, north] = info.bounds;
  const dl = document.getElementById("archive-metadata");
  if (dl) {
    dl.innerHTML = "";
    const rows: Array<[string, string]> = [
      ["Bounds W/S", `${west.toFixed(2)}, ${south.toFixed(2)}`],
      ["Bounds E/N", `${east.toFixed(2)}, ${north.toFixed(2)}`],
      ["Center", `${info.center[0].toFixed(2)}, ${info.center[1].toFixed(2)} @ z${info.center[2]}`],
      ["Attribution", info.attribution ?? "—"],
    ];
    for (const [term, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
  }
  const layers = document.getElementById("vector-layers");
  if (layers) {
    layers.innerHTML = "";
    if (info.vectorLayers.length === 0) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = "raster archive (no vector layers)";
      layers.append(chip);
    } else {
      for (const layer of info.vectorLayers) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = layer.id;
        layers.append(chip);
      }
    }
  }
}

function buildPackage(): HonuaMapPackage {
  return {
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    mapPackageId: "pmtiles-static",
    // A single PMTiles binding — no protocol-backed sources, so this loads with
    // no Honua server. `sourceType: "raster"` marks the archive as raster tiles.
    sourceBindings: [
      {
        sourceId: "basemap",
        protocol: "pmtiles",
        locator: { url: pmtilesUrl, sourceType: "raster" },
        attribution: "Honua PMTiles sample",
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [
        { id: "backdrop", type: "background", paint: { "background-color": "#0b1021" } },
        { id: "basemap-raster", type: "raster", source: "basemap" },
      ],
    },
    // The fixture archive holds a single z0 tile; start at the world view so it
    // renders without requesting higher zoom levels that are not present.
    initialView: { center: [-122.35, 37.6], zoom: 0 },
  };
}

async function main(): Promise<void> {
  const map = new maplibregl.Map({
    container: "map",
    // Start from an empty style; `loadMapPackage` composes and applies the real
    // one (including auto-registering the pmtiles:// protocol).
    style: { version: 8, sources: {}, layers: [] },
    center: [-122.35, 37.6],
    zoom: 0,
  });

  // `HonuaClient` is required by the runtime contract but never called here —
  // this package has no protocol-backed sources and skips compatibility checks.
  const client = new HonuaClient({ baseUrl: window.location.origin });

  await new Promise<void>((resolve) => map.on("load", () => resolve()));

  const runtime = await loadMapPackage(buildPackage(), map, {
    client,
    skipCompatibilityCheck: true,
  });

  text("protocol-state", isPmtilesProtocolRegistered() ? "pmtiles:// registered" : "not registered");
  text("source-state", runtime.honuaMap.hasSource("basemap") ? "basemap ready" : "missing");
  text("endpoint-state", `Serving ${archiveUrl}`);

  // Inspect the archive metadata through the contract's describe() surface.
  try {
    const info = await describePmtilesArchive(archiveUrl);
    state.archive = info;
    renderArchive(info);
  } catch (error) {
    text("archive-name", `describe() failed: ${(error as Error).message}`);
  }

  state.ready = true;
  window.__HONUA_PMTILES_STATIC_DEMO__ = {
    get ready() {
      return state.ready;
    },
    get protocolRegistered() {
      return isPmtilesProtocolRegistered();
    },
    get hasSource() {
      return runtime.honuaMap.hasSource("basemap");
    },
    get archive() {
      return state.archive;
    },
  };
}

void main();
