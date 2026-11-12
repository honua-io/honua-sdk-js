// Pre-vocabulary names, kept as deprecated aliases for one release.

import type { MapDocumentDiff } from "./diff.js";
import { HonuaMapDocumentError, type HonuaMapDocumentErrorStage } from "./errors.js";
import { type LoadMapDocumentOfflineRegion, type LoadMapDocumentOptions, loadMapDocument } from "./load-package.js";
import {
  type ExportMapDocumentOptions,
  HONUA_MAP_DOCUMENT_EXPORT_KIND_V1,
  type HonuaMapDocumentExport,
  type ImportMapDocumentOptions,
  type ImportMapDocumentResult,
  exportMapDocument,
  importMapDocument,
} from "./map-package-export.js";
import {
  BoundedMapDocumentFetchCache,
  DEFAULT_MAP_DOCUMENT_CACHE_LIMIT,
  DEFAULT_MAP_DOCUMENT_PATH_PREFIX,
  type FetchMapDocumentOptions,
  type FetchMapDocumentResult,
  type LoadMapDocumentFromIdOptions,
  type LoadMapDocumentFromIdResult,
  type MapDocumentFetchCache,
  type MapDocumentFetchCacheEntry,
  type MapDocumentFetchCacheState,
  type MapDocumentFetchCacheStatus,
  type MapDocumentLocator,
  type MapDocumentPathResolver,
  defaultMapDocumentPath,
  fetchMapDocument,
  loadMapDocumentFromId,
  mapDocumentFingerprint,
  resolveMapDocumentPath,
} from "./map-package-fetch.js";
import {
  MAP_DOCUMENT_REALTIME_CHANNEL_V1,
  type MapDocumentRealtimeAdvertisement,
  type MapDocumentRealtimeAuth,
  type MapDocumentRealtimeChannel,
  type MapDocumentRealtimeCheckpoint,
  type MapDocumentRealtimeDisconnectedMessage,
  type MapDocumentRealtimeErrorMessage,
  type MapDocumentRealtimeEventSource,
  type MapDocumentRealtimeEventSourceFactory,
  type MapDocumentRealtimeFallbackMode,
  type MapDocumentRealtimeHeartbeatMessage,
  type MapDocumentRealtimeMessage,
  type MapDocumentRealtimeMessageBase,
  type MapDocumentRealtimeObserver,
  type MapDocumentRealtimeReadyMessage,
  type MapDocumentRealtimeReconnectOptions,
  type MapDocumentRealtimeRefetchRequiredMessage,
  type MapDocumentRealtimeReloadRequiredMessage,
  type MapDocumentRealtimeStaleMessage,
  type MapDocumentRealtimeSubscribeRequest,
  type MapDocumentRealtimeSubscriptionHandle,
  type MapDocumentRealtimeTransport,
  type MapDocumentRealtimeTransportKind,
  type MapDocumentRealtimeUpdate,
  type MapDocumentRealtimeUpdatedMessage,
  type MapDocumentRealtimeWatchOptions,
  type MapDocumentServerSentEventsTransportOptions,
  createMapDocumentServerSentEventsTransport,
  decodeMapDocumentRealtimeMessage,
  encodeMapDocumentRealtimeUrl,
  readMapDocumentRealtimeAdvertisement,
} from "./map-package-realtime.js";
import {
  type HonuaMapDocumentDiagnostic,
  type HonuaMapDocumentDiagnosticCode,
  type HonuaMapDocumentDiagnosticSeverity,
  type ValidateMapDocumentOptions,
  type ValidateMapDocumentResult,
  hasMapDocumentDiagnosticErrors,
  validateMapDocument,
} from "./map-package-validation.js";
import {
  type MapDocumentWatchEvent,
  type MapDocumentWatchHandle,
  type WatchMapDocumentOptions,
  watchMapDocument,
} from "./map-package-watch.js";
import type {
  HonuaMapDocument,
  HonuaMapDocumentAttribution,
  HonuaMapDocumentDependency,
  HonuaMapDocumentFormat,
  HonuaMapDocumentInitialView,
  HonuaMapDocumentLabelBinding,
  HonuaMapDocumentLegendEntry,
  HonuaMapDocumentLocator,
  HonuaMapDocumentPopupBinding,
  HonuaMapDocumentProtocol,
  HonuaMapDocumentProvenance,
  HonuaMapDocumentSourceBinding,
  HonuaMapDocumentStatus,
  HonuaMapDocumentStyleRef,
  HonuaMapDocumentThemeSpec,
  HonuaMapDocumentWidget,
} from "./map-package.js";

/** @deprecated Use BoundedMapDocumentFetchCache. Removed in the next minor. */
export const BoundedMapPackageFetchCache = BoundedMapDocumentFetchCache;
/** @deprecated Use BoundedMapDocumentFetchCache. Removed in the next minor. */
export type BoundedMapPackageFetchCache = BoundedMapDocumentFetchCache;
/** @deprecated Use ExportMapDocumentOptions. Removed in the next minor. */
export type ExportMapPackageOptions = ExportMapDocumentOptions;
/** @deprecated Use FetchMapDocumentOptions. Removed in the next minor. */
export type FetchMapPackageOptions = FetchMapDocumentOptions;
/** @deprecated Use FetchMapDocumentResult. Removed in the next minor. */
export type FetchMapPackageResult = FetchMapDocumentResult;
/** @deprecated Use HonuaMapDocument. Removed in the next minor. */
export type HonuaMapPackage = HonuaMapDocument;
/** @deprecated Use HonuaMapDocumentAttribution. Removed in the next minor. */
export type HonuaMapPackageAttribution = HonuaMapDocumentAttribution;
/** @deprecated Use HonuaMapDocumentDependency. Removed in the next minor. */
export type HonuaMapPackageDependency = HonuaMapDocumentDependency;
/** @deprecated Use HonuaMapDocumentDiagnostic. Removed in the next minor. */
export type HonuaMapPackageDiagnostic = HonuaMapDocumentDiagnostic;
/** @deprecated Use HonuaMapDocumentDiagnosticCode. Removed in the next minor. */
export type HonuaMapPackageDiagnosticCode = HonuaMapDocumentDiagnosticCode;
/** @deprecated Use HonuaMapDocumentDiagnosticSeverity. Removed in the next minor. */
export type HonuaMapPackageDiagnosticSeverity = HonuaMapDocumentDiagnosticSeverity;
/** @deprecated Use HonuaMapDocumentError. Removed in the next minor. */
export const HonuaMapPackageError = HonuaMapDocumentError;
/** @deprecated Use HonuaMapDocumentError. Removed in the next minor. */
export type HonuaMapPackageError = HonuaMapDocumentError;
/** @deprecated Use HonuaMapDocumentErrorStage. Removed in the next minor. */
export type HonuaMapPackageErrorStage = HonuaMapDocumentErrorStage;
/** @deprecated Use HonuaMapDocumentExport. Removed in the next minor. */
export type HonuaMapPackageExport = HonuaMapDocumentExport;
/** @deprecated Use HonuaMapDocumentFormat. Removed in the next minor. */
export type HonuaMapPackageFormat = HonuaMapDocumentFormat;
/** @deprecated Use HonuaMapDocumentInitialView. Removed in the next minor. */
export type HonuaMapPackageInitialView = HonuaMapDocumentInitialView;
/** @deprecated Use HonuaMapDocumentLabelBinding. Removed in the next minor. */
export type HonuaMapPackageLabelBinding = HonuaMapDocumentLabelBinding;
/** @deprecated Use HonuaMapDocumentLegendEntry. Removed in the next minor. */
export type HonuaMapPackageLegendEntry = HonuaMapDocumentLegendEntry;
/** @deprecated Use HonuaMapDocumentLocator. Removed in the next minor. */
export type HonuaMapPackageLocator = HonuaMapDocumentLocator;
/** @deprecated Use HonuaMapDocumentPopupBinding. Removed in the next minor. */
export type HonuaMapPackagePopupBinding = HonuaMapDocumentPopupBinding;
/** @deprecated Use HonuaMapDocumentProtocol. Removed in the next minor. */
export type HonuaMapPackageProtocol = HonuaMapDocumentProtocol;
/** @deprecated Use HonuaMapDocumentProvenance. Removed in the next minor. */
export type HonuaMapPackageProvenance = HonuaMapDocumentProvenance;
/** @deprecated Use HonuaMapDocumentSourceBinding. Removed in the next minor. */
export type HonuaMapPackageSourceBinding = HonuaMapDocumentSourceBinding;
/** @deprecated Use HonuaMapDocumentStatus. Removed in the next minor. */
export type HonuaMapPackageStatus = HonuaMapDocumentStatus;
/** @deprecated Use HonuaMapDocumentStyleRef. Removed in the next minor. */
export type HonuaMapPackageStyleRef = HonuaMapDocumentStyleRef;
/** @deprecated Use HonuaMapDocumentThemeSpec. Removed in the next minor. */
export type HonuaMapPackageThemeSpec = HonuaMapDocumentThemeSpec;
/** @deprecated Use HonuaMapDocumentWidget. Removed in the next minor. */
export type HonuaMapPackageWidget = HonuaMapDocumentWidget;
/** @deprecated Use ImportMapDocumentOptions. Removed in the next minor. */
export type ImportMapPackageOptions = ImportMapDocumentOptions;
/** @deprecated Use ImportMapDocumentResult. Removed in the next minor. */
export type ImportMapPackageResult = ImportMapDocumentResult;
/** @deprecated Use LoadMapDocumentFromIdOptions. Removed in the next minor. */
export type LoadMapPackageFromIdOptions = LoadMapDocumentFromIdOptions;
/** @deprecated Use LoadMapDocumentFromIdResult. Removed in the next minor. */
export type LoadMapPackageFromIdResult = LoadMapDocumentFromIdResult;
/** @deprecated Use LoadMapDocumentOfflineRegion. Removed in the next minor. */
export type LoadMapPackageOfflineRegion = LoadMapDocumentOfflineRegion;
/** @deprecated Use LoadMapDocumentOptions. Removed in the next minor. */
export type LoadMapPackageOptions = LoadMapDocumentOptions;
/** @deprecated Use MapDocumentDiff. Removed in the next minor. */
export type MapPackageDiff = MapDocumentDiff;
/** @deprecated Use MapDocumentFetchCache. Removed in the next minor. */
export type MapPackageFetchCache = MapDocumentFetchCache;
/** @deprecated Use MapDocumentFetchCacheEntry. Removed in the next minor. */
export type MapPackageFetchCacheEntry = MapDocumentFetchCacheEntry;
/** @deprecated Use MapDocumentFetchCacheState. Removed in the next minor. */
export type MapPackageFetchCacheState = MapDocumentFetchCacheState;
/** @deprecated Use MapDocumentFetchCacheStatus. Removed in the next minor. */
export type MapPackageFetchCacheStatus = MapDocumentFetchCacheStatus;
/** @deprecated Use MapDocumentLocator. Removed in the next minor. */
export type MapPackageLocator = MapDocumentLocator;
/** @deprecated Use MapDocumentPathResolver. Removed in the next minor. */
export type MapPackagePathResolver = MapDocumentPathResolver;
/** @deprecated Use MapDocumentRealtimeAdvertisement. Removed in the next minor. */
export type MapPackageRealtimeAdvertisement = MapDocumentRealtimeAdvertisement;
/** @deprecated Use MapDocumentRealtimeAuth. Removed in the next minor. */
export type MapPackageRealtimeAuth = MapDocumentRealtimeAuth;
/** @deprecated Use MapDocumentRealtimeChannel. Removed in the next minor. */
export type MapPackageRealtimeChannel = MapDocumentRealtimeChannel;
/** @deprecated Use MapDocumentRealtimeCheckpoint. Removed in the next minor. */
export type MapPackageRealtimeCheckpoint = MapDocumentRealtimeCheckpoint;
/** @deprecated Use MapDocumentRealtimeDisconnectedMessage. Removed in the next minor. */
export type MapPackageRealtimeDisconnectedMessage = MapDocumentRealtimeDisconnectedMessage;
/** @deprecated Use MapDocumentRealtimeErrorMessage. Removed in the next minor. */
export type MapPackageRealtimeErrorMessage = MapDocumentRealtimeErrorMessage;
/** @deprecated Use MapDocumentRealtimeEventSource. Removed in the next minor. */
export type MapPackageRealtimeEventSource = MapDocumentRealtimeEventSource;
/** @deprecated Use MapDocumentRealtimeEventSourceFactory. Removed in the next minor. */
export type MapPackageRealtimeEventSourceFactory = MapDocumentRealtimeEventSourceFactory;
/** @deprecated Use MapDocumentRealtimeFallbackMode. Removed in the next minor. */
export type MapPackageRealtimeFallbackMode = MapDocumentRealtimeFallbackMode;
/** @deprecated Use MapDocumentRealtimeHeartbeatMessage. Removed in the next minor. */
export type MapPackageRealtimeHeartbeatMessage = MapDocumentRealtimeHeartbeatMessage;
/** @deprecated Use MapDocumentRealtimeMessage. Removed in the next minor. */
export type MapPackageRealtimeMessage = MapDocumentRealtimeMessage;
/** @deprecated Use MapDocumentRealtimeMessageBase. Removed in the next minor. */
export type MapPackageRealtimeMessageBase = MapDocumentRealtimeMessageBase;
/** @deprecated Use MapDocumentRealtimeObserver. Removed in the next minor. */
export type MapPackageRealtimeObserver = MapDocumentRealtimeObserver;
/** @deprecated Use MapDocumentRealtimeReadyMessage. Removed in the next minor. */
export type MapPackageRealtimeReadyMessage = MapDocumentRealtimeReadyMessage;
/** @deprecated Use MapDocumentRealtimeReconnectOptions. Removed in the next minor. */
export type MapPackageRealtimeReconnectOptions = MapDocumentRealtimeReconnectOptions;
/** @deprecated Use MapDocumentRealtimeRefetchRequiredMessage. Removed in the next minor. */
export type MapPackageRealtimeRefetchRequiredMessage = MapDocumentRealtimeRefetchRequiredMessage;
/** @deprecated Use MapDocumentRealtimeReloadRequiredMessage. Removed in the next minor. */
export type MapPackageRealtimeReloadRequiredMessage = MapDocumentRealtimeReloadRequiredMessage;
/** @deprecated Use MapDocumentRealtimeStaleMessage. Removed in the next minor. */
export type MapPackageRealtimeStaleMessage = MapDocumentRealtimeStaleMessage;
/** @deprecated Use MapDocumentRealtimeSubscribeRequest. Removed in the next minor. */
export type MapPackageRealtimeSubscribeRequest = MapDocumentRealtimeSubscribeRequest;
/** @deprecated Use MapDocumentRealtimeSubscriptionHandle. Removed in the next minor. */
export type MapPackageRealtimeSubscriptionHandle = MapDocumentRealtimeSubscriptionHandle;
/** @deprecated Use MapDocumentRealtimeTransport. Removed in the next minor. */
export type MapPackageRealtimeTransport = MapDocumentRealtimeTransport;
/** @deprecated Use MapDocumentRealtimeTransportKind. Removed in the next minor. */
export type MapPackageRealtimeTransportKind = MapDocumentRealtimeTransportKind;
/** @deprecated Use MapDocumentRealtimeUpdate. Removed in the next minor. */
export type MapPackageRealtimeUpdate = MapDocumentRealtimeUpdate;
/** @deprecated Use MapDocumentRealtimeUpdatedMessage. Removed in the next minor. */
export type MapPackageRealtimeUpdatedMessage = MapDocumentRealtimeUpdatedMessage;
/** @deprecated Use MapDocumentRealtimeWatchOptions. Removed in the next minor. */
export type MapPackageRealtimeWatchOptions = MapDocumentRealtimeWatchOptions;
/** @deprecated Use MapDocumentServerSentEventsTransportOptions. Removed in the next minor. */
export type MapPackageServerSentEventsTransportOptions = MapDocumentServerSentEventsTransportOptions;
/** @deprecated Use MapDocumentWatchEvent. Removed in the next minor. */
export type MapPackageWatchEvent = MapDocumentWatchEvent;
/** @deprecated Use MapDocumentWatchHandle. Removed in the next minor. */
export type MapPackageWatchHandle = MapDocumentWatchHandle;
/** @deprecated Use ValidateMapDocumentOptions. Removed in the next minor. */
export type ValidateMapPackageOptions = ValidateMapDocumentOptions;
/** @deprecated Use ValidateMapDocumentResult. Removed in the next minor. */
export type ValidateMapPackageResult = ValidateMapDocumentResult;
/** @deprecated Use WatchMapDocumentOptions. Removed in the next minor. */
export type WatchMapPackageOptions = WatchMapDocumentOptions;
/** @deprecated Use createMapDocumentServerSentEventsTransport. Removed in the next minor. */
export const createMapPackageServerSentEventsTransport = createMapDocumentServerSentEventsTransport;
/** @deprecated Use decodeMapDocumentRealtimeMessage. Removed in the next minor. */
export const decodeMapPackageRealtimeMessage = decodeMapDocumentRealtimeMessage;
/** @deprecated Use defaultMapDocumentPath. Removed in the next minor. */
export const defaultMapPackagePath = defaultMapDocumentPath;
/** @deprecated Use encodeMapDocumentRealtimeUrl. Removed in the next minor. */
export const encodeMapPackageRealtimeUrl = encodeMapDocumentRealtimeUrl;
/** @deprecated Use exportMapDocument. Removed in the next minor. */
export const exportMapPackage = exportMapDocument;
/** @deprecated Use fetchMapDocument. Removed in the next minor. */
export const fetchMapPackage = fetchMapDocument;
/** @deprecated Use hasMapDocumentDiagnosticErrors. Removed in the next minor. */
export const hasMapPackageDiagnosticErrors = hasMapDocumentDiagnosticErrors;
/** @deprecated Use importMapDocument. Removed in the next minor. */
export const importMapPackage = importMapDocument;
/** @deprecated Use loadMapDocument. Removed in the next minor. */
export const loadMapPackage = loadMapDocument;
/** @deprecated Use loadMapDocumentFromId. Removed in the next minor. */
export const loadMapPackageFromId = loadMapDocumentFromId;
/** @deprecated Use mapDocumentFingerprint. Removed in the next minor. */
export const mapPackageFingerprint = mapDocumentFingerprint;
/** @deprecated Use readMapDocumentRealtimeAdvertisement. Removed in the next minor. */
export const readMapPackageRealtimeAdvertisement = readMapDocumentRealtimeAdvertisement;
/** @deprecated Use resolveMapDocumentPath. Removed in the next minor. */
export const resolveMapPackagePath = resolveMapDocumentPath;
/** @deprecated Use validateMapDocument. Removed in the next minor. */
export const validateMapPackage = validateMapDocument;
/** @deprecated Use watchMapDocument. Removed in the next minor. */
export const watchMapPackage = watchMapDocument;
export { HONUA_MAP_PACKAGE_FORMAT_V1 } from "./map-package.js";
/** @deprecated Use DEFAULT_MAP_DOCUMENT_CACHE_LIMIT. Removed in the next minor. */
export const DEFAULT_MAP_PACKAGE_CACHE_LIMIT = DEFAULT_MAP_DOCUMENT_CACHE_LIMIT;
/** @deprecated Use DEFAULT_MAP_DOCUMENT_PATH_PREFIX. Removed in the next minor. */
export const DEFAULT_MAP_PACKAGE_PATH_PREFIX = DEFAULT_MAP_DOCUMENT_PATH_PREFIX;
/** @deprecated Use HONUA_MAP_DOCUMENT_EXPORT_KIND_V1. Removed in the next minor. */
export const HONUA_MAP_PACKAGE_EXPORT_KIND_V1 = HONUA_MAP_DOCUMENT_EXPORT_KIND_V1;
/** @deprecated Use MAP_DOCUMENT_REALTIME_CHANNEL_V1. Removed in the next minor. */
export const MAP_PACKAGE_REALTIME_CHANNEL_V1 = MAP_DOCUMENT_REALTIME_CHANNEL_V1;
