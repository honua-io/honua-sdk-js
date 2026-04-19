/**
 * Shared client contract — canonical types and source factories that all
 * protocol adapters speak. Re-exported from `@honua/sdk-js/contract`.
 *
 * The runtime classes in `src/core/surfaces.ts` remain the implementation;
 * this module is the protocol-neutral vocabulary layered over them. See
 * `docs/shared-client-contract.md` for the full design.
 *
 * @module
 */

export type {
  AdapterFor,
  AdapterKind,
  AdapterTypeMap,
  AggregationFn,
  AggregationMetric,
  AggregationSpec,
  Capabilities,
  Capability,
  CapabilityPolicy,
  CreateDatasetOptions,
  Dataset,
  DatasetId,
  DegradedReason,
  FeatureId,
  MapBinding,
  PaginationSpec,
  Protocol,
  Query,
  ResolveSourceContext,
  Result,
  SortSpec,
  Source,
  SourceDescriptor,
  SourceId,
  SourceLocator,
  SourceResolver,
  SourceSchema,
} from "./types.js";

export {
  CAPABILITIES,
  PROTOCOL_DEFAULT_CAPABILITIES,
  PROTOCOLS,
  capabilities,
} from "./types.js";

export {
  ALL_CAPABILITIES,
  FIRST_PARTY_PROTOCOLS,
  createDataset,
  geoServicesFeatureSource,
  geoServicesMapServiceSource,
  ogcFeaturesSource,
} from "./source.js";
