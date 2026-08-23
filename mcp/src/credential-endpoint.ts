/** Validate a credential-bearing HTTP endpoint before any transport is created. */
export function requireSecureCredentialEndpoint(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not include embedded credentials, query parameters, or a fragment`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(`${label} requires HTTPS except for exact loopback HTTP development endpoints`);
  }
  return url;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
