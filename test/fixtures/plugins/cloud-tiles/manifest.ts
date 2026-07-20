import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginManifest,
} from "../../../../src/plugin/index.js";

/**
 * Manifest for the independent, out-of-tree-style "cloud tiles" protocol
 * plugin (issue #538 REQ-004). This is the exact manifest shape used as the
 * worked example in `docs/plugin-manifest-certification.md`.
 */
export const cloudTilesProtocolManifest: HonuaPluginManifest<"protocol"> = {
  manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
  id: "com.example.cloud-tiles",
  version: "1.0.0",
  kind: "protocol",
  package: { name: "@example/honua-cloud-tiles", entrypoint: "./plugin.js" },
  compatibility: {
    pluginApi: HONUA_PLUGIN_API_VERSION,
    minimumSdk: "0.1.0-beta.0",
    environments: ["browser", "node", "worker"],
  },
  capabilities: ["tiles"],
  requestedGrants: {},
  data: {
    cache: "memory",
    freshness: "ttl",
    authentication: "none",
    provenance: "preserved",
    mutation: "none",
    realtime: "none",
  },
  lifecycle: { initialization: "explicit", disposal: "required" },
  support: "community",
};
