import type { ProtocolModule } from "../../../../src/contract/index.js";
import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import type { CloudTilesReaderLike } from "./fake-cloud-tiles-reader.js";
import { createFakeCloudTilesReader } from "./fake-cloud-tiles-reader.js";
import { cloudTilesProtocolManifest } from "./manifest.js";
import type { CloudTilesArchiveHandle } from "./protocol-module.js";
import { cloudTilesProtocolModule } from "./protocol-module.js";

export interface CloudTilesProtocolExtension extends HonuaPluginExtension<"protocol"> {
  readonly module: ProtocolModule<"cloud-tiles", CloudTilesArchiveHandle>;
}

/**
 * The independent "cloud tiles" plugin factory. Registering it through
 * `HonuaPluginRegistry` is structurally identical to registering the
 * first-party `pmtilesProtocolPlugin()` (`src/plugin/pmtiles-protocol-plugin.ts`):
 * same manifest shape, same `ProtocolModule` extension surface, same
 * lifecycle hooks.
 */
export function cloudTilesProtocolPlugin(
  reader: CloudTilesReaderLike = createFakeCloudTilesReader(),
): HonuaPluginFactory<"protocol", CloudTilesProtocolExtension> {
  return {
    manifest: JSON.stringify(cloudTilesProtocolManifest),
    initialize(context) {
      const module = cloudTilesProtocolModule(reader);
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "protocol" as const,
          module,
        }),
        dispose() {},
      };
    },
  };
}
