/**
 * Typed mirror of the server-produced `MapPackage` (honua-server #731). The
 * package shape is `honua_map_package.v1` — the format string is the
 * canonical version gate and the runtime loader refuses other values.
 *
 * Field names mirror the server's camelCase JSON; see
 * `/honua-server/docs/developer/AI_OPERATOR_CONTRACT.md#MapPackage` for the
 * authoritative definition. The runtime preserves unknown fields on the
 * package through `updatePackage` so minor additive changes do not break
 * callers.
 *
 * @module
 */

import type { HonuaStyleSpecification } from "../style/specification.js";

/** Canonical format string for the v1 MapPackage shape. */
export const HONUA_MAP_PACKAGE_FORMAT_V1 = "honua_map_package.v1" as const;

/** Canonical format string for the v1 MapPackage shape. */
export type HonuaMapPackageFormat = typeof HONUA_MAP_PACKAGE_FORMAT_V1;

/** Lifecycle states a MapPackage may occupy server-side. */
export type HonuaMapPackageStatus = "Draft" | "Composing" | "Ready" | "Failed" | "Expired";

/**
 * Server `SourceBinding.protocol` enum. Uses snake_case to match the
 * server wire format. Translated to the SDK's kebab-case `Protocol`
 * union in `source-bridge.ts`.
 */
export type HonuaMapPackageProtocol =
  | "geoservices_feature_service"
  | "geoservices_map_service"
  | "ogc_features"
  | "ogc_maps"
  | "ogc_tiles"
  | "wfs"
  | "wms"
  | "odata"
  | "vector_tile"
  | "raster_tile"
  | "workspace_artifact";

/** Protocol-specific endpoint information attached to a binding. */
export interface HonuaMapPackageLocator {
  url?: string;
  serviceId?: string;
  layerId?: number;
  collectionId?: string | number;
  typeName?: string;
  entitySet?: string;
  /** Allow additive fields from newer server revisions. */
  [extra: string]: unknown;
}

/** One inlined `SourceBinding` entry on a MapPackage. */
export interface HonuaMapPackageSourceBinding {
  sourceId: string;
  protocol: HonuaMapPackageProtocol;
  locator: HonuaMapPackageLocator;
  /** Server-side filter expression (protocol-specific). */
  filter?: string;
  /** Optional free-form attribution text. */
  attribution?: string;
  /** Out-of-band binding metadata. Preserved round-trip. */
  metadata?: Record<string, string>;
}

/** A style reference carried inline on the package body. */
export interface HonuaMapPackageStyleRef {
  styleId: string;
  label?: string;
  presetId?: string;
  /**
   * Inline body — MapLibre `paint` / `layout` overrides keyed by layer id.
   * Draft-1 of honua-server#731 attaches bodies inline; when the server
   * moves to out-of-band retrieval, callers supply `resolveStyleRef` on the
   * loader instead.
   */
  body?: HonuaStyleRefBody;
}

/**
 * Resolved `StyleRef` body. Keys name MapLibre layers; values are partial
 * layer overrides (paint/layout/minzoom/maxzoom/filter/metadata). Token
 * placeholders in the form `{theme:key}` are substituted during
 * composition from the active {@link HonuaMapPackageThemeSpec}.
 */
export type HonuaStyleRefBody = Record<string, HonuaStyleRefLayerOverride>;

/** Partial layer specification applied on top of `mapSpec.layers[i]`. */
export interface HonuaStyleRefLayerOverride {
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Resolved `ThemeSpec`. v1 uses a flat, name-keyed token map. Richer
 * ramp / typography shapes can be added without breaking the runtime
 * public surface.
 */
export interface HonuaMapPackageThemeSpec {
  themeId?: string;
  tokens?: Record<string, string | number>;
}

/** Initial camera / extent for the composed map. */
export interface HonuaMapPackageInitialView {
  bbox?: readonly [number, number, number, number];
  center?: readonly [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
  crs?: string;
}

/** Legend swatch rendered by the runtime. */
export interface HonuaMapPackageLegendEntry {
  label: string;
  color?: string;
  minValue?: number;
  maxValue?: number;
  /** Optional symbol URL for icon-based legends. */
  iconUrl?: string;
}

/** Popup binding surface; resolved into a click handler by the runtime. */
export interface HonuaMapPackagePopupBinding {
  sourceId: string;
  /** Name of the source field to render. Optional when `template` is set. */
  fieldName?: string;
  /**
   * Optional template. Default is a list of `key: value` rows rendered in
   * a neutral, unstyled DOM subtree — `#29` operator components replace it.
   */
  template?: string;
  /** Optional HTML title for the popup. */
  title?: string;
}

/** Label binding surface (v1 is pass-through metadata for the runtime). */
export interface HonuaMapPackageLabelBinding {
  sourceId: string;
  fieldName: string;
  placement?: "point" | "line" | "polygon";
}

/**
 * v1 MapPackage shape — mirrors the draft server type in
 * `/home/makani/honua-server/src/Honua.Core/Features/Geoprocessing/Domain/MapPackage.cs`.
 * Unknown fields are preserved through `updatePackage` round-trip so
 * minor additive changes do not break runtime consumers.
 */
export interface HonuaMapPackage {
  mapPackageId: string;
  format: HonuaMapPackageFormat;
  status?: HonuaMapPackageStatus;
  createdAt?: string;
  updatedAt?: string;

  templateId?: string;
  themeId?: string;
  /** Optional inline theme body. Overrides out-of-band theme lookup. */
  theme?: HonuaMapPackageThemeSpec;
  previewArtifactId?: string;

  sourceBindings: readonly HonuaMapPackageSourceBinding[];
  styleRefs?: readonly HonuaMapPackageStyleRef[];

  /**
   * MapLibre-compatible style document. The runtime composes style-ref
   * overrides and theme tokens into this body before handing it to
   * `maplibre-gl.Map.setStyle`.
   */
  mapSpec: HonuaStyleSpecification;

  initialView?: HonuaMapPackageInitialView;
  legend?: readonly HonuaMapPackageLegendEntry[];
  popupBindings?: readonly HonuaMapPackagePopupBinding[];
  labelBindings?: readonly HonuaMapPackageLabelBinding[];
  boundArtifacts?: readonly string[];

  /** Preserve additive fields through round-trip without forcing a type bump. */
  [extra: string]: unknown;
}
