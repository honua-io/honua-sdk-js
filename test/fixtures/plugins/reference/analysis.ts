import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { referenceManifest } from "./shared.js";

/**
 * Reference `analysis` plugin. Runs a cancellable reduction over an input
 * series, honouring the caller's `AbortSignal`. Demonstrates capabilities
 * `execute` and `cancel`.
 */
export interface ReferenceAnalysisExtension extends HonuaPluginExtension<"analysis"> {
  readonly execute: (values: readonly number[], signal?: AbortSignal) => Promise<number>;
}

export const referenceAnalysisManifest = referenceManifest({
  id: "com.example.reference-analysis",
  kind: "analysis",
  packageName: "@example/reference-analysis",
  capabilities: ["execute", "cancel"],
});

export function referenceAnalysisPlugin(
  events: string[] = [],
): HonuaPluginFactory<"analysis", ReferenceAnalysisExtension> {
  return {
    manifest: JSON.stringify(referenceAnalysisManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "analysis" as const,
          execute: async (values: readonly number[], signal?: AbortSignal) => {
            let total = 0;
            for (const value of values) {
              signal?.throwIfAborted();
              total += value * value;
            }
            return total;
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
