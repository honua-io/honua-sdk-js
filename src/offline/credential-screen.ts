import { type CredentialScreenStrictness, hasCredentialShapedMaterial } from "../connect-url-safety.js";
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
 * The denylist itself lives in `src/connect-url-safety.ts` so endpoint
 * normalization, plan persistence, and offline persistence share one vocabulary.
 */

export type { CredentialScreenStrictness };

export type CredentialScreenReason = "credential-shaped" | "url-shaped" | "endpoint-not-normalized";

/**
 * Report why a persisted string must be refused, or `undefined` when it is safe.
 *
 * Both strictness levels reject a request URL carrying userinfo, a query, or a
 * fragment. `identity` additionally refuses a relative request reference — any
 * embedded `?`, `#`, or `@` — mirroring the persisted-source shape check in
 * `src/query-planner/planner.ts`, so a matched request URL cannot become a stored
 * identity by accident. Never returns `endpoint-not-normalized`, which only
 * applies to the endpoint's own normalization contract.
 */
export function screenPersistedString(
  value: string,
  strictness: CredentialScreenStrictness,
): CredentialScreenReason | undefined {
  if (hasCredentialShapedMaterial(value, strictness)) return "credential-shaped";
  return isCredentialFreeShape(value, strictness) ? undefined : "url-shaped";
}

/** Message for `reason` at `path`. Never echoes the offending value (NFR-002). */
export function credentialScreenMessage(path: string, reason: CredentialScreenReason): string {
  if (reason === "url-shaped") return `${path} must not be a request URL carrying userinfo, a query, or a fragment.`;
  if (reason === "endpoint-not-normalized") return `${path} must be a normalized, credential-free absolute URL.`;
  return `${path} must not contain credential-shaped material.`;
}

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

function isCredentialFreeShape(value: string, strictness: CredentialScreenStrictness): boolean {
  // An absolute URL always carries a scheme separator; the guard keeps the
  // common non-URL case free of throwing URL construction.
  if (value.includes(":")) {
    try {
      const url = new URL(value);
      // Prose is only refused for a real request URL, one with an authority.
      // A label such as `Data: NOAA #1` parses as an opaque `data:` URL and
      // must not be rejected for a colon followed by a fragment character.
      if (strictness === "identity" || url.host.length > 0) {
        return !url.username && !url.password && !url.search && !url.hash;
      }
      return true;
    } catch {
      // Not an absolute URL; fall through to the literal reference check.
    }
  }
  // A machine identity must not even be a relative request reference.
  return strictness === "label" || (!value.includes("?") && !value.includes("#") && !value.includes("@"));
}
