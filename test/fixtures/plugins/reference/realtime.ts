import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { referenceManifest } from "./shared.js";

/**
 * Reference `realtime` plugin. Subscribes through the host-injected realtime
 * service and forwards the subscription handle. Declares push realtime
 * semantics; capability `subscribe`.
 */
export interface ReferenceRealtimeExtension extends HonuaPluginExtension<"realtime"> {
  readonly subscribe: (topic: string, signal: AbortSignal) => Promise<unknown>;
}

export const referenceRealtimeManifest = referenceManifest({
  id: "com.example.reference-realtime",
  kind: "realtime",
  packageName: "@example/reference-realtime",
  capabilities: ["subscribe"],
  data: { realtime: "push" },
});

export function referenceRealtimePlugin(
  events: string[] = [],
): HonuaPluginFactory<"realtime", ReferenceRealtimeExtension> {
  return {
    manifest: JSON.stringify(referenceRealtimeManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      const realtime = context.services.realtime;
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "realtime" as const,
          subscribe: async (topic: string, signal: AbortSignal) => {
            if (!realtime) throw new Error("realtime service was not granted");
            return realtime.subscribe(topic, signal);
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
