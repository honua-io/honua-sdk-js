/**
 * Framework-neutral Honua custom elements.
 *
 * Importing this module registers the shipped custom elements when a browser
 * `customElements` registry is present. Node imports are safe; call
 * `defineHonuaWebComponents()` explicitly when using a scoped registry.
 *
 * The `<honua-measure-control>` and `<honua-sketch-control>` elements need a
 * drawing backend to be interactive. The SDK does not bundle one (no hard
 * dependency on maplibre-gl-draw or similar); instead, supply a
 * {@link HonuaMeasureProvider} via `measurementGeometry` and/or a
 * {@link HonuaSketchProvider} via `sketchGeometry` to
 * `createHonuaWebComponentController`. Without a provider both controls render
 * disabled by design with a "configure a provider" affordance.
 *
 * The survival-tier widget set (issue #493) — `<honua-legend>`,
 * `<honua-layer-list>` (visibility / opacity / reorder), `<honua-search>`
 * (geocoding-provider-aware), and `<honua-measurement>` (self-contained
 * distance/area drawing on the map's pointer events, computed with
 * `@honua/geometry` ops) — needs no external drawing provider.
 *
 * `<honua-legend>` and `<honua-layer-list>` are also each contested by the
 * `controls` kit's own framework-free implementation. This kit's classes are
 * both tags' canonical/default registrant: importing `./web-components` —
 * alone, or alongside `@honua/sdk-js/controls` in either order — always
 * registers these tags with the classes exported here (issue #679; see
 * `./catalog.js` for the full ownership record and `./registry.js` for the
 * catalog-id-addressable registration APIs re-exported below).
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

import { defineHonuaWebComponents } from "./elements.js";

// The blanket auto-registration side effect lives here, not in `./elements.js`
// (issue #679 PR review): `./elements.js` must stay side-effect-free on
// import so `../controls/registry.js` can dynamically `import()` it to
// register one tag without also claiming every tag the kit owns. This is
// every existing `@honua/sdk-js/web-components` consumer's actual entry
// point, so the observable behavior — importing this module registers all 16
// tags when a `customElements` registry is present — is unchanged.
defineHonuaWebComponents();

export {
  HonuaInMemoryWebComponentController,
  createHonuaWebComponentController,
  createHonuaWebComponentControllerFromRuntime,
  layersFromMapPackage,
  legendFromMapPackage,
} from "./controller.js";

export {
  HONUA_COMPONENT_CATALOG,
  describeDeprecatedComponentImport,
  getCanonicalComponentCatalogEntry,
  getComponentCatalogEntriesForTag,
  getComponentCatalogEntry,
  listComponentCatalogEntries,
  listDeprecatedComponentImports,
} from "../controls/catalog.js";
export type {
  HonuaComponentCatalogEntry,
  HonuaComponentSource,
  HonuaComponentSupportTier,
  HonuaDeprecatedComponentDiagnostic,
} from "../controls/catalog.js";
export {
  HonuaComponentCatalogError,
  createComponentRegistry,
  registerAllComponents,
  registerComponent,
  registerComponents,
} from "../controls/registry.js";
export type {
  HonuaComponentCatalogId,
  HonuaComponentRegistrationOptions,
  HonuaComponentRegistry,
} from "../controls/registry.js";

export {
  HonuaActionPanelElement,
  HonuaBasemapControlElement,
  HonuaBookmarksElement,
  HonuaChartElement,
  HonuaEditorElement,
  HonuaFeatureTableElement,
  HonuaLayerListElement,
  HonuaLegendElement,
  HonuaLocateControlElement,
  HonuaMapElement,
  HonuaMapStatusElement,
  HonuaMeasureControlElement,
  HonuaPrintExportElement,
  HonuaSearchElement,
  HonuaSketchControlElement,
  defineHonuaWebComponent,
  defineHonuaWebComponents,
  honuaExportKindFromFormat,
} from "./elements.js";

export { HonuaMeasurementElement, defineHonuaMeasurement } from "./measurement.js";

// ── secure export contract (issue #683) ──────────────────────────────────
export {
  HONUA_EXPORT_KINDS,
  HonuaExportError,
  approximateHonuaScaleLabel,
  assertHonuaExportProvenanceComplete,
  assertHonuaExportReady,
  buildHonuaExportProvenance,
  createBrowserPrintExportAdapter,
  createHonuaExportAdapter,
  runHonuaExport,
} from "./export.js";
export type {
  BuildHonuaExportProvenanceOptions,
  CreateHonuaExportAdapterOptions,
  HonuaExportAdapter,
  HonuaExportCapabilities,
  HonuaExportContext,
  HonuaExportKind,
  HonuaExportOwnership,
  HonuaExportPayload,
  HonuaExportProvenance,
  HonuaExportRequest,
  HonuaExportResult,
  HonuaExportStatus,
  HonuaPrintWindowLike,
  HonuaSnapshotCanvasLike,
  HonuaSnapshotSource,
} from "./export.js";
export {
  HONUA_EXPORT_REDACTED,
  HONUA_EXPORT_STATE_SCHEMA,
  HonuaExportSafetyError,
  assertCredentialFreeExportBytes,
  assertCredentialFreeExportText,
  containsCredentialMaterial,
  extractPrintableRuns,
  isSensitiveExportKey,
  projectExportEndpoint,
  redactHonuaExportText,
  sanitizeHonuaExportFilename,
  sanitizeHonuaExportHeaders,
  sanitizeHonuaExportState,
} from "./export-redaction.js";
export type {
  HonuaExportEndpointProjection,
  HonuaExportRedaction,
  HonuaExportRedactionReason,
  HonuaExportStateSanitizationResult,
  HonuaSanitizedExportFilter,
  HonuaSanitizedExportLayer,
  HonuaSanitizedExportLegendItem,
  HonuaSanitizedExportSelection,
  HonuaSanitizedExportSource,
  HonuaSanitizedExportState,
  SanitizeHonuaExportFilenameOptions,
  SanitizeHonuaExportStateOptions,
} from "./export-redaction.js";

// ── production qualification matrix (issue #683) ─────────────────────────
export {
  HONUA_COMPONENT_QUALIFICATION_DATA_VERSION,
  HONUA_COMPONENT_QUALIFICATION_GATES,
  HONUA_COMPONENT_QUALIFICATION_STATUSES,
  describeComponentQualificationGate,
  getComponentQualification,
  isComponentProductionQualified,
  listOpenQualificationGates,
  listComponentQualifications,
  summarizeComponentQualification,
} from "../controls/qualification.js";
export type {
  HonuaComponentQualification,
  HonuaComponentQualificationGate,
  HonuaComponentQualificationGateId,
  HonuaComponentQualificationRequirement,
  HonuaComponentQualificationStatus,
  HonuaComponentQualificationSummary,
  HonuaComponentQualificationCell,
} from "../controls/qualification.js";

// ── production-tier feature editor (issue #680) ──────────────────────────
export { HonuaFeatureEditorElement, defineHonuaFeatureEditor } from "./feature-editor.js";
export type { HonuaFeatureEditChangeDetail, HonuaFeatureEditCommitDetail } from "./feature-editor.js";
export { HonuaFeatureEditorWorkflow, createFeatureEditorWorkflow } from "./feature-editor-workflow.js";
export type {
  HonuaFeatureEditorCommit,
  HonuaFeatureEditorConflict,
  HonuaFeatureEditorConflictChoice,
  HonuaFeatureEditorExternalChangeOutcome,
  HonuaFeatureEditorFailure,
  HonuaFeatureEditorIdentity,
  HonuaFeatureEditorOptions,
  HonuaFeatureEditorSketchState,
  HonuaFeatureEditorSnapshot,
  HonuaFeatureEditorStatus,
} from "./feature-editor-workflow.js";
export {
  buildEditorFormModel,
  coerceEditorFieldValue,
  editorControlKind,
  editorDomainFromSchema,
  editorFieldInputValue,
  editorFieldsFromSchema,
  editorOperationAvailability,
  hiddenEditorFieldNames,
  redactEditorAttachment,
  resolveActiveEditorSubtype,
  resolveEditorFields,
  resolveEditorOperations,
} from "./feature-editor-model.js";
export type {
  BuildEditorFormModelInput,
  HonuaEditorAttachmentDraft,
  HonuaEditorAttachmentMutationLike,
  HonuaEditorCapabilityDecisionLike,
  HonuaEditorChoice,
  HonuaEditorControlKind,
  HonuaEditorFieldControl,
  HonuaEditorFormModel,
  HonuaEditorOperation,
  HonuaEditorOperationAvailability,
  HonuaEditorOperationOverride,
  HonuaEditorOperationOverrides,
  HonuaEditorSchemaDomainLike,
  HonuaEditorSchemaFieldLike,
  HonuaEditorSubtype,
  HonuaEditorSubtypeConfig,
  HonuaEditorSubtypeFieldOverride,
  HonuaEditorUnavailableCode,
  ResolveEditorOperationsInput,
} from "./feature-editor-model.js";
export { bindEditorSketch, createTerraDrawEditorSketch, editorSnappingOptions } from "./feature-editor-sketch.js";
export type {
  CreateTerraDrawEditorSketchOptions,
  HonuaEditorSketchAdapter,
  HonuaEditorSketchOptions,
  HonuaEditorSnappingOptions,
} from "./feature-editor-sketch.js";

export type {
  HonuaActionDetail,
  HonuaActionPanelAction,
  HonuaBasemapChangeDetail,
  HonuaBookmark,
  HonuaBookmarkChangeDetail,
  CreateHonuaWebComponentControllerOptions,
  HonuaChartDatum,
  HonuaChartModel,
  HonuaComponentStatus,
  HonuaControllerReadyDetail,
  HonuaControllerStateListener,
  HonuaControllerSubscription,
  HonuaEditCapabilities,
  HonuaEditChangeDetail,
  HonuaEditRequest,
  HonuaEditorModel,
  HonuaExportDetail,
  HonuaFeatureRecord,
  HonuaFeatureStateEntry,
  HonuaFeatureStateTarget,
  HonuaFeatureTableModel,
  HonuaFilterChangeDetail,
  HonuaFilterState,
  HonuaFullscreenChangeDetail,
  HonuaGeocodeSelectDetail,
  HonuaLayerModel,
  HonuaLayerOpacityChangeDetail,
  HonuaLayerOrderChangeDetail,
  HonuaLayerVisibilityChangeDetail,
  HonuaLegendItem,
  HonuaLocateChangeDetail,
  HonuaMapClickDetail,
  HonuaMapErrorDetail,
  HonuaMapHoverDetail,
  HonuaMapInteractionDetail,
  HonuaMapInteractionPoint,
  HonuaMapReadyDetail,
  HonuaMeasureChangeDetail,
  HonuaMeasureMode,
  HonuaMeasureProvider,
  HonuaMeasureResult,
  HonuaMeasurementMap,
  HonuaQueryFeaturesOptions,
  HonuaSearchDetail,
  HonuaSearchGeocodeCandidate,
  HonuaSearchGeocodeSuggestion,
  HonuaSearchGeocoderLike,
  HonuaSearchOptions,
  HonuaSearchResult,
  HonuaSelectionChangeDetail,
  HonuaSelectionState,
  HonuaSketchChangeDetail,
  HonuaSketchMode,
  HonuaSketchProvider,
  HonuaSketchResult,
  HonuaViewportChangeDetail,
  HonuaViewportState,
  HonuaWebComponentController,
  HonuaWebComponentRuntimeLike,
  HonuaWebComponentState,
} from "./types.js";
