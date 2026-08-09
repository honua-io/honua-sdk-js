import { HonuaCoverageError } from "./errors.js";
import type { CoverageMapLibreImage, CoverageResult } from "./types.js";

export function coverageToMapLibreImage(
  coverage: CoverageResult,
  bbox: readonly [number, number, number, number],
  options: { readonly sourceId?: string; readonly layerId?: string } = {},
): CoverageMapLibreImage {
  if (!["image/png", "image/jpeg", "image/webp"].includes(coverage.contentType)) {
    throw new HonuaCoverageError(
      "unsupported-format",
      `MapLibre image sources require PNG, JPEG, or WebP; received ${coverage.contentType}.`,
    );
  }
  if (typeof URL.createObjectURL !== "function") {
    throw new HonuaCoverageError("invalid-request", "MapLibre image projection requires browser object URL support.");
  }
  const [west, south, east, north] = bbox;
  const sourceId = options.sourceId ?? "coverage";
  const buffer = new ArrayBuffer(coverage.bytes.byteLength);
  new Uint8Array(buffer).set(coverage.bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: coverage.contentType }));
  return {
    sourceId,
    source: {
      type: "image",
      url,
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
    },
    layer: { id: options.layerId ?? `${sourceId}-raster`, type: "raster", source: sourceId },
    dispose: () => URL.revokeObjectURL(url),
  };
}
