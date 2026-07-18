import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginManifest,
} from "../../../../src/plugin/index.js";
import { OPENLAYERS_RENDERER_KIND } from "./renderer-adapter.js";

/**
 * Manifest for the external-style OpenLayers renderer plugin (issue #566).
 * It certifies through the same #392 kit as every other plugin kind, using a
 * stable namespaced id, and requests no grants: rendering consumes an
 * already-accepted query plan through the injected `planQuery`/`execution`
 * seam rather than making its own network or credential calls.
 */
export const openLayersRendererManifest: HonuaPluginManifest<"renderer"> = {
  manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
  id: "io.honua.plugins.openlayers",
  version: "1.0.0",
  kind: "renderer",
  package: {
    name: "@example/honua-plugin-openlayers",
    entrypoint: "./plugin.js",
  },
  compatibility: {
    pluginApi: HONUA_PLUGIN_API_VERSION,
    minimumSdk: "0.1.0-beta.0",
    environments: ["browser"],
  },
  capabilities: ["2d"],
  // `ol` is an optional peer of the external plugin package, never of SDK core.
  peers: [{ name: "ol", minimumVersion: "9.0.0", optional: true }],
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
  supportStatus: { state: "experimental", since: "1.0.0" },
};

export { OPENLAYERS_RENDERER_KIND };
