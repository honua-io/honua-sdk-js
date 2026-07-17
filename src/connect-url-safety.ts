/** Internal credential rejection and canonical query helpers for discovery URLs. */

const CREDENTIAL_QUERY_NAMES = new Set([
  "access-token",
  "access_token",
  "apikey",
  "api-key",
  "api_key",
  "auth",
  "authorization",
  "awsaccesskeyid",
  "bearer",
  "client-secret",
  "client_secret",
  "code",
  "credential",
  "googleaccessid",
  "id-token",
  "id_token",
  "jwt",
  "key",
  "key-pair-id",
  "ocp-apim-subscription-key",
  "password",
  "passwd",
  "policy",
  "refresh-token",
  "refresh_token",
  "sas",
  "secret",
  "securitytoken",
  "session",
  "session-id",
  "session_id",
  "sessionid",
  "sig",
  "signature",
  "subscription-key",
  "subscription_key",
  "token",
  "x-api-key",
]);

/** URLSearchParams has already percent-decoded names before this check. */
export function isCredentialQueryName(name: string): boolean {
  let normalized = name.trim().toLowerCase();
  for (let depth = 0; depth < 4 && /%[0-9a-f]{2}/i.test(normalized); depth += 1) {
    try {
      const decoded = decodeURIComponent(normalized).trim().toLowerCase();
      if (decoded === normalized) break;
      normalized = decoded;
    } catch {
      return true;
    }
  }
  // More than four encoding layers is never required for a legitimate
  // service parameter and must not bypass a credential-name comparison.
  if (/%[0-9a-f]{2}/i.test(normalized)) return true;
  return CREDENTIAL_QUERY_NAMES.has(normalized) || normalized.startsWith("x-amz-") || normalized.startsWith("x-goog-");
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
