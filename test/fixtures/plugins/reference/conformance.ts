import {
  type HonuaPluginConformanceProbe,
  type HonuaPluginConformanceSpec,
  type HonuaPluginExtension,
  type HonuaPluginFactory,
  type HonuaPluginManifest,
} from "../../../../src/plugin/index.js";
import { REFERENCE_ORIGIN, referenceManifest } from "./shared.js";

/**
 * Retry-capable, external-style reference plugin used to exercise the
 * behavioral-conformance harness. Its `countInBbox` operation retries the
 * origin-restricted network service up to a fixed attempt budget, so the
 * harness can inject transient failures and observe deterministic recovery,
 * per-run host-interaction cost, and bundle metadata. It is not imported by
 * SDK core. It also declares a `supportStatus` attestation so the certifier's
 * support-status program is covered end to end.
 */
export interface ReferenceRetryingProtocolExtension extends HonuaPluginExtension<"protocol"> {
  readonly countInBbox: (bbox: readonly [number, number, number, number]) => Promise<number>;
}

/** Total attempts the reference plugin makes before giving up. */
export const REFERENCE_CONFORMANCE_MAX_ATTEMPTS = 3;

export const referenceConformanceManifest: HonuaPluginManifest<"protocol"> = {
  ...referenceManifest({
    id: "com.example.reference-conformance",
    kind: "protocol",
    packageName: "@example/reference-conformance",
    capabilities: ["query"],
    data: { cache: "memory", freshness: "ttl" },
    requestedGrants: { networkOrigins: [REFERENCE_ORIGIN] },
  }),
  supportStatus: { state: "supported", since: "1.0.0" },
};

export function referenceConformancePlugin(
  maxAttempts: number = REFERENCE_CONFORMANCE_MAX_ATTEMPTS,
): HonuaPluginFactory<"protocol", ReferenceRetryingProtocolExtension> {
  return {
    manifest: JSON.stringify(referenceConformanceManifest),
    initialize(context) {
      const network = context.services.network;
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "protocol" as const,
          countInBbox: async () => {
            if (!network) return 0;
            let lastError: unknown;
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
              try {
                return Number(await network.request(`${REFERENCE_ORIGIN}/count`));
              } catch (error) {
                lastError = error;
              }
            }
            throw lastError ?? new Error("retry budget exhausted");
          },
        }),
        dispose() {},
      };
    },
  };
}

/** Drive exactly one canonical operation of the reference conformance plugin. */
export const referenceConformanceProbe: HonuaPluginConformanceProbe = async (registry) => {
  const extension = registry.get<"protocol", ReferenceRetryingProtocolExtension>(
    "protocol",
    referenceConformanceManifest.id,
  );
  if (!extension) throw new Error("reference conformance extension was not registered");
  await extension.countInBbox([0, 0, 10, 10]);
};

/** Declared behavioral bounds the reference conformance plugin is expected to meet. */
export const referenceConformanceSpec: HonuaPluginConformanceSpec = {
  factory: referenceConformancePlugin(),
  probe: referenceConformanceProbe,
  retries: { injectedFailures: 2, maxAttempts: REFERENCE_CONFORMANCE_MAX_ATTEMPTS },
  performance: { maxServiceCalls: 4 },
  bundle: { minifiedBytes: 38862, gzipBytes: 12996, maxMinifiedBytes: 45000, maxGzipBytes: 15000 },
};
