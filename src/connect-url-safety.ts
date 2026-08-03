/** Internal credential rejection and canonical query helpers for discovery URLs. */

const CREDENTIAL_QUERY_TOKENS = new Set([
  "auth",
  "awsaccesskeyid",
  "bearer",
  "code",
  "credentials",
  "expires",
  "googleaccessid",
  "jwt",
  "key",
  "keypairid",
  "passwd",
  "policy",
  "pwd",
  "sas",
  "session",
  "sessionid",
  "sig",
]);
// Suffix matching keeps prefixed spellings (`proxy-authorization`, `set-cookie`,
// `x-api-key`) credential-bearing, matching the plan-persistence classifier in
// `src/query-planner/planner.ts`.
const CREDENTIAL_QUERY_SUFFIXES = [
  "accountkey",
  "accesskey",
  "apikey",
  "authorization",
  "consumerkey",
  "cookie",
  "credential",
  "encryptionkey",
  "masterkey",
  "passphrase",
  "password",
  "privatekey",
  "secret",
  "secretkey",
  "signingkey",
  "signature",
  "storagekey",
  "subscriptionkey",
  "token",
] as const;

/**
 * Compare one already-lowercased candidate against the shared credential
 * vocabulary. Separators are dropped so `x-api-key`, `x_api_key`, and `apiKey`
 * collapse onto the same token. This is the single place the denylist is
 * evaluated; callers own segmentation only.
 */
function matchesCredentialVocabulary(candidate: string): boolean {
  const token = candidate.replace(/[^a-z0-9]/gu, "");
  if (token.length === 0) return false;
  return (
    CREDENTIAL_QUERY_TOKENS.has(token) ||
    token.startsWith("xamz") ||
    token.startsWith("xgoog") ||
    CREDENTIAL_QUERY_SUFFIXES.some((suffix) => token.endsWith(suffix))
  );
}

/**
 * Fold percent-encoding so an encoded credential name cannot bypass the
 * denylist. Returns `undefined` when the value stays encoded after four
 * layers, which no legitimate service parameter requires.
 */
function decodeCredentialCandidate(value: string): string | undefined {
  let normalized = value.trim().toLowerCase();
  for (let depth = 0; depth < 4 && /%[0-9a-f]{2}/i.test(normalized); depth += 1) {
    try {
      const decoded = decodeURIComponent(normalized).trim().toLowerCase();
      if (decoded === normalized) break;
      normalized = decoded;
    } catch {
      return undefined;
    }
  }
  return /%[0-9a-f]{2}/i.test(normalized) ? undefined : normalized;
}

/** URLSearchParams has already percent-decoded names before this check. */
export function isCredentialQueryName(name: string): boolean {
  const normalized = decodeCredentialCandidate(name);
  if (normalized === undefined) return true;
  return normalized
    .split(/[&;?#]/u)
    .some((part) => matchesCredentialVocabulary(part.split(/[=:]/u, 1)[0]?.trim() ?? ""));
}

/**
 * How strictly a value that will be persisted verbatim is screened.
 *
 * `identity` is for machine keys (source ids, resource ids, versions, content
 * types, attribution ids) whose whole value is compared against the denylist.
 * `label` is for human prose (display names, attribution text) where only
 * embedded `name=value` / `name: value` assignments are screened, so an
 * ordinary phrase that happens to end in a denylisted word still persists.
 */
export type CredentialScreenStrictness = "identity" | "label";

/** Segment separators that can introduce an embedded credential assignment. */
const CREDENTIAL_SEGMENT_SEPARATORS = /[&;?#,\s]+/u;

/**
 * Screen a value that a caller wants persisted verbatim for credential-shaped
 * material, using the same denylist that governs endpoint normalization.
 *
 * Scanning is linear in the input length and allocation-bounded: the value is
 * split on literal separators and each segment is compared with unanchored
 * `startsWith`/`endsWith` checks, so there is no backtracking regex (see
 * `src/core/path-utils.ts` for the same constraint on path trimming).
 */
export function hasCredentialShapedMaterial(value: string, strictness: CredentialScreenStrictness): boolean {
  const normalized = decodeCredentialCandidate(value);
  if (normalized === undefined) return true;
  if (strictness === "identity" && matchesCredentialVocabulary(normalized)) return true;
  for (const segment of normalized.split(CREDENTIAL_SEGMENT_SEPARATORS)) {
    const separator = assignmentIndex(segment);
    if (separator >= 0 && matchesCredentialVocabulary(segment.slice(0, separator))) return true;
  }
  return false;
}

/** Index of the first `=` or `:` in `segment`, or `-1`. Linear scan, no regex. */
function assignmentIndex(segment: string): number {
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code === 61 /* '=' */ || code === 58 /* ':' */) return index;
  }
  return -1;
}

export function hasCredentialQuery(parameters: URLSearchParams): boolean {
  return [...parameters.keys()].some(isCredentialQueryName);
}

export function deleteQueryNames(url: URL, names: ReadonlySet<string>): void {
  for (const name of [...url.searchParams.keys()]) {
    if (names.has(name.toLowerCase())) url.searchParams.delete(name);
  }
}

/** Stable key/value ordering for credential-free service identity and provenance. */
export function canonicalizeUrlQuery(url: URL): void {
  const entries = [...url.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
  url.search = "";
  for (const [name, value] of entries) url.searchParams.append(name, value);
}
