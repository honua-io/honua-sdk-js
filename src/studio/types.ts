/**
 * Browser-safe TypeScript projections for the Studio package families
 * (query, analysis, map, dashboard, report, form, app, workflow, GP, ETL).
 *
 * Console interop, MCP, QGIS, generated apps, and embeds must not fork the
 * server-owned package schemas. These projections mirror the canonical
 * server wire shapes — the `format` string on each family is the version
 * gate, exactly as on {@link HonuaMapPackage}. The `map` and `app` families
 * reuse established SDK-native types; `dashboard` is authored by this Studio
 * surface and consumed read-only by renderers.
 *
 * The remaining families (query, analysis, report, form, workflow, GP, ETL)
 * have no finalized server contract yet, so their interfaces are minimal,
 * open-ended stubs (every field optional, plus `[extra: string]: unknown`)
 * gated by a `HONUA_X_PACKAGE_FORMAT_V1` constant. They expand once the
 * server shape lands.
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0` and before the matching
 *   server contracts ship.
 * @module
 */

import type {
  HonuaGeneratedAppDataBinding,
  HonuaGeneratedAppFieldBinding,
  HonuaGeneratedAppLayout,
  HonuaGeneratedAppPackage,
} from "../generated-app/manifest.js";
import type { HonuaMapPackage, HonuaMapPackageStatus } from "../runtime/map-package.js";

/** Canonical format string for the v1 QueryPackage shape. */
export const HONUA_QUERY_PACKAGE_FORMAT_V1 = "honua_query_package.v1" as const;
/** Canonical format string for the v1 AnalysisPackage shape. */
export const HONUA_ANALYSIS_PACKAGE_FORMAT_V1 = "honua_analysis_package.v1" as const;
/** Canonical format string for the v1 Studio-authored dashboard package. */
export const HONUA_DASHBOARD_PACKAGE_FORMAT_V1 = "honua_dashboard_package.v1" as const;
/** Canonical format string for the v1 ReportPackage shape. */
export const HONUA_REPORT_PACKAGE_FORMAT_V1 = "honua_report_package.v1" as const;
/** Canonical format string for the v1 FormPackage shape. */
export const HONUA_FORM_PACKAGE_FORMAT_V1 = "honua_form_package.v1" as const;
/** Canonical format string for the v1 WorkflowPackage shape. */
export const HONUA_WORKFLOW_PACKAGE_FORMAT_V1 = "honua_workflow_package.v1" as const;
/** Canonical format string for the v1 GPPackage shape. */
export const HONUA_GP_PACKAGE_FORMAT_V1 = "honua_gp_package.v1" as const;
/** Canonical format string for the v1 ETLPackage shape. */
export const HONUA_ETL_PACKAGE_FORMAT_V1 = "honua_etl_package.v1" as const;

export type HonuaQueryPackageFormat = typeof HONUA_QUERY_PACKAGE_FORMAT_V1;
export type HonuaAnalysisPackageFormat = typeof HONUA_ANALYSIS_PACKAGE_FORMAT_V1;
export type HonuaDashboardPackageFormat = typeof HONUA_DASHBOARD_PACKAGE_FORMAT_V1;
export type HonuaReportPackageFormat = typeof HONUA_REPORT_PACKAGE_FORMAT_V1;
export type HonuaFormPackageFormat = typeof HONUA_FORM_PACKAGE_FORMAT_V1;
export type HonuaWorkflowPackageFormat = typeof HONUA_WORKFLOW_PACKAGE_FORMAT_V1;
export type HonuaGPPackageFormat = typeof HONUA_GP_PACKAGE_FORMAT_V1;
export type HonuaETLPackageFormat = typeof HONUA_ETL_PACKAGE_FORMAT_V1;

/**
 * Lifecycle states a Studio package may occupy server-side. Shared with the
 * stable {@link HonuaMapPackageStatus} so every family reports one lifecycle.
 *
 * @experimental
 */
export type HonuaStudioPackageStatus = HonuaMapPackageStatus;

/**
 * Fields every stub Studio package family carries. `format` is narrowed to a
 * family-specific literal by each interface; unknown additive fields are
 * preserved through `[extra: string]: unknown` so minor server revisions do
 * not break clients.
 *
 * @experimental
 */
export interface HonuaStudioPackageBase {
  readonly packageId: string;
  readonly format: string;
  readonly status?: HonuaStudioPackageStatus;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly [extra: string]: unknown;
}

/**
 * Minimal reference to a source a package binds to. Open-ended until the
 * server source-binding contract for non-map families is finalized.
 *
 * @experimental
 */
export interface HonuaStudioBindingRef {
  readonly sourceId?: string;
  readonly [extra: string]: unknown;
}

/**
 * Query specification carried by a {@link HonuaQueryPackage}.
 *
 * @experimental
 */
export interface HonuaStudioQuerySpec {
  readonly where?: string;
  readonly orderBy?: string | readonly string[];
  readonly outFields?: readonly string[];
  readonly groupBy?: readonly string[];
  readonly [extra: string]: unknown;
}

/**
 * Client projection of a server QueryPackage.
 *
 * @experimental
 */
export interface HonuaQueryPackage extends HonuaStudioPackageBase {
  readonly format: HonuaQueryPackageFormat;
  readonly sourceBindings?: readonly HonuaStudioBindingRef[];
  readonly querySpec?: HonuaStudioQuerySpec;
  readonly previewLimit?: number;
}

/**
 * Client projection of a server AnalysisPackage.
 *
 * @experimental
 */
export interface HonuaAnalysisPackage extends HonuaStudioPackageBase {
  readonly format: HonuaAnalysisPackageFormat;
  readonly sourcePackageId?: string;
  readonly analysisKind?: string;
  readonly parameters?: Record<string, unknown>;
  readonly resultBindings?: readonly HonuaStudioBindingRef[];
}

/**
 * Renderer-neutral dashboard artifact authored by the sdk-js Studio agent
 * path. Console and other hosts consume this shape read-only.
 *
 * The package deliberately excludes publication lifecycle, tenant/actor,
 * authorization, audit, correlation, and optimistic-concurrency fields. Those
 * belong to the server-owned Studio lifecycle envelope. Unknown additive
 * authoring fields are preserved within v1; incompatible semantics require a
 * new format discriminator.
 *
 * `mapPackageId` references the portable map artifact owned by the runtime
 * contract. A dashboard must not embed credentials or a second map shape.
 *
 * @experimental
 */
export interface HonuaDashboardPackage {
  readonly packageId: string;
  readonly format: HonuaDashboardPackageFormat;
  readonly title?: string;
  readonly description?: string;
  readonly data: HonuaGeneratedAppDataBinding;
  readonly mapPackageId?: string;
  readonly layout: HonuaGeneratedAppLayout;
  readonly bindings?: HonuaGeneratedAppFieldBinding;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [extra: string]: unknown;
}

/**
 * One section in a {@link HonuaReportPackage} layout.
 *
 * @experimental
 */
export interface HonuaReportSectionSpec {
  readonly id?: string;
  readonly kind?: string;
  readonly title?: string;
  readonly [extra: string]: unknown;
}

/**
 * Client projection of a server ReportPackage.
 *
 * @experimental
 */
export interface HonuaReportPackage extends HonuaStudioPackageBase {
  readonly format: HonuaReportPackageFormat;
  readonly title?: string;
  readonly templateId?: string;
  readonly sections?: readonly HonuaReportSectionSpec[];
  readonly mapPackageId?: string;
}

/**
 * One field in a {@link HonuaFormPackage}.
 *
 * @experimental
 */
export interface HonuaFormFieldSpec {
  readonly name?: string;
  readonly label?: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly [extra: string]: unknown;
}

/**
 * Client projection of a server FormPackage.
 *
 * @experimental
 */
export interface HonuaFormPackage extends HonuaStudioPackageBase {
  readonly format: HonuaFormPackageFormat;
  readonly title?: string;
  readonly sourceId?: string;
  readonly fields?: readonly HonuaFormFieldSpec[];
  readonly submitAction?: string;
}

/**
 * One step in a {@link HonuaWorkflowPackage}.
 *
 * @experimental
 */
export interface HonuaWorkflowStepSpec {
  readonly id?: string;
  readonly kind?: string;
  readonly [extra: string]: unknown;
}

/**
 * Client projection of a server WorkflowPackage.
 *
 * @experimental
 */
export interface HonuaWorkflowPackage extends HonuaStudioPackageBase {
  readonly format: HonuaWorkflowPackageFormat;
  readonly title?: string;
  readonly steps?: readonly HonuaWorkflowStepSpec[];
  readonly trigger?: string;
}

/**
 * One geoprocessing input/output parameter in a {@link HonuaGPPackage}.
 *
 * @experimental
 */
export interface HonuaGPParameterSpec {
  readonly name?: string;
  readonly dataType?: string;
  readonly direction?: "input" | "output" | (string & {});
  readonly [extra: string]: unknown;
}

/**
 * Client projection of a server GPPackage (geoprocessing).
 *
 * @experimental
 */
export interface HonuaGPPackage extends HonuaStudioPackageBase {
  readonly format: HonuaGPPackageFormat;
  readonly processId?: string;
  readonly inputs?: readonly HonuaGPParameterSpec[];
  readonly outputs?: readonly HonuaGPParameterSpec[];
}

/**
 * Client projection of a server ETLPackage.
 *
 * @experimental
 */
export interface HonuaETLPackage extends HonuaStudioPackageBase {
  readonly format: HonuaETLPackageFormat;
  readonly pipelineId?: string;
  readonly sourceKind?: string;
  readonly targetKind?: string;
  readonly transformSpec?: unknown;
}

/**
 * Maps each Studio package family discriminant to its projection shape.
 * `map` and `app` reuse established SDK-native types. `dashboard` is the
 * dedicated Studio-authored artifact consumed read-only by Console.
 *
 * @experimental
 */
export interface StudioPackageFamilyShapes {
  readonly query: HonuaQueryPackage;
  readonly analysis: HonuaAnalysisPackage;
  readonly map: HonuaMapPackage;
  readonly dashboard: HonuaDashboardPackage;
  readonly report: HonuaReportPackage;
  readonly form: HonuaFormPackage;
  readonly app: HonuaGeneratedAppPackage;
  readonly workflow: HonuaWorkflowPackage;
  readonly gp: HonuaGPPackage;
  readonly etl: HonuaETLPackage;
}

/**
 * The client-side discriminant tag naming a package family. The server wire
 * shape does not carry this field — projection helpers add it.
 *
 * @experimental
 */
export type HonuaStudioPackageFamily = keyof StudioPackageFamilyShapes;

/**
 * Discriminated union over every Studio package family, tagged by a
 * client-side `packageFamily` field. Narrow on `packageFamily` to access the
 * family-specific shape. Build values through {@link tagStudioPackage} rather
 * than casting a raw wire object — the tag is not present on the wire.
 *
 * @experimental
 */
export type HonuaStudioPackage = {
  readonly [F in HonuaStudioPackageFamily]: { readonly packageFamily: F } & StudioPackageFamilyShapes[F];
}[HonuaStudioPackageFamily];

/**
 * Every known Studio package family discriminant, in spec order.
 *
 * @experimental
 */
export const STUDIO_PACKAGE_FAMILIES = [
  "query",
  "analysis",
  "map",
  "dashboard",
  "report",
  "form",
  "app",
  "workflow",
  "gp",
  "etl",
] as const satisfies readonly HonuaStudioPackageFamily[];

/**
 * Type guard for a known {@link HonuaStudioPackageFamily} discriminant.
 *
 * @experimental
 */
export function isStudioPackageFamily(value: unknown): value is HonuaStudioPackageFamily {
  return typeof value === "string" && (STUDIO_PACKAGE_FAMILIES as readonly string[]).includes(value);
}

/**
 * Tag a raw family package with its client-side `packageFamily` discriminant,
 * producing a narrowable {@link HonuaStudioPackage} union member. The server
 * wire shape omits the tag; this is the canonical way to add it.
 *
 * @experimental
 */
export function tagStudioPackage<F extends HonuaStudioPackageFamily>(
  family: F,
  pkg: StudioPackageFamilyShapes[F],
): Extract<HonuaStudioPackage, { readonly packageFamily: F }> {
  return { ...(pkg as Record<string, unknown>), packageFamily: family } as Extract<
    HonuaStudioPackage,
    { readonly packageFamily: F }
  >;
}
