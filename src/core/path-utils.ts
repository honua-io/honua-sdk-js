/**
 * Linear-time string trimming helpers used for URL and path normalization.
 *
 * These intentionally avoid regular expressions such as `\/+$` or `^\/+`.
 * Anchored quantifier regexes over repeated characters can exhibit
 * super-linear (polynomial) matching on adversarial input, so the helpers
 * below scan from the relevant end with simple index arithmetic, which is
 * always O(n) regardless of input shape.
 */

/** Remove every trailing `/` character from `value`. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

/** Remove every leading `/` character from `value`. */
export function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47 /* '/' */) {
    start += 1;
  }
  return start === 0 ? value : value.slice(start);
}

/** Remove every leading and trailing `/` character from `value`. */
export function trimSurroundingSlashes(value: string): string {
  return trimTrailingSlashes(trimLeadingSlashes(value));
}

/**
 * Remove leading and trailing runs of `char` from `value`.
 *
 * `char` must be a single-character string; only its first code unit is
 * considered. Used for slug/identifier normalization (e.g. stripping `-`
 * or `_` padding) without anchored `^x+|x+$` regexes.
 */
export function trimChar(value: string, char: string): string {
  const code = char.charCodeAt(0);
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === code) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === code) {
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

/**
 * Return `value` with any `?query` and `#fragment` suffix removed.
 *
 * Equivalent to `value.replace(/[?#].*$/, "")` but uses `indexOf` slicing
 * so it stays linear and cannot backtrack.
 */
export function stripQueryAndFragment(value: string): string {
  let cut = -1;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 63 /* '?' */ || code === 35 /* '#' */) {
      cut = i;
      break;
    }
  }
  return cut < 0 ? value : value.slice(0, cut);
}

/**
 * Return `value` with any `?query` suffix removed (the fragment, if present,
 * is preserved). Equivalent to `value.replace(/\?.*$/, "")`.
 */
export function stripQuery(value: string): string {
  const index = value.indexOf("?");
  return index < 0 ? value : value.slice(0, index);
}

/**
 * Percent-encode a path that may contain `/` separators, encoding each
 * segment independently so the separators survive.
 *
 * `encodeURIComponent("a/b")` returns `a%2Fb`, which is wrong for
 * folder-prefixed identifiers such as `myFolder/parcels` that must serialize
 * as `myFolder/parcels` on the wire. Splitting on `/` and encoding each
 * segment keeps the separators literal while still escaping reserved
 * characters inside each segment. Empty segments (leading/trailing/double
 * slashes) are preserved verbatim so callers retain full control over the
 * resulting path shape.
 */
export function encodePathSegments(value: string): string {
  if (!value.includes("/")) {
    return encodeURIComponent(value);
  }
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
