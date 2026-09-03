/**
 * `@honua/sdk-js/studio` — browser-safe TypeScript projections, validation and
 * preview envelopes, capability-manifest types, publish/share/embed
 * contracts, and a full typed package-lifecycle client for the Studio
 * package families.
 *
 * This barrel is intentionally MCP/QGIS-safe: it exports only types, pure
 * functions, and one typed HTTP client built on the SDK's standard
 * {@link HonuaClient} transport, and never imports from `operator`,
 * `esri-compat`, `web-components`, `interactions`, or `realtime` (which pull
 * in MapLibre / DOM code). The established `map` and `app` shapes are
 * re-exported from their leaf modules; the dedicated `dashboard` authoring
 * contract is owned here so consumers reach every family from one import path.
 *
 * {@link HonuaStudioLifecycleClient} (`./lifecycle-client.js`) covers every
 * endpoint in `honua-server`'s Studio package lifecycle API
 * (`/api/v{version}/studio`): package-family discovery, draft CRUD with
 * optimistic-generation checking, validate, preview-plan, immutable content
 * versions and comparisons, publish requests, reopen, and rollback requests.
 * It also enumerates: `contentItems.list()` and `drafts.list()` page the
 * `honua-server#3003` content-browser endpoints with filters, opaque keyset
 * cursors, and a joined publication-registry lifecycle badge per content-item
 * row — plus bounded `listAll()`/`collect()` cursor walks. See that module's
 * doc comment.
 *
 * Publication proposals are submitted, read and polled to a final state
 * through `publicationRequests` — `create`, `get` and a bounded, cancellable
 * `poll` that returns a final publication URL only at `Active`. This surface
 * carries **no** approve/authorize/override capability by design: approval is
 * a separate principal acting through the canonical Admin API/CLI. See
 * `./publication-status.js` for the state machine.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`, and the
 *   stub families may change again when their server contracts ship.
 * @module
 */

export {
  HONUA_ANALYSIS_PACKAGE_FORMAT_V1,
  HONUA_DASHBOARD_PACKAGE_FORMAT_V1,
  HONUA_ETL_PACKAGE_FORMAT_V1,
  HONUA_FORM_PACKAGE_FORMAT_V1,
  HONUA_GP_PACKAGE_FORMAT_V1,
  HONUA_QUERY_PACKAGE_FORMAT_V1,
  HONUA_REPORT_PACKAGE_FORMAT_V1,
  HONUA_WORKFLOW_PACKAGE_FORMAT_V1,
  STUDIO_PACKAGE_FAMILIES,
  isStudioPackageFamily,
  tagStudioPackage,
} from "./types.js";
export type {
  HonuaAnalysisPackage,
  HonuaAnalysisPackageFormat,
  HonuaDashboardPackage,
  HonuaDashboardPackageFormat,
  HonuaETLPackage,
  HonuaETLPackageFormat,
  HonuaFormFieldSpec,
  HonuaFormPackage,
  HonuaFormPackageFormat,
  HonuaGPPackage,
  HonuaGPPackageFormat,
  HonuaGPParameterSpec,
  HonuaQueryPackage,
  HonuaQueryPackageFormat,
  HonuaReportPackage,
  HonuaReportPackageFormat,
  HonuaReportSectionSpec,
  HonuaStudioBindingRef,
  HonuaStudioPackage,
  HonuaStudioPackageBase,
  HonuaStudioPackageFamily,
  HonuaStudioPackageStatus,
  HonuaStudioQuerySpec,
  HonuaWorkflowPackage,
  HonuaWorkflowPackageFormat,
  HonuaWorkflowStepSpec,
  StudioPackageFamilyShapes,
} from "./types.js";

export { fromMapPackageValidation, toStudioValidationResponse } from "./validation.js";
export type {
  StudioPackageDiagnostic,
  StudioPackageDiagnosticSeverity,
  StudioPackagePreviewResponse,
  StudioPackageValidationResponse,
  StudioPreviewArtifactRef,
} from "./validation.js";

export { validatePackageProvenance, validateStudioPackage } from "./validate.js";
export type { ValidateStudioPackageOptions } from "./validate.js";

export { HONUA_PACKAGE_PROVENANCE_FORMAT_V1, getPackageProvenance } from "./provenance.js";
export type {
  HonuaPackageOrigin,
  HonuaPackagePermission,
  HonuaPackageProvenance,
  HonuaPackageProvenanceFormat,
  HonuaPlanProvenance,
  HonuaPlanStep,
  HonuaPromptProvenance,
  HonuaProvenanceDataBinding,
} from "./provenance.js";

export { HONUA_VEGA_LITE_SCHEMA, chartWidgetToVegaLiteSpec } from "./chart-spec.js";
export type {
  HonuaChartEncoding,
  HonuaChartEncodingChannel,
  HonuaChartFieldType,
  HonuaChartMark,
  HonuaVegaLiteChartSpec,
} from "./chart-spec.js";

export {
  getCapability,
  getCapabilityReasonCode,
  hasCapability,
  hasPackageFamily,
  isCapabilitySupported,
} from "./capability-manifest.js";
export type {
  StudioCapabilityAnalysisLimits,
  StudioCapabilityAttachmentLimits,
  StudioCapabilityEditLimits,
  StudioCapabilityEntitlementDecision,
  StudioCapabilityEntry,
  StudioCapabilityEnvironment,
  StudioCapabilityGeometryLimits,
  StudioCapabilityJobLimits,
  StudioCapabilityLimits,
  StudioCapabilityLink,
  StudioCapabilityManifest,
  StudioCapabilityPackageFamily,
  StudioCapabilityPackages,
  StudioCapabilityPolicies,
  StudioCapabilityPreviewLimits,
  StudioCapabilityPublicationLimits,
  StudioCapabilityQueryLimits,
  StudioCapabilityScope,
  StudioCapabilityServerInfo,
  StudioCapabilityStreamingLimits,
  StudioCapabilityTransports,
  StudioCapabilityTransportState,
  StudioCapabilityUploadLimits,
} from "./capability-manifest.js";

export type {
  HonuaShareRequest,
  HonuaShareResponse,
  StudioEmbedConfig,
  StudioPublishRequest,
  StudioPublishResponse,
} from "./publish.js";

// Re-exported established families so `@honua/sdk-js/studio` is the single
// import path for every Studio package projection. These leaf modules carry
// no MapLibre/DOM runtime imports (their cross-module imports are type-only).
export { HONUA_MAP_PACKAGE_FORMAT_V1 } from "../runtime/map-package.js";
export type { HonuaMapPackage, HonuaMapPackageFormat } from "../runtime/map-package.js";
export { HONUA_GENERATED_APP_MANIFEST_FORMAT_V1 } from "../generated-app/manifest.js";
export type { HonuaGeneratedAppManifest, HonuaGeneratedAppPackage } from "../generated-app/manifest.js";

export {
  HONUA_STUDIO_PROBLEM_TYPE,
  HonuaStudioError,
  classifyStudioProblemStatus,
  isHonuaStudioError,
  isHonuaStudioGenerationConflict,
} from "./lifecycle-errors.js";
export type { HonuaStudioProblemDetails, HonuaStudioProblemKind } from "./lifecycle-errors.js";

export {
  STUDIO_PUBLICATION_LIFECYCLE_STATES,
  isStudioPublicationActive,
  isStudioPublicationTerminal,
  normalizeStudioPublicationStatus,
  studioPublicationUrl,
} from "./publication-status.js";

export type {
  StudioApiResponse,
  StudioBindingRef,
  StudioContentItemListOptions,
  StudioContentItemListResponse,
  StudioContentItemListRow,
  StudioContentItemPointers,
  StudioContentItemPublicationBadge,
  StudioContentItemState,
  StudioContentVersion,
  StudioContentVersionListResponse,
  StudioDependencyRef,
  StudioListFilterOptions,
  StudioListPage,
  StudioPackageDraft,
  StudioPackageDraftCreateRequest,
  StudioPackageDraftListOptions,
  StudioPackageDraftListResponse,
  StudioPackageDraftReplaceRequest,
  StudioPackageEnvelope,
  StudioPackageFamilyCapabilities,
  StudioPackageFamilyCapability,
  StudioPackageFamilyOperation,
  StudioPackageFamilySupportLevel,
  StudioPersistenceMode,
  StudioPreviewPlan,
  StudioProvenanceRef,
  StudioPublicationIdentifiers,
  StudioPublicationIntent,
  StudioPublicationLifecycleState,
  StudioPublicationRequest,
  StudioPublicationRequestInput,
  StudioPublicationRequestStatus,
  StudioPublicationRouteLifecycle,
  StudioReopenVersionRequest,
  StudioRollbackPointer,
  StudioRollbackRequest,
  StudioRollbackRequestInput,
  StudioValidationDepth,
  StudioValidationStatus,
  StudioValidationSummary,
  StudioVersionComparison,
  StudioVersionComparisonDiff,
  StudioVersionComparisonRequest,
} from "./lifecycle-types.js";

export {
  HONUA_STUDIO_LIFECYCLE_BASE_PATH,
  HONUA_STUDIO_LIST_DEFAULT_LIMIT,
  HONUA_STUDIO_LIST_MAX_LIMIT,
  HONUA_STUDIO_LIST_MAX_PAGES,
  HONUA_STUDIO_PUBLICATION_POLL_INTERVAL_MS,
  HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS,
  HonuaStudioContentItemsClient,
  HonuaStudioContentVersionsClient,
  HonuaStudioDraftsClient,
  HonuaStudioLifecycleClient,
  HonuaStudioPackageFamiliesClient,
  HonuaStudioPublicationRequestsClient,
  HonuaStudioRollbackRequestsClient,
  createHonuaStudioLifecycleClient,
  isStudioListExhausted,
} from "./lifecycle-client.js";
export type {
  HonuaStudioLifecycleClientOptions,
  HonuaStudioPaginationOptions,
  HonuaStudioPublicationPollOptions,
  HonuaStudioRawRequest,
  HonuaStudioRequestOptions,
  StudioListCollection,
  StudioPublicationPollOutcome,
} from "./lifecycle-client.js";
