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
  AttachmentAdd,
  AttachmentApi,
  AttachmentDelete,
  AttachmentEditOutcome,
  AttachmentGroup,
  AttachmentInfo,
  AttachmentQuery,
  AttachmentUpdate,
  CanonicalFeature,
  Capabilities,
  Capability,
  CapabilityPolicy,
  CreateDatasetOptions,
  Dataset,
  DatasetId,
  DegradedReason,
  EditEnvelope,
  EditOutcome,
  EditResult,
  FeatureId,
  MapBinding,
  PaginationSpec,
  Protocol,
  Query,
  RelatedGroup,
  RelatedQuery,
  RelatedResult,
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
  geoServicesGPServiceSource,
  geoServicesGeometryServiceSource,
  geoServicesImageSource,
  geoServicesMapServiceSource,
  odataSource,
  ogcFeaturesSource,
  ogcTilesSource,
  ogcMapsSource,
  stacSearchSource,
  wfsSource,
  wmsSource,
  wmtsSource,
} from "./source.js";

export type {
  IJobRun,
  JobError,
  JobProgress,
  JobResult,
  JobSnapshot,
  JobSnapshotListener,
  JobStatus,
} from "./jobs.js";
export { isJobTerminal } from "./jobs.js";
