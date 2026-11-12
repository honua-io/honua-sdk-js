const CREDENTIAL_QUERY_KEYS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "awsaccesskeyid",
  "bearer",
  "bearertoken",
  "clientsecret",
  "code",
  "credential",
  "expires",
  "googleaccessid",
  "idtoken",
  "jwt",
  "key",
  "keypairid",
  "password",
  "passwd",
  "privatekey",
  "policy",
  "pwd",
  "refreshtoken",
  "sas",
  "secret",
  "se",
  "session",
  "sessionid",
  "sig",
  "signature",
  "sp",
  "subscriptionkey",
  "sv",
  "token",
]);

/** Return whether a URL is safe to embed in a browser-owned tile source. */
export function isSafeBrowserTileEndpoint(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) {
      return false;
    }
    return [...url.searchParams.keys()].every((key) => !isCredentialQueryKey(key));
  } catch {
    return false;
  }
}

function isCredentialQueryKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return CREDENTIAL_QUERY_KEYS.has(normalized) || normalized.startsWith("xamz") || normalized.startsWith("xgoog");
}
