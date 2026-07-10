import { createHonua, maplibreRenderer } from "./contracts.js";

declare const maplibre: unknown;

/** Golden workflow 1: public URL to a useful map in seven application statements. */
export async function publicUrlToMap(): Promise<void> {
  const honua = createHonua();
  const data = await honua.connect("https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer/3");
  const inspection = await data.inspect();
  const map = await data.mount("#map", { renderer: maplibreRenderer(maplibre), style: "auto" });
  await map.ready;
  await honua.dispose();

  void inspection.observation.provenance;
}
