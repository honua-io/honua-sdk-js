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
  | "wmts"
  | "odata"
  | "vector_tile"
  | "raster_tile"
  | "pmtiles"
  | "workspace_artifact";

/** Protocol-specific endpoint information attached to a binding. */
export interface HonuaMapPackageLocator {
  url?: string;
  serviceId?: string;
  /**
   * The server's canonical `SourceLocator.LayerId` is `string?`
   * (`honua-server/src/Honua.Core/Features/Geoprocessing/Domain/SourceBinding.cs`).
   * Numeric forms (`0`) are accepted to match the SDK's historical
   * shape; both variants are coerced to a number inside
   * `projectSourceBindings` before hitting `createDataset`.
   */
  layerId?: number | string;
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
 * Package-level attribution the host is expected to display.
 *
 * Per-binding `attribution` on {@link HonuaMapPackageSourceBinding} stays the
 * source-of-record for a single service; this collection is for the
 * package-wide notices (basemap credit, licence text) that no single binding
 * owns.
 */
export interface HonuaMapPackageAttribution {
  /** Attribution text. Plain text; hosts escape before rendering. */
  text: string;
  /** Optional link target for the attribution. */
  url?: string;
  /** Bindings this notice covers. Omitted means package-wide. */
  sourceIds?: readonly string[];
  /** Whether the host must display this notice (licence obligation). */
  required?: boolean;
}

/**
 * A renderer-neutral widget/component declared by the package.
 *
 * `type` is an open string rather than a closed union: the widget catalogue
 * belongs to the host application, and closing it here would make every new
 * component a breaking change to the artifact. Unknown types are carried
 * through the round trip and ignored by hosts that cannot render them.
 */
export interface HonuaMapPackageWidget {
  widgetId: string;
  /** Widget kind, e.g. `legend`, `layer-list`, `basemap-gallery`, `search`. */
  type: string;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  label?: string;
  /** Whether the widget starts visible. Defaults to `true` when omitted. */
  visible?: boolean;
  /** Widget-specific configuration, carried through unmodified. */
  config?: Record<string, unknown>;
}

/**
 * An external capability the package needs in order to render. Declarative
 * only — nothing in the SDK installs or resolves these; hosts use them to
 * report a fidelity gap before rendering rather than after.
 */
export interface HonuaMapPackageDependency {
  /** Dependency name, e.g. `maplibre-gl`, `@honua/sdk-js`, `pmtiles`. */
  name: string;
  /** semver range the package was authored against. */
  versionRange?: string;
  kind?: "renderer" | "protocol" | "sdk" | "plugin" | "font" | "sprite" | "basemap";
  /** Whether the package still renders (degraded) without it. */
  optional?: boolean;
}

/**
 * How this package was produced. Descriptive only.
 *
 * Deliberately carries no content hash, actor/tenant, authorization scope, or
 * audit/correlation identifier. Those are identity and governance concerns
 * owned by the canonical honua-server composition contract and projected into
 * the SDK through #1397 / #1398; minting them here would fork the identity
 * model, which is the failure mode #1426 exists to prevent.
 */
export interface HonuaMapPackageProvenance {
  /** Tool that produced the package, e.g. `honua-cli`, `@honua/mcp-server`. */
  generatedBy?: string;
  /** Version of that tool. */
  generatorVersion?: string;
  /** ISO-8601 timestamp of production. */
  generatedAt?: string;
  /** Ids of upstream artifacts this package was composed from. */
  derivedFrom?: readonly string[];
  /** Free-text note for humans reading the artifact. */
  notes?: string;
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
  /** Optional server retention / hosting expiry timestamp. */
  expiresAt?: string;

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

  /** Package-wide attribution notices. */
  attribution?: readonly HonuaMapPackageAttribution[];
  /** Renderer-neutral widgets/components declared by the package. */
  widgets?: readonly HonuaMapPackageWidget[];
  /** External capabilities required to render at full fidelity. */
  dependencies?: readonly HonuaMapPackageDependency[];
  /** How the package was produced. Descriptive; carries no identity. */
  provenance?: HonuaMapPackageProvenance;

  /** Preserve additive fields through round-trip without forcing a type bump. */
  [extra: string]: unknown;
}
