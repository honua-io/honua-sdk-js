/**
 * Experimental hosted-product/control-plane client.
 *
 * Runtime data operations stay on `HonuaClient` and `@honua/sdk-js/runtime`.
 * This subpath owns admin resources such as hosted maps, packages, imports,
 * tokens, workspaces, connections, and sharing, with typed handoff through
 * MapPackage locators and SourceDescriptor-compatible shapes.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export {
  HonuaApiTokensClient,
  HonuaConnectionsClient,
  HonuaControlPlaneClient,
  HonuaControlPlaneJobHandle,
  HonuaHostedMapsClient,
  HonuaImportsClient,
  HonuaMapPackagesClient,
  HonuaSharingClient,
  HonuaWorkspacesClient,
  createHonuaControlPlane,
} from "./client.js";
export type { HonuaControlPlaneClientOptions } from "./client.js";
export {
  HonuaAdminApiError,
  HonuaAdminClient,
  createHonuaAdminClient,
} from "./admin-client.js";
export type {
  AdminClientOptions,
  AdminOperationContentType,
  AdminOperationRequest,
  AdminOperationRequestBody,
  AdminOperationResponse,
  AdminOperationResult,
} from "./admin-client.js";
export {
  ADMIN_API_BASE_PATH,
  ADMIN_API_OPERATION_COUNT,
  ADMIN_API_SERVER_SHA,
  ADMIN_API_SPEC_SHA256,
  ADMIN_OPERATIONS,
  ADMIN_PUBLISHED_OPERATION_COUNT,
  ADMIN_RELEASE_CONTRACT_COMPATIBLE,
  ADMIN_RELEASE_CONTRACT_STATUS,
  ADMIN_RELEASE_OPERATION_COUNT,
  ADMIN_RELEASE_SERVER_SHA,
} from "./generated/admin-operations.js";
export type { AdminOperationDescriptor, AdminOperationId } from "./generated/admin-operations.js";
export type { components as AdminApiComponents, operations as AdminApiOperations } from "./generated/admin-api.js";
export type { StudioCapabilityManifest } from "../studio/capability-manifest.js";
export { HONUA_CAPABILITY_MANIFEST_PATH, HONUA_CONTROL_PLANE_BASE_PATH } from "./types.js";
export type {
  HonuaApiToken,
  HonuaApiTokenCreateRequest,
  HonuaCapabilityManifestOptions,
  HonuaConnectionSummary,
  HonuaControlPlaneCapability,
  HonuaControlPlaneJob,
  HonuaControlPlaneJobStatus,
  HonuaControlPlaneLinks,
  HonuaControlPlaneListOptions,
  HonuaControlPlanePage,
  HonuaControlPlaneRawRequest,
  HonuaControlPlaneRequestOptions,
  HonuaControlPlaneResult,
  HonuaControlPlaneSourceDescriptor,
  HonuaControlPlaneSuccess,
  HonuaControlPlaneUnsupported,
  HonuaCreateHostedMapRequest,
  HonuaEntityValidators,
  HonuaHostedMap,
  HonuaHostedMapSummary,
  HonuaImportCreateRequest,
  HonuaMapPackageSummary,
  HonuaProblemDetails,
  HonuaPublishMapPackageRequest,
  HonuaPublishMapPackageResponse,
  HonuaShareRequest,
  HonuaShareResponse,
  HonuaUpdateHostedMapRequest,
  HonuaWorkspaceSummary,
} from "./types.js";
