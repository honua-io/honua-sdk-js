/**
 * Protocol-default filter constraints for the `query` capability.
 *
 * These are the operators and predicates each built-in adapter can prove it
 * lowers exactly onto its wire dialect today — the same truth the generated
 * protocol-capability matrix publishes, expressed in the `CapabilityConstraints`
 * vocabulary so discovery can attach it as `protocol-default` evidence and the
 * canonical filter gate can enforce it per source.
 *
 * They are a *default*, not a ceiling: observed evidence (a WFS
 * `FilterCapabilities` document, a GeoServices layer's
 * `supportedSpatialRelationships`) narrows them further when a caller supplies
 * it, and a protocol absent from this table attaches no constraints at all
 * rather than an empty allow list, because "no table entry" means "no evidence",
 * not "nothing is supported".
 *
 * `config/support-manifest.v1.json` is the reviewed source of the same truth;
 * `test/source-capability-filter-constraints.test.ts` gates the two against
 * drift.
 *
 * @module
 */

import type {
  CapabilityConstraints,
  FilterOperatorId,
  SpatialPredicate,
  TemporalPredicate,
} from "./source-capability-types.js";

/** Attribute and boolean operators every filtering adapter compiles exactly. */
const ATTRIBUTE_OPERATORS: readonly FilterOperatorId[] = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "between",
  "is-null",
  "is-not-null",
  "like",
  "and",
  "or",
  "not",
];

/** Topological predicates a dialect can express without widening the result. */
const TOPOLOGICAL_PREDICATES: readonly SpatialPredicate[] = [
  "intersects",
  "contains",
  "within",
  "crosses",
  "touches",
  "overlaps",
  "bbox-intersects",
];

/** Only an intersects-shaped predicate survives a bbox or `geo.intersects` lowering. */
const INTERSECTS_ONLY: readonly SpatialPredicate[] = ["intersects", "bbox-intersects"];

const ALL_TEMPORAL: readonly TemporalPredicate[] = ["before", "after", "during", "time-intersects"];

function constraints(
  spatialPredicates: readonly SpatialPredicate[],
  temporalPredicates: readonly TemporalPredicate[] = ALL_TEMPORAL,
): CapabilityConstraints {
  return {
    filterOperators: [...ATTRIBUTE_OPERATORS, ...spatialPredicates, ...temporalPredicates],
    spatialPredicates,
    temporalPredicates,
  };
}

/**
 * Per-protocol defaults for the `query` capability. Protocols with no
 * filterable query surface (render-only tile/map adapters, WMS GetFeatureInfo,
 * the geometry and geoprocessing services) are deliberately absent.
 */
export const PROTOCOL_QUERY_FILTER_CONSTRAINTS: Readonly<Record<string, CapabilityConstraints>> = Object.freeze({
  grpc: constraints(TOPOLOGICAL_PREDICATES),
  "geoservices-feature-service": constraints(TOPOLOGICAL_PREDICATES),
  "geoservices-map-service": constraints(TOPOLOGICAL_PREDICATES),
  // The ImageServer raster catalog accepts no geometry parameters at all.
  "geoservices-image-service": constraints([]),
  "ogc-features": constraints(TOPOLOGICAL_PREDICATES),
  "ogc-records": constraints(TOPOLOGICAL_PREDICATES),
  stac: constraints(TOPOLOGICAL_PREDICATES),
  wfs: constraints(TOPOLOGICAL_PREDICATES),
  // OData v4 standardizes only `geo.intersects`.
  odata: constraints(INTERSECTS_ONLY),
  // GeoParquet pushes spatial predicates down as a bbox, which only preserves
  // intersects semantics.
  geoparquet: constraints(INTERSECTS_ONLY),
});

/** Protocol-default `query` constraints, or `undefined` when the protocol has no filter surface. */
export function protocolQueryFilterConstraints(protocol: string): CapabilityConstraints | undefined {
  return Object.hasOwn(PROTOCOL_QUERY_FILTER_CONSTRAINTS, protocol)
    ? PROTOCOL_QUERY_FILTER_CONSTRAINTS[protocol]
    : undefined;
}
