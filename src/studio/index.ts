/**
 * `@honua/sdk-js/studio` — browser-safe TypeScript projections, validation and
 * preview envelopes, capability-manifest types, and publish/share/embed
 * contracts for the Studio package families.
 *
 * This barrel is intentionally MCP/QGIS-safe: it exports only types and pure
 * functions and never imports from `operator`, `esri-compat`, `web-components`,
 * `interactions`, or `realtime` (which pull in MapLibre / DOM code). The
 * established `map` and `dashboard`/`app` shapes are re-exported from their
 * leaf modules so consumers reach every family from one import path.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`, and the
 *   stub families may change again when their server contracts ship.
 * @module
 */

export {
  HONUA_ANALYSIS_PACKAGE_FORMAT_V1,
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

export { getCapability, hasCapability } from "./capability-manifest.js";
export type {
  StudioCapabilityConstraint,
  StudioCapabilityEntry,
  StudioCapabilityManifest,
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
