/**
 * Diff primitives for incremental `updatePackage` application.
 *
 * The runtime uses stable IDs (`sourceId`, `layer.id`) as the diff key
 * and falls back to a full `map.setStyle` only when structural change
 * makes incremental patching unsafe (e.g. layer reorder, mapSpec version
 * mismatch, source type change).
 *
 * @module
 */

import type { HonuaLayerSpecification, HonuaStyleSpecification } from "../style/specification.js";
import type { HonuaMapPackage, HonuaMapPackageSourceBinding } from "./map-package.js";

export interface MapPackageDiff {
  /** Bindings present in `next` but not `previous`. */
  addedSourceBindings: HonuaMapPackageSourceBinding[];
  /** sourceIds present in `previous` but not `next`. */
  removedSourceIds: string[];
  /** sourceIds whose locator / filter changed — requires add-then-remove. */
  changedSourceIds: string[];
  /** Layer ids newly added in `next`. */
  addedLayerIds: string[];
  /** Layer ids removed in `next`. */
  removedLayerIds: string[];
  /** Layer ids whose paint/layout/filter changed. */
  changedLayerIds: string[];
  /** Whether the diff is safe to apply incrementally. */
  incremental: boolean;
  /** Human-readable reason when `incremental` is false. */
  structuralReason?: string;
}

export function diffPackages(previous: HonuaMapPackage, next: HonuaMapPackage): MapPackageDiff {
  const prevBindings = new Map(previous.sourceBindings.map((b) => [b.sourceId, b]));
  const nextBindings = new Map(next.sourceBindings.map((b) => [b.sourceId, b]));

  const addedSourceBindings: HonuaMapPackageSourceBinding[] = [];
  const removedSourceIds: string[] = [];
  const changedSourceIds: string[] = [];

  for (const [id, binding] of nextBindings) {
    if (!prevBindings.has(id)) addedSourceBindings.push(binding);
    else if (!sameBinding(prevBindings.get(id)!, binding)) changedSourceIds.push(id);
  }
  for (const id of prevBindings.keys()) {
    if (!nextBindings.has(id)) removedSourceIds.push(id);
  }

  const prevLayers = new Map(previous.mapSpec.layers.map((l) => [l.id, l]));
  const nextLayers = new Map(next.mapSpec.layers.map((l) => [l.id, l]));

  const addedLayerIds: string[] = [];
  const removedLayerIds: string[] = [];
  const changedLayerIds: string[] = [];

  for (const [id, layer] of nextLayers) {
    if (!prevLayers.has(id)) addedLayerIds.push(id);
    else if (!sameLayer(prevLayers.get(id)!, layer)) changedLayerIds.push(id);
  }
  for (const id of prevLayers.keys()) {
    if (!nextLayers.has(id)) removedLayerIds.push(id);
  }

  const styleStructuralReason = detectStructuralChange(previous.mapSpec, next.mapSpec);
  const sourceStructuralReason = detectSourceBindingChange(
    addedSourceBindings,
    removedSourceIds,
    changedSourceIds,
  );
  const structuralReason = styleStructuralReason ?? sourceStructuralReason;

  return {
    addedSourceBindings,
    removedSourceIds,
    changedSourceIds,
    addedLayerIds,
    removedLayerIds,
    changedLayerIds,
    incremental: structuralReason === undefined,
    structuralReason,
  };
}

function detectSourceBindingChange(
  added: readonly HonuaMapPackageSourceBinding[],
  removed: readonly string[],
  changed: readonly string[],
): string | undefined {
  if (added.length > 0) return "source bindings added";
  if (removed.length > 0) return "source bindings removed";
  if (changed.length > 0) return "source bindings changed";
  return undefined;
}

function sameBinding(a: HonuaMapPackageSourceBinding, b: HonuaMapPackageSourceBinding): boolean {
  if (a.protocol !== b.protocol) return false;
  if ((a.filter ?? "") !== (b.filter ?? "")) return false;
  if ((a.attribution ?? "") !== (b.attribution ?? "")) return false;
  return shallowEqual(a.locator as Record<string, unknown>, b.locator as Record<string, unknown>);
}

function sameLayer(a: HonuaLayerSpecification, b: HonuaLayerSpecification): boolean {
  if (a.type !== b.type) return false;
  if ((a.source ?? "") !== (b.source ?? "")) return false;
  if (a["source-layer"] !== b["source-layer"]) return false;
  if (!stableEqual(a.paint, b.paint)) return false;
  if (!stableEqual(a.layout, b.layout)) return false;
  if (!stableEqual(a.filter, b.filter)) return false;
  if (a.minzoom !== b.minzoom) return false;
  if (a.maxzoom !== b.maxzoom) return false;
  return true;
}

function detectStructuralChange(prev: HonuaStyleSpecification, next: HonuaStyleSpecification): string | undefined {
  if (prev.version !== next.version) return "mapSpec.version changed";

  const prevIds = prev.layers.map((l) => l.id);
  const nextIds = next.layers.map((l) => l.id);
  if (prevIds.length !== nextIds.length || prevIds.some((id) => !nextIds.includes(id))) {
    return "layer set changed";
  }

  const commonPrev = prevIds.filter((id) => nextIds.includes(id));
  const commonNext = nextIds.filter((id) => prevIds.includes(id));
  for (let i = 0; i < commonPrev.length; i++) {
    if (commonPrev[i] !== commonNext[i]) return "layer order changed";
  }
  return undefined;
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}
