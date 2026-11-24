---
type: reference
title: "Vocabulary renames"
description: "Public SDK names renamed to the Honua vocabulary (old -> new). The old names were removed outright, with no deprecated aliases."
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
# Vocabulary renames

The SDK's public names follow the Honua vocabulary (honua-server
`docs/concepts/domain/README.md`): `MapPackage` -> `MapDocument`, `ApiToken` -> `ApiKey`,
`HostedMap` -> `Map`, and `AppPackage` -> `AppVersion`. The old names were removed outright
([#2348](https://github.com/honua-io/honua-sdk-js/issues/2348)). There are no deprecated aliases,
re-exports or shims. Update imports to the new names.

## Breaking change

`@honua/sdk-js` 0.3.4 and earlier export the old names; the first release after 0.3.5 (0.4.0) removes
them. Affected entry points:

- `@honua/sdk-js/runtime`: the `MapPackage` / `MAP_PACKAGE` names (92 in the 0.3.4 stable API report),
  for example `HonuaMapPackage`, `fetchMapPackage`, `exportMapPackage`, `HonuaMapPackageError`.
- `@honua/app-platform/control-plane`: `HonuaApiToken*`, `HonuaHostedMap*`, `HonuaMapPackagesClient`,
  `HonuaPublishMapPackage*`, `mapPackagePublishCommand`.
- `@honua/app-platform/app`, `/studio`, `/generated-app`, `/web-components` and `/operator`: the same
  map-document types they re-export, plus `HonuaGeneratedAppPackage`, `AppPackage`,
  `projectMapPackageToGeneratedAppManifest`, `layersFromMapPackage`, `legendFromMapPackage` and
  `fromMapPackageValidation`.

The table below maps every old name to its replacement.

The Map vocabulary follow-up removes `SavedMap` from the control-plane and collaboration APIs.
Use `client.maps` instead of `client.savedMaps`, and `client.joinMap()` instead of
`client.joinSavedMap()`. The collaboration envelope version remains
`honua.saved-map-collaboration.v1`, matching the server wire contract.

Unchanged: server-owned wire fields (`mapPackageId`, `mapPackage` in JSON bodies and the export
envelope, `links.mapPackage`), routes, capability keys, error codes (`runtime.map-package.*`), format
ids (`honua_map_package.v1`) and `schemas/honua-map-package.v1.json`.

## Exported names

`test/vocabulary-public-names.test.ts` checks that this table lists every rename in
`test/fixtures/vocabulary/retired-name-exceptions.json`, and that no old name is exported.

| Old | New |
| --- | --- |
| `AppPackage` | `AppVersion` |
| `BoundedMapPackageFetchCache` | `BoundedMapDocumentFetchCache` |
| `createMapPackageServerSentEventsTransport` | `createMapDocumentServerSentEventsTransport` |
| `decodeMapPackageRealtimeMessage` | `decodeMapDocumentRealtimeMessage` |
| `DEFAULT_MAP_PACKAGE_CACHE_LIMIT` | `DEFAULT_MAP_DOCUMENT_CACHE_LIMIT` |
| `DEFAULT_MAP_PACKAGE_PATH_PREFIX` | `DEFAULT_MAP_DOCUMENT_PATH_PREFIX` |
| `DEFAULT_MAX_PACKAGE_BYTES` | `DEFAULT_MAX_MAP_DOCUMENT_BYTES` |
| `defaultMapPackagePath` | `defaultMapDocumentPath` |
| `diffPackages` | `diffMapDocuments` |
| `encodeMapPackageRealtimeUrl` | `encodeMapDocumentRealtimeUrl` |
| `exportMapPackage` | `exportMapDocument` |
| `ExportMapPackageOptions` | `ExportMapDocumentOptions` |
| `fetchMapPackage` | `fetchMapDocument` |
| `FetchMapPackageOptions` | `FetchMapDocumentOptions` |
| `FetchMapPackageResult` | `FetchMapDocumentResult` |
| `fromMapPackageValidation` | `fromMapDocumentValidation` |
| `hasMapPackageDiagnosticErrors` | `hasMapDocumentDiagnosticErrors` |
| `HONUA_MAP_PACKAGE_EXPORT_KIND_V1` | `HONUA_MAP_DOCUMENT_EXPORT_KIND_V1` |
| `HONUA_MAP_PACKAGE_FORMAT_V1` | `HONUA_MAP_DOCUMENT_FORMAT_V1` |
| `HonuaApiToken` | `HonuaApiKey` |
| `HonuaApiTokenCreateRequest` | `HonuaApiKeyCreateRequest` |
| `HonuaApiTokensClient` | `HonuaApiKeysClient` |
| `HonuaCreateHostedMapRequest` | `HonuaCreateMapRequest` |
| `HonuaGeneratedAppPackage` | `HonuaGeneratedAppVersion` |
| `HonuaHostedMap` | `HonuaMap` |
| `HonuaHostedMapsClient` | `HonuaMapsClient` |
| `HonuaHostedMapSummary` | `HonuaMapSummary` |
| `HonuaMapPackage` | `HonuaMapDocument` |
| `HonuaMapPackageAttribution` | `HonuaMapDocumentAttribution` |
| `HonuaMapPackageDependency` | `HonuaMapDocumentDependency` |
| `HonuaMapPackageDiagnostic` | `HonuaMapDocumentDiagnostic` |
| `HonuaMapPackageDiagnosticCode` | `HonuaMapDocumentDiagnosticCode` |
| `HonuaMapPackageDiagnosticSeverity` | `HonuaMapDocumentDiagnosticSeverity` |
| `HonuaMapPackageError` | `HonuaMapDocumentError` |
| `HonuaMapPackageErrorStage` | `HonuaMapDocumentErrorStage` |
| `HonuaMapPackageExport` | `HonuaMapDocumentExport` |
| `HonuaMapPackageFormat` | `HonuaMapDocumentFormat` |
| `HonuaMapPackageInitialView` | `HonuaMapDocumentInitialView` |
| `HonuaMapPackageLabelBinding` | `HonuaMapDocumentLabelBinding` |
| `HonuaMapPackageLegendEntry` | `HonuaMapDocumentLegendEntry` |
| `HonuaMapPackageLocator` | `HonuaMapDocumentLocator` |
| `HonuaMapPackagePopupBinding` | `HonuaMapDocumentPopupBinding` |
| `HonuaMapPackageProtocol` | `HonuaMapDocumentProtocol` |
| `HonuaMapPackageProvenance` | `HonuaMapDocumentProvenance` |
| `HonuaMapPackagesClient` | `HonuaMapDocumentsClient` |
| `HonuaMapPackageSourceBinding` | `HonuaMapDocumentSourceBinding` |
| `HonuaMapPackageStatus` | `HonuaMapDocumentStatus` |
| `HonuaMapPackageStyleRef` | `HonuaMapDocumentStyleRef` |
| `HonuaMapPackageSummary` | `HonuaMapDocumentSummary` |
| `HonuaMapPackageThemeSpec` | `HonuaMapDocumentThemeSpec` |
| `HonuaMapPackageWidget` | `HonuaMapDocumentWidget` |
| `HonuaPublishMapPackageRequest` | `HonuaPublishMapDocumentRequest` |
| `HonuaPublishMapPackageResponse` | `HonuaPublishMapDocumentResponse` |
| `HonuaUpdateHostedMapRequest` | `HonuaUpdateMapRequest` |
| `importMapPackage` | `importMapDocument` |
| `ImportMapPackageOptions` | `ImportMapDocumentOptions` |
| `ImportMapPackageResult` | `ImportMapDocumentResult` |
| `layersFromMapPackage` | `layersFromMapDocument` |
| `legendFromMapPackage` | `legendFromMapDocument` |
| `loadMapPackage` | `loadMapDocument` |
| `loadMapPackageFromId` | `loadMapDocumentFromId` |
| `LoadMapPackageFromIdOptions` | `LoadMapDocumentFromIdOptions` |
| `LoadMapPackageFromIdResult` | `LoadMapDocumentFromIdResult` |
| `LoadMapPackageOfflineRegion` | `LoadMapDocumentOfflineRegion` |
| `LoadMapPackageOptions` | `LoadMapDocumentOptions` |
| `MAP_PACKAGE_REALTIME_CHANNEL_V1` | `MAP_DOCUMENT_REALTIME_CHANNEL_V1` |
| `MapPackageDiff` | `MapDocumentDiff` |
| `MapPackageFetchCache` | `MapDocumentFetchCache` |
| `MapPackageFetchCacheEntry` | `MapDocumentFetchCacheEntry` |
| `MapPackageFetchCacheState` | `MapDocumentFetchCacheState` |
| `MapPackageFetchCacheStatus` | `MapDocumentFetchCacheStatus` |
| `mapPackageFingerprint` | `mapDocumentFingerprint` |
| `MapPackageLocator` | `MapDocumentLocator` |
| `MapPackagePathResolver` | `MapDocumentPathResolver` |
| `mapPackagePublishCommand` | `mapDocumentPublishCommand` |
| `MapPackagePublishInput` | `MapDocumentPublishInput` |
| `MapPackageRealtimeAdvertisement` | `MapDocumentRealtimeAdvertisement` |
| `MapPackageRealtimeAuth` | `MapDocumentRealtimeAuth` |
| `MapPackageRealtimeChannel` | `MapDocumentRealtimeChannel` |
| `MapPackageRealtimeCheckpoint` | `MapDocumentRealtimeCheckpoint` |
| `MapPackageRealtimeDisconnectedMessage` | `MapDocumentRealtimeDisconnectedMessage` |
| `MapPackageRealtimeErrorMessage` | `MapDocumentRealtimeErrorMessage` |
| `MapPackageRealtimeEventSource` | `MapDocumentRealtimeEventSource` |
| `MapPackageRealtimeEventSourceFactory` | `MapDocumentRealtimeEventSourceFactory` |
| `MapPackageRealtimeFallbackMode` | `MapDocumentRealtimeFallbackMode` |
| `MapPackageRealtimeHeartbeatMessage` | `MapDocumentRealtimeHeartbeatMessage` |
| `MapPackageRealtimeMessage` | `MapDocumentRealtimeMessage` |
| `MapPackageRealtimeMessageBase` | `MapDocumentRealtimeMessageBase` |
| `MapPackageRealtimeObserver` | `MapDocumentRealtimeObserver` |
| `MapPackageRealtimeReadyMessage` | `MapDocumentRealtimeReadyMessage` |
| `MapPackageRealtimeReconnectOptions` | `MapDocumentRealtimeReconnectOptions` |
| `MapPackageRealtimeRefetchRequiredMessage` | `MapDocumentRealtimeRefetchRequiredMessage` |
| `MapPackageRealtimeReloadRequiredMessage` | `MapDocumentRealtimeReloadRequiredMessage` |
| `MapPackageRealtimeStaleMessage` | `MapDocumentRealtimeStaleMessage` |
| `MapPackageRealtimeSubscribeRequest` | `MapDocumentRealtimeSubscribeRequest` |
| `MapPackageRealtimeSubscriptionHandle` | `MapDocumentRealtimeSubscriptionHandle` |
| `MapPackageRealtimeTransport` | `MapDocumentRealtimeTransport` |
| `MapPackageRealtimeTransportKind` | `MapDocumentRealtimeTransportKind` |
| `MapPackageRealtimeUpdate` | `MapDocumentRealtimeUpdate` |
| `MapPackageRealtimeUpdatedMessage` | `MapDocumentRealtimeUpdatedMessage` |
| `MapPackageRealtimeWatchOptions` | `MapDocumentRealtimeWatchOptions` |
| `MapPackageServerSentEventsTransportOptions` | `MapDocumentServerSentEventsTransportOptions` |
| `MapPackageWatchEvent` | `MapDocumentWatchEvent` |
| `MapPackageWatchHandle` | `MapDocumentWatchHandle` |
| `projectAppPackageToGeneratedAppManifest` | `projectAppVersionToGeneratedAppManifest` |
| `projectMapPackageToGeneratedAppManifest` | `projectMapDocumentToGeneratedAppManifest` |
| `ProjectMapPackageToGeneratedAppManifestOptions` | `ProjectMapDocumentToGeneratedAppManifestOptions` |
| `readMapPackageRealtimeAdvertisement` | `readMapDocumentRealtimeAdvertisement` |
| `resolveMapPackagePath` | `resolveMapDocumentPath` |
| `validateMapPackage` | `validateMapDocument` |
| `ValidateMapPackageOptions` | `ValidateMapDocumentOptions` |
| `ValidateMapPackageResult` | `ValidateMapDocumentResult` |
| `watchMapPackage` | `watchMapDocument` |
| `WatchMapPackageOptions` | `WatchMapDocumentOptions` |
| `FixtureSavedMapCollaborationTransport` | `FixtureMapCollaborationTransport` |
| `FixtureSavedMapCollaborationTransportOptions` | `FixtureMapCollaborationTransportOptions` |
| `HonuaCreateSavedMapRequest` | `HonuaCreateMapRequest` |
| `HonuaSavedMap` | `HonuaMap` |
| `HonuaSavedMapCollaborationClient` | `HonuaMapCollaborationClient` |
| `HonuaSavedMapCollaborationClientOptions` | `HonuaMapCollaborationClientOptions` |
| `HonuaSavedMapCollaborationSession` | `HonuaMapCollaborationSession` |
| `HonuaSavedMapSummary` | `HonuaMapSummary` |
| `HonuaSavedMapsClient` | `HonuaMapsClient` |
| `HonuaUpdateSavedMapRequest` | `HonuaUpdateMapRequest` |
| `SavedMapCollaborationCapabilities` | `MapCollaborationCapabilities` |
| `SavedMapCollaborationConnectionStatus` | `MapCollaborationConnectionStatus` |
| `SavedMapCollaborationEnvelope` | `MapCollaborationEnvelope` |
| `SavedMapCollaborationErrorCode` | `MapCollaborationErrorCode` |
| `SavedMapCollaborationErrorEvent` | `MapCollaborationErrorEvent` |
| `SavedMapCollaborationEvent` | `MapCollaborationEvent` |
| `SavedMapCollaborationJoinRequest` | `MapCollaborationJoinRequest` |
| `SavedMapCollaborationJoinResult` | `MapCollaborationJoinResult` |
| `SavedMapCollaborationObserver` | `MapCollaborationObserver` |
| `SavedMapCollaborationParticipant` | `MapCollaborationParticipant` |
| `SavedMapCollaborationParticipantId` | `MapCollaborationParticipantId` |
| `SavedMapCollaborationReconnectOptions` | `MapCollaborationReconnectOptions` |
| `SavedMapCollaborationSessionId` | `MapCollaborationSessionId` |
| `SavedMapCollaborationSessionRef` | `MapCollaborationSessionRef` |
| `SavedMapCollaborationSnapshot` | `MapCollaborationSnapshot` |
| `SavedMapCollaborationSnapshotListener` | `MapCollaborationSnapshotListener` |
| `SavedMapCollaborationSubscriptionHandle` | `MapCollaborationSubscriptionHandle` |
| `SavedMapCollaborationTransport` | `MapCollaborationTransport` |
| `SavedMapCollaborationTransportCapabilities` | `MapCollaborationTransportCapabilities` |
| `SavedMapCollaborationTransportKind` | `MapCollaborationTransportKind` |
| `SavedMapCommittedOperation` | `MapCommittedOperation` |
| `SavedMapCursor` | `MapCursor` |
| `SavedMapEditOperation` | `MapEditOperation` |
| `SavedMapFeatureLock` | `MapFeatureLock` |
| `SavedMapFeatureLockReleaseRequest` | `MapFeatureLockReleaseRequest` |
| `SavedMapFeatureLockRequest` | `MapFeatureLockRequest` |
| `SavedMapFollowTarget` | `MapFollowTarget` |
| `SavedMapId` | `MapId` |
| `SavedMapOperationReplayRequest` | `MapOperationReplayRequest` |
| `SavedMapOperationReplayResult` | `MapOperationReplayResult` |
| `SavedMapOperationSubmitRequest` | `MapOperationSubmitRequest` |
| `SavedMapSelection` | `MapSelection` |
| `createFixtureSavedMapCollaborationTransport` | `createFixtureMapCollaborationTransport` |
| `createHonuaSavedMapCollaboration` | `createHonuaMapCollaboration` |
| `reduceSavedMapCollaborationSnapshot` | `reduceMapCollaborationSnapshot` |

## Members and messages

| Old | New |
| --- | --- |
| `HonuaControlPlaneClient#hostedMaps` | `maps` |
| `HonuaControlPlaneClient#savedMaps` | `maps` |
| `HonuaSavedMapCollaborationClient#joinSavedMap()` | `HonuaMapCollaborationClient#joinMap()` |
| `HonuaControlPlaneClient#packages` | `mapDocuments` |
| `HonuaControlPlaneClient#tokens` | `apiKeys` |
| `HonuaHostedMapsClient#getPackage()` | `getMapDocument()` |
| `HonuaHostedMapsClient#getPackageLocator()` | `getMapDocumentLocator()` |
| `HonuaMapRuntime#updatePackage()` | `updateMapDocument()` |
| `MapWorkspaceController#loadPackage()` | `loadMapDocument()` |
| `BuilderWorkspaceController#loadPackage()` | `loadAppVersion()` |
| `BuilderWorkspaceController#appPackage` | `appVersion` |
| `BuilderWorkspaceController#bindMapPackage()` | `bindMapDocument()` |
| `HonuaMapDocumentError#name` `"HonuaMapPackageError"` | `"HonuaMapDocumentError"` |
| `ExportMapDocumentOptions#maxPackageBytes`, `ImportMapDocumentOptions#maxPackageBytes` | `maxMapDocumentBytes` |

Error and status messages say "map document" where they said "MapPackage" or "map package".

Not yet renamed (follow-up, renamed outright when done): the `HonuaMapRuntime#mapPackage` getter and the `"package-loaded"` and `"package-refined"` builder event kinds.

## Beta state and content APIs

The beta app and scene orchestration APIs now use **store** names. Operator UI composition uses **shell** names; Studio listing uses **content** and server grouping uses **folder**. Rename imports and type references using the table below; no deprecated aliases remain. The entrypoint paths remain unchanged. Access the renamed grouping and listing clients through `controlPlane.folders` and `studio.content` instead of `controlPlane.workspaces` and `studio.contentItems`.

The saved app-state document still uses the `honua.saved-workspace` format identifier. Server routes, capability keys, generated schema names and wire fields remain unchanged.

| Previous export | Current export |
| --- | --- |
| `BuilderWorkspaceController` | `BuilderController` |
| `BuilderWorkspaceControllerOptions` | `BuilderControllerOptions` |
| `BuilderWorkspaceEvent` | `BuilderEvent` |
| `CreateKeplerWorkspaceBridgeOptions` | `CreateKeplerAppBridgeOptions` |
| `HONUA_SAVED_WORKSPACE_DOCUMENT_KIND` | `HONUA_SAVED_APP_STATE_DOCUMENT_KIND` |
| `HONUA_SAVED_WORKSPACE_DOCUMENT_VERSION` | `HONUA_SAVED_APP_STATE_DOCUMENT_VERSION` |
| `HonuaAppWorkspace` | `HonuaAppStore` |
| `HonuaAppWorkspaceChangeEvent` | `HonuaAppStoreChangeEvent` |
| `HonuaAppWorkspaceChartModel` | `HonuaAppStoreChartModel` |
| `HonuaAppWorkspaceDetailModel` | `HonuaAppStoreDetailModel` |
| `HonuaAppWorkspaceDraftEntry` | `HonuaAppStoreDraftEntry` |
| `HonuaAppWorkspaceDraftState` | `HonuaAppStoreDraftState` |
| `HonuaAppWorkspaceEquality` | `HonuaAppStoreEquality` |
| `HonuaAppWorkspaceExplorationReference` | `HonuaAppStoreExplorationReference` |
| `HonuaAppWorkspaceExplorationState` | `HonuaAppStoreExplorationState` |
| `HonuaAppWorkspaceFilterModel` | `HonuaAppStoreFilterModel` |
| `HonuaAppWorkspaceIntent` | `HonuaAppStoreIntent` |
| `HonuaAppWorkspaceJobEntry` | `HonuaAppStoreJobEntry` |
| `HonuaAppWorkspaceJobModel` | `HonuaAppStoreJobModel` |
| `HonuaAppWorkspaceJobState` | `HonuaAppStoreJobState` |
| `HonuaAppWorkspaceLayoutState` | `HonuaAppStoreLayoutState` |
| `HonuaAppWorkspaceListener` | `HonuaAppStoreListener` |
| `HonuaAppWorkspaceMapModel` | `HonuaAppStoreMapModel` |
| `HonuaAppWorkspaceMetadataCacheModel` | `HonuaAppStoreMetadataCacheModel` |
| `HonuaAppWorkspaceOptions` | `HonuaAppStoreOptions` |
| `HonuaAppWorkspacePanelState` | `HonuaAppStorePanelState` |
| `HonuaAppWorkspaceRealtimeModel` | `HonuaAppStoreRealtimeModel` |
| `HonuaAppWorkspaceRealtimeState` | `HonuaAppStoreRealtimeState` |
| `HonuaAppWorkspaceReviewableIntent` | `HonuaAppStoreReviewableIntent` |
| `HonuaAppWorkspaceSavedStateMetadata` | `HonuaAppStoreSavedStateMetadata` |
| `HonuaAppWorkspaceSelector` | `HonuaAppStoreSelector` |
| `HonuaAppWorkspaceSelectorListener` | `HonuaAppStoreSelectorListener` |
| `HonuaAppWorkspaceSlice` | `HonuaAppStoreSlice` |
| `HonuaAppWorkspaceSnapshot` | `HonuaAppStoreSnapshot` |
| `HonuaAppWorkspaceSourceState` | `HonuaAppStoreSourceState` |
| `HonuaAppWorkspaceState` | `HonuaAppStoreState` |
| `HonuaAppWorkspaceTableModel` | `HonuaAppStoreTableModel` |
| `HonuaSavedWorkspaceAnalysisOutput` | `HonuaSavedAppStateAnalysisOutput` |
| `HonuaSavedWorkspaceCreateOptions` | `HonuaSavedAppStateCreateOptions` |
| `HonuaSavedWorkspaceDocument` | `HonuaSavedAppStateDocument` |
| `HonuaSavedWorkspaceDocumentKind` | `HonuaSavedAppStateDocumentKind` |
| `HonuaSavedWorkspaceDocumentVersion` | `HonuaSavedAppStateDocumentVersion` |
| `HonuaSavedWorkspaceHydrateOptions` | `HonuaSavedAppStateHydrateOptions` |
| `HonuaSavedWorkspaceJob` | `HonuaSavedAppStateJob` |
| `HonuaSavedWorkspaceLayer` | `HonuaSavedAppStateLayer` |
| `HonuaSavedWorkspaceMcpSummary` | `HonuaSavedAppStateMcpSummary` |
| `HonuaSavedWorkspaceMigrationMetadata` | `HonuaSavedAppStateMigrationMetadata` |
| `HonuaSavedWorkspaceMigrationStep` | `HonuaSavedAppStateMigrationStep` |
| `HonuaSavedWorkspaceQuery` | `HonuaSavedAppStateQuery` |
| `HonuaSavedWorkspaceSelectedFeature` | `HonuaSavedAppStateSelectedFeature` |
| `HonuaSavedWorkspaceSource` | `HonuaSavedAppStateSource` |
| `HonuaSavedWorkspaceStyle` | `HonuaSavedAppStateStyle` |
| `HonuaSavedWorkspaceValidationError` | `HonuaSavedAppStateValidationError` |
| `HonuaSavedWorkspaceValidationResult` | `HonuaSavedAppStateValidationResult` |
| `HonuaStudioContentItemsClient` | `HonuaStudioContentClient` |
| `HonuaWorkspaceProjectState` | `HonuaAppProjectState` |
| `HonuaWorkspaceSessionState` | `HonuaAppSessionState` |
| `HonuaWorkspaceSummary` | `HonuaFolderSummary` |
| `HonuaWorkspacesClient` | `HonuaFoldersClient` |
| `KeplerWorkspaceBridge` | `KeplerAppBridge` |
| `KeplerWorkspaceDatasetState` | `KeplerAppDatasetState` |
| `KeplerWorkspaceHost` | `KeplerAppHost` |
| `KeplerWorkspaceMetrics` | `KeplerAppMetrics` |
| `MapWorkspaceController` | `MapController` |
| `MapWorkspaceControllerOptions` | `MapControllerOptions` |
| `MapWorkspaceEvent` | `MapEvent` |
| `OperatorWorkspace` | `OperatorShell` |
| `OperatorWorkspaceOptions` | `OperatorShellOptions` |
| `SCENE_STATE_SYNC_SLICE_WORKSPACE_CROSSWALK` | `SCENE_STATE_SYNC_SLICE_STORE_CROSSWALK` |
| `SCENE_WORKSPACE_SLICES` | `SCENE_STORE_SLICES` |
| `SceneWorkspace` | `SceneStore` |
| `SceneWorkspaceAdapterEvent` | `SceneStoreAdapterEvent` |
| `SceneWorkspaceChangeEvent` | `SceneStoreChangeEvent` |
| `SceneWorkspaceHistoryEntry` | `SceneStoreHistoryEntry` |
| `SceneWorkspaceIntent` | `SceneStoreIntent` |
| `SceneWorkspaceListener` | `SceneStoreListener` |
| `SceneWorkspaceSlice` | `SceneStoreSlice` |
| `SceneWorkspaceSnapshot` | `SceneStoreSnapshot` |
| `SceneWorkspaceState` | `SceneStoreState` |
| `SceneWorkspaceUnsubscribe` | `SceneStoreUnsubscribe` |
| `StudioContentItemListOptions` | `StudioContentListOptions` |
| `StudioContentItemListResponse` | `StudioContentListResponse` |
| `StudioContentItemListRow` | `StudioContentListRow` |
| `StudioContentItemPointers` | `StudioContentPointers` |
| `StudioContentItemPublicationBadge` | `StudioContentPublicationBadge` |
| `StudioContentItemState` | `StudioContentState` |
| `WorkspaceEvent` | `OperatorShellEvent` |
| `WorkspaceEventListener` | `OperatorShellEventListener` |
| `assertHonuaSavedWorkspaceDocument` | `assertHonuaSavedAppStateDocument` |
| `bindHonuaAppWorkspaceSelector` | `bindHonuaAppStoreSelector` |
| `createHonuaAppWorkspace` | `createHonuaAppStore` |
| `createHonuaAppWorkspaceFromSavedDocument` | `createHonuaAppStoreFromSavedDocument` |
| `createHonuaSavedWorkspaceDocument` | `createHonuaSavedAppStateDocument` |
| `createKeplerWorkspaceBridge` | `createKeplerAppBridge` |
| `createSceneWorkspace` | `createSceneStore` |
| `emptySceneWorkspaceState` | `emptySceneStoreState` |
| `hydrateHonuaSavedWorkspaceState` | `hydrateHonuaSavedAppState` |
| `reattachHonuaSavedWorkspaceArtifacts` | `reattachHonuaSavedAppStateArtifacts` |
| `reduceSceneWorkspaceState` | `reduceSceneStoreState` |
| `sceneWorkspaceIntentFromAdapterEvent` | `sceneStoreIntentFromAdapterEvent` |
| `selectHonuaAppWorkspaceChartModel` | `selectHonuaAppStoreChartModel` |
| `selectHonuaAppWorkspaceDetailModel` | `selectHonuaAppStoreDetailModel` |
| `selectHonuaAppWorkspaceDrafts` | `selectHonuaAppStoreDrafts` |
| `selectHonuaAppWorkspaceFilterModel` | `selectHonuaAppStoreFilterModel` |
| `selectHonuaAppWorkspaceJobModel` | `selectHonuaAppStoreJobModel` |
| `selectHonuaAppWorkspaceMapModel` | `selectHonuaAppStoreMapModel` |
| `selectHonuaAppWorkspaceMetadataCacheModel` | `selectHonuaAppStoreMetadataCacheModel` |
| `selectHonuaAppWorkspaceRealtimeModel` | `selectHonuaAppStoreRealtimeModel` |
| `selectHonuaAppWorkspaceTableModel` | `selectHonuaAppStoreTableModel` |
| `summarizeHonuaSavedWorkspaceForMcp` | `summarizeHonuaSavedAppStateForMcp` |
| `validateHonuaSavedWorkspaceDocument` | `validateHonuaSavedAppStateDocument` |
