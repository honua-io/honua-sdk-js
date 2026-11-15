import type { ApplyServiceEditsRequest } from "./types.js";

/** Service edits name each layer once, on every transport. */
export function assertDistinctServiceLayers(request: ApplyServiceEditsRequest): void {
  const seen = new Set<number>();
  for (const layer of request.edits) {
    if (seen.has(layer.layerId)) {
      throw new RangeError(`applyServiceEdits names layer ${layer.layerId} more than once.`);
    }
    seen.add(layer.layerId);
  }
}
