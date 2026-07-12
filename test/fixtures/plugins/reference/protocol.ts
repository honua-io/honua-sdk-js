import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { REFERENCE_ORIGIN, referenceManifest } from "./shared.js";

/**
 * Reference `protocol` plugin. Answers a bounding-box feature count, preferring
 * the host-injected, origin-restricted network service and falling back to a
 * tiny in-memory index. Demonstrates capability `query` plus network DI.
 */
export interface ReferenceProtocolExtension extends HonuaPluginExtension<"protocol"> {
  readonly countInBbox: (bbox: readonly [number, number, number, number]) => Promise<number>;
}

const FEATURES: readonly (readonly [number, number])[] = [
  [0, 0],
  [10, 10],
  [40, 40],
];

export const referenceProtocolManifest = referenceManifest({
  id: "com.example.reference-protocol",
  kind: "protocol",
  packageName: "@example/reference-protocol",
  capabilities: ["query"],
  data: { cache: "memory", freshness: "ttl" },
  requestedGrants: { networkOrigins: [REFERENCE_ORIGIN] },
});

export function referenceProtocolPlugin(events: string[] = []): HonuaPluginFactory<"protocol", ReferenceProtocolExtension> {
  return {
    manifest: JSON.stringify(referenceProtocolManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      const network = context.services.network;
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "protocol" as const,
          countInBbox: async (bbox: readonly [number, number, number, number]) => {
            const [minX, minY, maxX, maxY] = bbox;
            if (network) {
              const response = await network.request(`${REFERENCE_ORIGIN}/count`);
              return Number(response);
            }
            return FEATURES.filter(([x, y]) => x >= minX && x <= maxX && y >= minY && y <= maxY).length;
          },
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
