/**
 * Versioned manifest/profile consumed by `@honua/sdk-js/generated-app`.
 *
 * The manifest is the browser-safe projection of the canonical builder
 * package: it does not define a new wire contract, it names the SDK widget
 * bindings the preview runtime needs to hydrate one generated operations
 * dashboard slice.
 *
 * @module
 */

import type { AggregationMetric, FeatureId } from "../contract/index.js";
import type { ExplorationState, FilterClause, LinkedViewPresetName } from "../exploration/index.js";
import type { HonuaMapPackage } from "../runtime/index.js";

export const HONUA_GENERATED_APP_MANIFEST_FORMAT_V1 = "honua_generated_app_manifest.v1" as const;
export const HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND = "honua.generated-app.manifest" as const;
export const HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION = 1 as const;
export const HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1 = "operations-dashboard.v1" as const;

export type HonuaGeneratedAppManifestFormat = typeof HONUA_GENERATED_APP_MANIFEST_FORMAT_V1;
export type HonuaGeneratedAppManifestArtifactKind = typeof HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND;
export type HonuaGeneratedAppManifestArtifactVersion = typeof HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION;
export type HonuaGeneratedAppProfile = typeof HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1;

export type HonuaGeneratedAppWidgetKind = "map" | "table" | "list" | "count" | "chart" | "filter";

export interface HonuaGeneratedAppFieldBinding {
  readonly sourceId?: string;
  readonly primaryKey?: string;
  readonly titleField?: string;
  readonly subtitleField?: string;
  readonly categoryField?: string;
  readonly filterField?: string;
  readonly tableFields?: ReadonlyArray<string>;
  readonly searchFields?: ReadonlyArray<string>;
  readonly layerId?: string;
  readonly sourceLayer?: string;
  readonly [extra: string]: unknown;
}

export interface HonuaGeneratedAppDataBinding {
  readonly sourceId: string;
  /**
   * Maximum records the default preview loader requests from the source.
   * Hosts that need larger/realtime result sets should pass a custom
   * `featureLoader` to the runtime.
   */
  readonly previewLimit?: number;
  readonly [extra: string]: unknown;
}

export interface HonuaGeneratedAppWidgetBase {
  readonly id: string;
  readonly kind: HonuaGeneratedAppWidgetKind;
  readonly title?: string;
  readonly sourceId?: string;
  readonly [extra: string]: unknown;
}

export interface HonuaGeneratedAppMapWidget extends HonuaGeneratedAppWidgetBase {
  readonly kind: "map";
  readonly layerId?: string;
  readonly sourceLayer?: string;
  readonly showLegend?: boolean;
  readonly showSearch?: boolean;
}

export interface HonuaGeneratedAppTableWidget extends HonuaGeneratedAppWidgetBase {
  readonly kind: "table" | "list";
  readonly fields?: ReadonlyArray<string>;
  readonly primaryKey?: string;
  readonly titleField?: string;
  readonly subtitleField?: string;
  readonly pageSize?: number;
}

export interface HonuaGeneratedAppCountWidget extends HonuaGeneratedAppWidgetBase {
  readonly kind: "count";
  readonly label?: string;
}

export interface HonuaGeneratedAppChartWidget extends HonuaGeneratedAppWidgetBase {
  readonly kind: "chart";
  readonly groupBy: string;
  readonly metric?: AggregationMetric;
}

export interface HonuaGeneratedAppFilterOption {
  readonly value: string | number | boolean;
  readonly label?: string;
}

export interface HonuaGeneratedAppFilterWidget extends HonuaGeneratedAppWidgetBase {
  readonly kind: "filter";
  readonly field: string;
  readonly label?: string;
  readonly options?: ReadonlyArray<HonuaGeneratedAppFilterOption>;
}

export type HonuaGeneratedAppWidget =
  | HonuaGeneratedAppMapWidget
  | HonuaGeneratedAppTableWidget
  | HonuaGeneratedAppCountWidget
  | HonuaGeneratedAppChartWidget
  | HonuaGeneratedAppFilterWidget;

export interface HonuaGeneratedAppLayout {
  readonly kind: "operations-dashboard";
  readonly widgets: ReadonlyArray<HonuaGeneratedAppWidget>;
}

export interface HonuaGeneratedAppManifest {
  readonly format: HonuaGeneratedAppManifestFormat;
  readonly profile: HonuaGeneratedAppProfile;
  readonly appId: string;
  readonly title?: string;
  readonly description?: string;
  readonly version?: string;
  readonly data: HonuaGeneratedAppDataBinding;
  readonly mapPackageId?: string;
  readonly mapPackage?: HonuaMapPackage;
  readonly layout: HonuaGeneratedAppLayout;
  readonly bindings?: HonuaGeneratedAppFieldBinding;
  readonly initialState?: Partial<ExplorationState>;
  readonly linkedViewPreset?: LinkedViewPresetName;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [extra: string]: unknown;
}

export interface HonuaGeneratedAppManifestArtifact {
  readonly artifactKind: HonuaGeneratedAppManifestArtifactKind;
  readonly artifactVersion: HonuaGeneratedAppManifestArtifactVersion;
  readonly manifest: HonuaGeneratedAppManifest;
  readonly createdAt?: string;
  readonly source?: string;
  readonly [extra: string]: unknown;
}

export interface HonuaGeneratedAppAssetRef {
  readonly id: string;
  readonly kind: "map-package" | "app-package" | "manifest" | "file" | "artifact" | (string & {});
  readonly url?: string;
  readonly mediaType?: string;
  readonly [extra: string]: unknown;
}

/**
 * Structural `AppPackage` subset the SDK generated-app projection consumes.
 * The canonical server object remains authoritative; this interface only names
 * the `manifest_artifact` bridge and stable package identity the browser needs.
 */
export interface HonuaGeneratedAppPackage {
  readonly id: string;
  readonly version: string;
  readonly assets?: ReadonlyArray<HonuaGeneratedAppAssetRef>;
  readonly manifest_artifact?: HonuaGeneratedAppManifestArtifact | HonuaGeneratedAppManifest;
  readonly manifestArtifact?: HonuaGeneratedAppManifestArtifact | HonuaGeneratedAppManifest;
  readonly mapPackage?: HonuaMapPackage;
  readonly metadata?: unknown;
  readonly [extra: string]: unknown;
}

/**
 * Structural `BuildSpec` subset used by the SDK projection helper. Canonical
 * builders may carry richer fields; additive content is preserved on
 * `manifest.metadata.buildSpec`.
 */
export interface HonuaGeneratedAppBuildSpec {
  readonly id?: string;
  readonly appId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly profile?: string;
  readonly appProfile?: string;
  readonly sourceId?: string;
  readonly primarySourceId?: string;
  readonly widgets?: ReadonlyArray<HonuaGeneratedAppWidget>;
  readonly layout?: Partial<HonuaGeneratedAppLayout> & {
    readonly widgets?: ReadonlyArray<HonuaGeneratedAppWidget>;
  };
  readonly bindings?: HonuaGeneratedAppFieldBinding;
  readonly initialState?: Partial<ExplorationState>;
  readonly linkedViewPreset?: LinkedViewPresetName;
  readonly [extra: string]: unknown;
}

export interface HonuaGeneratedAppFeatureRecord<TAttributes extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: FeatureId;
  readonly sourceId?: string;
  readonly attributes: TAttributes;
  readonly geometry?: unknown;
  readonly [extra: string]: unknown;
}

export interface HonuaGeneratedAppFilterState {
  readonly id: string;
  readonly clause: FilterClause;
}
