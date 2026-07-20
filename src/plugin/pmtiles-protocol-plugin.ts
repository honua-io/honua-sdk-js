/**
 * First-party PMTiles `protocol` plugin (issue #538).
 *
 * `HonuaPluginRegistry` never imports first-party protocol wiring, and SDK
 * core never imports the plugin SDK: this file is the seam between them,
 * kept in `src/plugin` (not `src/contract`) precisely so that importing
 * `@honua/sdk-js/contract` never pulls plugin-manifest machinery into a
 * consumer's bundle. It packages `pmtilesProtocolModule()`
 * (`src/contract/pmtiles.ts`) — the exact factory `pmtilesSource()` uses
 * internally to build `Source.protocol("pmtiles")` — as a certifiable
 * `HonuaPluginFactory<"protocol">`. Registering it through
 * `HonuaPluginRegistry` and calling `pmtilesSource()` both end up
 * constructing the archive adapter through the identical `ProtocolModule`
 * seam, which is what proves the built-in carries no special registry
 * privilege over an out-of-tree module (see
 * `test/plugin-pmtiles-protocol-seam.test.ts`).
 *
 * @module
 */
import type { DescribePmtilesArchiveDeps, HonuaPmtilesArchive } from "../contract/pmtiles.js";
import { pmtilesProtocolModule } from "../contract/pmtiles.js";
import type { ProtocolModule } from "../contract/protocol-module.js";
import { HONUA_PLUGIN_API_VERSION, HONUA_PLUGIN_MANIFEST_VERSION } from "./types.js";
import type { HonuaPluginExtension, HonuaPluginFactory, HonuaPluginManifest } from "./types.js";

/** Stable identifier the first-party PMTiles protocol module registers with the public seam. */
export const PMTILES_PROTOCOL_PLUGIN_ID = "io.honua.protocols.pmtiles" as const;

/**
 * Manifest for the first-party PMTiles protocol plugin. It certifies through
 * the same #392 kit as every out-of-tree plugin and requests no grants:
 * discovery never touches the network (the reader opens lazily on the
 * handle's own `describe()` call), so there is no origin or credential scope
 * to request up front.
 */
export const pmtilesProtocolManifest: HonuaPluginManifest<"protocol"> = {
  manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
  id: PMTILES_PROTOCOL_PLUGIN_ID,
  version: "1.0.0",
  kind: "protocol",
  package: { name: "@honua/sdk-js", entrypoint: "./pmtiles-protocol-plugin.js" },
  compatibility: {
    pluginApi: HONUA_PLUGIN_API_VERSION,
    minimumSdk: "0.1.0-beta.0",
    environments: ["browser", "node", "worker"],
  },
  capabilities: ["tiles"],
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
  support: "honua",
  supportStatus: { state: "experimental", since: "1.0.0" },
};

/** The `protocol` extension surface this plugin publishes: the `ProtocolModule` itself. */
export interface PmtilesProtocolExtension extends HonuaPluginExtension<"protocol"> {
  readonly module: ProtocolModule<"pmtiles", HonuaPmtilesArchive>;
}

/**
 * Build the first-party PMTiles protocol plugin factory. Register it through
 * `HonuaPluginRegistry` to obtain the same `ProtocolModule` that
 * `pmtilesSource()` builds internally:
 *
 * ```ts
 * const registry = new HonuaPluginRegistry({ host: JSON.stringify(host) });
 * await registry.register([pmtilesProtocolPlugin()]);
 * const extension = registry.get("protocol", PMTILES_PROTOCOL_PLUGIN_ID);
 * const handle = extension?.module.discover(descriptor);
 * ```
 */
export function pmtilesProtocolPlugin(
  deps: DescribePmtilesArchiveDeps = {},
): HonuaPluginFactory<"protocol", PmtilesProtocolExtension> {
  return {
    manifest: JSON.stringify(pmtilesProtocolManifest),
    initialize(context) {
      const module = pmtilesProtocolModule(deps);
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "protocol" as const,
          module,
        }),
        dispose() {
          // The module holds no registry-owned resources between discover()
          // calls; disposal is deterministic and synchronous.
        },
      };
    },
  };
}
