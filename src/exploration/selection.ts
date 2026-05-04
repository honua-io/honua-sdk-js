/**
 * Selection target helpers for exploration state.
 *
 * Raw feature ids remain valid for single-source apps. Multi-source apps
 * should use source-qualified targets so the same object id in two sources
 * does not collide in map/table/detail synchronization.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import type { FeatureSelectionTarget, SourceQualifiedFeatureSelectionTarget } from "./types.js";

/** Build a serializable source-qualified selection target. */
export function sourceFeatureSelectionTarget(
  sourceId: SourceId,
  id: FeatureId,
  options: { readonly sourceLayer?: string } = {},
): SourceQualifiedFeatureSelectionTarget {
  return {
    sourceId,
    id,
    ...(options.sourceLayer !== undefined ? { sourceLayer: options.sourceLayer } : {}),
  };
}

/** True when a selection target carries source identity. */
export function isSourceQualifiedSelectionTarget(
  target: FeatureSelectionTarget,
): target is SourceQualifiedFeatureSelectionTarget {
  return typeof target === "object" && target !== null && "sourceId" in target && "id" in target;
}

/**
 * Stable key for de-duplicating and comparing selection targets.
 *
 * The key intentionally includes raw-id type and source layer so `"101"`,
 * `101`, and vector-tile sublayer features remain distinct.
 */
export function featureSelectionKey(target: FeatureSelectionTarget): string {
  if (!isSourceQualifiedSelectionTarget(target)) {
    return `id:${typeof target}:${String(target)}`;
  }
  const layer = target.sourceLayer ?? "";
  return `source:${target.sourceId}\u0000layer:${layer}\u0000id:${typeof target.id}:${String(target.id)}`;
}
