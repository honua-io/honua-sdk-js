/**
 * ArcGIS `SnappingOptions`-shaped compat surface, mapped onto the
 * renderer-neutral `SnappingConfig` from `contract/edit-snapping.ts`.
 *
 * @module
 */

import {
  DEFAULT_SNAPPING_CONFIG,
  type SnapCandidateKind,
  type SnappingConfig,
  resolveSnappingConfig,
} from "../contract/edit-snapping.js";

/** ArcGIS `FeatureSnappingLayerSource`-shaped entry. */
export interface SnappingFeatureSourceCompat {
  /** Layer (or layer-like object) providing snap features. */
  layer?: unknown;
  /** Explicit Honua source id when no layer id is derivable. */
  id?: string;
  /** @default true */
  enabled?: boolean;
}

/** ArcGIS `SnappingOptions`-shaped configuration accepted by the shims. */
export interface SnappingOptionsCompat {
  /** Master switch. ArcGIS defaults snapping off. @default false */
  enabled?: boolean;
  /** Snap distance in pixels; maps to `SnappingConfig.tolerance`. */
  distance?: number;
  /** Snap to features from `featureSources`. @default true */
  featureEnabled?: boolean;
  /**
   * Snap to the geometry being drawn. Stored for parity; self snapping is a
   * runtime concern (index the active sketch source to approximate it).
   * @default true
   */
  selfEnabled?: boolean;
  featureSources?: readonly SnappingFeatureSourceCompat[];
}

/**
 * Map ArcGIS-shaped snapping options to the contract `SnappingConfig`.
 *
 * `distance` maps to pixel tolerance; `featureSources` map to per-source
 * enablement keyed by `source.id` (falling back to a duck-typed `layer.id` /
 * `layer.sourceId`); `featureEnabled: false` disables every listed source.
 * Vertex and edge candidates are enabled — matching ArcGIS 2D snapping,
 * which always resolves both.
 */
export function snappingOptionsToSnappingConfig(options: SnappingOptionsCompat = {}): SnappingConfig {
  const kinds: SnapCandidateKind[] = ["vertex", "edge"];
  const sources: Record<string, boolean> = {};
  for (const featureSource of options.featureSources ?? []) {
    const sourceId = featureSourceId(featureSource);
    if (sourceId === undefined) continue;
    sources[sourceId] = options.featureEnabled === false ? false : (featureSource.enabled ?? true);
  }
  return resolveSnappingConfig({
    enabled: options.enabled ?? false,
    tolerance: options.distance ?? DEFAULT_SNAPPING_CONFIG.tolerance,
    kinds,
    sources,
  });
}

function featureSourceId(featureSource: SnappingFeatureSourceCompat): string | undefined {
  if (featureSource.id !== undefined) return featureSource.id;
  const layer = featureSource.layer;
  if (layer && typeof layer === "object") {
    const candidate = layer as { id?: unknown; sourceId?: unknown };
    if (typeof candidate.id === "string") return candidate.id;
    if (typeof candidate.sourceId === "string") return candidate.sourceId;
  }
  return undefined;
}
