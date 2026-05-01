/**
 * Compose the runtime MapLibre style document from a `MapPackage`:
 *
 *   mapSpec  ─┐
 *   styleRefs ─┤──> applyStyleRefs ──> applyTheme ──> composed style
 *   theme     ─┘
 *
 * `mapSpec` is already MapLibre-compatible (it is a `HonuaStyleSpecification`).
 * Style refs attach paint/layout overrides per layer id; theme tokens are
 * substituted by name against `{theme:key}` placeholders.
 *
 * Resolvers are async so the loader can plug into server-hosted lookup
 * without reopening this module.
 *
 * @module
 */

import type { HonuaLayerSpecification, HonuaStyleSpecification } from "../style/specification.js";
import { HonuaMapPackageError } from "./errors.js";
import type {
  HonuaMapPackage,
  HonuaMapPackageThemeSpec,
  HonuaStyleRefBody,
  HonuaStyleRefLayerOverride,
} from "./map-package.js";

/**
 * Resolver for out-of-band style-ref bodies. Returns the per-layer
 * override map keyed by MapLibre layer id. The default loader assumes
 * inline bodies attached to the package and calls this resolver only
 * when the inline body is absent.
 */
export type StyleRefResolver = (styleId: string, presetId?: string) => Promise<HonuaStyleRefBody>;

/** Resolver for out-of-band theme bodies; called only when `mapPackage.theme` is absent. */
export type ThemeResolver = (themeId: string) => Promise<HonuaMapPackageThemeSpec>;

export interface StyleComposeOptions {
  resolveStyleRef?: StyleRefResolver;
  resolveTheme?: ThemeResolver;
}

/** Compose a MapLibre-ready style from the `MapPackage`. */
export async function composeStyle(
  pkg: HonuaMapPackage,
  mapSpecWithSources: HonuaStyleSpecification,
  options: StyleComposeOptions,
): Promise<HonuaStyleSpecification> {
  try {
    const withStyleRefs = await applyStyleRefs(mapSpecWithSources, pkg, options.resolveStyleRef);
    const theme = await resolveTheme(pkg, options.resolveTheme);
    return theme ? applyTheme(withStyleRefs, theme) : withStyleRefs;
  } catch (cause) {
    if (cause instanceof HonuaMapPackageError) throw cause;
    throw new HonuaMapPackageError("style composition failed", {
      packageId: pkg.mapPackageId,
      stage: "style-compose",
      cause,
    });
  }
}

/**
 * Merge style-ref layer overrides onto the base style. Each ref's body is
 * keyed by layer id; unknown layer ids are ignored (they may target
 * layers emitted by an adapter plugin).
 */
export async function applyStyleRefs(
  base: HonuaStyleSpecification,
  pkg: HonuaMapPackage,
  resolve?: StyleRefResolver,
): Promise<HonuaStyleSpecification> {
  const refs = pkg.styleRefs ?? [];
  if (refs.length === 0) return base;

  const nextLayers: HonuaLayerSpecification[] = base.layers.map((layer) => cloneLayer(layer));

  for (const ref of refs) {
    const body = ref.body ?? (resolve ? await resolve(ref.styleId, ref.presetId) : undefined);
    if (!body) {
      throw new HonuaMapPackageError(`StyleRef "${ref.styleId}" has no inline body and no resolver was provided`, {
        packageId: pkg.mapPackageId,
        stage: "style-compose",
        detail: { styleId: ref.styleId },
      });
    }
    for (const [layerId, override] of Object.entries(body)) {
      const idx = nextLayers.findIndex((layer) => layer.id === layerId);
      if (idx === -1) continue;
      nextLayers[idx] = mergeLayerOverride(nextLayers[idx], override);
    }
  }

  return { ...base, layers: nextLayers };
}

/**
 * Substitute `{theme:key}` placeholders in string paint/layout values with
 * the corresponding theme token. Values that resolve to nothing are left
 * untouched so authors can spot missing tokens at review time.
 */
export function applyTheme(style: HonuaStyleSpecification, theme: HonuaMapPackageThemeSpec): HonuaStyleSpecification {
  const tokens = theme.tokens;
  if (!tokens) return style;

  const nextLayers = style.layers.map((layer) => substituteLayerTokens(layer, tokens));
  return { ...style, layers: nextLayers };
}

async function resolveTheme(
  pkg: HonuaMapPackage,
  resolve?: ThemeResolver,
): Promise<HonuaMapPackageThemeSpec | undefined> {
  if (pkg.theme) return pkg.theme;
  if (!pkg.themeId) return undefined;
  if (!resolve) return undefined;
  try {
    return await resolve(pkg.themeId);
  } catch (cause) {
    throw new HonuaMapPackageError(`theme resolution failed for themeId "${pkg.themeId}"`, {
      packageId: pkg.mapPackageId,
      stage: "style-compose",
      detail: { themeId: pkg.themeId },
      cause,
    });
  }
}

function mergeLayerOverride(
  layer: HonuaLayerSpecification,
  override: HonuaStyleRefLayerOverride,
): HonuaLayerSpecification {
  return {
    ...layer,
    ...(override.filter !== undefined ? { filter: override.filter } : {}),
    ...(override.minzoom !== undefined ? { minzoom: override.minzoom } : {}),
    ...(override.maxzoom !== undefined ? { maxzoom: override.maxzoom } : {}),
    paint: { ...(layer.paint ?? {}), ...(override.paint ?? {}) },
    layout: { ...(layer.layout ?? {}), ...(override.layout ?? {}) },
    metadata: { ...(layer.metadata ?? {}), ...(override.metadata ?? {}) },
  };
}

function cloneLayer(layer: HonuaLayerSpecification): HonuaLayerSpecification {
  return {
    ...layer,
    paint: layer.paint ? { ...layer.paint } : undefined,
    layout: layer.layout ? { ...layer.layout } : undefined,
    metadata: layer.metadata ? { ...layer.metadata } : undefined,
  };
}

function substituteLayerTokens(
  layer: HonuaLayerSpecification,
  tokens: Record<string, string | number>,
): HonuaLayerSpecification {
  return {
    ...layer,
    paint: layer.paint ? substituteTokens(layer.paint, tokens) : layer.paint,
    layout: layer.layout ? substituteTokens(layer.layout, tokens) : layer.layout,
  };
}

function substituteTokens(
  obj: Record<string, unknown>,
  tokens: Record<string, string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = substituteTokenValue(value, tokens);
  }
  return out;
}

const TOKEN_RE = /^\{theme:([^}]+)\}$/;

function substituteTokenValue(value: unknown, tokens: Record<string, string | number>): unknown {
  if (typeof value === "string") {
    const match = value.match(TOKEN_RE);
    if (match) {
      const token = tokens[match[1]];
      return token !== undefined ? token : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTokenValue(item, tokens));
  }
  if (value && typeof value === "object") {
    return substituteTokens(value as Record<string, unknown>, tokens);
  }
  return value;
}
