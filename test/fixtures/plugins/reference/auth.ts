import type { HonuaPluginExtension, HonuaPluginFactory } from "../../../../src/plugin/index.js";
import { REFERENCE_CREDENTIAL_SCOPE, referenceManifest } from "./shared.js";

/**
 * Reference `auth` plugin. Resolves an Authorization header from the
 * scope-restricted credential service the host injects. It only ever sees the
 * `reference.read` scope identifier, never a raw secret at rest.
 */
export interface ReferenceAuthExtension extends HonuaPluginExtension<"auth"> {
  readonly authorize: () => Promise<string>;
}

export const referenceAuthManifest = referenceManifest({
  id: "com.example.reference-auth",
  kind: "auth",
  packageName: "@example/reference-auth",
  capabilities: ["authorize"],
  data: { authentication: "application-grant" },
  requestedGrants: { credentialScopes: [REFERENCE_CREDENTIAL_SCOPE] },
});

export function referenceAuthPlugin(events: string[] = []): HonuaPluginFactory<"auth", ReferenceAuthExtension> {
  return {
    manifest: JSON.stringify(referenceAuthManifest),
    initialize(context) {
      events.push(`initialize:${context.manifest.id}`);
      const credentials = context.services.credentials;
      return {
        extension: Object.freeze({
          id: context.manifest.id,
          kind: "auth" as const,
          authorize: async () => {
            if (!credentials) throw new Error("credential service was not granted");
            const token = await credentials.get(REFERENCE_CREDENTIAL_SCOPE);
            return `Bearer ${String(token)}`;
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
