import { coverageToMapLibreImage, createCoverageClient, createWcsClient } from "@honua/sdk-js/coverages";
import { HonuaClient } from "@honua/sdk-js/honua";

import { fixtureFetch } from "./pinned-fixtures.js";
import "./styles.css";

interface CoverageDemoState {
  ready: boolean;
  byteLength?: number;
  wcsCoverageId?: string;
  error?: string;
}

declare global {
  interface Window {
    __HONUA_COVERAGES_WCS__?: CoverageDemoState;
  }
}

const bbox = [-158.1, 21.3, -157.9, 21.5] as const;
const client = new HonuaClient({
  baseUrl: "https://coverages.fixture.invalid",
  fetchFn: fixtureFetch,
});
const source = createCoverageClient(client).source("7");
const wcs = createWcsClient(client, { basePath: "/ogc/services/7/wcs" });
const demoState: CoverageDemoState = { ready: false };
window.__HONUA_COVERAGES_WCS__ = demoState;

async function main(): Promise<void> {
  const [domain, range, coverage, wcsCapabilities, wcsDescriptions] = await Promise.all([
    source.domainSet(),
    source.rangeType(),
    source.coverage({
      bbox,
      properties: ["elevation"],
      scaleSize: { width: 320, height: 220 },
      format: "image/png",
      maxResponseBytes: 1024 * 1024,
    }),
    wcs.capabilities(),
    wcs.describeCoverage(["7"]),
  ]);

  setText("axes", domain.axes.map((axis) => axis.name).join(", "));
  setText("range", range.fields.map((field) => field.title ?? field.name).join(", "));
  const wcsCoverageId = wcsDescriptions[0]?.coverageId;
  if (!wcsCoverageId || !wcsCapabilities.coverageIds.includes(wcsCoverageId)) {
    throw new Error("Pinned WCS discovery did not describe the expected coverage.");
  }
  setText("wcs", `${wcsCapabilities.version} · coverage ${wcsCoverageId}`);

  const projection = coverageToMapLibreImage(coverage, bbox, { sourceId: "elevation" });
  const image = document.querySelector<HTMLImageElement>("#preview");
  if (!image) throw new Error("Coverage preview element is unavailable.");
  image.src = projection.source.url;
  await image.decode();
  setText("status", `${coverage.bytes.byteLength} bytes, ${coverage.contentType}`);
  window.addEventListener("pagehide", projection.dispose, { once: true });
  demoState.byteLength = coverage.bytes.byteLength;
  demoState.wcsCoverageId = wcsCoverageId;
  demoState.ready = true;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  demoState.error = message;
  setText("status", message);
});
