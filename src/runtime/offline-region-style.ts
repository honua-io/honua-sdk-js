/**
 * Rewriting a style's tile templates onto the `offline-region://` scheme.
 *
 * A persisted region can only answer what it was addressed for, so pointing a
 * style at one is a narrow, mechanical edit: replace a source's single XYZ tile
 * template with `offline-region://<tileMatrixSetId>/{z}/{x}/{y}`. Everything
 * else — TileJSON `url` members, GeoJSON `data`, sprites, glyphs, layer paint —
 * is left exactly as authored.
 *
 * The rewrite is lossless and reversible: it returns a new style plus a record of
 * every replacement, and {@link revertOfflineRegionStyleRewrite} restores the
 * original byte-for-byte. Anything it cannot rewrite *exactly* is refused with a
 * reason rather than guessed at, because a style that silently kept its network
 * template would render live tiles while the application believed it was reading
 * from a region.
 *
 * @module
 */

import { OFFLINE_REGION_PROTOCOL_SCHEME } from "./offline-region-protocol.js";

/** Source types whose `tiles` templates address XYZ tiles. */
const TILE_SOURCE_TYPES = new Set(["vector", "raster", "raster-dem"]);

/** Placeholders the offline tile handler can answer. Anything else is refused. */
const SUPPORTED_PLACEHOLDERS = new Set(["z", "x", "y"]);

export type OfflineRegionStyleRefusalReason =
  /** No source with this id exists in the style. */
  | "unknown-source"
  /** The source is not a tile source (`geojson`, `image`, `video`, …). */
  | "not-a-tile-source"
  /** The source addresses tiles only through a TileJSON `url`, which a region does not serve. */
  | "tilejson-url-only"
  /** The source carries both `url` and `tiles`; which one MapLibre uses is not ours to decide. */
  | "ambiguous-tile-source"
  /** The source has no single tile template to replace. */
  | "multiple-tile-templates"
  /** The template is not a plain `{z}/{x}/{y}` address. */
  | "unsupported-tile-template"
  /** The template already addresses the offline scheme. */
  | "already-rewritten";

export interface OfflineRegionStyleRefusalV1 {
  readonly sourceId: string;
  readonly reason: OfflineRegionStyleRefusalReason;
  readonly detail: string;
}

/** One replacement, carrying exactly what is needed to undo it. */
export interface OfflineRegionStyleRewriteEntryV1 {
  readonly sourceId: string;
  readonly member: "tiles";
  readonly index: number;
  readonly from: string;
  readonly to: string;
}

export interface OfflineRegionStyleRewriteV1<TStyle = unknown> {
  /** A new style. The input is never mutated. */
  readonly style: TStyle;
  readonly rewrites: readonly OfflineRegionStyleRewriteEntryV1[];
  readonly refusals: readonly OfflineRegionStyleRefusalV1[];
}

export interface RewriteStyleTilesForOfflineRegionOptions {
  /** Style source ids to serve from the region. Only these are considered. */
  readonly sourceIds: readonly string[];
  /** Tile-matrix-set segment of the rewritten URL. Defaults to `"default"`. */
  readonly tileMatrixSetId?: string;
  /** Protocol scheme. Defaults to `"offline-region"`. */
  readonly scheme?: string;
}

interface MutableStyle {
  sources?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Point the named tile sources at a persisted offline region.
 *
 * Rewrites only `sources[id].tiles[0]`, and only when that source is a
 * `vector`, `raster`, or `raster-dem` source whose single template is a plain
 * `{z}`/`{x}`/`{y}` address. Every other shape is refused; the caller decides
 * whether a refusal is fatal.
 */
export function rewriteStyleTilesForOfflineRegion<TStyle>(
  style: TStyle,
  options: RewriteStyleTilesForOfflineRegionOptions,
): OfflineRegionStyleRewriteV1<TStyle> {
  const sourceIds = options?.sourceIds;
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw new TypeError("rewriteStyleTilesForOfflineRegion requires at least one style source id.");
  }
  const scheme = options.scheme ?? OFFLINE_REGION_PROTOCOL_SCHEME;
  const tileMatrixSetId = options.tileMatrixSetId ?? "default";
  if (tileMatrixSetId.length === 0 || tileMatrixSetId.includes("/")) {
    throw new TypeError("tileMatrixSetId must be a non-empty path segment.");
  }
  const target = `${scheme}://${tileMatrixSetId}/{z}/{x}/{y}`;

  const sources = (style as MutableStyle | null | undefined)?.sources;
  const rewrites: OfflineRegionStyleRewriteEntryV1[] = [];
  const refusals: OfflineRegionStyleRefusalV1[] = [];
  const replacements = new Map<string, unknown>();

  for (const sourceId of sourceIds) {
    const source = sources && typeof sources === "object" ? (sources as Record<string, unknown>)[sourceId] : undefined;
    const refusal = classify(sourceId, source, scheme);
    if (refusal) {
      refusals.push(refusal);
      continue;
    }
    const record = source as { readonly tiles: readonly string[] };
    rewrites.push({ sourceId, member: "tiles", index: 0, from: record.tiles[0] as string, to: target });
    replacements.set(sourceId, { ...(record as object), tiles: [target] });
  }

  if (replacements.size === 0) {
    return { style, rewrites, refusals };
  }
  const nextSources: Record<string, unknown> = { ...(sources as Record<string, unknown>) };
  for (const [sourceId, source] of replacements) nextSources[sourceId] = source;
  return { style: { ...(style as object), sources: nextSources } as TStyle, rewrites, refusals };
}

/**
 * Undo a rewrite, restoring every original template exactly.
 *
 * Applying this to the style a rewrite produced yields a style deep-equal to the
 * one that went in, which is what makes the offline binding safe to apply to a
 * package a host still owns.
 */
export function revertOfflineRegionStyleRewrite<TStyle>(
  style: TStyle,
  rewrite: Pick<OfflineRegionStyleRewriteV1, "rewrites">,
): TStyle {
  const entries = rewrite?.rewrites ?? [];
  if (entries.length === 0) return style;
  const sources = (style as MutableStyle | null | undefined)?.sources;
  if (!sources || typeof sources !== "object") {
    throw new TypeError("Cannot revert an offline-region rewrite against a style without sources.");
  }
  const nextSources: Record<string, unknown> = { ...(sources as Record<string, unknown>) };
  for (const entry of entries) {
    const source = nextSources[entry.sourceId] as { tiles?: readonly string[] } | undefined;
    const current = source?.tiles?.[entry.index];
    if (current !== entry.to) {
      throw new TypeError(
        `Style source "${entry.sourceId}" no longer carries the rewritten tile template; refusing a partial revert.`,
      );
    }
    const tiles = [...(source?.tiles ?? [])];
    tiles[entry.index] = entry.from;
    nextSources[entry.sourceId] = { ...(source as object), tiles };
  }
  return { ...(style as object), sources: nextSources } as TStyle;
}

function classify(sourceId: string, source: unknown, scheme: string): OfflineRegionStyleRefusalV1 | undefined {
  if (!source || typeof source !== "object") {
    return refuse(sourceId, "unknown-source", "The style declares no source with this id.");
  }
  const record = source as { type?: unknown; url?: unknown; tiles?: unknown };
  if (typeof record.type !== "string" || !TILE_SOURCE_TYPES.has(record.type)) {
    return refuse(
      sourceId,
      "not-a-tile-source",
      `Only vector, raster, and raster-dem sources address tiles; this source is "${String(record.type)}".`,
    );
  }
  const hasTiles = Array.isArray(record.tiles);
  if (record.url !== undefined && hasTiles) {
    return refuse(
      sourceId,
      "ambiguous-tile-source",
      "The source carries both a TileJSON url and a tiles array; remove one before binding it to a region.",
    );
  }
  if (!hasTiles) {
    return refuse(
      sourceId,
      "tilejson-url-only",
      "The source addresses tiles through a TileJSON url, which a persisted region does not serve.",
    );
  }
  const tiles = record.tiles as readonly unknown[];
  if (tiles.length !== 1 || typeof tiles[0] !== "string") {
    return refuse(
      sourceId,
      "multiple-tile-templates",
      `Exactly one string tile template can be bound to a region; this source declares ${tiles.length}.`,
    );
  }
  const template = tiles[0] as string;
  if (template.startsWith(`${scheme}://`)) {
    return refuse(sourceId, "already-rewritten", "The source already addresses the offline-region scheme.");
  }
  const placeholders = collectPlaceholders(template);
  const missing = ["z", "x", "y"].filter((name) => !placeholders.has(name));
  if (missing.length > 0) {
    return refuse(
      sourceId,
      "unsupported-tile-template",
      `The template is missing the ${missing.join(", ")} placeholder(s) a region addresses tiles by.`,
    );
  }
  for (const placeholder of placeholders) {
    if (!SUPPORTED_PLACEHOLDERS.has(placeholder)) {
      return refuse(
        sourceId,
        "unsupported-tile-template",
        `The template uses the {${placeholder}} placeholder, which a persisted region cannot address.`,
      );
    }
  }
  return undefined;
}

/** Bounded linear scan for `{name}` placeholders; deliberately not a regex. */
function collectPlaceholders(template: string): ReadonlySet<string> {
  const found = new Set<string>();
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf("{", index);
    if (open < 0) break;
    const close = template.indexOf("}", open + 1);
    if (close < 0) break;
    found.add(template.slice(open + 1, close));
    index = close + 1;
  }
  return found;
}

function refuse(
  sourceId: string,
  reason: OfflineRegionStyleRefusalReason,
  detail: string,
): OfflineRegionStyleRefusalV1 {
  return { sourceId, reason, detail };
}
