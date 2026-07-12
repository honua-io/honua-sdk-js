import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginCapability,
  type HonuaPluginDataSemantics,
  type HonuaPluginKind,
  type HonuaPluginManifest,
  type HonuaPluginRequestedGrants,
} from "../../../../src/plugin/index.js";

/**
 * Shared scaffolding for the minimal external-style reference plugins. Every
 * sample is a real, certifiable manifest paired with a tiny factory; none of
 * them are imported by SDK core. The host below grants exactly the authorities
 * the samples request, so each certifies without weakening capability honesty.
 */

const BASE_DATA: HonuaPluginDataSemantics = {
  cache: "none",
  freshness: "snapshot",
  authentication: "none",
  provenance: "preserved",
  mutation: "none",
  realtime: "none",
};

export const REFERENCE_ORIGIN = "https://reference.example";
export const REFERENCE_CREDENTIAL_SCOPE = "reference.read";

/** One explicit application host that grants precisely what the samples declare. */
export const REFERENCE_HOST = JSON.stringify({
  pluginApi: HONUA_PLUGIN_API_VERSION,
  sdkVersion: "0.1.0-beta.0",
  environment: "node",
  peers: {},
  grants: {
    networkOrigins: [REFERENCE_ORIGIN],
    credentialScopes: [REFERENCE_CREDENTIAL_SCOPE],
    storage: "scoped",
    mutation: true,
  },
});

export interface ReferenceManifestOptions<K extends HonuaPluginKind> {
  readonly id: string;
  readonly kind: K;
  readonly packageName: string;
  readonly capabilities: readonly HonuaPluginCapability<K>[];
  readonly data?: Partial<HonuaPluginDataSemantics>;
  readonly requestedGrants?: HonuaPluginRequestedGrants;
}

/** Build a minimal, spec-valid manifest for one reference plugin. */
export function referenceManifest<K extends HonuaPluginKind>(
  options: ReferenceManifestOptions<K>,
): HonuaPluginManifest<K> {
  return {
    manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
    id: options.id,
    version: "1.0.0",
    kind: options.kind,
    package: { name: options.packageName, entrypoint: "./plugin.js" },
    compatibility: {
      pluginApi: HONUA_PLUGIN_API_VERSION,
      minimumSdk: "0.1.0-beta.0",
      environments: ["node"],
    },
    capabilities: options.capabilities,
    requestedGrants: options.requestedGrants ?? {},
    data: { ...BASE_DATA, ...options.data },
    lifecycle: { initialization: "explicit", disposal: "required" },
    support: "community",
  } as HonuaPluginManifest<K>;
}
