export type EsriRequestResponseTypeCompat = "json" | "text" | "blob" | "array-buffer";

export interface EsriRequestCompatOptions {
  method?: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  responseType?: EsriRequestResponseTypeCompat;
  signal?: AbortSignal;
}

export interface EsriRequestCompatResponse<TData = unknown> {
  data: TData;
  url: string;
  status: number;
  headers: Headers;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SAFE_REDIRECTS = 20;

/**
 * Fetch that never auto-follows a cross-origin redirect.
 *
 * `esriRequest` replays caller-supplied auth headers (e.g. `X-API-Key`,
 * `X-Esri-Authorization`). The default `redirect: "follow"` forwards those
 * custom headers across a 30x to an attacker-supplied `Location` host, leaking
 * the credentials. Mirroring the core client's `fetchWithSafeRedirects`, this
 * issues every request with `redirect: "manual"` and only follows a redirect
 * whose target origin still matches the original request origin. Cross-origin
 * (and opaque) redirects throw before the credentialed request is replayed.
 */
async function fetchWithSafeRedirects(url: string, init: RequestInit): Promise<Response> {
  // Resolve against the document base when the caller passed a relative URL
  // (browser usage). When no absolute origin can be derived (e.g. a relative
  // URL under Node), origin-guarding is skipped — but `fetch` itself requires
  // an absolute URL there, so a relative request only resolves in a browser
  // where the base is available.
  const documentBase = (globalThis as { location?: { href?: string } }).location?.href;
  let originalOrigin: string | undefined;
  let currentUrl = url;
  try {
    const absolute = new URL(url, documentBase);
    originalOrigin = absolute.origin;
    currentUrl = absolute.toString();
  } catch {
    originalOrigin = undefined;
  }
  let currentInit: RequestInit = init;

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(currentUrl, { ...currentInit, redirect: "manual" });

    if (response.type === "opaqueredirect") {
      throw new Error(
        "esriRequest: refusing to follow an opaque cross-origin redirect; the request's auth headers would be leaked to the redirect target.",
      );
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (redirects >= MAX_SAFE_REDIRECTS) {
      throw new Error(`esriRequest: exceeded the maximum of ${MAX_SAFE_REDIRECTS} redirects.`);
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    const nextUrl = new URL(location, currentUrl);
    if (originalOrigin !== undefined && nextUrl.origin !== originalOrigin) {
      throw new Error(
        `esriRequest: refusing to follow a cross-origin redirect to ${nextUrl.origin}; the request's auth headers would be leaked.`,
      );
    }

    // Apply the standard Fetch redirect method/body rewriting: 303 always
    // becomes GET; 301/302 turn a non-GET/HEAD into GET, dropping the body.
    const method = (currentInit.method ?? "GET").toUpperCase();
    const downgradeToGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD");
    currentInit = downgradeToGet ? { ...currentInit, method: "GET", body: null } : currentInit;
    currentUrl = nextUrl.toString();

    // Drain the redirect body so the underlying connection can be reused.
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function esriRequest<TData = unknown>(
  url: string,
  options: EsriRequestCompatOptions = {},
): Promise<EsriRequestCompatResponse<TData>> {
  const finalUrl = appendQuery(url, options.query);
  const method = options.method?.toUpperCase() ?? "GET";
  const responseType = options.responseType ?? "json";

  const response = await fetchWithSafeRedirects(finalUrl, {
    method,
    headers: options.headers,
    body: options.body ?? undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`esriRequest failed (${response.status}): ${detail}`);
  }

  const data = (await parseResponseBody(response, responseType)) as TData;
  return {
    data,
    url: response.url,
    status: response.status,
    headers: response.headers,
  };
}

function appendQuery(urlText: string, query: Record<string, string | number | boolean> | undefined): string {
  if (!query || Object.keys(query).length === 0) {
    return urlText;
  }

  const hashIndex = urlText.indexOf("#");
  const hash = hashIndex >= 0 ? urlText.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? urlText.slice(0, hashIndex) : urlText;

  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const existingQuery = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  const url = new URLSearchParams(existingQuery);
  for (const [key, value] of Object.entries(query)) {
    url.set(key, String(value));
  }
  const nextQuery = url.toString();
  const withQuery = nextQuery.length > 0 ? `${path}?${nextQuery}` : path;
  return `${withQuery}${hash}`;
}

async function parseResponseBody(response: Response, responseType: EsriRequestResponseTypeCompat): Promise<unknown> {
  switch (responseType) {
    case "text":
      return response.text();
    case "blob":
      return response.blob();
    case "array-buffer":
      return response.arrayBuffer();
    default:
      return response.json();
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      return JSON.stringify(payload);
    }
    const text = await response.text();
    return text || response.statusText;
  } catch {
    return response.statusText || "request failed";
  }
}
