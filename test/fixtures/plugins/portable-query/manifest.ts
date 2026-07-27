import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginManifest,
} from "../../../../src/plugin/index.js";

export const portableQueryManifest: HonuaPluginManifest<"protocol"> = {
  manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
  id: "com.example.portable-query",
  version: "1.0.0",
  kind: "protocol",
  package: { name: "@example/honua-portable-query", entrypoint: "./plugin.js" },
  compatibility: {
    pluginApi: HONUA_PLUGIN_API_VERSION,
    minimumSdk: "0.1.0-beta.0",
    environments: ["browser", "node", "worker"],
  },
  capabilities: ["query"],
  requestedGrants: {},
  data: {
    cache: "none",
    freshness: "snapshot",
    authentication: "none",
    provenance: "preserved",
    mutation: "none",
    realtime: "none",
  },
  lifecycle: { initialization: "explicit", disposal: "required" },
  support: "community",
};
