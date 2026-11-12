// Pre-vocabulary names, kept as deprecated aliases for one release.

import { HonuaApiKeysClient, HonuaMapDocumentsClient, HonuaSavedMapsClient } from "./client.js";
import { type MapDocumentPublishInput, mapDocumentPublishCommand } from "./commands/catalog.js";
import type {
  HonuaApiKey,
  HonuaApiKeyCreateRequest,
  HonuaCreateSavedMapRequest,
  HonuaMapDocumentSummary,
  HonuaPublishMapDocumentRequest,
  HonuaPublishMapDocumentResponse,
  HonuaSavedMap,
  HonuaSavedMapSummary,
  HonuaUpdateSavedMapRequest,
} from "./types.js";

/** @deprecated Use HonuaApiKey. Removed in the next minor. */
export type HonuaApiToken = HonuaApiKey;
/** @deprecated Use HonuaApiKeyCreateRequest. Removed in the next minor. */
export type HonuaApiTokenCreateRequest = HonuaApiKeyCreateRequest;
/** @deprecated Use HonuaApiKeysClient. Removed in the next minor. */
export const HonuaApiTokensClient = HonuaApiKeysClient;
/** @deprecated Use HonuaApiKeysClient. Removed in the next minor. */
export type HonuaApiTokensClient = HonuaApiKeysClient;
/** @deprecated Use HonuaMapDocumentSummary. Removed in the next minor. */
export type HonuaMapPackageSummary = HonuaMapDocumentSummary;
/** @deprecated Use HonuaMapDocumentsClient. Removed in the next minor. */
export const HonuaMapPackagesClient = HonuaMapDocumentsClient;
/** @deprecated Use HonuaMapDocumentsClient. Removed in the next minor. */
export type HonuaMapPackagesClient = HonuaMapDocumentsClient;
/** @deprecated Use HonuaPublishMapDocumentRequest. Removed in the next minor. */
export type HonuaPublishMapPackageRequest = HonuaPublishMapDocumentRequest;
/** @deprecated Use HonuaPublishMapDocumentResponse. Removed in the next minor. */
export type HonuaPublishMapPackageResponse = HonuaPublishMapDocumentResponse;
/** @deprecated Use MapDocumentPublishInput. Removed in the next minor. */
export type MapPackagePublishInput = MapDocumentPublishInput;
/** @deprecated Use mapDocumentPublishCommand. Removed in the next minor. */
export const mapPackagePublishCommand = mapDocumentPublishCommand;
/** @deprecated Use HonuaSavedMap. Removed in the next minor. */
export type HonuaHostedMap = HonuaSavedMap;
/** @deprecated Use HonuaSavedMapSummary. Removed in the next minor. */
export type HonuaHostedMapSummary = HonuaSavedMapSummary;
/** @deprecated Use HonuaCreateSavedMapRequest. Removed in the next minor. */
export type HonuaCreateHostedMapRequest = HonuaCreateSavedMapRequest;
/** @deprecated Use HonuaUpdateSavedMapRequest. Removed in the next minor. */
export type HonuaUpdateHostedMapRequest = HonuaUpdateSavedMapRequest;
/** @deprecated Use HonuaSavedMapsClient. Removed in the next minor. */
export const HonuaHostedMapsClient = HonuaSavedMapsClient;
/** @deprecated Use HonuaSavedMapsClient. Removed in the next minor. */
export type HonuaHostedMapsClient = HonuaSavedMapsClient;
