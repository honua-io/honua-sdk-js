/**
 * `@honua/sdk-js/plugin` — versioned plugin manifests and deterministic,
 * data-only certification reports.
 *
 * This entrypoint validates declarations before any extension code runs. It
 * does not load entrypoints, mutate a registry, or grant credentials. Hosts
 * remain responsible for explicit dependency injection and for enforcing the
 * authorities recorded in a successful report.
 *
 * @experimental The runtime lifecycle and behavioral conformance phases of
 * issue #392 are not included yet, so this surface may change before 1.0.
 * @packageDocumentation
 */

export {
  certifyHonuaPluginManifest,
  validateHonuaPluginCertificationHost,
  validateHonuaPluginManifest,
} from "./certification.js";
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
  HonuaPluginGrantedAuthorities,
  HonuaPluginHostValidation,
  HonuaPluginJsonPrimitive,
  HonuaPluginJsonValue,
  HonuaPluginKind,
  HonuaPluginLifecycle,
  HonuaPluginManifest,
  HonuaPluginManifestValidation,
  HonuaPluginPeerRequirement,
  HonuaPluginRequestedGrants,
} from "./types.js";
