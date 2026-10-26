/**
 * Transport-security guards for credentialed Honua endpoints.
 *
 * The SDK attaches static credentials (`X-API-Key`, `Authorization: Bearer`)
 * and credential-provider output to every request it sends to `baseUrl`. Over
 * plain `http://` those secrets travel in cleartext, so a credentialed client
 * is refused unless the endpoint is a loopback development host or the caller
 * opts in explicitly.
 */

/**
 * `true` when `hostname` (as produced by the WHATWG `URL` parser) names the
 * local machine: `localhost`, any IPv4 address in `127.0.0.0/8`, or the IPv6
 * loopback `::1` (with or without brackets).
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  const octets = normalized.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/**
 * `true` when `url` is an absolute `http:` URL whose host is not loopback,
 * i.e. a cleartext endpoint on which credentials must not be sent. Relative
 * and unparsable values return `false`: a relative `baseUrl` inherits the
 * embedding page's origin, which the SDK does not control.
 */
export function isInsecureRemoteHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname);
}

/**
 * Throw when credentials are configured for a non-loopback `http://` base URL
 * and the caller has not opted in with `allowInsecureHttp`.
 *
 * @param baseUrl - The configured base URL.
 * @param credentialSources - Human-readable names of the configured credential
 *   options (for example `["apiKey", "auth"]`); empty means no credentials.
 * @param allowInsecureHttp - Explicit opt-in to send credentials in cleartext.
 */
export function assertSecureCredentialedBaseUrl(
  baseUrl: string,
  credentialSources: readonly string[],
  allowInsecureHttp: boolean,
): void {
  if (allowInsecureHttp || credentialSources.length === 0 || !isInsecureRemoteHttpUrl(baseUrl)) {
    return;
  }
  throw new Error(
    `HonuaClient refuses to send credentials (${credentialSources.join(", ")}) over plain HTTP to a non-loopback host: ${baseUrl}. Use an https:// baseUrl, use localhost / 127.0.0.0/8 / [::1] for local development, or pass allowInsecureHttp: true to opt in explicitly.`,
  );
}
