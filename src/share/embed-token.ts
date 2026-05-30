/**
 * Fragment-only embed-token parsing.
 *
 * Embed bearer tokens MUST travel in the URL fragment (`#...`), never the query
 * string. The fragment is not sent to the origin server, is not written to
 * server access logs or the `Referer` header, and is not captured by most
 * proxy/CDN request logging — so a fragment-borne bearer token has a much
 * smaller disclosure surface than a query-string one. This helper extracts a
 * token from the fragment and *rejects* query-string bearer patterns outright
 * so a generated app or embed never silently accepts a leak-prone placement.
 *
 * @module
 */

/** Default fragment parameter name an embed token is read from. */
export const HONUA_EMBED_TOKEN_FRAGMENT_PARAM = "embed_token" as const;

/** Why an embed-token parse rejected an input. */
export type HonuaEmbedTokenRejectionReason =
  /** No token was present in the fragment. */
  | "missing"
  /** The token appeared in the query string — a forbidden, leak-prone placement. */
  | "query-string-token"
  /** The fragment held a token-shaped value but it was empty/blank. */
  | "empty"
  /** The input was not a parseable URL or fragment. */
  | "malformed";

/** Successful fragment-only token parse. */
export interface HonuaEmbedTokenParseOk {
  readonly ok: true;
  /** The extracted opaque token value (trimmed, never empty). */
  readonly token: string;
  /** The fragment parameter the token was read from. */
  readonly param: string;
}

/** Rejected token parse — carries a reason but never the offending value. */
export interface HonuaEmbedTokenParseRejected {
  readonly ok: false;
  readonly reason: HonuaEmbedTokenRejectionReason;
}

/** Result of {@link parseEmbedTokenFromFragment}. */
export type HonuaEmbedTokenParseResult = HonuaEmbedTokenParseOk | HonuaEmbedTokenParseRejected;

/** Options for {@link parseEmbedTokenFromFragment}. */
export interface ParseEmbedTokenOptions {
  /**
   * Fragment parameter name(s) to read the token from. Defaults to
   * {@link HONUA_EMBED_TOKEN_FRAGMENT_PARAM}. The same name(s) are also the
   * query-string keys that are rejected if a token is found there.
   */
  readonly param?: string | readonly string[];
}

function normalizeParams(param: ParseEmbedTokenOptions["param"]): readonly string[] {
  if (param === undefined) return [HONUA_EMBED_TOKEN_FRAGMENT_PARAM];
  const list = typeof param === "string" ? [param] : param;
  const names = list.map((name) => name.trim()).filter((name) => name.length > 0);
  return names.length > 0 ? names : [HONUA_EMBED_TOKEN_FRAGMENT_PARAM];
}

/**
 * Splits an arbitrary URL or location-like string into its query and fragment
 * components without requiring an absolute base. Accepts a full URL
 * (`https://host/path?q#frag`), a relative URL (`/path?q#frag`), a bare query
 * (`?q`), or a bare fragment (`#frag`).
 */
function splitLocation(input: string): { query: string; fragment: string } | null {
  if (typeof input !== "string") return null;
  const hashIndex = input.indexOf("#");
  const fragment = hashIndex >= 0 ? input.slice(hashIndex + 1) : "";
  const beforeFragment = hashIndex >= 0 ? input.slice(0, hashIndex) : input;
  const queryIndex = beforeFragment.indexOf("?");
  const query = queryIndex >= 0 ? beforeFragment.slice(queryIndex + 1) : "";
  return { query, fragment };
}

/**
 * Reads a named parameter out of a `&`/`=` encoded component (query or
 * fragment). Returns the first match's decoded value, or `null` if absent. A
 * present-but-empty parameter (`embed_token=`) returns an empty string so the
 * caller can distinguish "absent" from "blank".
 */
function readParam(component: string, names: readonly string[]): string | null {
  if (component.length === 0) return null;
  const params = new URLSearchParams(component);
  for (const name of names) {
    if (params.has(name)) return params.get(name) ?? "";
  }
  return null;
}

/**
 * Extracts an embed bearer token from a URL/location fragment, rejecting any
 * token placed in the query string.
 *
 * Resolution order:
 * 1. If a token parameter is present in the **query string**, reject with
 *    `query-string-token` — even if a fragment token also exists — so a
 *    leak-prone placement is never silently tolerated.
 * 2. Otherwise read the token from the **fragment**. A blank fragment token
 *    rejects with `empty`; a missing one rejects with `missing`.
 *
 * @param input A full or relative URL, a bare query, or a bare fragment. In a
 *   browser, pass `window.location.href` (or `location.search + location.hash`).
 */
export function parseEmbedTokenFromFragment(
  input: string,
  options: ParseEmbedTokenOptions = {},
): HonuaEmbedTokenParseResult {
  const names = normalizeParams(options.param);
  const parts = splitLocation(input);
  if (parts === null) return { ok: false, reason: "malformed" };

  // (1) Reject query-string bearer tokens unconditionally.
  const queryToken = readParam(parts.query, names);
  if (queryToken !== null) {
    return { ok: false, reason: "query-string-token" };
  }

  // (2) Read from the fragment.
  const fragmentToken = readParam(parts.fragment, names);
  if (fragmentToken === null) return { ok: false, reason: "missing" };

  const trimmed = fragmentToken.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };

  return { ok: true, token: trimmed, param: names[0] };
}

/**
 * Convenience guard: `true` when `input` carries an embed-token parameter in the
 * query string (any leak-prone placement). Useful for asserting a redirect
 * stripped the token before it reached a logged surface.
 */
export function hasQueryStringEmbedToken(input: string, options: ParseEmbedTokenOptions = {}): boolean {
  const names = normalizeParams(options.param);
  const parts = splitLocation(input);
  if (parts === null) return false;
  return readParam(parts.query, names) !== null;
}
