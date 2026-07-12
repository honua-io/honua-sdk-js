import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { referenceManifest } from "./shared.js";

/**
 * Reference `cache` plugin. Persists entries through the scoped storage service
 * the host grants. Declares persistent-cache semantics and scoped storage, so
 * capabilities `write` and `invalidate` certify honestly.
 */
export interface ReferenceCacheExtension extends HonuaPluginExtension<"cache"> {
  readonly read: (key: string) => Promise<unknown>;
  readonly write: (key: string, value: unknown) => Promise<void>;
  readonly invalidate: (key: string) => Promise<void>;
}

export const referenceCacheManifest = referenceManifest({
  id: "com.example.reference-cache",
  kind: "cache",
  packageName: "@example/reference-cache",
  capabilities: ["read", "write", "invalidate"],
  data: { cache: "persistent" },
  requestedGrants: { storage: "scoped" },
});

export function referenceCachePlugin(events: string[] = []): HonuaPluginFactory<"cache", ReferenceCacheExtension> {
  return {
    manifest: JSON.stringify(referenceCacheManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      const storage = context.services.storage;
      const requireStorage = () => {
        if (!storage) throw new Error("scoped storage was not granted");
        return storage;
      };
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "cache" as const,
          read: (key: string) => requireStorage().get(key),
          write: (key: string, value: unknown) => requireStorage().set(key, value),
          invalidate: (key: string) => requireStorage().delete(key),
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
