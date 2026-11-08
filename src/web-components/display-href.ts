/** Resolve a display link without carrying credentials or unsafe schemes. */
export function sanitizeDisplayHref(
  value: string,
  options: { readonly baseHref?: string; readonly allowedOrigins?: readonly string[] } = {},
): string | undefined {
  try {
    const url = options.baseHref ? new URL(value, options.baseHref) : new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    const allowed = options.allowedOrigins;
    if (allowed && allowed.length > 0 && !allowed.includes(url.origin)) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}
