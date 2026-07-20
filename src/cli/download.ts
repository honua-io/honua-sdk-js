/**
 * Credential-safe binary download for CLI verbs that fetch server-supplied
 * URLs (exported map images, tiles).
 *
 * The SDK attaches the API key as a custom `X-API-Key` header. The Fetch /
 * undici runtime only strips `Authorization` / `Cookie` / `Host` on a
 * cross-origin redirect, so a custom auth header like `X-API-Key` would
 * otherwise be replayed to an attacker-controlled `Location` host. The
 * `export` response additionally returns a fully server-controlled `href`,
 * which a malicious or compromised server could point at another origin.
 *
 * This helper mirrors `HonuaClient.fetchWithSafeRedirects` /
 * `HonuaGeocodingClient.fetchWithSafeRedirects`: it (a) only attaches the API
 * key when the resolved URL origin equals the configured server origin, and
 * (b) issues `redirect: "manual"` so every hop recomputes that decision.
 * Cross-origin download hops remain usable, but never receive the credential.
 *
 * @packageDocumentation
 */

/** HTTP status codes that carry a `Location` redirect header. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Conventional browser / undici redirect cap. */
const MAX_REDIRECTS = 20;

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Download `url` and return the response body as bytes. The API key is only
 * sent when the current hop is same-origin with `baseUrl`; redirects are
 * followed manually and the credential decision is recomputed for every hop.
 *
 * @throws if the redirect chain is too long or the final response is not `ok`.
 */
export async function downloadCredentialedResource(
  url: string,
  options: { baseUrl?: string; apiKey?: string },
): Promise<Buffer> {
  const baseOrigin = originOf(options.baseUrl);

  let currentUrl = url;
  for (let redirects = 0; ; redirects += 1) {
    // Only attach the credential when the request stays on the configured
    // server origin, so a cross-origin href never receives the API key.
    const sameOrigin = baseOrigin !== undefined && originOf(currentUrl) === baseOrigin;
    const init: RequestInit = {
      redirect: "manual",
      ...(sameOrigin && options.apiKey ? { headers: { "X-API-Key": options.apiKey } } : {}),
    };
    const res = await fetch(currentUrl, init);

    if (res.type === "opaqueredirect") {
      // A browser-style opaque redirect hides Location, so it cannot be
      // advanced manually. Retry that hop with automatic redirects and no
      // headers at all: the destination remains usable without risking the
      // custom API key. Node/undici normally exposes Location and uses the
      // ordinary manual path below.
      await res.body?.cancel().catch(() => undefined);
      const uncredentialed = await fetch(currentUrl, { redirect: "follow" });
      if (!uncredentialed.ok) {
        throw new Error(
          `Failed to download resource (${uncredentialed.status} ${uncredentialed.statusText}) from ${currentUrl}`,
        );
      }
      return Buffer.from(await uncredentialed.arrayBuffer());
    }

    if (!REDIRECT_STATUSES.has(res.status)) {
      if (!res.ok) {
        throw new Error(`Failed to download resource (${res.status} ${res.statusText}) from ${currentUrl}`);
      }
      return Buffer.from(await res.arrayBuffer());
    }

    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Exceeded the maximum of ${MAX_REDIRECTS} redirects while downloading ${url}.`);
    }

    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`Redirect response from ${currentUrl} is missing a Location header.`);
    }
    let target: URL;
    try {
      target = new URL(location, currentUrl);
    } catch {
      throw new Error(`Redirect response has an invalid Location header: ${location}`);
    }
    await res.body?.cancel().catch(() => undefined);
    currentUrl = target.toString();
  }
}
