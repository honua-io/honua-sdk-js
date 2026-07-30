/**
 * Credential safety for the Kepler bridge (REQ-006).
 *
 * Two enforcement points:
 *
 * 1. **Ingestion** — {@link assertCredentialFreeUrl} /
 *    {@link assertCredentialFreeScalar} refuse credential-bearing remote source
 *    URLs, authorization scopes, and attribution strings before anything is
 *    handed to Kepler, so a credential never enters the workspace at all.
 * 2. **Export** — {@link redactKeplerExportState} walks a Kepler saved map /
 *    exported state and removes private headers, bearer tokens, signed-URL
 *    query parameters, and credential-bearing config keys by default.
 *
 * Matching is deliberately name- and parameter-driven with linear scanning
 * rather than backtracking regexes.
 *
 * @experimental
 * @module
 */

import { HonuaKeplerBridgeError } from "./types.js";

/** Replacement written over every removed credential. */
export const KEPLER_REDACTED = "[REDACTED]" as const;

const MAX_EXPORT_NODES = 200_000;
const MAX_EXPORT_DEPTH = 32;

/**
 * Normalized key fragments that always indicate a credential-bearing value.
 * Keys are lowercased with non-alphanumerics stripped before matching, so
 * `X-API-Key`, `api_key`, and `apiKey` all normalize to `apikey`.
 */
const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "idtoken",
  "passphrase",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessionid",
  "sessiontoken",
  "signature",
  "signedurl",
  "subscriptionkey",
];

/** Normalized keys that are credential-bearing on their own. */
const SENSITIVE_KEY_EXACT: ReadonlySet<string> = new Set([
  "auth",
  "authtoken",
  "headers",
  "jwt",
  "passwd",
  "pwd",
  "requestheaders",
  "sas",
  "sastoken",
  "sig",
  "token",
]);

/**
 * Normalized keys that are credential-bearing by name but hold a value the
 * bridge itself guarantees is a non-secret opaque fingerprint. Only the
 * key-name rule is skipped — the value still goes through the signed-URL and
 * opaque-credential value scans, and ingestion already rejected a
 * credential-shaped `authorizationScope` via {@link assertCredentialFreeScalar}.
 */
const SAFE_KEY_EXACT: ReadonlySet<string> = new Set(["authorizationscope"]);

/**
 * Query parameters that carry a credential or a presigned grant. Includes AWS
 * SigV4, Azure SAS, Google Cloud Storage, CloudFront, and common bearer-style
 * parameters.
 */
const CREDENTIAL_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "awsaccesskeyid",
  "expires",
  "goog-signature",
  "googleaccessid",
  "jwt",
  "key",
  "key-pair-id",
  "policy",
  "sas",
  "se",
  "si",
  "sig",
  "signature",
  "sks",
  "ske",
  "skoid",
  "skt",
  "sktid",
  "skv",
  "sp",
  "spr",
  "sr",
  "srt",
  "ss",
  "st",
  "subscription-key",
  "sv",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
  "x-ms-encryption-key",
]);

/** Literal prefixes for well-known opaque credential formats. */
const CREDENTIAL_VALUE_PREFIXES: readonly string[] = [
  "aiza",
  "akia",
  "asia",
  "basic ",
  "bearer ",
  "eyj",
  "ghp_",
  "gho_",
  "glpat-",
  "pk.eyj",
  "sk-",
  "sk.eyj",
  "sk_live_",
  "sk_test_",
  "xoxb-",
  "xoxp-",
];

export type KeplerRedactionKind = "sensitive-key" | "signed-url-parameter" | "url-userinfo" | "embedded-credential";

export interface KeplerRedaction {
  /** JSON pointer-ish path of the redacted value, for example `mapStyle.mapStyles.custom.accessToken`. */
  readonly path: string;
  readonly kind: KeplerRedactionKind;
  readonly detail: string;
}

export interface KeplerRedactionResult<T = unknown> {
  /** Deep copy of the input with every credential removed. */
  readonly state: T;
  readonly redactions: readonly KeplerRedaction[];
  readonly redacted: boolean;
}

export interface RedactKeplerExportStateOptions {
  /** Extra key names to treat as credential-bearing (normalized like the built-ins). */
  readonly additionalSensitiveKeys?: readonly string[];
}

function normalizeKey(key: string): string {
  let normalized = "";
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    if (code >= 48 && code <= 57) normalized += key[index];
    else if (code >= 97 && code <= 122) normalized += key[index];
    else if (code >= 65 && code <= 90) normalized += key[index].toLowerCase();
  }
  return normalized;
}

/**
 * True when a config/JSON key names a credential-bearing value.
 *
 * Matching is deliberately fail-closed: a key whose normalized form merely
 * contains a credential fragment (for example `signature_field_label`) is
 * treated as sensitive, because over-redacting an export is safer than
 * leaking one.
 */
export function isSensitiveKeplerKey(key: string, additional: ReadonlySet<string> = new Set()): boolean {
  const normalized = normalizeKey(key);
  if (normalized.length === 0) return false;
  if (additional.has(normalized)) return true;
  if (SAFE_KEY_EXACT.has(normalized)) return false;
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
  for (const fragment of SENSITIVE_KEY_FRAGMENTS) {
    if (normalized.includes(fragment)) return true;
  }
  return false;
}

/** True when a scalar string looks like an opaque credential rather than data. */
export function looksLikeCredentialValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8) return false;
  const lowered = trimmed.toLowerCase();
  for (const prefix of CREDENTIAL_VALUE_PREFIXES) {
    if (lowered.startsWith(prefix)) return true;
  }
  return false;
}

function parseUrl(value: string): URL | undefined {
  const lowered = value.toLowerCase();
  if (!lowered.startsWith("http://") && !lowered.startsWith("https://")) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Credential-bearing query parameter names present in `value`, or an empty
 * array when `value` is not an absolute HTTP(S) URL or carries none.
 */
export function credentialQueryParameters(value: string): readonly string[] {
  const url = parseUrl(value);
  if (!url) return [];
  const found: string[] = [];
  for (const name of new Set([...url.searchParams.keys()])) {
    if (CREDENTIAL_QUERY_PARAMS.has(name.toLowerCase())) found.push(name);
  }
  return found.sort();
}

/**
 * True when `value` is an absolute HTTP(S) URL carrying userinfo credentials
 * (`https://user:password@host/...`). Ingestion refuses these outright; export
 * has to strip them from state that predates the bridge or was assembled by the
 * host, where neither the query-parameter scan nor the opaque-value scan sees
 * them — the string starts with a plain `https://` scheme.
 */
export function hasUrlUserinfo(value: string): boolean {
  const url = parseUrl(value);
  return url !== undefined && (url.username.length > 0 || url.password.length > 0);
}

/** Remove userinfo from an absolute HTTP(S) URL, preserving the rest verbatim. */
function redactUrlUserinfo(value: string): string {
  const url = parseUrl(value);
  if (!url) return KEPLER_REDACTED;
  url.username = "";
  url.password = "";
  return url.toString();
}

function redactUrlParameters(value: string, offenders: readonly string[]): string {
  const url = parseUrl(value);
  if (!url) return KEPLER_REDACTED;
  for (const name of offenders) url.searchParams.set(name, KEPLER_REDACTED);
  return url.toString();
}

/**
 * Reject a remote source URL that embeds a credential. The bridge never
 * accepts one: authorization belongs in a transport interceptor the host
 * applies at request time, not in serializable Kepler configuration.
 */
export function assertCredentialFreeUrl(value: string, label: string): string {
  if (value.includes("@") && (value.startsWith("http://") || value.startsWith("https://"))) {
    const url = parseUrl(value);
    if (url && (url.username.length > 0 || url.password.length > 0)) {
      throw new HonuaKeplerBridgeError(
        "credential-leak",
        `${label} must not embed userinfo credentials. Apply authorization in a transport interceptor instead.`,
        { label },
      );
    }
  }
  const offenders = credentialQueryParameters(value);
  if (offenders.length > 0) {
    throw new HonuaKeplerBridgeError(
      "credential-leak",
      `${label} carries credential-bearing query parameters (${offenders.join(", ")}). Signed URLs are never serialized into a Kepler workspace.`,
      { label, parameters: offenders },
    );
  }
  if (looksLikeCredentialValue(value)) {
    throw new HonuaKeplerBridgeError("credential-leak", `${label} looks like an opaque credential.`, { label });
  }
  return value;
}

/**
 * Reject a non-secret metadata scalar (authorization scope, attribution,
 * dataset label, …) that actually carries a credential.
 */
export function assertCredentialFreeScalar(value: string, label: string): string {
  if (hasUrlUserinfo(value) || looksLikeCredentialValue(value) || credentialQueryParameters(value).length > 0) {
    throw new HonuaKeplerBridgeError(
      "credential-leak",
      `${label} must be an opaque non-secret value; it looks like a credential.`,
      { label },
    );
  }
  return value;
}

function joinPath(parent: string, key: string): string {
  return parent.length === 0 ? key : `${parent}.${key}`;
}

/**
 * Redact a Kepler saved map, exported config, or any JSON-ish state before it
 * is persisted or shared. Private headers, bearer tokens, signed URLs, and
 * credential-bearing config keys are removed by default.
 *
 * The walk is bounded: more than 200,000 nodes or 32 levels of nesting throws
 * `limit-exceeded` rather than silently truncating an export.
 */
export function redactKeplerExportState<T>(
  state: T,
  options: RedactKeplerExportStateOptions = {},
): KeplerRedactionResult<T> {
  const additional = new Set((options.additionalSensitiveKeys ?? []).map(normalizeKey).filter((key) => key.length > 0));
  const redactions: KeplerRedaction[] = [];
  const budget = { nodes: 0 };

  function walk(value: unknown, path: string, depth: number): unknown {
    budget.nodes += 1;
    if (budget.nodes > MAX_EXPORT_NODES) {
      throw new HonuaKeplerBridgeError(
        "limit-exceeded",
        `Kepler export state exceeds the ${MAX_EXPORT_NODES}-node redaction budget.`,
        { nodes: budget.nodes },
      );
    }
    if (depth > MAX_EXPORT_DEPTH) {
      throw new HonuaKeplerBridgeError(
        "limit-exceeded",
        `Kepler export state exceeds the ${MAX_EXPORT_DEPTH}-level redaction depth budget.`,
        { path },
      );
    }
    if (typeof value === "string") {
      let current = value;
      let rewritten = false;
      // Userinfo first: ingestion refuses `https://user:password@host/...`
      // outright, but state assembled by the host (or predating the bridge) can
      // still carry it, and neither the query-parameter scan nor the
      // opaque-value scan sees it — the string just starts with `https://`.
      if (hasUrlUserinfo(current)) {
        redactions.push({
          path,
          kind: "url-userinfo",
          detail: "Removed userinfo credentials embedded in a URL.",
        });
        current = redactUrlUserinfo(current);
        rewritten = true;
      }
      const offenders = credentialQueryParameters(current);
      if (offenders.length > 0) {
        redactions.push({
          path,
          kind: "signed-url-parameter",
          detail: `Redacted credential-bearing query parameters: ${offenders.join(", ")}.`,
        });
        current = redactUrlParameters(current, offenders);
        rewritten = true;
      }
      if (rewritten) return current;
      if (looksLikeCredentialValue(current)) {
        redactions.push({ path, kind: "embedded-credential", detail: "Redacted an opaque credential value." });
        return KEPLER_REDACTED;
      }
      return current;
    }
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item, index) => walk(item, joinPath(path, String(index)), depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = joinPath(path, key);
      if (isSensitiveKeplerKey(key, additional)) {
        redactions.push({
          path: childPath,
          kind: "sensitive-key",
          detail: `Removed the value of credential-bearing key "${key}".`,
        });
        output[key] = KEPLER_REDACTED;
        continue;
      }
      output[key] = walk(child, childPath, depth + 1);
    }
    return output;
  }

  const redactedState = walk(state, "", 0) as T;
  return Object.freeze({
    state: redactedState,
    redactions: Object.freeze(redactions),
    redacted: redactions.length > 0,
  });
}
