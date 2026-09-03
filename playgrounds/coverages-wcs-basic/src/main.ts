import "maplibre-gl/dist/maplibre-gl.css";
import "./maplibre-vite-worker.js";

import {
  type CoverageMapLibreImage,
  type CoverageResult,
  HonuaCoverageServiceError,
  HonuaWcsExceptionError,
  coverageToMapLibreImage,
  createCoverageClient,
  createWcsClient,
} from "@honua/sdk-js/coverages";
import { HonuaClient } from "@honua/sdk-js/honua";
import * as maplibregl from "maplibre-gl";

import {
  COVERAGE_FIXTURE_CONTRACT,
  ELEVATION_LEGEND,
  FIXTURE_IMAGE_SHA256,
  FIXTURE_ORIGIN,
  FIXTURE_VERSION,
  createPinnedFixtureFetch,
  fixtureRequestLog,
} from "./pinned-fixtures.js";
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
  activeObjectUrl: string | null;
  revokedObjectUrls: readonly string[];
  mapRemoved: boolean;
  sourceCleanupVerified: boolean;
  imageWidth: number | null;
  imageHeight: number | null;
  fixtureDigest: string;
  centerPixelValue: number | null;
  centerPixelColor: readonly number[] | null;
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

const bbox = COVERAGE_FIXTURE_CONTRACT.bbox;
const byteCeiling = COVERAGE_FIXTURE_CONTRACT.maxResponseBytes;
const selectedBand = COVERAGE_FIXTURE_CONTRACT.band;
const client = new HonuaClient({
  baseUrl: FIXTURE_ORIGIN,
  fetchFn: createPinnedFixtureFetch({ maxResponseBytes: byteCeiling }),
});
const coverages = createCoverageClient(client);
const source = coverages.source(COVERAGE_FIXTURE_CONTRACT.collectionId);
const wcs = createWcsClient(client, {
  basePath: `/ogc/services/${COVERAGE_FIXTURE_CONTRACT.collectionId}/wcs`,
});
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
  activeObjectUrl: null,
  revokedObjectUrls: [],
  mapRemoved: false,
  sourceCleanupVerified: false,
  imageWidth: null,
  imageHeight: null,
  fixtureDigest: FIXTURE_IMAGE_SHA256,
  centerPixelValue: null,
  centerPixelColor: null,
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
        bboxCrs: COVERAGE_FIXTURE_CONTRACT.bboxCrs,
        outputCrs: COVERAGE_FIXTURE_CONTRACT.bboxCrs,
        properties: [selectedBand],
        scaleSize: {
          width: COVERAGE_FIXTURE_CONTRACT.width,
          height: COVERAGE_FIXTURE_CONTRACT.height,
        },
        format: COVERAGE_FIXTURE_CONTRACT.format,
        maxResponseBytes: byteCeiling,
        signal,
      }),
      wcs.capabilities({ acceptVersions: ["2.0.1"], acceptFormats: ["application/xml"], signal }),
      wcs.describeCoverage([COVERAGE_FIXTURE_CONTRACT.coverageId], { signal }),
      wcs.getCoverage(COVERAGE_FIXTURE_CONTRACT.coverageId, {
        subsets: [
          { axis: COVERAGE_FIXTURE_CONTRACT.axes.latitude, low: bbox[1], high: bbox[3] },
          { axis: COVERAGE_FIXTURE_CONTRACT.axes.longitude, low: bbox[0], high: bbox[2] },
        ],
        subsettingCrs: COVERAGE_FIXTURE_CONTRACT.wcsCrs,
        outputCrs: COVERAGE_FIXTURE_CONTRACT.wcsCrs,
        rangeSubset: [selectedBand],
        scaleSize: {
          [COVERAGE_FIXTURE_CONTRACT.axes.latitude]: COVERAGE_FIXTURE_CONTRACT.height,
          [COVERAGE_FIXTURE_CONTRACT.axes.longitude]: COVERAGE_FIXTURE_CONTRACT.width,
        },
        format: COVERAGE_FIXTURE_CONTRACT.format,
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
  if (!equalBytes(ogcCoverage.bytes, wcsCoverage.bytes)) {
    throw new Error("OGC API Coverages and WCS fixture bytes diverged.");
  }

  const pixel = await inspectCenterPixel(ogcCoverage);
  renderLegend();

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
  setText("pixel-value", `${pixel.value} m`);
  setText("pixel-coordinate", `${((bbox[0] + bbox[2]) / 2).toFixed(4)}, ${((bbox[1] + bbox[3]) / 2).toFixed(4)}`);
  setText("fixture-version", FIXTURE_VERSION);
  setText("ogc-request", compactRequest(ogcCoverage.requestUrl));
  setText("wcs-request", compactRequest(wcsCoverage.requestUrl));

  demoState.collectionId = collection.id;
  demoState.ogcRequestUrl = ogcCoverage.requestUrl;
  demoState.wcsRequestUrl = wcsCoverage.requestUrl;
  demoState.ogcByteLength = ogcCoverage.bytes.byteLength;
  demoState.wcsByteLength = wcsCoverage.bytes.byteLength;
  demoState.imageWidth = pixel.width;
  demoState.imageHeight = pixel.height;
  demoState.centerPixelValue = pixel.value;
  demoState.centerPixelColor = pixel.color;
  refreshRequestEvidence();
  demoState.phase = "ready";
  demoState.ready = true;
  setInteractive(true);
}

function selectProtocol(protocol: CoverageProtocol): void {
  if (demoState.disposed) return;
  const coverage = coverageResults.get(protocol);
  if (!coverage) return;

  releaseActiveProjection();

  activeProjection = coverageToMapLibreImage(coverage, bbox, {
    sourceId: `${protocol}-elevation`,
    layerId: `${protocol}-elevation-raster`,
  });
  const imageSource = activeProjection.source as maplibregl.ImageSourceSpecification;
  map.addSource(activeProjection.sourceId, imageSource);
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
  demoState.activeObjectUrl = imageSource.url;
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
  setText(
    "safety-status",
    `Requesting the ${activeProtocol.toUpperCase()} quality band, then aborting it before the fixture responds...`,
  );
  const controller = new AbortController();
  const pending = requestCancellableCoverage(activeProtocol, controller.signal);
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
  setText(
    "safety-status",
    `Asking ${activeProtocol.toUpperCase()} for ${COVERAGE_FIXTURE_CONTRACT.degradationBand}...`,
  );
  try {
    await requestInvalidBand(activeProtocol);
    throw new Error("Degradation proof unexpectedly completed.");
  } catch (error) {
    const code = degradationCode(activeProtocol, error);
    demoState.degradationCount += 1;
    demoState.phase = "degraded";
    refreshRequestEvidence();
    setText(
      "safety-status",
      `${code}: ${activeProtocol.toUpperCase()} rejected the unknown band. The ${activeProtocol.toUpperCase()} elevation raster remains visible.`,
    );
    return { status: "degraded", code, activeProtocol };
  }
}

function requestCancellableCoverage(protocol: CoverageProtocol, signal: AbortSignal): Promise<CoverageResult> {
  if (protocol === "ogc") {
    return source.coverage({
      bbox,
      bboxCrs: COVERAGE_FIXTURE_CONTRACT.bboxCrs,
      outputCrs: COVERAGE_FIXTURE_CONTRACT.bboxCrs,
      properties: [COVERAGE_FIXTURE_CONTRACT.cancellationBand],
      scaleSize: {
        width: COVERAGE_FIXTURE_CONTRACT.cancellationSize,
        height: COVERAGE_FIXTURE_CONTRACT.cancellationSize,
      },
      format: COVERAGE_FIXTURE_CONTRACT.format,
      maxResponseBytes: byteCeiling,
      signal,
    });
  }
  return wcs.getCoverage(COVERAGE_FIXTURE_CONTRACT.coverageId, {
    subsets: [
      { axis: COVERAGE_FIXTURE_CONTRACT.axes.latitude, low: bbox[1], high: bbox[3] },
      { axis: COVERAGE_FIXTURE_CONTRACT.axes.longitude, low: bbox[0], high: bbox[2] },
    ],
    subsettingCrs: COVERAGE_FIXTURE_CONTRACT.wcsCrs,
    outputCrs: COVERAGE_FIXTURE_CONTRACT.wcsCrs,
    rangeSubset: [COVERAGE_FIXTURE_CONTRACT.cancellationBand],
    scaleSize: {
      [COVERAGE_FIXTURE_CONTRACT.axes.latitude]: COVERAGE_FIXTURE_CONTRACT.cancellationSize,
      [COVERAGE_FIXTURE_CONTRACT.axes.longitude]: COVERAGE_FIXTURE_CONTRACT.cancellationSize,
    },
    format: COVERAGE_FIXTURE_CONTRACT.format,
    maxResponseBytes: byteCeiling,
    signal,
  });
}

function requestInvalidBand(protocol: CoverageProtocol): Promise<CoverageResult> {
  if (protocol === "ogc") {
    return source.coverage({
      bbox,
      bboxCrs: COVERAGE_FIXTURE_CONTRACT.bboxCrs,
      outputCrs: COVERAGE_FIXTURE_CONTRACT.bboxCrs,
      properties: [COVERAGE_FIXTURE_CONTRACT.degradationBand],
      scaleSize: {
        width: COVERAGE_FIXTURE_CONTRACT.cancellationSize,
        height: COVERAGE_FIXTURE_CONTRACT.cancellationSize,
      },
      format: COVERAGE_FIXTURE_CONTRACT.format,
      maxResponseBytes: byteCeiling,
    });
  }
  return wcs.getCoverage(COVERAGE_FIXTURE_CONTRACT.coverageId, {
    subsets: [
      { axis: COVERAGE_FIXTURE_CONTRACT.axes.latitude, low: bbox[1], high: bbox[3] },
      { axis: COVERAGE_FIXTURE_CONTRACT.axes.longitude, low: bbox[0], high: bbox[2] },
    ],
    subsettingCrs: COVERAGE_FIXTURE_CONTRACT.wcsCrs,
    outputCrs: COVERAGE_FIXTURE_CONTRACT.wcsCrs,
    rangeSubset: [COVERAGE_FIXTURE_CONTRACT.degradationBand],
    scaleSize: {
      [COVERAGE_FIXTURE_CONTRACT.axes.latitude]: COVERAGE_FIXTURE_CONTRACT.cancellationSize,
      [COVERAGE_FIXTURE_CONTRACT.axes.longitude]: COVERAGE_FIXTURE_CONTRACT.cancellationSize,
    },
    format: COVERAGE_FIXTURE_CONTRACT.format,
    maxResponseBytes: byteCeiling,
  });
}

function degradationCode(protocol: CoverageProtocol, error: unknown): string {
  if (protocol === "wcs" && error instanceof HonuaWcsExceptionError) return error.exceptionCode;
  if (protocol === "ogc" && error instanceof HonuaCoverageServiceError && error.statusCode === 400) {
    const bodyCode =
      typeof error.body === "object" && error.body !== null ? Reflect.get(error.body, "code") : undefined;
    return typeof bodyCode === "string" ? bodyCode : error.code;
  }
  throw error;
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function inspectCenterPixel(coverage: CoverageResult): Promise<{
  readonly width: number;
  readonly height: number;
  readonly value: number;
  readonly color: readonly number[];
}> {
  const bytes = Uint8Array.from(coverage.bytes);
  const bitmap = await createImageBitmap(new Blob([bytes.buffer], { type: coverage.contentType }));
  try {
    if (bitmap.width !== COVERAGE_FIXTURE_CONTRACT.width || bitmap.height !== COVERAGE_FIXTURE_CONTRACT.height) {
      throw new Error(`Pinned image dimensions drifted to ${bitmap.width} x ${bitmap.height}.`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas pixel inspection is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const pixel = context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data;
    const match = ELEVATION_LEGEND.find(
      (entry) => entry.color[0] === pixel[0] && entry.color[1] === pixel[1] && entry.color[2] === pixel[2],
    );
    if (!match || pixel[3] !== 255) {
      throw new Error(`Center pixel does not match the explicit elevation legend: ${[...pixel].join(",")}`);
    }
    document
      .querySelector<HTMLElement>(".pixel-dot")
      ?.style.setProperty("background", `rgb(${match.color.join(", ")})`);
    return { width: bitmap.width, height: bitmap.height, value: match.value, color: [...match.color] };
  } finally {
    bitmap.close();
  }
}

function renderLegend(): void {
  const ramp = document.getElementById("legend-ramp");
  const labels = document.getElementById("legend-labels");
  if (!ramp || !labels) return;
  ramp.replaceChildren(
    ...ELEVATION_LEGEND.map((entry) => {
      const swatch = document.createElement("span");
      swatch.style.background = `rgb(${entry.color.join(", ")})`;
      return swatch;
    }),
  );
  labels.replaceChildren(
    ...ELEVATION_LEGEND.map((entry) => {
      const label = document.createElement("span");
      label.textContent = `${entry.value} m`;
      return label;
    }),
  );
}

function releaseActiveProjection(): void {
  if (!activeProjection) return;
  const objectUrl = demoState.activeObjectUrl;
  const sourceId = activeProjection.sourceId;
  if (map.getLayer(activeProjection.layer.id)) map.removeLayer(activeProjection.layer.id);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  demoState.sourceCleanupVerified = !map.getSource(sourceId);
  activeProjection.dispose();
  activeProjection = undefined;
  demoState.mapSourceId = null;
  demoState.activeObjectUrl = null;
  if (objectUrl) demoState.revokedObjectUrls = [...demoState.revokedObjectUrls, objectUrl];
}

function dispose(): void {
  if (demoState.disposed) return;
  demoState.disposed = true;
  demoState.ready = false;
  bootController.abort("Coverage sample disposed");
  releaseActiveProjection();
  map.remove();
  demoState.mapRemoved = true;
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
