/**
 * Experimental hosted-product/control-plane client.
 *
 * Runtime data operations stay on `HonuaClient` and `@honua/sdk-js/runtime`.
 * This subpath owns admin resources such as hosted maps, packages, imports,
 * tokens, workspaces, connections, and sharing, with typed handoff through
 * MapPackage locators and SourceDescriptor-compatible shapes.
 *
 * It also owns the shared application-command layer (`./commands/index.js`):
 * one typed, idempotent command set that the CLI, MCP, Studio, and direct JS
 * all dispatch through, so no surface reimplements domain sequencing or
 * authorization policy.
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
export * from "./commands/index.js";
export {
  assertAdminBaseUrl,
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
  ADMIN_MCP_CONTRACT_SERVER_SHA,
  ADMIN_MCP_CONTRACT_REVIEW_SERVER_SHA,
  ADMIN_MCP_CONTRACT_STATUS,
  ADMIN_MCP_COVERAGE_SHA256,
  ADMIN_MCP_EXCLUDED_OPERATION_COUNT,
  ADMIN_MCP_EXCLUDED_OPERATIONS,
  ADMIN_MCP_EXCLUSION_ROSTER_SHA256,
  ADMIN_MCP_PUBLISHED_TOOL_NAMES,
  ADMIN_OPERATIONS,
  ADMIN_PUBLISHED_OPERATION_COUNT,
  ADMIN_RELEASE_CONTRACT_COMPATIBLE,
  ADMIN_RELEASE_CONTRACT_STATUS,
  ADMIN_RELEASE_OPERATION_COUNT,
  ADMIN_RELEASE_SERVER_SHA,
  MCP_DEFAULT_STATIC_TOOL_COUNT,
  MCP_DEFAULT_TOTAL_TOOL_COUNT,
} from "./generated/admin-operations.js";
export type {
  AdminMcpExcludedOperation,
  AdminMcpPublishedToolName,
  AdminOperationDescriptor,
  AdminOperationId,
} from "./generated/admin-operations.js";
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
