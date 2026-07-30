/**
 * `@honua/sdk-js/plugin` — versioned plugin manifests and deterministic,
 * data-only certification reports and an explicit application-local runtime.
 *
 * This entrypoint validates declarations before any extension code runs. It
 * does not load entrypoints or grant ambient authority. Applications import
 * plugin factories explicitly and inject only reviewed host services into an
 * instance-scoped `HonuaPluginRegistry`.
 *
 * @experimental This surface still stabilizes the plugin API before 1.0 and may
 * change; the behavioral-conformance kit, signed reports, and support-status
 * program from issue #392 are included here.
 * @packageDocumentation
 */

export {
  certifyHonuaPluginManifest,
  createHonuaPluginCertificationSigningPayload,
  validateHonuaPluginCertificationHost,
  validateHonuaPluginManifest,
  verifyHonuaPluginCertificationReport,
  verifyHonuaPluginCertificationSigningEnvelope,
} from "./certification.js";
export { runHonuaPluginConformance } from "./conformance.js";
export type {
  AnyHonuaPluginFactory,
  HonuaPluginConformanceProbe,
  HonuaPluginConformanceSpec,
} from "./conformance.js";
export { HonuaPluginRegistry, HonuaPluginRegistryError } from "./registry.js";
export {
  PMTILES_PROTOCOL_PLUGIN_ID,
  pmtilesProtocolManifest,
  pmtilesProtocolPlugin,
} from "./pmtiles-protocol-plugin.js";
export type { PmtilesProtocolExtension } from "./pmtiles-protocol-plugin.js";
export {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_CAPABILITIES,
  HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS,
  HONUA_PLUGIN_CERTIFICATION_REPORT_VERSION,
  HONUA_PLUGIN_CERTIFICATION_SIGNING_ENVELOPE_VERSION,
  HONUA_PLUGIN_ENVIRONMENTS,
  HONUA_PLUGIN_KINDS,
  HONUA_PLUGIN_MANIFEST_VERSION,
  HONUA_PLUGIN_SUPPORT_STATES,
} from "./types.js";
export type {
  HonuaPluginCapability,
  HonuaPluginCapabilityRequiredGrant,
  HonuaPluginCertificationCheck,
  HonuaPluginCertificationHost,
  HonuaPluginCertificationReport,
  HonuaPluginCertificationSignatureVerifier,
  HonuaPluginCertificationSigningEnvelope,
  HonuaPluginCertificationSigningEnvelopeVerification,
  HonuaPluginCheckResult,
  HonuaPluginCompatibility,
  HonuaPluginConformanceObservation,
  HonuaPluginConformanceReport,
  HonuaPluginConformanceScenario,
  HonuaPluginConformanceScenarioResult,
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
  HonuaPluginReportVerification,
  HonuaPluginScopedServices,
  HonuaPluginSupportState,
  HonuaPluginSupportStatus,
  HonuaPluginInstance,
  HonuaPluginNetworkService,
  HonuaPluginCredentialService,
  HonuaPluginStorageService,
  HonuaPluginMutationService,
  HonuaPluginCacheService,
  HonuaPluginProvenanceService,
  HonuaPluginRealtimeService,
} from "./types.js";
