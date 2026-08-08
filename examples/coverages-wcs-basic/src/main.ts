import { coverageToMapLibreImage, createCoverageClient } from "@honua/sdk-js/coverages";
import { HonuaClient } from "@honua/sdk-js/honua";

import { fixtureFetch } from "./pinned-fixtures.js";
import "./styles.css";

const bbox = [-158.1, 21.3, -157.9, 21.5] as const;
const client = new HonuaClient({
  baseUrl: "https://coverages.fixture.invalid",
  fetchFn: fixtureFetch,
});
const source = createCoverageClient(client).source("7");

async function main(): Promise<void> {
  const [domain, range, coverage] = await Promise.all([
    source.domainSet(),
    source.rangeType(),
    source.coverage({
      bbox,
      properties: ["elevation"],
      scaleSize: { width: 320, height: 220 },
      format: "image/png",
      maxResponseBytes: 1024 * 1024,
    }),
  ]);

  setText("axes", domain.axes.map((axis) => axis.name).join(", "));
  setText("range", range.fields.map((field) => field.title ?? field.name).join(", "));

  const projection = coverageToMapLibreImage(coverage, bbox, { sourceId: "elevation" });
  const image = document.querySelector<HTMLImageElement>("#preview");
  if (image) image.src = projection.source.url;
  setText("status", `${coverage.bytes.byteLength} bytes, ${coverage.contentType}`);
  window.addEventListener("pagehide", projection.dispose, { once: true });
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

void main().catch((error: unknown) => setText("status", error instanceof Error ? error.message : String(error)));
