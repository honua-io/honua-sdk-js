import { type RendererAdapter, createHonua } from "./contracts.js";

interface OpenLayersMap {
  getView(): unknown;
}

declare const openlayers: unknown;

const openLayersRenderer: RendererAdapter<"org.openlayers", OpenLayersMap> = {
  kind: "org.openlayers",
  environments: ["browser"],
  peer: openlayers,
};

/** Compile proof: an external adapter keeps its registered identity and raw type. */
export async function thirdPartyRenderer(): Promise<void> {
  const honua = createHonua();
  const data = await honua.connect("https://example.test/ogc/features");
  const map = await data.mount("#map", { renderer: openLayersRenderer });

  map.raw("org.openlayers")?.getView();
  // @ts-expect-error A mounted adapter exposes only its own registered identity.
  map.raw("maplibre");

  await honua.dispose();
}
