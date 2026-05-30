/**
 * `@honua/sdk-js/console` — browser-safe SDK contracts for `honua-console`.
 *
 * This subpath exposes the SDK-projected view of the shared content/metadata
 * model (content items, Metadata v2, sharing, embeds, provenance) and the
 * dashboard/report package projections with Vega-Lite chart spec support, so
 * Console can consume stable contracts without copying server DTOs or Portal
 * types.
 *
 * Contract ownership:
 * - **server-owned**: canonical wire shapes in `honua-server` (Metadata v2,
 *   content items, packages, sharing, embeds, provenance). Not defined here.
 * - **SDK-projected**: the browser-safe types and projection helpers in this
 *   module, plus `@honua/sdk-js/runtime` (`MapPackage`), `./control-plane`
 *   (admin resources, sharing), and `./generated-app` (generated-app runtime).
 * - **Console-rendered**: render models (`*RenderModel`) derived from the
 *   projections above.
 *
 * MCP / QGIS / Console parity: these contracts describe the same package
 * artifacts the MCP server and QGIS plugin consume. The chart-kind vocabulary
 * (`categories` / `histogram` / `time-series`) is shared with
 * `./generated-app`; {@link chartWidgetToVegaLiteSpec} is the canonical bridge
 * so every consumer renders identical charts.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export {
  HONUA_CONSOLE_METADATA_FORMAT_V2,
  HONUA_CONSOLE_KNOWN_CONTENT_KINDS,
  isKnownConsoleContentKind,
} from "./content.js";
export type {
  HonuaConsoleContentItem,
  HonuaConsoleContentKind,
  HonuaConsoleEmbed,
  HonuaConsoleMetadata,
  HonuaConsoleMetadataFormat,
  HonuaConsoleProvenance,
  HonuaConsoleSharing,
  HonuaConsoleVisibility,
} from "./content.js";

export {
  assertVegaLiteSpec,
  isVegaLiteSpec,
  normalizeVegaLiteSpec,
  HONUA_CONSOLE_VEGA_LITE_SCHEMA,
} from "./vega-lite.js";
export type {
  HonuaVegaLiteAggregate,
  HonuaVegaLiteData,
  HonuaVegaLiteEncoding,
  HonuaVegaLiteFieldDef,
  HonuaVegaLiteFieldType,
  HonuaVegaLiteMark,
  HonuaVegaLiteSpec,
} from "./vega-lite.js";

export {
  chartWidgetToVegaLiteSpec,
  projectDashboardPackage,
  projectReportPackage,
  HONUA_CONSOLE_DASHBOARD_PACKAGE_FORMAT_V1,
  HONUA_CONSOLE_REPORT_PACKAGE_FORMAT_V1,
} from "./dashboard.js";
export type {
  HonuaConsoleChartKind,
  HonuaConsoleChartPanel,
  HonuaConsoleChartPanelModel,
  HonuaConsoleChartWidgetLike,
  HonuaConsoleDashboardPackage,
  HonuaConsoleDashboardPackageFormat,
  HonuaConsoleDashboardRenderModel,
  HonuaConsolePanel,
  HonuaConsolePanelBase,
  HonuaConsolePanelBinding,
  HonuaConsolePanelKind,
  HonuaConsoleReportPackage,
  HonuaConsoleReportPackageFormat,
  HonuaConsoleReportRenderModel,
  HonuaConsoleReportSection,
} from "./dashboard.js";

export { HonuaConsoleError, toConsoleDiagnostic } from "./errors.js";
export type {
  HonuaConsoleDiagnostic,
  HonuaConsoleErrorCode,
  HonuaConsoleErrorDetail,
  HonuaConsoleErrorStage,
} from "./errors.js";
