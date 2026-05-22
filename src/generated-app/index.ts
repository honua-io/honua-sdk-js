/**
 * `@honua/sdk-js/generated-app` — browser-safe manifest projection and
 * runtime for the generated operations-dashboard proof slice.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export {
  HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND,
  HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION,
  HONUA_GENERATED_APP_MANIFEST_FORMAT_V1,
  HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1,
} from "./manifest.js";
export type {
  HonuaGeneratedAppAssetRef,
  HonuaGeneratedAppBuildSpec,
  HonuaGeneratedAppChartKind,
  HonuaGeneratedAppChartWidget,
  HonuaGeneratedAppCountWidget,
  HonuaGeneratedAppDataBinding,
  HonuaGeneratedAppFeatureRecord,
  HonuaGeneratedAppFieldBinding,
  HonuaGeneratedAppFilterOption,
  HonuaGeneratedAppFilterState,
  HonuaGeneratedAppFilterWidget,
  HonuaGeneratedAppLayout,
  HonuaGeneratedAppManifest,
  HonuaGeneratedAppManifestArtifact,
  HonuaGeneratedAppManifestArtifactKind,
  HonuaGeneratedAppManifestArtifactVersion,
  HonuaGeneratedAppManifestFormat,
  HonuaGeneratedAppMapWidget,
  HonuaGeneratedAppPackage,
  HonuaGeneratedAppProfile,
  HonuaGeneratedAppTableWidget,
  HonuaGeneratedAppWidget,
  HonuaGeneratedAppWidgetBase,
  HonuaGeneratedAppWidgetKind,
} from "./manifest.js";

export {
  assertGeneratedAppManifest,
  createGeneratedAppManifestArtifact,
  projectAppPackageToGeneratedAppManifest,
  projectBuildSpecToGeneratedAppManifest,
  projectMapPackageToGeneratedAppManifest,
} from "./projection.js";
export type {
  ProjectBuildSpecToGeneratedAppManifestOptions,
  ProjectMapPackageToGeneratedAppManifestOptions,
} from "./projection.js";

export { HonuaGeneratedAppError, toGeneratedAppDiagnostic } from "./errors.js";
export type {
  HonuaGeneratedAppDiagnostic,
  HonuaGeneratedAppErrorCode,
  HonuaGeneratedAppErrorDetail,
  HonuaGeneratedAppErrorStage,
} from "./errors.js";

export { HonuaGeneratedAppRuntime, loadGeneratedAppRuntime, previewGeneratedApp } from "./runtime.js";
export type {
  HonuaGeneratedAppChartBucket,
  HonuaGeneratedAppFeatureInput,
  HonuaGeneratedAppFeatureLoader,
  HonuaGeneratedAppFeatureLoaderContext,
  HonuaGeneratedAppFilterOptionModel,
  HonuaGeneratedAppHistogramBin,
  HonuaGeneratedAppLoadOptions,
  HonuaGeneratedAppMapFactory,
  HonuaGeneratedAppMapFactoryResult,
  HonuaGeneratedAppPreviewInput,
  HonuaGeneratedAppPreviewResult,
  HonuaGeneratedAppRenderModel,
  HonuaGeneratedAppRenderedRow,
  HonuaGeneratedAppRuntimeEvent,
  HonuaGeneratedAppRuntimeEventListener,
  HonuaGeneratedAppTimeSeriesBucket,
  HonuaGeneratedAppWidgetModel,
} from "./runtime.js";
