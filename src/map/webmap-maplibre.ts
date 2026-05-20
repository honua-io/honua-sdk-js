/**
 * WebMap JSON → MapLibre style derivation for the `honua-maplibre`
 * migration target.
 *
 * This module is a thin orchestrator on top of `src/webmap/parseWebMap`
 * (which already converts basemap, operational layers, renderers, popups,
 * labels, and extents) plus a structured-gap classifier that records the
 * unsupported constructs the migration punch list cares about:
 *
 *   - Arcade expressions (popupInfo.expressionInfos, label Arcade)
 *   - Unknown / unsupported renderer types (heatmap, dotDensity, …)
 *   - 3D / Scene references (ground, viewingMode, SceneServiceLayer, …)
 *   - Dashboard / ExperienceBuilder / custom-widget host shells
 *
 * The function is pure: callers supply the WebMap JSON, no network or
 * disk I/O is performed.
 *
 * @module
 */

import type { HonuaStyleSpecification } from "../style/specification.js";
import { parseWebMap } from "../webmap/parse.js";
import type { WebMapJson } from "../webmap/types.js";
import type { WebMapWarning } from "../webmap/warnings.js";

/** Stable taxonomy for the gaps the punch list expects callers to handle. */
export type WebMapMapLibreGapKind =
  | "arcade-expression"
  | "unsupported-renderer"
  | "scene-3d"
  | "dashboard-reference"
  | "experience-builder-reference"
  | "custom-widget-reference"
  | "unsupported-symbol"
  | "unsupported-layer-type"
  | "unsupported-feature-collection"
  | "unsupported-webmap-version"
  | "other";

/** A single unsupported construct discovered while deriving the style. */
export interface WebMapMapLibreManualGap {
  kind: WebMapMapLibreGapKind;
  /** Human-readable explanation surfaced in reports / TODO annotations. */
  reason: string;
  /** Path within the WebMap JSON (e.g. `operationalLayers[2].popupInfo`). */
  path?: string;
  /** Operational layer id, when the gap is attributable to a specific layer. */
  layerId?: string;
  /** The offending Arcade expression text, when applicable. */
  expression?: string;
  /** Extra context (renderer type, scene layer URL, widget name, …). */
  context?: Record<string, unknown>;
}

export interface WebMapJsonToMapLibreStyleOptions {
  /** Whether to include the basemap in the derived style. Defaults to true. */
  includeBasemap?: boolean;
}

export interface WebMapJsonToMapLibreStyleResult {
  /** A MapLibre-shaped style document suitable for `map.setStyle(...)`. */
  style: HonuaStyleSpecification;
  /** Structured gap entries — one per unsupported construct. */
  manualGaps: WebMapMapLibreManualGap[];
}

/**
 * Derive a MapLibre style document from an ArcGIS WebMap JSON payload.
 *
 * Reuses the entire `src/webmap/*` conversion pipeline (`convertBasemap`,
 * `convertOperationalLayer`, `convertRenderer`, `convertPopupInfo`,
 * `convertLabelingInfo`, `convertExtent`) via `parseWebMap`. The
 * `parseWebMap` warnings are then mapped onto the structured `manualGaps`
 * taxonomy, and additional gaps are appended for Dashboard /
 * ExperienceBuilder / custom-widget shell properties that the WebMap
 * converter itself doesn't model.
 */
export function webmapJsonToMapLibreStyle(
  webmap: WebMapJson,
  options: WebMapJsonToMapLibreStyleOptions = {},
): WebMapJsonToMapLibreStyleResult {
  const parsed = parseWebMap(webmap, {
    includeBasemap: options.includeBasemap !== false,
  });

  const manualGaps: WebMapMapLibreManualGap[] = [];
  for (const warning of parsed.warnings) {
    const gap = classifyWarning(warning, webmap);
    if (gap) {
      manualGaps.push(gap);
    }
  }

  // Detect Dashboard / ExperienceBuilder / custom-widget shells that
  // `parseWebMap` does not model. These appear at the top of WebMap-
  // adjacent application documents (Dashboards, Experience Builder
  // configs, web-app items) and on the WebMap when authored by those
  // apps. We never raise the renderer/popup conversion result over
  // them — we only record a gap so the caller can replan that surface.
  detectShellGaps(webmap, manualGaps);

  return {
    style: parsed.style,
    manualGaps,
  };
}

// ── Internals ───────────────────────────────────────────────────────────

function classifyWarning(warning: WebMapWarning, webmap: WebMapJson): WebMapMapLibreManualGap | undefined {
  const layerId = resolveLayerIdFromPath(warning.path, webmap);
  const base: Pick<WebMapMapLibreManualGap, "path" | "layerId" | "context"> = {
    path: warning.path,
    ...(layerId ? { layerId } : {}),
    ...(warning.context ? { context: warning.context } : {}),
  };

  switch (warning.code) {
    case "unsupported-arcade-expression":
    case "complex-arcade":
    case "complex-label-expression": {
      const expression = pickStringContext(warning.context, ["expression", "value"]);
      return {
        kind: "arcade-expression",
        reason: warning.message,
        ...(expression ? { expression } : {}),
        ...base,
      };
    }

    case "unsupported-renderer": {
      return {
        kind: "unsupported-renderer",
        reason: warning.message,
        ...base,
      };
    }

    case "unsupported-3d-property": {
      return {
        kind: "scene-3d",
        reason: warning.message,
        ...base,
      };
    }

    case "unsupported-symbol":
      return { kind: "unsupported-symbol", reason: warning.message, ...base };

    case "unsupported-layer-type":
      return { kind: "unsupported-layer-type", reason: warning.message, ...base };

    case "unsupported-feature-collection":
      return { kind: "unsupported-feature-collection", reason: warning.message, ...base };

    case "unsupported-webmap-version":
      return { kind: "unsupported-webmap-version", reason: warning.message, ...base };

    // Warnings the punch list does not (yet) treat as a manual gap:
    // `sprite-required` (picture marker needs a sprite — degrades but
    // doesn't block), `missing-field` (classBreaks misuse — caller's
    // data error, not a target gap), `unknown-property` (forward-compat
    // pass-through), `unsupported-viewpoint-geometry` (rare and
    // recoverable). We deliberately do not invent gap entries for
    // those; they remain in `parseWebMap` warnings for diagnostics.
    case "sprite-required":
    case "missing-field":
    case "unknown-property":
    case "unsupported-viewpoint-geometry":
      return undefined;

    default:
      return {
        kind: "other",
        reason: warning.message,
        ...base,
      };
  }
}

/**
 * Inspect the WebMap document for shell properties belonging to
 * Dashboards, Experience Builder, or generic custom-widget hosts.
 *
 * The WebMap JSON spec doesn't model these directly — they appear on
 * application documents that wrap a WebMap — but they often leak into
 * WebMap payloads exported from those products. Recording a gap lets
 * the migration report flag them instead of silently dropping them.
 */
function detectShellGaps(webmap: WebMapJson, gaps: WebMapMapLibreManualGap[]): void {
  // Dashboard authoring metadata.
  if (hasOwn(webmap, "dashboard") || isDashboardItemType(webmap)) {
    gaps.push({
      kind: "dashboard-reference",
      reason:
        "WebMap payload carries Dashboard application properties; Dashboard widgets do not map to a MapLibre style and require manual reauthoring.",
      path: hasOwn(webmap, "dashboard") ? "dashboard" : "type",
    });
  }

  // Experience Builder authoring metadata.
  if (hasOwn(webmap, "experience") || hasOwn(webmap, "experienceBuilder") || isExperienceBuilderItemType(webmap)) {
    gaps.push({
      kind: "experience-builder-reference",
      reason:
        "WebMap payload carries Experience Builder application properties; Experience Builder pages do not map to a MapLibre style and require manual reauthoring.",
      path: hasOwn(webmap, "experience")
        ? "experience"
        : hasOwn(webmap, "experienceBuilder")
          ? "experienceBuilder"
          : "type",
    });
  }

  // Generic custom-widget host shells. We do NOT treat the built-in 2D
  // widget set (Home, Compass, Zoom, …) as a gap — those have parity
  // shims in src/esri-compat. Only widget hosts that carry a free-form
  // `widgets`/`widgetsOnScreen` payload, which is what custom widgets
  // and 3rd-party plugins ride on, get flagged.
  const appProps = (webmap as { applicationProperties?: unknown }).applicationProperties;
  if (appProps && typeof appProps === "object") {
    const viewing = (appProps as Record<string, unknown>).viewing;
    if (viewing && typeof viewing === "object" && hasOwn(viewing as Record<string, unknown>, "widgetsOnScreen")) {
      gaps.push({
        kind: "custom-widget-reference",
        reason:
          "WebMap.applicationProperties.viewing.widgetsOnScreen references custom widgets that must be ported individually to MapLibre/Honua controls.",
        path: "applicationProperties.viewing.widgetsOnScreen",
      });
    }
  }

  const customWidgets = (webmap as { widgets?: unknown }).widgets;
  if (Array.isArray(customWidgets) && customWidgets.length > 0) {
    gaps.push({
      kind: "custom-widget-reference",
      reason: "WebMap.widgets array references custom widgets that require manual MapLibre/Honua reimplementation.",
      path: "widgets",
      context: { count: customWidgets.length },
    });
  }
}

function isDashboardItemType(webmap: WebMapJson): boolean {
  const value = (webmap as { type?: unknown }).type;
  return typeof value === "string" && /dashboard/i.test(value);
}

function isExperienceBuilderItemType(webmap: WebMapJson): boolean {
  const value = (webmap as { type?: unknown }).type;
  return typeof value === "string" && /experience\s*builder|web\s*experience/i.test(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function pickStringContext(context: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!context) return undefined;
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Best-effort `layerId` extraction from a warning path such as
 * `operationalLayers[2].layerDefinition.drawingInfo.renderer`. Falls
 * back to the synthesized `operational-<index>` id used by
 * `convertOperationalLayer` when no explicit id is present.
 */
function resolveLayerIdFromPath(path: string, webmap: WebMapJson): string | undefined {
  const match = path.match(/operationalLayers\[(\d+)\]/);
  if (!match) return undefined;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index)) return undefined;
  const layer = webmap.operationalLayers?.[index];
  if (!layer) return `operational-${index}`;
  return layer.id ?? `operational-${index}`;
}
