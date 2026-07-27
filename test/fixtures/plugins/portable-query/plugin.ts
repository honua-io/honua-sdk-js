import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { portableQueryManifest } from "./manifest.js";
import type { PortableQueryReaderLike } from "./reader.js";
import { createFakePortableQueryReader } from "./reader.js";
import type { PortableQueryModule } from "./protocol-module.js";
import { portableQueryProtocolModule } from "./protocol-module.js";

export interface PortableQueryExtension extends HonuaPluginExtension<"protocol"> {
  readonly module: PortableQueryModule;
}

export function portableQueryPlugin(
  reader: PortableQueryReaderLike = createFakePortableQueryReader(),
): HonuaPluginFactory<"protocol", PortableQueryExtension> {
  return {
    manifest: JSON.stringify(portableQueryManifest),
    initialize(context) {
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "protocol" as const,
          module: portableQueryProtocolModule(reader),
        }),
        dispose() {
          // Discovered handles own their reader lifecycle; the registry-owned
          // module itself retains no open resource.
        },
      };
    },
  };
}
