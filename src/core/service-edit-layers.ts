import { HonuaGrpcError } from "./errors.js";
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

/** The native contract returns every request layer in request order. */
export function assertServiceLayerOrder(
  expected: readonly { layerId: number }[],
  actual: readonly { layerId: number }[],
): void {
  const results = actual.map((layer) => layer.layerId);
  const order = results.join(",");
  if (order !== expected.map((layer) => layer.layerId).join(",")) {
    throw new HonuaGrpcError(
      13,
      `ApplyServiceEdits returned layers [${order}] for a request of different layers.`,
      { results },
    );
  }
}
