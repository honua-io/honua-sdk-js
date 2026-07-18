import type { FakeOlProjectionRegistry } from "./fake-ol.js";

/**
 * Renderer-reported execution fidelity for one view projection, per issue
 * #566 REQ-004. `unsupported` is the fail-closed outcome for an unrecognized
 * CRS: the adapter must refuse the mount rather than silently defaulting to
 * Web Mercator.
 */
export type OpenLayersCrsFidelity = "exact" | "reprojected-equivalent" | "approximate" | "unsupported";

export interface OpenLayersCrsFidelityResult {
  readonly fidelity: OpenLayersCrsFidelity;
  readonly projection: string;
  readonly accuracyMeters?: number;
}

/**
 * Classify how faithfully the injected OpenLayers peer can render the
 * requested view projection:
 *  - `exact`: native OL projection (EPSG:4326 / EPSG:3857), no transform.
 *  - `reprojected-equivalent`: a registered projection with an exact
 *    (proj4-style) transform definition.
 *  - `approximate`: a registered projection whose definition is only a
 *    bounding-box/low-accuracy fit.
 *  - `unsupported`: not registered with this peer at all.
 */
export function classifyOpenLayersCrsFidelity(
  projections: FakeOlProjectionRegistry,
  projectionCode: string,
): OpenLayersCrsFidelityResult {
  const definition = projections.get(projectionCode);
  if (!definition) return { fidelity: "unsupported", projection: projectionCode };
  if (definition.native) return { fidelity: "exact", projection: projectionCode };
  if (definition.approximate) {
    return {
      fidelity: "approximate",
      projection: projectionCode,
      ...(definition.accuracyMeters === undefined ? {} : { accuracyMeters: definition.accuracyMeters }),
    };
  }
  return { fidelity: "reprojected-equivalent", projection: projectionCode };
}
