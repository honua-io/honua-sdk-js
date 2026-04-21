/**
 * Legend helpers. The runtime surfaces a `LegendEntry[]` derived from
 * `MapPackage.legend[]` (authoritative) with optional swatches pulled
 * from the composed style for layers that did not supply an explicit
 * color.
 *
 * @module
 */

import type { HonuaStyleSpecification } from "../style/specification.js";
import type { HonuaMapPackageLegendEntry } from "./map-package.js";

/** Runtime-facing legend entry. */
export interface LegendEntry {
  /** Stable id for UI list keys. Derived from label when absent. */
  id: string;
  label: string;
  color?: string;
  minValue?: number;
  maxValue?: number;
  iconUrl?: string;
}

/** Build a legend list from the package entries, backfilling colors from the style when possible. */
export function buildLegend(
  packageEntries: readonly HonuaMapPackageLegendEntry[] | undefined,
  style: HonuaStyleSpecification,
): LegendEntry[] {
  const entries = packageEntries ?? [];
  const fallbackColors = collectFirstFillColors(style);

  return entries.map((entry, index) => ({
    id: legendEntryId(entry, index),
    label: entry.label,
    color: entry.color ?? fallbackColors[index],
    ...(entry.minValue !== undefined ? { minValue: entry.minValue } : {}),
    ...(entry.maxValue !== undefined ? { maxValue: entry.maxValue } : {}),
    ...(entry.iconUrl !== undefined ? { iconUrl: entry.iconUrl } : {}),
  }));
}

function legendEntryId(entry: HonuaMapPackageLegendEntry, index: number): string {
  const slug = entry.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `${slug}-${index}` : `legend-${index}`;
}

function collectFirstFillColors(style: HonuaStyleSpecification): Array<string | undefined> {
  const colors: Array<string | undefined> = [];
  for (const layer of style.layers) {
    const paint = layer.paint ?? {};
    const value = (paint["fill-color"] ?? paint["circle-color"] ?? paint["line-color"]) as unknown;
    colors.push(typeof value === "string" ? value : undefined);
  }
  return colors;
}
