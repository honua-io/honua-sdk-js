/**
 * Experimental hosted-product/control-plane client.
 *
 * Runtime data operations stay on `HonuaClient` and `@honua/sdk-js/runtime`.
 * This subpath owns admin resources such as hosted maps, packages, imports,
 * tokens, workspaces, connections, and sharing, with typed handoff through
 * MapPackage locators and SourceDescriptor-compatible shapes.
 *
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
export { HONUA_CONTROL_PLANE_BASE_PATH } from "./types.js";
export type {
  HonuaApiToken,
  HonuaApiTokenCreateRequest,
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
