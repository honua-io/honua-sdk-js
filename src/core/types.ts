import type { HonuaCacheState, HonuaMetadataRequestOptions } from "./cache-state.js";

export type QueryMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HonuaRequestContext {
  url: string;
  path: string;
  method: QueryMethod;
  init: RequestInit;
}

export interface HonuaRequestMutation {
  url?: string;
  method?: QueryMethod;
  init?: RequestInit;
}

export interface HonuaResponseContext {
  request: HonuaRequestContext;
  response: Response;
  /** Wall-clock duration of the fetch call in milliseconds. */
  durationMs: number;
}

export interface HonuaErrorContext {
  request: HonuaRequestContext;
  error: unknown;
  /** Wall-clock duration of the fetch call in milliseconds, if available. */
  durationMs?: number;
}

export interface HonuaRequestInterceptor {
  before?(context: HonuaRequestContext): void | HonuaRequestMutation | Promise<void | HonuaRequestMutation>;
  after?(context: HonuaResponseContext): void | Promise<void>;
  error?(context: HonuaErrorContext): void | Promise<void>;
}

export type HonuaAuthRefreshReason = "initial" | "expired" | "unauthorized" | "manual";

export interface HonuaAuthCredentials {
  /** API key sent as `X-API-Key`. Useful for server key rotation. */
  apiKey?: string;
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Full Authorization header value for non-bearer schemes. */
  authorization?: string;
  /** Expiry time. Number values are epoch milliseconds. */
  expiresAt?: number | string | Date;
}

export interface HonuaAuthProviderContext {
  reason: HonuaAuthRefreshReason;
  forceRefresh: boolean;
  previousCredentials?: HonuaAuthCredentials;
}

export interface HonuaAuthRevocationContext {
  reason: "manual" | "unauthorized";
}

export type HonuaAuthProviderResult =
  | HonuaAuthCredentials
  | string
  | null
  | undefined
  | Promise<HonuaAuthCredentials | string | null | undefined>;

export type HonuaAuthCredentialsProvider = (context: HonuaAuthProviderContext) => HonuaAuthProviderResult;

export interface HonuaAuthProvider {
  getCredentials(context: HonuaAuthProviderContext): HonuaAuthProviderResult;
  revokeCredentials?(credentials: HonuaAuthCredentials, context: HonuaAuthRevocationContext): void | Promise<void>;
}

/** Parameters for querying features from a feature layer. */
export interface QueryFeaturesRequest {
  serviceId: string;
  layerId: number;
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  outSr?: HonuaSpatialReference | number | string;
  method?: QueryMethod;
  orderByFields?: string;
  objectIds?: number[] | string;
  geometry?: string | Record<string, unknown>;
  geometryType?: EsriGeometryType;
  spatialRel?: EsriSpatialRel;
  distance?: number;
  units?: string;
  nearestCount?: number;
  returnDistance?: boolean;
  returnDistinctValues?: boolean;
  returnCentroid?: boolean;
  groupByFieldsForStatistics?: string;
  outStatistics?: string | readonly Record<string, unknown>[];
  resultOffset?: number;
  resultRecordCount?: number;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/** Parameters for querying features from a map service layer. */
export interface MapLayerQueryRequest {
  serviceId: string;
  layerId: number;
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  outSr?: HonuaSpatialReference | number | string;
  method?: QueryMethod;
  orderByFields?: string;
  objectIds?: number[] | string;
  geometry?: string | Record<string, unknown>;
  geometryType?: EsriGeometryType;
  spatialRel?: EsriSpatialRel;
  distance?: number;
  units?: string;
  nearestCount?: number;
  returnDistance?: boolean;
  returnDistinctValues?: boolean;
  returnCentroid?: boolean;
  groupByFieldsForStatistics?: string;
  outStatistics?: string | readonly Record<string, unknown>[];
  resultOffset?: number;
  resultRecordCount?: number;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/** Parameters for querying related records from a feature layer. */
export interface QueryRelatedRecordsRequest {
  serviceId: string;
  layerId: number;
  relationshipId: number;
  objectIds?: number[] | string;
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/** Parameters for querying related records from a map service layer. */
export interface MapRelatedRecordsRequest {
  serviceId: string;
  layerId: number;
  relationshipId: number;
  objectIds?: number[] | string;
  where?: string;
  outFields?: string | string[];
  returnGeometry?: boolean;
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/** Parameters for exporting a map image from a map service. */
export interface ExportMapRequest {
  serviceId: string;
  bbox: string | [number, number, number, number];
  size: string | [number, number];
  responseFormat?: "json" | "pjson";
  format?: string;
  dpi?: number;
  transparent?: boolean;
  layers?: string;
  bboxSr?: string | number;
  imageSr?: string | number;
  backgroundColor?: string;
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
}

/** Parameters for requesting legend information from a map service. */
export interface MapLegendRequest {
  serviceId: string;
  responseFormat?: "json" | "pjson";
  size?: string | number | [number, number];
  dynamicLayers?: string;
  extraParams?: Record<string, string | number | boolean>;
}

/** Parameters for identifying features at a point on a map service. */
export interface MapIdentifyRequest {
  serviceId: string;
  geometry: string | Record<string, unknown>;
  geometryType?: string;
  sr?: string | number;
  layers?: string;
  tolerance?: number;
  mapExtent: string | [number, number, number, number];
  imageDisplay: string | [number, number, number];
  returnGeometry?: boolean;
  responseFormat?: "json" | "pjson";
  maxAllowableOffset?: number;
  layerDefs?: string;
  dynamicLayers?: string;
  time?: string;
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
}

/** Parameters for finding features by attribute value in a map service. */
export interface MapFindRequest {
  serviceId: string;
  searchText: string;
  contains?: boolean;
  searchFields?: string | string[];
  layers?: string;
  sr?: string | number;
  layerDefs?: string;
  returnGeometry?: boolean;
  maxAllowableOffset?: number;
  dynamicLayers?: string;
  returnZ?: boolean;
  returnM?: boolean;
  gdbVersion?: string;
  time?: string;
  relationParam?: string;
  responseFormat?: "json" | "pjson";
  method?: QueryMethod;
  extraParams?: Record<string, string | number | boolean>;
}

/** Parameters for making a raw HTTP request through the client. */
export interface HonuaRawRequest {
  path: string;
  method?: QueryMethod;
  responseFormat?: "json" | "pjson";
  query?: Record<string, string | number | boolean>;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
}

// ── Migration Toolkit Admin Contracts ─────────

export const MIGRATION_SOURCE_INVENTORY_ARTIFACT_KIND = "honua.migration.source-inventory";
export const MIGRATION_SOURCE_INVENTORY_ARTIFACT_VERSION = "1.0";
export const MIGRATION_MANIFEST_ARTIFACT_KIND = "honua.migration.manifest";
export const MIGRATION_MANIFEST_ARTIFACT_VERSION = "1.0";
export const MIGRATION_PARITY_EVIDENCE_ARTIFACT_KIND = "honua.migration.parity-evidence-pack";
export const MIGRATION_PARITY_EVIDENCE_ARTIFACT_VERSION = "1.0";

export const MIGRATION_EVIDENCE_STATES = {
  pass: "pass",
  fail: "fail",
  unknown: "unknown",
  notApplicable: "not-applicable",
} as const;

export type MigrationEvidenceState = (typeof MIGRATION_EVIDENCE_STATES)[keyof typeof MIGRATION_EVIDENCE_STATES];

export type MigrationInventorySourceKind =
  | "geoserver"
  | "geoserver-rest"
  | "geoservices"
  | "arcgis-geoservices-rest"
  | (string & {});

export interface MigrationInventoryScanRequest {
  sourceKind: MigrationInventorySourceKind;
  sourceUrl: string;
  username?: string;
  password?: string;
  timeoutSeconds?: number;
  includeStyleContent?: boolean;
  /** Request `/api/v1/admin/import/scan?export=json`; the response is still parsed as JSON. */
  exportJson?: boolean;
  signal?: AbortSignal;
}

export interface MigrationSourceInventoryArtifact {
  artifactKind: typeof MIGRATION_SOURCE_INVENTORY_ARTIFACT_KIND;
  artifactVersion: typeof MIGRATION_SOURCE_INVENTORY_ARTIFACT_VERSION;
  sourceKind: string;
  source: MigrationSourceIdentity;
  authPosture: MigrationInventoryAuthPosture;
  scanCompleteness: MigrationInventoryCompleteness;
  summary: MigrationInventorySummary;
  overallCompatibility: MigrationCompatibilityAssessment;
  containers: MigrationInventoryContainer[];
  resources: MigrationInventoryResource[];
  styles: MigrationInventoryStyle[];
  externalDependencies: MigrationExternalDependency[];
}

export interface MigrationSourceIdentity {
  displayName: string;
  baseUrl: string;
  product?: string;
  version?: string;
  build?: string;
  serviceType?: string;
}

export interface MigrationInventoryAuthPosture {
  mode: string;
  credentialsSupplied: boolean;
  accessConfirmed: boolean;
  notes: string[];
}

export interface MigrationInventoryCompleteness {
  /** `200 OK` can still carry `status: "failed"`; use this value as the planning gate. */
  status: "complete" | "partial" | "failed" | (string & {});
  warnings: string[];
  missingArtifacts: string[];
}

export interface MigrationInventorySummary {
  containerCount: number;
  resourceCount: number;
  styleCount: number;
  externalDependencyCount: number;
  compatibleCount: number;
  partiallyCompatibleCount: number;
  incompatibleCount: number;
}

export interface MigrationCompatibilityAssessment {
  level: "compatible" | "partial" | "incompatible" | (string & {});
  code?: string;
  reason: string;
  warnings: string[];
  manualSteps: string[];
}

export interface MigrationInventoryContainer {
  id: string;
  kind: string;
  name: string;
  title?: string;
  description?: string;
  isDefault?: boolean;
  compatibility: MigrationCompatibilityAssessment;
}

export interface MigrationInventoryResource {
  id: string;
  containerId: string;
  kind: string;
  name: string;
  title?: string;
  description?: string;
  geometryType?: string;
  featureCount?: number;
  hasAttachments?: boolean;
  capabilities: string[];
  spatialReferences: MigrationSpatialReferenceInfo[];
  fields: MigrationInventoryField[];
  styleIds: string[];
  externalDependencyIds: string[];
  compatibility: MigrationCompatibilityAssessment;
}

export interface MigrationInventoryField {
  name: string;
  alias?: string;
  fieldType: string;
  nullable?: boolean;
  domainType?: string;
  domainName?: string;
  domainValues?: MigrationInventoryCodedValue[];
}

export interface MigrationInventoryCodedValue {
  code: string;
  name: string;
}

export interface MigrationInventoryStyle {
  id: string;
  containerId: string;
  kind: string;
  name: string;
  format?: string;
  resourceIds: string[];
  externalDependencyIds: string[];
  metadata: Record<string, string>;
  compatibility: MigrationCompatibilityAssessment;
}

export interface MigrationExternalDependency {
  id: string;
  containerId: string;
  resourceId?: string;
  kind: string;
  name: string;
  dependencyType?: string;
  address?: string;
  metadata: Record<string, string>;
  spatialReferences: MigrationSpatialReferenceInfo[];
  compatibility: MigrationCompatibilityAssessment;
}

export interface MigrationSpatialReferenceInfo {
  role: string;
  sourceValue?: string;
  srid?: number;
  crsUri?: string;
  datum?: string;
  unit?: string;
  axisOrder?: string;
  isGeographic?: boolean;
}

export interface MigrationManifestArtifact {
  artifactKind: typeof MIGRATION_MANIFEST_ARTIFACT_KIND;
  artifactVersion: typeof MIGRATION_MANIFEST_ARTIFACT_VERSION;
  sourceArtifactKind: typeof MIGRATION_SOURCE_INVENTORY_ARTIFACT_KIND;
  sourceArtifactVersion: typeof MIGRATION_SOURCE_INVENTORY_ARTIFACT_VERSION;
  sourceKind: string;
  source: MigrationSourceIdentity;
  summary: MigrationManifestSummary;
  targetResources: MigrationManifestTargetResource[];
  styleActions: MigrationManifestStyleAction[];
  manualReviewItems: MigrationManifestReviewItem[];
  unsupportedItems: MigrationManifestReviewItem[];
}

export interface MigrationManifestSummary {
  sourceResourceCount: number;
  targetResourceCount: number;
  styleActionCount: number;
  manualReviewCount: number;
  unsupportedCount: number;
}

export interface MigrationManifestTargetResource {
  sourceResourceId: string;
  sourceKind: string;
  action: string;
  targetServiceName: string;
  targetResourceName: string;
  geometryType?: string;
  fields: MigrationInventoryField[];
  capabilities: string[];
  spatialReferences: MigrationSpatialReferenceInfo[];
  styleIds: string[];
  externalDependencyIds: string[];
  compatibility: MigrationCompatibilityAssessment;
}

export interface MigrationManifestStyleAction {
  sourceStyleId: string;
  action: string;
  format?: string;
  resourceIds: string[];
  externalDependencyIds: string[];
  compatibility: MigrationCompatibilityAssessment;
}

export interface MigrationManifestReviewItem {
  sourceId: string;
  kind: string;
  code: string;
  severity: string;
  reason: string;
  manualSteps: string[];
  warnings: string[];
}

export interface MigrationParityEvidenceArtifact {
  artifactKind: typeof MIGRATION_PARITY_EVIDENCE_ARTIFACT_KIND;
  artifactVersion: typeof MIGRATION_PARITY_EVIDENCE_ARTIFACT_VERSION;
  sourceKind: string;
  source: MigrationSourceIdentity;
  overallState: MigrationEvidenceState;
  summary: string;
  manifestAvailable: boolean;
  sections: MigrationParityEvidenceSection[];
  cutoverReadiness: MigrationCutoverReadinessSummary;
}

export interface MigrationParityEvidenceSection {
  id: string;
  title: string;
  state: MigrationEvidenceState;
  items: MigrationParityEvidenceItem[];
}

export interface MigrationParityEvidenceItem {
  id: string;
  state: MigrationEvidenceState;
  summary: string;
  evidence: string[];
  remediation: string[];
  relatedIds: string[];
}

export interface MigrationCutoverReadinessSummary {
  state: MigrationEvidenceState;
  items: MigrationCutoverReadinessItem[];
}

export interface MigrationCutoverReadinessItem {
  id: string;
  title: string;
  state: MigrationEvidenceState;
  evidence: string[];
  remediation: string[];
  owner?: string;
}

export interface MigrationReadinessAttestation {
  items: MigrationReadinessAttestationItem[];
}

export interface MigrationReadinessAttestationItem {
  id: string;
  state: MigrationEvidenceState;
  evidence: string[];
  owner?: string;
}

/** Parameters for applying feature edits (add, update, delete) to a feature layer. */
export interface ApplyEditsRequest {
  serviceId: string;
  layerId: number;
  adds?: HonuaFeature[];
  updates?: HonuaFeature[];
  deletes?: number[] | string;
  rollbackOnFailure?: boolean;
  signal?: AbortSignal;
}

export type HonuaTransport = "rest" | "grpc-web";

export interface HonuaClientOptions {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  /**
   * Optional credential provider. The SDK calls it lazily, caches returned
   * credentials until `expiresAt` nears, and never persists secrets itself.
   * Returning a string is shorthand for `{ bearerToken: string }`.
   */
  auth?: HonuaAuthProvider | HonuaAuthCredentialsProvider;
  /** Milliseconds before `expiresAt` when credentials should be refreshed. Default: 60 seconds. */
  authRefreshSkewMs?: number;
  fetchFn?: typeof fetch;
  interceptors?: readonly HonuaRequestInterceptor[];
  timeoutMs?: number;
  retry?: HonuaRetryOptions;
  /**
   * When `true`, query methods use `f=pbf` for binary protobuf responses
   * and decode them transparently into the same JSON-compatible shape.
   * Falls back to `f=json` on decode failure. Default: `false`.
   */
  preferBinary?: boolean;
  /**
   * Transport protocol. `"rest"` uses JSON/PBF over HTTP (default).
   * `"grpc-web"` uses typed RPC via Connect gRPC-Web transport.
   */
  transport?: HonuaTransport;
}

export interface HonuaRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryStatuses?: readonly number[];
}

export interface HonuaCompatibilityRequest {
  signal?: AbortSignal;
  refresh?: boolean;
}

export interface HonuaServerCompatibilityControlPlaneApi {
  major: number;
  basePath: string;
  deprecated: boolean;
}

export interface HonuaServerCompatibilityMetadataSchema {
  version: string;
  deprecated: boolean;
}

export interface HonuaServerCompatibilityFeatures {
  metadataResources: boolean;
  manifestExport: boolean;
  manifestApply: boolean;
  manifestDryRun: boolean;
  manifestPrune: boolean;
}

export type HonuaServerCompatibilityFeature = keyof HonuaServerCompatibilityFeatures;

export interface HonuaServerCompatibility {
  serverVersion: string;
  releaseChannel: string;
  controlPlaneApi: HonuaServerCompatibilityControlPlaneApi;
  metadataSchemas: HonuaServerCompatibilityMetadataSchema[];
  features: HonuaServerCompatibilityFeatures;
}

export interface HonuaServerCapabilitiesResponse {
  metadataApiVersions?: string[];
  resourceKinds?: string[];
  manifestSupported?: boolean;
  manifestDryRunSupported?: boolean;
  manifestPruneSupported?: boolean;
  compatibility: HonuaServerCompatibility;
}

export interface HonuaApiEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
  timestamp?: string;
}

export interface HonuaServerCompatibilityStatus {
  supported: boolean;
  minimumSupportedServerVersion: string;
  compatibility?: HonuaServerCompatibility;
  reasons: string[];
}

export type OgcResponseFormat = "json" | "html" | "geojson" | "gml" | "csv" | "schemajson" | "schema+json";

export interface OgcMetadataRequest extends HonuaMetadataRequestOptions {
  responseFormat?: OgcResponseFormat | string;
  extraParams?: Record<string, string | number | boolean>;
}

export interface OgcCollectionRequest extends OgcMetadataRequest {
  collectionId: string | number;
}

export interface OgcItemsRequest extends OgcCollectionRequest {
  limit?: number;
  offset?: number;
  bbox?: string;
  datetime?: string;
  filter?: string;
  ids?: string | readonly (string | number)[];
  properties?: string | readonly string[];
  sortby?: string;
  crs?: string;
  signal?: AbortSignal;
}

export interface OgcItemRequest extends OgcCollectionRequest {
  featureId: string | number;
  crs?: string;
  signal?: AbortSignal;
}

export interface OgcCreateItemRequest extends OgcCollectionRequest {
  feature: GeoJsonFeature | Record<string, unknown>;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface OgcReplaceItemRequest extends OgcItemRequest {
  feature: GeoJsonFeature | Record<string, unknown>;
  headers?: HeadersInit;
}

export interface OgcPatchItemRequest extends OgcItemRequest {
  patch: Record<string, unknown>;
  headers?: HeadersInit;
}

export interface OgcDeleteItemRequest extends OgcItemRequest {}

// ── Esri Geometry Types ───────────────────────────────────────

/** Well-known Esri geometry type identifiers with open-ended fallback. */
export type EsriGeometryType =
  | "esriGeometryPoint"
  | "esriGeometryPolyline"
  | "esriGeometryPolygon"
  | "esriGeometryEnvelope"
  | "esriGeometryMultipoint"
  | (string & {});

/** Well-known Esri spatial relationship identifiers. */
export type EsriSpatialRel =
  | "esriSpatialRelIntersects"
  | "esriSpatialRelContains"
  | "esriSpatialRelCrosses"
  | "esriSpatialRelEnvelopeIntersects"
  | "esriSpatialRelIndexIntersects"
  | "esriSpatialRelOverlaps"
  | "esriSpatialRelTouches"
  | "esriSpatialRelWithin"
  | (string & {});

/** Well-known Esri field type identifiers. */
export type EsriFieldType =
  | "esriFieldTypeString"
  | "esriFieldTypeInteger"
  | "esriFieldTypeSmallInteger"
  | "esriFieldTypeDouble"
  | "esriFieldTypeSingle"
  | "esriFieldTypeDate"
  | "esriFieldTypeOID"
  | "esriFieldTypeGeometry"
  | "esriFieldTypeBlob"
  | "esriFieldTypeRaster"
  | "esriFieldTypeGUID"
  | "esriFieldTypeGlobalID"
  | "esriFieldTypeXML"
  | (string & {});

/** An Esri point geometry. */
export interface EsriPoint {
  x: number;
  y: number;
  z?: number;
  m?: number;
  spatialReference?: HonuaSpatialReference;
}

/** An Esri polyline geometry. */
export interface EsriPolyline {
  paths: number[][][];
  spatialReference?: HonuaSpatialReference;
}

/** An Esri polygon geometry. */
export interface EsriPolygon {
  rings: number[][][];
  spatialReference?: HonuaSpatialReference;
}

/** An Esri envelope (bounding box) geometry. */
export interface EsriEnvelope {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: HonuaSpatialReference;
}

/** An Esri multipoint geometry. */
export interface EsriMultipoint {
  points: number[][];
  spatialReference?: HonuaSpatialReference;
}

/** Union of all Esri geometry shapes. */
export type EsriGeometry = EsriPoint | EsriPolyline | EsriPolygon | EsriEnvelope | EsriMultipoint;

/** A GeoJSON Feature object. */
export interface GeoJsonFeature {
  type: "Feature";
  id?: string | number;
  geometry: import("../expr/expression.js").GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
}

// ── Response Types ────────────────────────────────────────────

// ── Geometry & Spatial Reference ──────────────

/** A coordinate system reference, identified by WKID or WKT. */
export interface HonuaSpatialReference {
  wkid?: number;
  latestWkid?: number;
  wkt?: string;
}

/** An axis-aligned bounding box with an optional spatial reference. */
export interface HonuaExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: HonuaSpatialReference;
}

// ── Field Definitions ─────────────────────────

/** Metadata for a single attribute field in a layer. */
export interface HonuaFieldInfo {
  name: string;
  /** Esri field type string, e.g. `"esriFieldTypeString"`. */
  type: EsriFieldType;
  alias?: string;
  length?: number;
  nullable?: boolean;
  editable?: boolean;
  defaultValue?: unknown;
}

// ── Feature ───────────────────────────────────

/** A single feature with attribute values and optional geometry. */
export interface HonuaFeature {
  attributes: Record<string, unknown>;
  geometry?: EsriGeometry | Record<string, unknown> | null;
}

// ── Query Responses ───────────────────────────

/** Response from a feature or map-layer query returning features. */
export interface HonuaQueryResponse {
  objectIdFieldName?: string;
  geometryType?: EsriGeometryType;
  spatialReference?: HonuaSpatialReference;
  fields?: HonuaFieldInfo[];
  features?: HonuaFeature[];
  exceededTransferLimit?: boolean;
}

/** Response from a count-only query (`returnCountOnly=true`). */
export interface HonuaCountResponse {
  count: number | string;
}

/** Response from an IDs-only query (`returnIdsOnly=true`). */
export interface HonuaObjectIdsResponse {
  objectIdFieldName: string;
  objectIds: Array<number | string>;
}

/** Response from an extent-only query (`returnExtentOnly=true`). */
export interface HonuaExtentResponse {
  extent: HonuaExtent;
  count?: number | string;
}

// ── Apply Edits Response ──────────────────────

/** Result for a single add, update, or delete operation. */
export interface HonuaEditResult {
  objectId: number;
  success: boolean;
  error?: { code: number; description: string };
}

/** Response from `applyEdits` containing results for each operation type. */
export interface HonuaApplyEditsResponse {
  addResults?: HonuaEditResult[];
  updateResults?: HonuaEditResult[];
  deleteResults?: HonuaEditResult[];
}

// ── Related Records Response ──────────────────

/** A group of related records for a single source object ID. */
export interface HonuaRelatedRecordGroup {
  objectId: number;
  relatedRecords?: HonuaFeature[];
}

/** Response from `queryRelatedRecords`. */
export interface HonuaRelatedRecordsResponse {
  relatedRecordGroups?: HonuaRelatedRecordGroup[];
  fields?: HonuaFieldInfo[];
  geometryType?: EsriGeometryType;
  spatialReference?: HonuaSpatialReference;
}

// ── Map Service Responses ─────────────────────

/** Response from `exportMap` / `export`. */
export interface HonuaExportMapResponse {
  href?: string;
  width?: number;
  height?: number;
  extent?: HonuaExtent;
  scale?: number;
}

/** A single legend entry (swatch) for a layer. */
export interface HonuaLegendEntry {
  label?: string;
  url?: string;
  imageData?: string;
  contentType?: string;
  width?: number;
  height?: number;
}

/** Legend information for a single layer. */
export interface HonuaLegendLayer {
  layerId: number;
  layerName?: string;
  layerType?: string;
  minScale?: number;
  maxScale?: number;
  legend?: HonuaLegendEntry[];
}

/** Response from `legend`. */
export interface HonuaLegendResponse {
  layers?: HonuaLegendLayer[];
}

/** A single identified feature with layer info. */
export interface HonuaIdentifyResult {
  layerId: number;
  layerName?: string;
  displayFieldName?: string;
  value?: string;
  attributes?: Record<string, unknown>;
  geometryType?: string;
  geometry?: Record<string, unknown> | null;
}

/** Response from `identify`. */
export interface HonuaIdentifyResponse {
  results?: HonuaIdentifyResult[];
}

/** A single result from `find`. */
export interface HonuaFindResult {
  layerId: number;
  layerName?: string;
  displayFieldName?: string;
  foundFieldName?: string;
  value?: string;
  attributes?: Record<string, unknown>;
  geometryType?: string;
  geometry?: Record<string, unknown> | null;
}

/** Response from `find`. */
export interface HonuaFindResponse {
  results?: HonuaFindResult[];
}

// ── Attachment Responses ──────────────────────

/** Metadata for a single attachment on a feature. */
export interface HonuaAttachmentInfo {
  id: number;
  name?: string;
  contentType?: string;
  size?: number;
  parentObjectId?: number;
}

/** Response from `listAttachments`. */
export interface HonuaAttachmentListResponse {
  attachmentInfos?: HonuaAttachmentInfo[];
}

/** Result of an add/update/delete attachment operation. */
export interface HonuaAttachmentEditResult {
  objectId?: number;
  success: boolean;
  error?: { code: number; description: string };
}

/** Response from `addAttachment`. */
export interface HonuaAddAttachmentResponse {
  addAttachmentResult: HonuaAttachmentEditResult;
}

/** Response from `updateAttachment`. */
export interface HonuaUpdateAttachmentResponse {
  updateAttachmentResult: HonuaAttachmentEditResult;
}

/** Response from `deleteAttachments`. */
export interface HonuaDeleteAttachmentsResponse {
  deleteAttachmentResults: HonuaAttachmentEditResult[];
}

/** Response from attachment query with grouped results. */
export interface HonuaAttachmentGroup {
  parentObjectId: number;
  attachmentInfos?: HonuaAttachmentInfo[];
}

/** Response from `queryAttachments`. */
export interface HonuaQueryAttachmentsResponse {
  attachmentGroups?: HonuaAttachmentGroup[];
}

// ── Layer / Service Metadata ──────────────────

/** Metadata for a relationship between two layers/tables. */
export interface HonuaRelationshipInfo {
  id: number;
  name?: string;
  relatedTableId: number;
  role?: string;
  cardinality?: string;
  keyField?: string;
  keyFieldInRelationshipTable?: string;
}

/** Full metadata for a single feature or map layer. */
export interface HonuaLayerMetadata {
  id: number;
  name: string;
  type?: string;
  geometryType?: EsriGeometryType;
  description?: string;
  fields?: HonuaFieldInfo[];
  extent?: HonuaExtent;
  spatialReference?: HonuaSpatialReference;
  maxRecordCount?: number;
  supportsAttachments?: boolean;
  relationships?: HonuaRelationshipInfo[];
  cache?: HonuaCacheState;
}

/** Top-level metadata for a FeatureServer or MapServer service. */
export interface HonuaServiceMetadata {
  serviceDescription?: string;
  layers?: Array<{ id: number; name: string }>;
  tables?: Array<{ id: number; name: string }>;
  spatialReference?: HonuaSpatialReference;
  fullExtent?: HonuaExtent;
  maxRecordCount?: number;
  cache?: HonuaCacheState;
}

/** Response from `listServices()` — the REST services directory. */
export interface HonuaServicesResponse {
  currentVersion?: number;
  folders?: string[];
  services?: Array<{ name: string; type: string }>;
  cache?: HonuaCacheState;
}

// ── OGC Responses ─────────────────────────────

/** OGC API Features collection response (GeoJSON FeatureCollection). */
export interface HonuaOgcFeatureCollectionResponse {
  type: "FeatureCollection";
  features: HonuaOgcFeatureResponse[];
  numberMatched?: number;
  numberReturned?: number;
  links?: HonuaOgcLink[];
}

/** A single OGC API Feature (GeoJSON Feature). */
export interface HonuaOgcFeatureResponse {
  type: "Feature";
  id?: string | number;
  geometry: import("../expr/expression.js").GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
  links?: HonuaOgcLink[];
}

/** A hypermedia link in an OGC API response. */
export interface HonuaOgcLink {
  href: string;
  rel?: string;
  type?: string;
  title?: string;
}

// ── OGC Metadata Responses ───────────────────

/** Response from the OGC API landing page (`/ogc/features`). */
export interface HonuaOgcLandingResponse {
  title?: string;
  description?: string;
  links?: HonuaOgcLink[];
  cache?: HonuaCacheState;
}

/** Response from OGC API conformance (`/ogc/features/conformance`). */
export interface HonuaOgcConformanceResponse {
  conformsTo: string[];
  cache?: HonuaCacheState;
}

/** A single collection summary in an OGC collections listing. */
export interface HonuaOgcCollectionSummary {
  id: string;
  title?: string;
  description?: string;
  links?: HonuaOgcLink[];
  extent?: {
    spatial?: { bbox?: number[][]; crs?: string };
    temporal?: { interval?: (string | null)[][]; trs?: string };
  };
  itemType?: string;
  crs?: string[];
}

/** Response from OGC API collections listing (`/ogc/features/collections`). */
export interface HonuaOgcCollectionsResponse {
  collections: HonuaOgcCollectionSummary[];
  links?: HonuaOgcLink[];
  cache?: HonuaCacheState;
}

/** Response from a single OGC API collection (`/ogc/features/collections/{id}`). */
export interface HonuaOgcCollectionMetadata extends HonuaOgcCollectionSummary {
  cache?: HonuaCacheState;
}

/** A single queryable property definition. */
export interface HonuaOgcQueryableProperty {
  title?: string;
  description?: string;
  type?: string;
  enum?: unknown[];
}

/** Response from OGC API queryables (`/ogc/features/collections/{id}/queryables`). */
export interface HonuaOgcQueryablesResponse {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, HonuaOgcQueryableProperty>;
  cache?: HonuaCacheState;
}

// ── OGC API Tiles ─────────────────────────────

/** Identifier of an OGC tile-matrix-set (e.g. `WebMercatorQuad`). */
export type OgcTileMatrixSetId = string;

/** Identifier for a tileset variant (vector or raster) within a collection. */
export type OgcTileDataType = "vector" | "map" | "coverage" | (string & {});

/** Metadata for one tile-matrix entry (zoom level). */
export interface HonuaOgcTileMatrix {
  id: string;
  scaleDenominator?: number;
  cellSize?: number;
  matrixWidth?: number;
  matrixHeight?: number;
  tileWidth?: number;
  tileHeight?: number;
  pointOfOrigin?: readonly number[];
  cornerOfOrigin?: "topLeft" | "bottomLeft";
}

/** Metadata for one tile-matrix-set (CRS and supported tile matrices). */
export interface HonuaOgcTileMatrixSet {
  id: string;
  uri?: string;
  title?: string;
  description?: string;
  crs?: string;
  orderedAxes?: readonly string[];
  tileMatrices?: readonly HonuaOgcTileMatrix[];
  links?: HonuaOgcLink[];
  cache?: HonuaCacheState;
}

/** Response from `/tileMatrixSets`. */
export interface HonuaOgcTileMatrixSetsResponse {
  tileMatrixSets: HonuaOgcTileMatrixSet[];
  links?: HonuaOgcLink[];
  cache?: HonuaCacheState;
}

/** Metadata for a single tileset (a tile-matrix-set bound to a collection). */
export interface HonuaOgcTilesetMetadata {
  tileMatrixSetURI?: string;
  tileMatrixSetId?: string;
  dataType?: OgcTileDataType;
  crs?: string;
  links?: HonuaOgcLink[];
  /** Optional explicit CRS for tile bounds, otherwise inferred from TMS. */
  boundingBox?: { lowerLeft?: readonly number[]; upperRight?: readonly number[]; crs?: string };
  /** Pre-baked styles available on the tileset (for styled-tile access). */
  styles?: Array<{ id: string; title?: string }>;
  cache?: HonuaCacheState;
}

/** Response from `/collections/{id}/tiles` (list of tilesets). */
export interface HonuaOgcTilesetsResponse {
  tilesets: HonuaOgcTilesetMetadata[];
  links?: HonuaOgcLink[];
  cache?: HonuaCacheState;
}

/** Request envelope for tileset-discovery operations. */
export interface OgcTilesetsRequest extends OgcMetadataRequest {
  collectionId: string | number;
}

/** Request envelope for one tileset's metadata. */
export interface OgcTilesetRequest extends OgcTilesetsRequest {
  tileMatrixSetId: OgcTileMatrixSetId;
}

/** Request envelope for fetching a single tile. */
export interface OgcTileRequest {
  collectionId: string | number;
  tileMatrixSetId: OgcTileMatrixSetId;
  tileMatrix: string | number;
  tileRow: number;
  tileCol: number;
  /** `Accept` header (`application/vnd.mapbox-vector-tile`, `image/png`, …). */
  accept?: string;
  signal?: AbortSignal;
  extraParams?: Record<string, string | number | boolean>;
}

/** Raw bytes returned from a tile fetch, plus the negotiated content type. */
export interface HonuaOgcTileResponse {
  bytes: Uint8Array;
  contentType: string;
  /** True when the server returned a non-error empty payload (sparse tile). */
  empty: boolean;
}

// ── OGC API Maps ──────────────────────────────

/**
 * Output format token for an OGC API Maps request. The OGC standard
 * defines the `f` query value as a short-name token (`png`, `jpeg`,
 * `jpg`, `tiff`, `tif`); the server validates against that set. The SDK
 * also accepts the matching media-type aliases (`image/png`, etc.) and
 * normalizes them to the short name on the wire. The Accept header is
 * media-type based regardless.
 */
export type OgcMapFormat =
  | "png"
  | "jpeg"
  | "jpg"
  | "tiff"
  | "tif"
  | "image/png"
  | "image/jpeg"
  | "image/tiff"
  | (string & {});

/**
 * Request envelope for an OGC API Maps render. `collectionId` is omitted
 * for dataset-level renders. `styleId` selects a server-managed style;
 * inline style overrides are not exposed here (the server-side spec
 * does not standardize an inline-style channel).
 */
export interface OgcMapImageRequest {
  collectionId?: string | number;
  styleId?: string;
  width?: number;
  height?: number;
  bbox?: readonly [number, number, number, number] | string;
  bboxCrs?: string;
  crs?: string;
  format?: OgcMapFormat;
  /** Optional comma-separated list of collections (dataset-level only). */
  collections?: readonly string[];
  /** Optional transparency hint. */
  transparent?: boolean;
  signal?: AbortSignal;
  extraParams?: Record<string, string | number | boolean>;
}

/** Raw bytes returned from a map render, plus the negotiated content type. */
export interface HonuaOgcMapImageResponse {
  bytes: Uint8Array;
  contentType: string;
}

// ── OGC API Processes ─────────────────────────

/** Process input/output literal envelope. */
export type OgcProcessIoValue = string | number | boolean | null | Record<string, unknown> | unknown[];

/** Process input bag — id → value (or qualified value). */
export type OgcProcessInputs = Record<string, OgcProcessIoValue>;

/** OGC API Processes process metadata (subset; servers may include more). */
export interface HonuaOgcProcessSummary {
  id: string;
  title?: string;
  description?: string;
  version?: string;
  jobControlOptions?: readonly string[];
  outputTransmission?: readonly string[];
  links?: HonuaOgcLink[];
}

/** Detailed process description (input / output schemas). */
export interface HonuaOgcProcessDescription extends HonuaOgcProcessSummary {
  inputs?: Record<string, Record<string, unknown>>;
  outputs?: Record<string, Record<string, unknown>>;
  cache?: HonuaCacheState;
}

/** Response from `/processes`. */
export interface HonuaOgcProcessesResponse {
  processes: HonuaOgcProcessSummary[];
  links?: HonuaOgcLink[];
  cache?: HonuaCacheState;
}

/** OGC API Processes 1.0 status values. */
export type OgcProcessStatus = "accepted" | "running" | "successful" | "failed" | "dismissed";

/**
 * Job-status payload returned from `/jobs/{jobId}`. Mirrors the OGC
 * Processes 1.0 statusInfo schema.
 */
export interface HonuaOgcProcessJobStatus {
  jobID: string;
  processID?: string;
  status: OgcProcessStatus;
  message?: string;
  progress?: number;
  created?: string;
  started?: string;
  finished?: string;
  updated?: string;
  links?: HonuaOgcLink[];
  /** Server-reported error envelope on failure. */
  exception?: { code: string; message: string; details?: unknown };
}

/**
 * Process-execution request envelope. honua-server advertises
 * `jobControlOptions: ['async-execute', 'dismiss']` and rejects any
 * `response` other than `document` with HTTP 501 — the SDK type mirrors
 * that supported surface (no `sync` mode, no `raw` response). `mode: "auto"`
 * omits the `Prefer` header so the server applies its default; `"async"`
 * sends `Prefer: respond-async` explicitly.
 */
export interface OgcProcessExecuteRequest {
  processId: string;
  inputs?: OgcProcessInputs;
  outputs?: Record<string, { transmissionMode?: "value" | "reference"; format?: { mediaType?: string } }>;
  /** `async-execute` returns a job; `auto` lets the server pick (always async on Honua). */
  mode?: "async" | "auto";
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/** Job descriptor returned when the server accepted an async execution. */
export interface HonuaOgcProcessJobAccepted {
  jobID: string;
  status: OgcProcessStatus;
  processID?: string;
  links?: HonuaOgcLink[];
  /** Initial (often `accepted` or `running`) status payload, when reported. */
  statusInfo?: HonuaOgcProcessJobStatus;
}

/**
 * Result document returned from `/jobs/{jobId}/results`. OGC API Processes
 * Part 1 §7.11.1 defines the document-mode body as a map keyed by output
 * identifier; the body is the map itself, not an `{ outputs: ... }`
 * envelope. honua-server returns `{}` until populated entries land via the
 * artifact store.
 */
export type HonuaOgcProcessJobResults = Record<string, unknown>;

// ── STAC API ──────────────────────────────────

/** Subset of the STAC core API search request shape. */
export interface StacSearchRequest {
  bbox?: readonly [number, number, number, number];
  datetime?: string;
  intersects?: Record<string, unknown>;
  ids?: readonly string[];
  collections?: readonly string[];
  filter?: string;
  filterLang?: "cql2-text" | "cql2-json";
  limit?: number;
  /**
   * Numeric page offset. honua-server's `/stac/search` uses `offset` as
   * the canonical paging token (its `rel=next` link href carries
   * `?offset=N`). Prefer this over `next` for honua-server compatibility.
   */
  offset?: number;
  /**
   * Server-driven page token. Optional support for STAC servers that
   * advertise an opaque `?next=…` token instead of `offset`.
   */
  next?: string;
  /** Subset of asset / item properties to return. */
  fields?: { include?: readonly string[]; exclude?: readonly string[] };
  sortby?: string;
  signal?: AbortSignal;
  /** When `true`, the adapter posts the body to `/search`. */
  usePost?: boolean;
}

/** Single STAC item (a GeoJSON feature with STAC-specific extensions). */
export interface HonuaStacItemResponse extends HonuaOgcFeatureResponse {
  collection?: string;
  stac_version?: string;
  stac_extensions?: readonly string[];
  assets?: Record<string, { href: string; type?: string; title?: string; roles?: readonly string[] }>;
}

/** Response from STAC `/search`. */
export interface HonuaStacItemCollectionResponse {
  type: "FeatureCollection";
  features: HonuaStacItemResponse[];
  links?: HonuaOgcLink[];
  numberMatched?: number;
  numberReturned?: number;
  context?: { matched?: number; returned?: number; limit?: number };
}

/** Subset of the STAC catalog landing page. */
export interface HonuaStacLandingResponse extends HonuaOgcLandingResponse {
  conformsTo?: readonly string[];
  /** Stac-specific catalog id. */
  id?: string;
}

// ── Schema-Aware Typed Collections ────────────

/**
 * A feature with a typed attribute schema. Use with `HonuaFeatureLayer<T>` to
 * get autocompletion and type checking on attribute access.
 */
export interface HonuaTypedFeature<T = Record<string, unknown>> {
  attributes: T;
  geometry?: EsriGeometry | Record<string, unknown> | null;
}

/**
 * A query response with typed feature attributes. The generic parameter `T`
 * flows from `HonuaFeatureLayer<T>` to provide typed attribute access.
 */
export interface HonuaTypedQueryResponse<T = Record<string, unknown>> {
  objectIdFieldName?: string;
  geometryType?: EsriGeometryType;
  spatialReference?: HonuaSpatialReference;
  fields?: HonuaFieldInfo[];
  features?: HonuaTypedFeature<T>[];
  exceededTransferLimit?: boolean;
}
