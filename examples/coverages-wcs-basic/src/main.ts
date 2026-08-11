import "maplibre-gl/dist/maplibre-gl.css";
import "../../shared/maplibre-vite-worker.js";

import {
  type CoverageMapLibreImage,
  type CoverageResult,
  HonuaWcsExceptionError,
  coverageToMapLibreImage,
  createCoverageClient,
  createWcsClient,
} from "@honua/sdk-js/coverages";
import { HonuaClient } from "@honua/sdk-js/honua";
import * as maplibregl from "maplibre-gl";

import { CENTER_PIXEL, FIXTURE_ORIGIN, FIXTURE_VERSION, fixtureFetch, fixtureRequestLog } from "./pinned-fixtures.js";
import "./styles.css";

type CoverageProtocol = "ogc" | "wcs";

interface CoverageDemoState {
  ready: boolean;
  disposed: boolean;
  phase: "loading" | "ready" | "degraded" | "error";
  activeProtocol: CoverageProtocol | null;
  collectionId: string | null;
  selectedBand: string;
  mapSourceId: string | null;
  ogcRequestUrl: string | null;
  wcsRequestUrl: string | null;
  ogcByteLength: number | null;
  wcsByteLength: number | null;
  requestCount: number;
  requests: readonly string[];
  cancellationCount: number;
  degradationCount: number;
  error: string | null;
  selectProtocol(protocol: CoverageProtocol): void;
  proveCancellation(): Promise<{ readonly status: "cancelled"; readonly activeProtocol: CoverageProtocol }>;
  proveDegradation(): Promise<{
    readonly status: "degraded";
    readonly code: string;
    readonly activeProtocol: CoverageProtocol;
  }>;
  dispose(): void;
}

declare global {
  interface Window {
    __HONUA_COVERAGES_WCS__?: CoverageDemoState;
    __honuaMaps?: maplibregl.Map[];
  }
}

const bbox = [-158.1, 21.3, -157.9, 21.5] as const;
const byteCeiling = 1024 * 1024;
const selectedBand = "elevation";
const client = new HonuaClient({ baseUrl: FIXTURE_ORIGIN, fetchFn: fixtureFetch });
const coverages = createCoverageClient(client);
const source = coverages.source("7");
const wcs = createWcsClient(client, { basePath: "/ogc/services/7/wcs" });
const bootController = new AbortController();
const coverageResults = new Map<CoverageProtocol, CoverageResult>();
let activeProjection: CoverageMapLibreImage | undefined;

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "paper", type: "background", paint: { "background-color": "#d7e0d1" } }],
  },
  center: [-158, 21.4],
  zoom: 9.6,
  attributionControl: false,
  pitchWithRotate: false,
  dragRotate: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
window.__honuaMaps = [map];

const mapLoaded = new Promise<void>((resolve) => map.once("load", () => resolve()));
const demoState: CoverageDemoState = {
  ready: false,
  disposed: false,
  phase: "loading",
  activeProtocol: null,
  collectionId: null,
  selectedBand,
  mapSourceId: null,
  ogcRequestUrl: null,
  wcsRequestUrl: null,
  ogcByteLength: null,
  wcsByteLength: null,
  requestCount: 0,
  requests: [],
  cancellationCount: 0,
  degradationCount: 0,
  error: null,
  selectProtocol,
  proveCancellation,
  proveDegradation,
  dispose,
};
window.__HONUA_COVERAGES_WCS__ = demoState;

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-protocol]")) {
  button.addEventListener("click", () => {
    const protocol = button.dataset.protocol;
    if (protocol === "ogc" || protocol === "wcs") selectProtocol(protocol);
  });
}
document.querySelector<HTMLButtonElement>("#cancel-proof")?.addEventListener("click", () => {
  void proveCancellation();
});
document.querySelector<HTMLButtonElement>("#degrade-proof")?.addEventListener("click", () => {
  void proveDegradation();
});
window.addEventListener("pagehide", dispose, { once: true });

async function main(): Promise<void> {
  const signal = bootController.signal;
  const [collections, collection, domain, range, ogcCoverage, wcsCapabilities, wcsDescriptions, wcsCoverage] =
    await Promise.all([
      coverages.collections({ signal }),
      source.collection({ signal }),
      source.domainSet({ signal }),
      source.rangeType({ signal }),
      source.coverage({
        bbox,
        bboxCrs: "EPSG:4326",
        outputCrs: "EPSG:4326",
        properties: [selectedBand],
        scaleSize: { width: 320, height: 220 },
        format: "image/png",
        maxResponseBytes: byteCeiling,
        signal,
      }),
      wcs.capabilities({ acceptVersions: ["2.0.1"], acceptFormats: ["application/xml"], signal }),
      wcs.describeCoverage(["7"], { signal }),
      wcs.getCoverage("7", {
        subsets: [
          { axis: "Lat", low: bbox[1], high: bbox[3] },
          { axis: "Long", low: bbox[0], high: bbox[2] },
        ],
        subsettingCrs: "http://www.opengis.net/def/crs/EPSG/0/4326",
        outputCrs: "http://www.opengis.net/def/crs/EPSG/0/4326",
        rangeSubset: [selectedBand],
        scaleSize: { Lat: 220, Long: 320 },
        format: "image/png",
        maxResponseBytes: byteCeiling,
        signal,
      }),
    ]);

  const wcsDescription = wcsDescriptions[0];
  if (!collections.collections.some((candidate) => candidate.id === collection.id)) {
    throw new Error("Pinned collection discovery did not include the selected collection.");
  }
  if (!range.fields.some((field) => field.name === selectedBand)) {
    throw new Error("Pinned OGC range metadata did not include the elevation band.");
  }
  if (!wcsDescription || !wcsCapabilities.coverageIds.includes(wcsDescription.coverageId)) {
    throw new Error("Pinned WCS discovery did not describe the expected coverage.");
  }
  if (!wcsDescription.fields.some((field) => field.name === selectedBand)) {
    throw new Error("Pinned WCS range metadata did not include the elevation band.");
  }

  coverageResults.set("ogc", ogcCoverage);
  coverageResults.set("wcs", wcsCoverage);
  await mapLoaded;
  selectProtocol("ogc");

  setText("collection", `${collection.id} / ${collection.title ?? "Untitled coverage"}`);
  setText("axes", domain.axes.map((axis) => axis.name).join(" x "));
  setText("range", range.fields.map((field) => field.title ?? field.name).join(", "));
  setText(
    "wcs",
    `${wcsCapabilities.version} / ${wcsDescription.axisLabels.join(" x ")} / ${wcsDescription.fields
      .map((field) => field.name)
      .join(", ")}`,
  );
  setText("pixel-value", `${CENTER_PIXEL.value} ${CENTER_PIXEL.unit}`);
  setText("pixel-coordinate", CENTER_PIXEL.coordinate.map((value) => value.toFixed(4)).join(", "));
  setText("fixture-version", FIXTURE_VERSION);
  setText("ogc-request", compactRequest(ogcCoverage.requestUrl));
  setText("wcs-request", compactRequest(wcsCoverage.requestUrl));

  demoState.collectionId = collection.id;
  demoState.ogcRequestUrl = ogcCoverage.requestUrl;
  demoState.wcsRequestUrl = wcsCoverage.requestUrl;
  demoState.ogcByteLength = ogcCoverage.bytes.byteLength;
  demoState.wcsByteLength = wcsCoverage.bytes.byteLength;
  refreshRequestEvidence();
  demoState.phase = "ready";
  demoState.ready = true;
  setInteractive(true);
}

function selectProtocol(protocol: CoverageProtocol): void {
  if (demoState.disposed) return;
  const coverage = coverageResults.get(protocol);
  if (!coverage || !map.loaded()) return;

  if (activeProjection) {
    if (map.getLayer(activeProjection.layer.id)) map.removeLayer(activeProjection.layer.id);
    if (map.getSource(activeProjection.sourceId)) map.removeSource(activeProjection.sourceId);
    activeProjection.dispose();
  }

  activeProjection = coverageToMapLibreImage(coverage, bbox, {
    sourceId: `${protocol}-elevation`,
    layerId: `${protocol}-elevation-raster`,
  });
  map.addSource(activeProjection.sourceId, activeProjection.source as maplibregl.ImageSourceSpecification);
  map.addLayer({ ...activeProjection.layer });
  map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    { padding: 28, duration: 0 },
  );

  demoState.activeProtocol = protocol;
  demoState.mapSourceId = activeProjection.sourceId;
  setText("active-protocol", protocol === "ogc" ? "OGC API image source" : "WCS image source");
  setText("response", `${coverage.bytes.byteLength.toLocaleString()} bytes / ${coverage.contentType}`);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-protocol]")) {
    button.setAttribute("aria-pressed", String(button.dataset.protocol === protocol));
  }
}

async function proveCancellation(): Promise<{
  readonly status: "cancelled";
  readonly activeProtocol: CoverageProtocol;
}> {
  const activeProtocol = requireActiveProtocol();
  setText("safety-status", "Requesting the quality band, then aborting it before the fixture responds...");
  const controller = new AbortController();
  const pending = source.coverage({
    bbox,
    properties: ["quality"],
    scaleSize: { width: 64, height: 64 },
    format: "image/png",
    maxResponseBytes: byteCeiling,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort("Superseded fixture request");
  try {
    await pending;
    throw new Error("Cancellation proof unexpectedly completed.");
  } catch (error) {
    if (!(error instanceof Error) || !["AbortError", "HonuaAbortError"].includes(error.name)) throw error;
  }
  demoState.cancellationCount += 1;
  refreshRequestEvidence();
  setText("safety-status", `Cancelled safely. The ${activeProtocol.toUpperCase()} elevation raster stayed mounted.`);
  return { status: "cancelled", activeProtocol };
}

async function proveDegradation(): Promise<{
  readonly status: "degraded";
  readonly code: string;
  readonly activeProtocol: CoverageProtocol;
}> {
  const activeProtocol = requireActiveProtocol();
  setText("safety-status", "Asking WCS for rangeSubset=not-a-band...");
  try {
    await wcs.getCoverage("7", {
      subsets: [
        { axis: "Lat", low: bbox[1], high: bbox[3] },
        { axis: "Long", low: bbox[0], high: bbox[2] },
      ],
      rangeSubset: ["not-a-band"],
      scaleSize: { Lat: 64, Long: 64 },
      format: "image/png",
      maxResponseBytes: byteCeiling,
    });
    throw new Error("Degradation proof unexpectedly completed.");
  } catch (error) {
    if (!(error instanceof HonuaWcsExceptionError)) throw error;
    demoState.degradationCount += 1;
    demoState.phase = "degraded";
    refreshRequestEvidence();
    setText(
      "safety-status",
      `${error.exceptionCode}: WCS rejected the unknown band. The ${activeProtocol.toUpperCase()} elevation raster remains visible.`,
    );
    return { status: "degraded", code: error.exceptionCode, activeProtocol };
  }
}

function refreshRequestEvidence(): void {
  demoState.requestCount = fixtureRequestLog.length;
  demoState.requests = fixtureRequestLog.map((entry) => entry.url);
}

function requireActiveProtocol(): CoverageProtocol {
  if (!demoState.activeProtocol) throw new Error("Coverage sample is not ready.");
  return demoState.activeProtocol;
}

function setInteractive(enabled: boolean): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-protocol], #cancel-proof, #degrade-proof")) {
    button.disabled = !enabled;
  }
}

function compactRequest(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function dispose(): void {
  if (demoState.disposed) return;
  demoState.disposed = true;
  demoState.ready = false;
  bootController.abort("Coverage sample disposed");
  activeProjection?.dispose();
  activeProjection = undefined;
  map.remove();
  window.__honuaMaps = [];
  setInteractive(false);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  demoState.error = message;
  demoState.phase = "error";
  demoState.ready = true;
  setText("active-protocol", "Coverage unavailable");
  setText("safety-status", message);
});
