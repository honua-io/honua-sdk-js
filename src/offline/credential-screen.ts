import {
  type CredentialScreenReason,
  type CredentialScreenStrictness,
  credentialScreenMessage,
  screenPersistedString,
} from "../connect-url-safety.js";
import { normalizeDiscoveryEndpoint } from "../contract/discovery.js";
import { HonuaOfflineRegionError, type OfflineRegionManifestV1 } from "./types.js";

/**
 * Defence-in-depth screening for the strings the offline stores persist verbatim.
 *
 * The documented contract is still that persisted identities are non-secret by
 * construction: this boundary refuses credential-shaped values, it does not make
 * accepting secrets safe. Rejection fails the whole descriptor closed, because
 * silently rewriting an identity would change the deterministic region id and the
 * resource primary key.
 *
 * The denylist and the per-string screen itself live in
 * `src/connect-url-safety.ts` so endpoint normalization, plan persistence,
 * offline persistence, and realtime resume checkpoints share one vocabulary and
 * one implementation. This module keeps only the offline-manifest walk, which
 * is the part that knows about `OfflineRegionManifestV1`.
 */

export type { CredentialScreenReason, CredentialScreenStrictness };
export { credentialScreenMessage, screenPersistedString };

/**
 * Locate the first persisted manifest string that must not reach storage.
 *
 * Walks in a stable order so the reported path is deterministic. The
 * authorization scope is already reduced to its digest before a manifest exists,
 * so nothing here re-derives or inspects caller authorization material, and no
 * cached bytes are read.
 */
export function findManifestCredentialLeak(
  manifest: OfflineRegionManifestV1,
): { readonly path: string; readonly reason: CredentialScreenReason } | undefined {
  const record = manifest as unknown as Record<string, unknown>;
  const source = asRecord(record.source);
  const endpoint = source?.endpoint;
  if (!source || typeof endpoint !== "string" || !isNormalizedCredentialFreeEndpoint(endpoint)) {
    return { path: "source.endpoint", reason: "endpoint-not-normalized" };
  }
  for (const [path, value, strictness] of screenedManifestStrings(record, source)) {
    if (typeof value !== "string") continue;
    const reason = screenPersistedString(value, strictness);
    if (reason) return { path, reason };
  }
  return undefined;
}

/** Throw the structured `invalid-manifest` rejection when a manifest is unsafe to persist. */
export function assertCredentialFreeManifest(manifest: OfflineRegionManifestV1): void {
  const leak = findManifestCredentialLeak(manifest);
  if (!leak) return;
  throw new HonuaOfflineRegionError("invalid-manifest", credentialScreenMessage(leak.path, leak.reason), {
    path: leak.path,
  });
}

function* screenedManifestStrings(
  record: Record<string, unknown>,
  source: Record<string, unknown>,
): Generator<readonly [string, unknown, CredentialScreenStrictness]> {
  yield ["name", record.name, "label"];
  yield ["source.id", source.id, "identity"];
  yield ["source.sourceVersion", source.sourceVersion, "identity"];
  yield ["source.schemaVersion", source.schemaVersion, "identity"];
  yield ["source.planVersion", source.planVersion, "identity"];
  const attribution = asRecord(record.attribution);
  if (attribution) {
    for (const key in attribution) {
      if (!Object.hasOwn(attribution, key)) continue;
      yield ["attribution id", key, "identity"];
      yield [`attribution.${key}`, attribution[key], "label"];
    }
  }
  const resources = Array.isArray(record.resources) ? record.resources : [];
  for (let index = 0; index < resources.length; index += 1) {
    const resource = asRecord(resources[index]);
    if (!resource) continue;
    const path = `resources[${index}]`;
    yield [`${path}.id`, resource.id, "identity"];
    yield [`${path}.contentType`, resource.contentType, "identity"];
    yield [`${path}.sourceVersion`, resource.sourceVersion, "identity"];
    yield [`${path}.schemaVersion`, resource.schemaVersion, "identity"];
    yield [`${path}.planVersion`, resource.planVersion, "identity"];
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNormalizedCredentialFreeEndpoint(endpoint: string): boolean {
  try {
    return normalizeDiscoveryEndpoint(endpoint) === endpoint;
  } catch {
    return false;
  }
}
