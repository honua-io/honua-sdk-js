/** Internal credential rejection and canonical query helpers for discovery URLs. */

const CREDENTIAL_QUERY_TOKENS = new Set([
  "auth",
  "authorization",
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
const CREDENTIAL_QUERY_SUFFIXES = [
  "accountkey",
  "accesskey",
  "apikey",
  "consumerkey",
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
  return normalized.split(/[&;?#]/u).some((part) => {
    const candidate = part.split(/[=:]/u, 1)[0]?.trim() ?? "";
    const token = candidate.replace(/[^a-z0-9]/gu, "");
    return (
      CREDENTIAL_QUERY_TOKENS.has(token) ||
      token.startsWith("xamz") ||
      token.startsWith("xgoog") ||
      CREDENTIAL_QUERY_SUFFIXES.some((suffix) => token.endsWith(suffix))
    );
  });
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
