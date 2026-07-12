/**
 * `@honua/sdk-js/plugin` — versioned plugin manifests and deterministic,
 * data-only certification reports and an explicit application-local runtime.
 *
 * This entrypoint validates declarations before any extension code runs. It
 * does not load entrypoints or grant ambient authority. Applications import
 * plugin factories explicitly and inject only reviewed host services into an
 * instance-scoped `HonuaPluginRegistry`.
 *
 * @experimental The independent behavioral-conformance kit from issue #392 is
 * not included yet, so this surface may change before 1.0.
 * @packageDocumentation
 */

export {
  certifyHonuaPluginManifest,
  validateHonuaPluginCertificationHost,
  validateHonuaPluginManifest,
} from "./certification.js";
export { HonuaPluginRegistry, HonuaPluginRegistryError } from "./registry.js";
export {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_CAPABILITIES,
  HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS,
  HONUA_PLUGIN_ENVIRONMENTS,
  HONUA_PLUGIN_KINDS,
  HONUA_PLUGIN_MANIFEST_VERSION,
} from "./types.js";
export type {
  HonuaPluginCapability,
  HonuaPluginCapabilityRequiredGrant,
  HonuaPluginCertificationCheck,
  HonuaPluginCertificationHost,
  HonuaPluginCertificationReport,
  HonuaPluginCheckResult,
  HonuaPluginCompatibility,
  HonuaPluginDataSemantics,
  HonuaPluginDiagnostic,
  HonuaPluginDiagnosticSeverity,
  HonuaPluginEnvironment,
  HonuaPluginDependency,
  HonuaPluginExtension,
  HonuaPluginExtensionKindMap,
  HonuaPluginFactory,
  HonuaPluginGrantedAuthorities,
  HonuaPluginHostServices,
  HonuaPluginHostValidation,
  HonuaPluginJsonPrimitive,
  HonuaPluginJsonValue,
  HonuaPluginKind,
  HonuaPluginLifecycle,
  HonuaPluginLifecycleContext,
  HonuaPluginLifecycleDiagnostic,
  HonuaPluginLifecyclePhase,
  HonuaPluginLifecycleStatus,
  HonuaPluginManifest,
  HonuaPluginManifestValidation,
  HonuaPluginPeerRequirement,
  HonuaPluginRequestedGrants,
  HonuaPluginRegistryOptions,
  HonuaPluginScopedServices,
  HonuaPluginInstance,
  HonuaPluginNetworkService,
  HonuaPluginCredentialService,
  HonuaPluginStorageService,
  HonuaPluginMutationService,
  HonuaPluginCacheService,
  HonuaPluginProvenanceService,
  HonuaPluginRealtimeService,
} from "./types.js";
