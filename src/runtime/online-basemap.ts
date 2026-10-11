/**
 * Explicit online basemap policy for browser samples and installed consumers.
 * Importing this module never fetches styles or constructs a map.
 *
 * Public endpoints are mutable services, not reproducible offline snapshots.
 * Use reviewed local styles and assets in deterministic and offline lanes.
 */

/** Free, keyless defaults. Override these URLs to use a self-hosted provider. */
export const HONUA_ONLINE_BASEMAP_STYLES = Object.freeze({
  positron: "https://tiles.openfreemap.org/styles/positron",
  liberty: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
});

export type HonuaOnlineBasemapTheme = keyof typeof HONUA_ONLINE_BASEMAP_STYLES;

export interface HonuaOnlineBasemapOptions {
  /** Positron suits thematic maps; Liberty provides detailed street context. */
  readonly theme?: HonuaOnlineBasemapTheme;
  /** Explicit custom/self-hosted style, taking precedence over theme defaults. */
  readonly styleUrl?: string;
}

/** Resolve the online policy without starting any network request. */
export function resolveHonuaOnlineBasemapStyle(options: HonuaOnlineBasemapOptions = {}): string {
  if (options.styleUrl !== undefined) {
    const override = options.styleUrl.trim();
    if (!override) throw new Error("The basemap style URL must not be empty.");
    return override;
  }
  return HONUA_ONLINE_BASEMAP_STYLES[options.theme ?? "positron"];
}

import type { HonuaStyleSpecification } from "../style/specification.js";
import { validateRuntimeStyleSpec } from "./style-spec-validation.js";

/** MapLibre operations used without importing the renderer at runtime. */
export interface HonuaOnlineBasemapMap {
  addSource(id: string, source: unknown): unknown;
  removeSource(id: string): unknown;
  getSource(id: string): unknown;
  addLayer(layer: unknown, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  getLayer(id: string): unknown;
  getStyle(): unknown;
  setGlyphs(url: string | null): unknown;
  addSprite(id: string, url: string): unknown;
  removeSprite(id: string): unknown;
  getSprite(): readonly { id: string; url: string }[];
  on(type: "error", listener: (event: unknown) => void): unknown;
  off(type: "error", listener: (event: unknown) => void): unknown;
}

export interface HonuaOnlineBasemapBindingOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Display this actionable message beside the map; operational data stays usable. */
  readonly onError: (message: string) => void;
  readonly onReady?: () => void;
}

let nextBindingId = 0;

/**
 * Adds complete vector basemaps beneath existing operational layers. Theme
 * changes never replace the map style, sources, filters, feature state, camera
 * or popups owned by the host. Only the active basemap is downloaded initially.
 *
 * Call activate after the host's local initial style has loaded. Glyph URLs
 * must agree with an existing host glyph template: overwriting it would change
 * operational labels. Custom styles can use the same template or omit glyphs.
 */
export class HonuaOnlineBasemapBinding {
  readonly #map: HonuaOnlineBasemapMap;
  readonly #options: HonuaOnlineBasemapBindingOptions;
  #active: PreparedBasemap | undefined;
  readonly #prefix = `honua-online-basemap-${++nextBindingId}-`;
  readonly #styles = new Map<string, { value: unknown; baseUrl: string }>();
  #installationId = 0;
  readonly #assetPrefixes = new Set<string>();
  #request: AbortController | undefined;
  #disposed = false;
  #hostGlyphs: string | undefined;
  #hostGlyphsCaptured = false;

  constructor(map: HonuaOnlineBasemapMap, options: HonuaOnlineBasemapBindingOptions) {
    this.#map = map;
    this.#options = options;
    map.on("error", this.#onMapError);
  }

  /** Fetch and activate a theme/override; errors leave the previous base intact. */
  async activate(options: HonuaOnlineBasemapOptions = {}): Promise<boolean> {
    if (this.#disposed) return false;
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    let styleUrl = "";
    try {
      styleUrl = resolveHonuaOnlineBasemapStyle(options);
      if (!this.#hostGlyphsCaptured) {
        const hostGlyphs = object(this.#map.getStyle())?.glyphs;
        this.#hostGlyphs = typeof hostGlyphs === "string" ? hostGlyphs : undefined;
        this.#hostGlyphsCaptured = true;
      }
      let downloaded = this.#styles.get(styleUrl);
      if (!downloaded) {
        const response = await (this.#options.fetch ?? globalThis.fetch)(styleUrl, { signal: request.signal });
        if (!response.ok) throw new Error(`Style request returned HTTP ${response.status}.`);
        const value: unknown = await response.json();
        if (request.signal.aborted || this.#disposed) return false;
        downloaded = { value, baseUrl: response.url || new URL(styleUrl, globalThis.location?.href).href };
      }
      const prepared = await this.#prepare(downloaded.value, downloaded.baseUrl);
      if (request.signal.aborted || this.#disposed) return false;
      this.#install(prepared);
      this.#styles.set(styleUrl, downloaded);
      this.#options.onReady?.();
      return true;
    } catch (error) {
      if (!request.signal.aborted && !this.#disposed) {
        this.#options.onError(this.#failure(error instanceof Error ? error.message : String(error)));
      }
      return false;
    }
  }

  /** Cancel downloads and remove only the sources, layers and sprites we own. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#request?.abort();
    this.#map.off("error", this.#onMapError);
    if (this.#active) {
      this.#remove(this.#active);
      this.#map.setGlyphs(this.#hostGlyphs ?? null);
    }
    this.#active = undefined;
  }

  #failure(detail: string): string {
    return `Basemap unavailable: ${detail} Operational data and controls remain available. Check connectivity or configure a custom/self-hosted basemap style URL.`;
  }

  readonly #onMapError = (event: unknown): void => {
    const record = object(event);
    const sourceId = record?.sourceId;
    const detail = record?.error instanceof Error ? record.error.message : "";
    // An identified operational-source failure belongs to its host, even if
    // its data happens to share a server with the basemap assets.
    if (typeof sourceId === "string" && !sourceId.startsWith(this.#prefix)) return;
    if (typeof sourceId === "string" || [...this.#assetPrefixes].some((prefix) => detail.includes(prefix))) {
      this.#options.onError(this.#failure(detail || "A tile, glyph or sprite request failed."));
    }
  };

  async #prepare(value: unknown, baseUrl: string): Promise<PreparedBasemap> {
    const style = object(value);
    const sources = object(style?.sources);
    if (style?.version !== 8 || !sources || !Array.isArray(style.layers)) {
      throw new Error("Expected a MapLibre version 8 style with sources and layers.");
    }
    const diagnostics = await validateRuntimeStyleSpec(style as unknown as HonuaStyleSpecification, { mode: "strict" });
    const invalid = diagnostics.find((diagnostic) => diagnostic.severity === "error");
    if (invalid) throw new Error(`Invalid basemap style: ${invalid.message}`);
    const id = `${this.#prefix}${++this.#installationId}-`;
    const glyphs = typeof style.glyphs === "string" ? absoluteAsset(style.glyphs, baseUrl) : undefined;
    if (glyphs && this.#hostGlyphs !== undefined && this.#hostGlyphs !== glyphs) {
      throw new Error("Basemap glyphs conflict; use the host glyph template.");
    }
    const spriteDefinitions =
      typeof style.sprite === "string"
        ? [{ id: "default", url: style.sprite }]
        : Array.isArray(style.sprite)
          ? style.sprite
          : [];
    const sprites = spriteDefinitions.map((entry: unknown) => {
      const sprite = object(entry);
      if (typeof sprite?.id !== "string" || typeof sprite.url !== "string")
        throw new Error("Invalid basemap sprite definition.");
      return { id: `${id}${sprite.id}`, url: absoluteAsset(sprite.url, baseUrl) };
    });
    const preparedSources: Record<string, unknown> = {};
    for (const [sourceId, sourceValue] of Object.entries(sources)) {
      const source = object(sourceValue);
      if (!source || typeof source.type !== "string") throw new Error(`Invalid basemap source ${sourceId}.`);
      preparedSources[`${id}${sourceId}`] = {
        ...source,
        ...(typeof source.url === "string" ? { url: absoluteAsset(source.url, baseUrl) } : {}),
        ...(typeof source.data === "string" && source.type === "geojson"
          ? { data: absoluteAsset(source.data, baseUrl) }
          : {}),
        ...(Array.isArray(source.urls) ? { urls: source.urls.map((url: string) => absoluteAsset(url, baseUrl)) } : {}),
        ...(Array.isArray(source.tiles)
          ? { tiles: source.tiles.map((tile: string) => absoluteAsset(tile, baseUrl)) }
          : {}),
      };
    }
    const layers = style.layers.map((layerValue: unknown) => {
      const layer = object(layerValue);
      if (typeof layer?.id !== "string" || typeof layer.type !== "string") throw new Error("Invalid basemap layer.");
      const layout = object(layer.layout);
      const paint = object(layer.paint);
      return {
        ...layer,
        id: `${id}${layer.id}`,
        ...(typeof layer.source === "string" ? { source: `${id}${layer.source}` } : {}),
        ...(layout ? { layout: rewriteImageProperties(layout, id, sprites.length > 0) } : {}),
        ...(paint ? { paint: rewriteImageProperties(paint, id, sprites.length > 0) } : {}),
      };
    });
    const preparedDiagnostics = await validateRuntimeStyleSpec(
      {
        version: 8,
        sources: preparedSources,
        layers,
        ...(glyphs ? { glyphs } : {}),
        ...(sprites.length > 0 ? { sprite: sprites } : {}),
      } as unknown as HonuaStyleSpecification,
      { mode: "strict" },
    );
    const invalidPrepared = preparedDiagnostics.find((diagnostic) => diagnostic.severity === "error");
    if (invalidPrepared) throw new Error(`Invalid prepared basemap style: ${invalidPrepared.message}`);
    return {
      definition: { id, label: id, kind: "vector", sources: preparedSources, layers },
      sprites,
      glyphs,
      baseUrl,
    };
  }

  #remove(prepared: PreparedBasemap): void {
    for (const layer of [...prepared.definition.layers].reverse()) {
      if (this.#map.getLayer(layer.id)) this.#map.removeLayer(layer.id);
    }
    for (const sourceId of Object.keys(prepared.definition.sources)) {
      if (this.#map.getSource(sourceId)) this.#map.removeSource(sourceId);
    }
    for (const sprite of prepared.sprites) {
      if (this.#map.getSprite().some((installed) => installed.id === sprite.id)) this.#map.removeSprite(sprite.id);
    }
  }

  #install(prepared: PreparedBasemap): void {
    // Another SDK module instance or host may already own a generated ID.
    // Check before mutation so rollback can never remove foreign resources.
    for (const id of Object.keys(prepared.definition.sources)) {
      if (this.#map.getSource(id)) throw new Error(`Basemap source namespace collides with an existing source: ${id}.`);
    }
    for (const layer of prepared.definition.layers) {
      if (this.#map.getLayer(layer.id))
        throw new Error(`Basemap layer namespace collides with an existing layer: ${layer.id}.`);
    }
    const installedSprites = new Set(this.#map.getSprite().map((sprite) => sprite.id));
    for (const sprite of prepared.sprites) {
      if (installedSprites.has(sprite.id))
        throw new Error(`Basemap sprite namespace collides with an existing sprite: ${sprite.id}.`);
    }
    const previousGlyphs = object(this.#map.getStyle())?.glyphs;
    try {
      this.#map.setGlyphs(prepared.glyphs ?? this.#hostGlyphs ?? null);
      for (const sprite of prepared.sprites) {
        this.#map.addSprite(sprite.id, sprite.url);
      }
      for (const [id, source] of Object.entries(prepared.definition.sources)) this.#map.addSource(id, source);
      const previousLayers = object(this.#map.getStyle())?.layers;
      const activeIds = new Set(this.#active?.definition.layers.map((layer) => layer.id));
      const anchor = Array.isArray(previousLayers)
        ? previousLayers.find((layer: unknown) => {
            const entry = object(layer);
            return typeof entry?.id === "string" && entry.type !== "background" && !activeIds.has(entry.id);
          })
        : undefined;
      const anchorId = object(anchor)?.id;
      for (const layer of prepared.definition.layers)
        this.#map.addLayer(layer, typeof anchorId === "string" ? anchorId : undefined);
    } catch (error) {
      // A renderer can throw after inserting a resource. The unique namespace
      // lets rollback find even resources it did not return successfully.
      this.#remove(prepared);
      this.#map.setGlyphs(typeof previousGlyphs === "string" ? previousGlyphs : null);
      throw error;
    }
    if (this.#active) this.#remove(this.#active);
    this.#active = prepared;
    this.#assetPrefixes.clear();
    const track = (url: string) => {
      this.#assetPrefixes.add(url.split("{")[0]);
    };
    for (const sprite of prepared.sprites) track(sprite.url);
    if (prepared.glyphs) track(prepared.glyphs);
    track(prepared.baseUrl);
    for (const value of Object.values(prepared.definition.sources)) {
      const source = object(value);
      if (!source) continue;
      for (const key of ["url", "data"]) {
        if (typeof source?.[key] === "string") track(source[key] as string);
      }
      for (const key of ["tiles", "urls"]) {
        if (Array.isArray(source?.[key])) {
          for (const url of source[key] as unknown[]) if (typeof url === "string") track(url);
        }
      }
    }
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function absoluteAsset(value: string, baseUrl: string): string {
  // URL serializes braces, but MapLibre's URL templates require literal tokens.
  return new URL(value, baseUrl).href.replaceAll("%7B", "{").replaceAll("%7D", "}");
}

function spriteName(value: unknown, prefix: string, coerce = false): unknown {
  if (typeof value === "string") return value === "" ? "" : `${prefix}${value.includes(":") ? "" : "default:"}${value}`;
  const name = coerce ? ["to-string", value] : value;
  // Complete provider styles use an empty name to intentionally hide icons.
  // Preserve that sentinel rather than requesting a nonexistent sprite.
  // Keep a nullable string result null so mixed coalesce expressions can try their next branch.
  return [
    "case",
    ["==", ["typeof", value], "null"],
    value,
    ["==", name, ""],
    "",
    [">=", ["index-of", ":", name], 0],
    ["concat", prefix, name],
    ["concat", `${prefix}default:`, name],
  ];
}

function spriteImage(value: unknown, prefix: string, resolvedOutput = true): unknown {
  if (!Array.isArray(value)) return spriteName(value, prefix);
  if (value[0] === "image") return ["image", spriteName(value[1], prefix), ...value.slice(2)];
  // Keep zoom expressions at the root and leave condition inputs and match labels intact.
  const outputs = imageOutputIndices(value);
  if (value[0] !== "coalesce" || isResolvedImageExpression(value)) {
    if (outputs.length) {
      const rewritten = value.map((part, index) =>
        outputs.includes(index) ? spriteImage(part, prefix, resolvedOutput && value[0] !== "coalesce") : part,
      );
      return value[0] === "coalesce" && resolvedOutput ? ["image", ["to-string", rewritten]] : rewritten;
    }
  }
  return spriteName(value, prefix, true);
}

function imageOutputIndices(value: unknown[]): number[] {
  const op = value[0];
  const first =
    op === "coalesce"
      ? 1
      : op === "match"
        ? 3
        : op === "case" || op === "step"
          ? 2
          : typeof op === "string" && op.startsWith("interpolate")
            ? 4
            : 0;
  const indices: number[] = [];
  if (first) for (let i = first; i < value.length; i += op === "coalesce" ? 1 : 2) indices.push(i);
  if (op === "case" || op === "match") indices.push(value.length - 1);
  return indices;
}

function isResolvedImageExpression(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    (value[0] === "image" || imageOutputIndices(value).some((index) => isResolvedImageExpression(value[index])))
  );
}

function inlineImageVariables(value: unknown): unknown {
  let remaining = 10000;
  const visit = (value: unknown, bindings: ReadonlyMap<string, unknown>, depth: number): unknown => {
    if (--remaining < 0 || depth > 64) throw new Error("Basemap image expression exceeds expansion limits.");
    if (!Array.isArray(value)) {
      const record = object(value);
      return record
        ? Object.fromEntries(Object.entries(record).map(([key, part]) => [key, visit(part, bindings, depth + 1)]))
        : value;
    }
    if (value[0] === "literal") return value;
    if (value[0] === "var") return bindings.has(value[1]) ? visit(bindings.get(value[1]), new Map(), depth + 1) : value;
    if (value[0] === "let") {
      const scope = new Map(bindings);
      // RHS values use the outer scope, never sibling bindings. Resolve every
      // reference before moving the expression into its result's lexical scope.
      for (let i = 1; i < value.length - 1; i += 2) scope.set(value[i], visit(value[i + 1], bindings, depth + 1));
      return visit(value[value.length - 1], scope, depth + 1);
    }
    return value.map((part, index) =>
      value[0] === "match" && index >= 2 && index < value.length - 1 && index % 2 === 0
        ? part
        : visit(part, bindings, depth + 1),
    );
  };
  return visit(value, new Map(), 0);
}

interface PreparedBasemap {
  readonly definition: {
    readonly id: string;
    readonly label: string;
    readonly kind: "vector";
    readonly sources: Readonly<Record<string, unknown>>;
    readonly layers: readonly { readonly id: string; readonly [key: string]: unknown }[];
  };
  readonly sprites: readonly { id: string; url: string }[];
  readonly glyphs: string | undefined;
  readonly baseUrl: string;
}

function rewriteImageProperties(
  properties: Record<string, unknown>,
  prefix: string,
  hasSprites: boolean,
): Record<string, unknown> {
  if (!hasSprites) return properties;
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      key === "icon-image" ||
      key === "fill-pattern" ||
      key === "line-pattern" ||
      key === "background-pattern" ||
      key === "fill-extrusion-pattern"
        ? spriteImage(inlineImageVariables(value), prefix)
        : value,
    ]),
  );
}
