import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { referenceManifest } from "./shared.js";

/**
 * Reference `source-format` plugin. Parses a trivial newline-delimited
 * `lng,lat` text format into GeoJSON-style point records. Read-only, so it
 * requests no mutation authority.
 */
export interface ReferenceSourceFormatExtension extends HonuaPluginExtension<"source-format"> {
  readonly read: (input: string) => readonly (readonly [number, number])[];
}

export const referenceSourceFormatManifest = referenceManifest({
  id: "com.example.reference-source-format",
  kind: "source-format",
  packageName: "@example/reference-source-format",
  capabilities: ["read"],
});

export function referenceSourceFormatPlugin(
  events: string[] = [],
): HonuaPluginFactory<"source-format", ReferenceSourceFormatExtension> {
  return {
    manifest: JSON.stringify(referenceSourceFormatManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "source-format" as const,
          read: (input: string) =>
            input
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .map((line) => {
                const [lng, lat] = line.split(",").map(Number);
                return [lng ?? Number.NaN, lat ?? Number.NaN] as const;
              }),
        }),
        start() {
          events.push(`start:${context.manifest.id}`);
        },
        stop() {
          events.push(`stop:${context.manifest.id}`);
        },
        dispose() {
          events.push(`dispose:${context.manifest.id}`);
        },
      };
    },
  };
}
