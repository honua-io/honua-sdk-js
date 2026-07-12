import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { referenceManifest } from "./shared.js";

/**
 * Reference `geocoder-routing` plugin. Resolves a handful of place names to
 * coordinates from a static gazetteer. Deterministic and offline; requests no
 * grants.
 */
export interface ReferenceLngLat {
  readonly lng: number;
  readonly lat: number;
}

export interface ReferenceGeocoderExtension extends HonuaPluginExtension<"geocoder-routing"> {
  readonly geocode: (query: string) => ReferenceLngLat | undefined;
}

const GAZETTEER: Readonly<Record<string, ReferenceLngLat>> = {
  "null island": { lng: 0, lat: 0 },
  honolulu: { lng: -157.8583, lat: 21.3069 },
};

export const referenceGeocoderManifest = referenceManifest({
  id: "com.example.reference-geocoder",
  kind: "geocoder-routing",
  packageName: "@example/reference-geocoder",
  capabilities: ["geocode"],
});

export function referenceGeocoderPlugin(
  events: string[] = [],
): HonuaPluginFactory<"geocoder-routing", ReferenceGeocoderExtension> {
  return {
    manifest: JSON.stringify(referenceGeocoderManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "geocoder-routing" as const,
          geocode: (query: string) => GAZETTEER[query.trim().toLowerCase()],
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
