import { isSafeBrowserTileEndpoint } from "./browser-tile-endpoint.js";

/** Internal validation shared by discovery, cache reads, and native map projection. */
export function isOgcVectorTileTemplate(value: unknown): value is string {
  if (typeof value !== "string" || !["{z}", "{x}", "{y}"].every((token) => value.includes(token))) return false;
  if (/[{}]/.test(value.replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0"))) return false;
  return isSafeBrowserTileEndpoint(value);
}
