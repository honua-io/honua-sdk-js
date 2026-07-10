import type { ExplorationContext } from "../../../src/exploration/index.js";
import { createHonua, deckGlRenderer, geoparquetPlugin } from "./contracts.js";

interface Place {
  readonly id: string;
  readonly category: string;
  readonly confidence: number;
}

declare const deck: unknown;
declare const duckdb: unknown;

/** Golden workflow 2: columnar/GPU map plus linked server-side summary. */
export async function largeDataLinkedAnalysis(context: ExplorationContext, awsGeoparquetUrl: URL): Promise<void> {
  const honua = createHonua({ environment: "browser", plugins: [geoparquetPlugin(duckdb)] });
  const places = await honua.connect<Place>({ url: awsGeoparquetUrl, protocol: "geoparquet" });
  const display = await places.explain(
    { returnGeometry: true, outFields: ["id", "category", "confidence"] },
    { format: "columnar", context: context.snapshot() },
  );
  const summary = await places.query(
    {
      aggregation: { groupBy: ["category"], metrics: [{ field: "confidence", fn: "avg", alias: "mean" }] },
      returnGeometry: false,
    },
    { context: context.snapshot() },
  );
  const map = await places.mount("#map", {
    renderer: deckGlRenderer(deck),
    context,
    layers: [{ id: "places", query: display, style: "auto" }],
  });
  await map.ready;

  void summary.execution.observation.provenance;
  await honua.dispose();
}
