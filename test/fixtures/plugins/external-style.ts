import type { HonuaPluginExtension, HonuaPluginFactory, HonuaPluginManifest } from "../../../src/plugin/index.js";

export interface ExternalStyleExtension extends HonuaPluginExtension<"style"> {
  readonly validateStyle: (input: string) => boolean;
}

export function externalStylePlugin(
  manifest: HonuaPluginManifest<"style">,
  events: string[],
): HonuaPluginFactory<"style", ExternalStyleExtension> {
  return {
    manifest: JSON.stringify(manifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "style" as const,
          validateStyle: (input: string) => input.length > 0,
        }),
        start() { events.push(`start:${context.manifest.id}`); },
        stop() { events.push(`stop:${context.manifest.id}`); },
        dispose() { events.push(`dispose:${context.manifest.id}`); },
      };
    },
  };
}
