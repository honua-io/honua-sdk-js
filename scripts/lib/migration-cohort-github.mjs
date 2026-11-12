// Origin-bound GitHub reads for migration-cohort verification.
// githubBacklogRequest requires a token and only allows issue URLs.
// githubRequest follows redirects and reads GITHUB_TOKEN. Neither can keep
// local runs anonymous while still refusing another host's body as proof.
// Node fetch follows cross-origin redirects, so trusted reads stay manual.

const GITHUB_API_ORIGIN = "https://api.github.com";
const TOKEN_ENV = "HONUA_MIGRATION_GITHUB_TOKEN";
const TOKEN_ERROR = "migration GitHub token is not usable";
const ORIGIN_ERROR = "migration GitHub API origin is not usable";
const MAX_TOKEN_LENGTH = 1024;
const MAX_REDIRECTS = 5;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/u;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function migrationGitHubToken(env = process.env) {
  if (env === null || typeof env !== "object" || !Object.hasOwn(env, TOKEN_ENV)) return undefined;
  return normalizeToken(env[TOKEN_ENV]);
}

function normalizeToken(value) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(value)) {
    throw new Error(TOKEN_ERROR);
  }
  return value;
}

function migrationApiOrigin(apiOrigin) {
  if (apiOrigin === undefined || apiOrigin === GITHUB_API_ORIGIN) return GITHUB_API_ORIGIN;
  let url;
  try {
    url = new URL(apiOrigin);
  } catch {
    throw new Error(ORIGIN_ERROR);
  }
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!loopback || url.username || url.password || url.hash || url.search || url.pathname !== "/") {
    throw new Error(ORIGIN_ERROR);
  }
  return url.origin;
}

function isTrustedApiUrl(url, origin) {
  return url.origin === origin && url.username === "" && url.password === "" && url.hash === "";
}

function withoutCredentials(headers) {
  const next = new Headers(headers);
  next.delete("authorization");
  next.delete("proxy-authorization");
  return next;
}

export function migrationCohortFailureMessage(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof token !== "string" || token.length === 0 || !message.includes(token)) return message;
  return message.split(token).join("[redacted]");
}

export function migrationCohortDiagnostic(error) {
  try {
    return migrationCohortFailureMessage(error, migrationGitHubToken());
  } catch (tokenError) {
    return tokenError instanceof Error ? tokenError.message : TOKEN_ERROR;
  }
}

function redactError(error, token) {
  return new Error(migrationCohortFailureMessage(error, token));
}

function tokenFrom(options) {
  if (options && Object.hasOwn(options, "token")) return normalizeToken(options.token);
  return migrationGitHubToken();
}

function targetString(value) {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return String(value);
}

async function releaseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Redirect bodies are not publication proof.
  }
}

function closedRedirect(response) {
  return new Response(null, { status: response.status });
}

function nextTrustedUrl(current, location, origin) {
  if (typeof location !== "string" || location.length === 0) return undefined;
  try {
    const next = new URL(location, current);
    return isTrustedApiUrl(next, origin) ? next : undefined;
  } catch {
    return undefined;
  }
}

async function fetchUntrusted(request) {
  try {
    return await request.fetchImpl(request.target, {
      ...request.init,
      headers: withoutCredentials(request.init?.headers),
    });
  } catch (error) {
    throw redactError(error, request.token);
  }
}

async function fetchTrusted(request) {
  let current = request.current;
  let target = request.target;
  for (let redirects = 0; ; redirects += 1) {
    const headers = withoutCredentials(request.init?.headers);
    if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json");
    if (request.token) headers.set("authorization", `Bearer ${request.token}`);
    let response;
    try {
      response = await request.fetchImpl(target, {
        ...request.init,
        method: "GET",
        headers,
        redirect: "manual",
      });
    } catch (error) {
      throw redactError(error, request.token);
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers?.get("location");
    const next = redirects >= MAX_REDIRECTS ? undefined : nextTrustedUrl(current, location, request.origin);
    await releaseBody(response);
    if (!next) return closedRedirect(response);
    current = next;
    target = next.href;
  }
}

export async function migrationCohortFetch(url, init = {}, options = {}) {
  const token = tokenFrom(options);
  const origin = migrationApiOrigin(options.apiOrigin);
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw redactError(error, token);
  }
  const request = {
    fetchImpl: options.fetchImpl ?? fetch,
    init,
    token,
    origin,
    current: parsed,
    target: targetString(url),
  };
  if (!isTrustedApiUrl(parsed, origin)) return fetchUntrusted(request);
  return fetchTrusted(request);
}
