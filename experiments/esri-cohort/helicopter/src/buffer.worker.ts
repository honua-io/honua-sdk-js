import { buffer } from "@honua/geometry";
import type { GeoJsonGeometry } from "@honua/geometry";

self.onmessage = (event: MessageEvent<GeoJsonGeometry>) => {
  try {
    const geometry = buffer(event.data, 0.5, "miles");
    if (!geometry) throw new Error("Unable to construct the half-mile search area.");
    self.postMessage({ geometry });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Unable to construct the search area." });
  }
};
