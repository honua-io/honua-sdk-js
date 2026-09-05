<!-- GENERATED FILE - DO NOT EDIT. -->
<!-- Regenerate with: npm run admin-client:generate -->

# `honua admin` command reference

Generated from `honua-io/honua-server@07b8206a101f4a3c2e9ec0db46650c8cdb63aa4a` (396 REST operations).

Every operation is available through `honua admin api <operationId>`. The grouped spelling
`honua admin <group> <operationId>` adds an intentional workflow namespace without forking
the generated request or response contract.

Common options: `--body @file.json`, repeated `--path name=value`, repeated
`--query name=value`, `--json`, `--dry-run`, `--yes`, and `--profile <name>`.
Credential-bearing Admin requests require HTTPS; plain HTTP is accepted only
for exact loopback development hosts. Base URLs with user information, query
parameters, or fragments are rejected, and redirects are never followed.
`--dry-run` preserves request structure but replaces credential-bearing header,
query, and nested body values with `[REDACTED]`.

The six one-time-secret operations (`createAdminApiKey`, `rotateAdminApiKey`, `registerOAuthClient`, `createEmbedKey`, `issueAdminOperatorBearer`, `rotateEmbedKey`) fail closed unless
`--secret-output <new-private-file>` is supplied. The CLI atomically creates that file with
private permissions, refuses overwrite/reuse, and prints only allowlisted resource metadata plus
the sink path and SHA-256 digest; plaintext material is never written to stdout or stderr.
Existing saved profiles and local-install credential files are consumed only
after the same owner-only permission/ACL proof succeeds; permissive legacy files
must be rotated or reconciled rather than silently reused.

## connect

| Operation ID | Method | Path | Summary |
| --- | --- | --- | --- |
| `createConnection` | `POST` | `/connections` | Create Secure Connection |
| `deleteConnection` | `DELETE` | `/connections/{id}` | Delete Secure Connection |
| `getConnection` | `GET` | `/connections/{id}` | Get Secure Connection |
| `getConnections` | `GET` | `/connections` | List Secure Connections |
| `getConnectionTables` | `GET` | `/connections/{id}/tables` | Get Connection Tables |
| `rotateConnectionEncryptionKey` | `POST` | `/connections/encryption/rotate-key` | Rotate Encryption Key |
| `testConnection` | `POST` | `/connections/{id}/test` | Test Saved Connection |
| `testDraftConnection` | `POST` | `/connections/test` | Test Draft Connection |
| `updateConnection` | `PUT` | `/connections/{id}` | Update Secure Connection |
| `validateConnectionEncryption` | `POST` | `/connections/encryption/validate` | Validate Encryption Service |
| `validateConnectionTableForPublish` | `POST` | `/connections/{id}/tables/validate` | Validate Table For Layer Publishing |

## import

| Operation ID | Method | Path | Summary |
| --- | --- | --- | --- |
| `cancelGeoServerImportJob` | `POST` | `/import/geoserver/jobs/{jobId}/cancel` | Cancel GeoServer Import Job |
| `cancelGeoservicesImportJob` | `POST` | `/import/geoservices/jobs/{jobId}/cancel` | Cancel GeoServices Import Job |
| `cancelImportJob` | `POST` | `/import/jobs/{jobId}/cancel` | Cancel an Import Job |
| `cancelImportUpload` | `POST` | `/import/uploads/{uploadId}/cancel` | Cancel Import Upload |
| `deleteImportedRaster` | `DELETE` | `/import/raster/{rasterId}` | Delete Imported Raster |
| `discoverGeoServerService` | `POST` | `/import/geoserver/discover` | Discover GeoServer Service |
| `discoverGeoservicesService` | `POST` | `/import/geoservices/discover` | Discover GeoServices Service |
| `exportOgcTileCache` | `POST` | `/import/ogc-tiles/export` | Export OGC WMTS Tile Cache |
| `getActiveImportJobs` | `GET` | `/import/jobs` | List Active Import Jobs |
| `getArcGisMigrationManifest` | `GET` | `/import/arcgis/migrations/{runId}/manifest` | Get ArcGIS Migration Manifest |
| `getArcGisMigrationParity` | `GET` | `/import/arcgis/migrations/{runId}/parity` | Get ArcGIS Migration Parity |
| `getGeoServerImportJob` | `GET` | `/import/geoserver/jobs/{jobId}` | Get GeoServer Import Job |
| `getGeoservicesImportJob` | `GET` | `/import/geoservices/jobs/{jobId}` | Get GeoServices Import Job |
| `getImportFormats` | `GET` | `/import/formats` | Get Supported Import Formats |
| `getImportJobStatus` | `GET` | `/import/jobs/{jobId}` | Get Import Job Status |
| `getImportLimits` | `GET` | `/import/limits` | Get Import Limits |
| `getImportUploadProgress` | `GET` | `/import/uploads/{uploadId}/progress` | Get Import Upload Progress |
| `getMigrationBatch` | `GET` | `/import/migrations/{batchId}` | Get Migration Batch |
| `getRasterImportFormats` | `GET` | `/import/raster/formats` | Get Raster Import Formats |
| `importOgcApiFeaturesCollection` | `POST` | `/import/ogc-api-features/collection` | Import OGC API Features Collection |
| `importOgcCoverages` | `POST` | `/import/ogc/coverages/import` | Import OGC Coverages |
| `importOgcWcsCoverages` | `POST` | `/import/ogc-wcs/import` | Import Legacy WCS Coverages |
| `importRasterFile` | `POST` | `/import/raster` | Import Raster File |
| `importTileCachePackage` | `POST` | `/import/tile-package` | Import Tile Cache Package |
| `listActiveImportUploads` | `GET` | `/import/uploads` | List Active Import Uploads |
| `listArcGisMigrationRuns` | `GET` | `/import/arcgis/migrations` | List ArcGIS Migration Runs |
| `listGeoServerImportJobs` | `GET` | `/import/geoserver/jobs` | List GeoServer Import Jobs |
| `listGeoservicesImportJobs` | `GET` | `/import/geoservices/jobs` | List GeoServices Import Jobs |
| `previewImportFile` | `POST` | `/import/preview` | Preview a Geospatial File |
| `previewImportFileFromUrl` | `POST` | `/import/preview-url` | Preview a Geospatial File from a URL |
| `recordArcGisMigrationManifest` | `POST` | `/import/arcgis/migrations/{runId}/manifest` | Record ArcGIS Migration Manifest |
| `recordArcGisMigrationParity` | `POST` | `/import/arcgis/migrations/{runId}/parity` | Record ArcGIS Migration Parity |
| `scanMigrationSource` | `POST` | `/import/scan` | Scan Migration Source |
| `startGeoServerImport` | `POST` | `/import/geoserver/start` | Start GeoServer Import |
| `startGeoservicesImport` | `POST` | `/import/geoservices/start` | Start GeoServices Import |
| `startMigrationBatch` | `POST` | `/import/migrations` | Start Migration Batch |
| `startOgcWfsImport` | `POST` | `/import/ogc-wfs/start` | Start OGC WFS Import |
| `updateImportedRaster` | `PATCH` | `/import/raster/{rasterId}` | Update Imported Raster |
| `uploadImportFile` | `POST` | `/import/upload` | Upload and Import a Geospatial File |
| `uploadImportFileFromUrl` | `POST` | `/import/upload-url` | Import a Geospatial File from a URL |
| `validateToolboxTranslation` | `POST` | `/import/toolbox/translation/validate` | Validate a Translated Toolbox Manifest |

## publish

| Operation ID | Method | Path | Summary |
| --- | --- | --- | --- |
| `assignFieldWorkflowSubmission` | `POST` | `/field-workflows/submissions/{submissionId}/assignment` | Assign Field Submission |
| `commentFieldWorkflowSubmission` | `POST` | `/field-workflows/submissions/{submissionId}/comments` | Comment On Field Submission |
| `createFieldMaskPolicy` | `POST` | `/field-mask-policies` | Create Field-Mask Policy |
| `createFieldWorkflowExport` | `POST` | `/field-workflows/exports` | Create Field Export |
| `decideFieldWorkflowSubmission` | `POST` | `/field-workflows/submissions/{submissionId}/decision` | Decide Field Submission |
| `deleteFieldMaskPolicy` | `DELETE` | `/field-mask-policies/{id}` | Delete Field-Mask Policy |
| `exportLayerSldStyle` | `GET` | `/metadata/layers/{layerId}/style/export-sld` | Export Layer Style as SLD |
| `exportServiceLayer` | `GET` | `/services/{serviceName}/layers/{layerId}/export` | Export Layer Data |
| `getAdminLayerDrawingInfo` | `GET` | `/metadata/layers/{layerId}/drawing-info` | Get Layer Drawing Info |
| `getAdminLayerFields` | `GET` | `/metadata/layers/{layerId}/fields` | Get Layer Field Configuration |
| `getAdminLayerFilter` | `GET` | `/metadata/layers/{layerId}/filter` | Get Layer Permanent Filter |
| `getAdminLayerPopupInfo` | `GET` | `/metadata/layers/{layerId}/popup-info` | Get Layer Popup Info |
| `getAdminLayerRelationships` | `GET` | `/metadata/layers/{layerId}/relationships` | Get Layer Relationships |
| `getAdminLayerStyle` | `GET` | `/metadata/layers/{layerId}/style` | Get Layer Style |
| `getAdminLayerValidation` | `GET` | `/metadata/layers/{layerId}/validation` | Validate Layer Metadata |
| `getFieldMaskPolicy` | `GET` | `/field-mask-policies/{id}` | Get Field-Mask Policy |
| `getFieldWorkflowSubmission` | `GET` | `/field-workflows/submissions/{submissionId}` | Get Field Submission |
| `getLayerShareTrafficSeries` | `GET` | `/services/{serviceName}/layers/{layerId}/share/traffic/series` | Get Layer Share Traffic Series |
| `getLayerShareTrafficSummary` | `GET` | `/services/{serviceName}/layers/{layerId}/share/traffic` | Get Layer Share Traffic Summary |
| `getPublishedLayers` | `GET` | `/connections/{id}/layers` | List Published Layers |
| `importLayerSldStyle` | `POST` | `/metadata/layers/{layerId}/style/import-sld` | Import SLD Layer Style |
| `listFieldMaskPolicies` | `GET` | `/field-mask-policies` | List Field-Mask Policies |
| `listFieldWorkflowExports` | `GET` | `/field-workflows/exports` | List Field Exports |
| `listFieldWorkflowSubmissions` | `GET` | `/field-workflows/submissions` | List Field Submissions |
| `publishFormPackageVersion` | `POST` | `/forms/packages/{formId}/versions/{packageVersion}/publish` | Publish Form Package Version |
| `publishLayer` | `POST` | `/connections/{id}/layers` | Publish Layer |
| `refreshConnectionLayerExtents` | `POST` | `/connections/{id}/layers/extents/refresh` | Refresh Layer Extents |
| `refreshConnectionLayerFeatures` | `POST` | `/connections/{id}/layers/{layerId}/features/refresh` | Refresh Layer Feature Snapshot |
| `setAdminLayerDrawingInfo` | `PUT` | `/metadata/layers/{layerId}/drawing-info` | Set Layer Drawing Info |
| `setAdminLayerPopupInfo` | `PUT` | `/metadata/layers/{layerId}/popup-info` | Set Layer Popup Info |
| `setAdminLayerRelationships` | `PUT` | `/metadata/layers/{layerId}/relationships` | Set Layer Relationships |
| `setLayerEnabled` | `PUT` | `/connections/{id}/layers/{layerId}/enabled` | Set Layer Enabled |
| `setServiceLayersEnabled` | `PUT` | `/connections/{id}/layers/enabled` | Set Service Layers Enabled |
| `suggestLayerStyle` | `POST` | `/metadata/layers/{layerId}/suggest-style` | Suggest Layer Style |
| `updateAdminLayerFields` | `PUT` | `/metadata/layers/{layerId}/fields` | Update Layer Field Configuration |
| `updateAdminLayerFilter` | `PUT` | `/metadata/layers/{layerId}/filter` | Update Layer Permanent Filter |
| `updateAdminLayerStyle` | `PUT` | `/metadata/layers/{layerId}/style` | Update Layer Style |
| `updateLayerMetadata` | `PUT` | `/services/{serviceName}/layers/{layerId}/metadata` | Update Layer Metadata |

## configure

| Operation ID | Method | Path | Summary |
| --- | --- | --- | --- |
| `addInvestigationLink` | `POST` | `/investigations/{investigationId}/links` | Link Resource To Investigation |
| `addInvestigationPin` | `POST` | `/investigations/{investigationId}/pins` | Pin Event To Investigation |
| `allocateNetworkTopologyDraftGeneration` | `POST` | `/network-datasets/{id}/generations` | Allocate Draft Topology Generation |
| `applyNetworkTopologyEditBatch` | `POST` | `/network-datasets/{id}/generations/{generation}/edits` | Apply Topology Edit Batch |
| `cancelConsoleJob` | `POST` | `/jobs/{jobId}/cancel` | Cancel Console Job |
| `cancelMigrationRun` | `POST` | `/migration/runs/{runId}/cancel` | Cancel Migration Run |
| `completeMigrationRun` | `POST` | `/migration/runs/{runId}/complete` | Record Migration Run Completed |
| `createAdminAuthAuthorizeUrl` | `POST` | `/auth/providers/{providerKey}/authorize-url` | Create Admin Auth Authorize Url |
| `createAlertRule` | `POST` | `/alerts/rules` | Create Alert Rule |
| `createAlertZone` | `POST` | `/alerts/zones` | Create Alert Zone |
| `createEmbedKey` | `POST` | `/embed/keys` | Create Embed Key |
| `createFormPackageDraft` | `POST` | `/forms/packages` | Create Form Package Draft |
| `createInvestigation` | `POST` | `/investigations` | Create Investigation |
| `createShareExport` | `POST` | `/share/exports` | Create Share Export Definition |
| `deactivateSceneDataset` | `DELETE` | `/scenes/{id}` | Deactivate Scene Dataset |
| `deleteAlertRule` | `DELETE` | `/alerts/rules/{ruleId}` | Delete Alert Rule |
| `deleteAlertZone` | `DELETE` | `/alerts/zones/{zoneId}` | Delete Alert Zone |
| `deleteNetworkDataset` | `DELETE` | `/network-datasets/{id}` | Delete Network Dataset |
| `deleteShareExport` | `DELETE` | `/share/exports/{exportId}` | Delete Share Export Definition |
| `disconnectFeatureStreamSession` | `DELETE` | `/streaming/features/sessions/{sessionId}` | Disconnect a feature stream session |
| `discoverExternalService` | `POST` | `/external-services/discover` | Discover External Service |
| `evaluateResidencyPolicy` | `POST` | `/compliance/residency/evaluate` | Evaluate Residency Policy |
| `exportComplianceReport` | `GET` | `/compliance/report` | Export Compliance Report |
| `generateScene` | `POST` | `/scenes/generate` | Generate Scene From Feature Layer |
| `getAdminAuthConfig` | `GET` | `/auth/config` | Get Admin Auth Configuration |
| `getAdminAuthLogoutUrl` | `GET` | `/auth/providers/{providerKey}/logout-url` | Get Admin Auth Logout Url |
| `getAdminAuthSession` | `GET` | `/auth/session` | Get Admin Auth Session |
| `getAdminCapabilities` | `GET` | `/capabilities` | Get Admin Capabilities |
| `getAdminOpenApi` | `GET` | `/openapi.json` | Get Admin OpenAPI Specification |
| `getAdminVersion` | `GET` | `/version` | Get Admin Version Info |
| `getAlertRule` | `GET` | `/alerts/rules/{ruleId}` | Get Alert Rule |
| `getAlertZone` | `GET` | `/alerts/zones/{zoneId}` | Get Alert Zone |
| `getCloudRaster` | `GET` | `/cloud-rasters/{id}` | Get Cloud Raster |
| `getComplianceDashboard` | `GET` | `/compliance/dashboard` | Get Compliance Dashboard |
| `getConsoleJob` | `GET` | `/jobs/{jobId}` | Get Console Job Detail |
| `getConsoleJobActions` | `GET` | `/jobs/{jobId}/actions` | Get Console Job Actions |
| `getConsoleJobArtifacts` | `GET` | `/jobs/{jobId}/artifacts` | Get Console Job Artifacts |
| `getConsoleJobLogs` | `GET` | `/jobs/{jobId}/logs` | Get Console Job Logs |
| `getConsoleJobSteps` | `GET` | `/jobs/{jobId}/steps` | Get Console Job Steps |
| `getCurrentFormPackage` | `GET` | `/forms/packages/{formId}` | Get Current Form Package |
| `getEmbedKey` | `GET` | `/embed/keys/{id}` | Get Embed Key |
| `getEmbedUsage` | `GET` | `/embed/usage` | Query Embed Usage |
| `getEnhancedExceptionStatistics` | `GET` | `/performance/enhanced/exceptions/statistics` | Get exception statistics |
| `getEnhancedPerformanceSummary` | `GET` | `/performance/enhanced/summary` | Get overall performance summary |
| `getEnhancedPotentialResourceLeaks` | `GET` | `/performance/enhanced/resources/potential-leaks` | Get potential resource leaks |
| `getEnhancedQueryPerformanceStatistics` | `GET` | `/performance/enhanced/database/query-performance` | Get database query performance statistics |
| `getEnhancedRecentExceptions` | `GET` | `/performance/enhanced/exceptions/recent` | Get recent exceptions |
| `getEnhancedResourceTracking` | `GET` | `/performance/enhanced/resources/tracking` | Get resource tracking statistics |
| `getEnhancedSlowQueries` | `GET` | `/performance/enhanced/database/slow-queries` | Get recent slow queries |
| `getFeatureOverview` | `GET` | `/features` | Get Feature Overview |
| `getFormPackageVersion` | `GET` | `/forms/packages/{formId}/versions/{packageVersion}` | Get Form Package Version |
| `getGeocodingProviders` | `GET` | `/geocoding/providers` | Get Geocoding Providers |
| `getGeoprocessingToolUsageRanking` | `GET` | `/geoprocessing/tools/usage-ranking` | Get geoprocessing tool usage ranking |
| `getIdentityProviders` | `GET` | `/identity/providers` | Get Identity Providers |
| `getInvestigation` | `GET` | `/investigations/{investigationId}` | Get Investigation |
| `getLatestMigrationPerformanceEvidence` | `GET` | `/migration/performance-evidence/latest` | Get Latest Migration Performance Evidence |
| `getMetadataSemanticInventory` | `GET` | `/metadata/environments/{environment}/inventory` | Get Metadata Semantic Inventory |
| `getMigrationPerformanceEvidenceById` | `GET` | `/migration/performance-evidence/{evidenceId}` | Get Migration Performance Evidence |
| `getMigrationRun` | `GET` | `/migration/runs/{runId}` | Get Migration Run |
| `getMigrationRunEvidencePack` | `GET` | `/migration/runs/{runId}/evidence-pack` | Download Migration Run Evidence Pack |
| `getMigrationRunScorecard` | `GET` | `/migration/runs/{runId}/scorecard` | Download Migration Run Reconciliation Scorecard |
| `getMultidimCoverage` | `GET` | `/multidim-coverages/{id}` | Get Multidimensional Coverage |
| `getMultidimCoverageScanJob` | `GET` | `/multidim-coverages/jobs/{jobId}` | Get Multidimensional Coverage Scan Job |
| `getNetworkDataset` | `GET` | `/network-datasets/{id}` | Get Network Dataset |
| `getNetworkTopologyRebuildAttempt` | `GET` | `/network-datasets/{id}/generations/{generation}/rebuild/{attempt}` | Get Topology Rebuild Attempt |
| `getSceneDataset` | `GET` | `/scenes/{id}` | Get Scene Dataset |
| `getServiceReplica` | `GET` | `/services/{serviceId}/replicas/{replicaId}` | Get Service Replica |
| `getServiceReplicaConflict` | `GET` | `/services/{serviceId}/replicas/{replicaId}/conflicts/{conflictId}` | Get Replica Conflict |
| `getServiceSettings` | `GET` | `/services/{serviceName}/settings` | Get Service Settings |
| `getShareExport` | `GET` | `/share/exports/{exportId}` | Get Share Export Definition |
| `getShareExportRun` | `GET` | `/share/exports/{exportId}/runs/{runId}` | Get Share Export Run |
| `getShareTrafficSeries` | `GET` | `/share/traffic/series` | Get Aggregate Share Traffic Series |
| `getShareTrafficSummary` | `GET` | `/share/traffic` | Get Aggregate Share Traffic Summary |
| `getZarrStore` | `GET` | `/zarr-stores/{id}` | Get Zarr Store |
| `importGeocoderReferenceData` | `POST` | `/geocoding/reference-data/import` | Import Geocoder Reference Data |
| `ingestCityGmlScene` | `POST` | `/scenes/ingest/citygml` | Ingest CityGML Scene |
| `ingestPointCloudScene` | `POST` | `/scenes/ingest/pointcloud` | Ingest Point Cloud Scene |
| `issueAdminOperatorBearer` | `POST` | `/auth/bearer` | Issue Console Operator Bearer |
| `listAlertChannelStates` | `GET` | `/alerts/channels` | List Alert Channel States |
| `listAlertRuleEvents` | `GET` | `/alerts/rules/{ruleId}/events` | List Alert Rule Events |
| `listAlertRules` | `GET` | `/alerts/rules` | List Alert Rules |
| `listAlertZones` | `GET` | `/alerts/zones` | List Alert Zones |
| `listCloudRasters` | `GET` | `/cloud-rasters` | List Cloud Rasters |
| `listConsoleJobs` | `GET` | `/jobs` | List Console Jobs |
| `listEmbedKeys` | `GET` | `/embed/keys` | List Embed Keys |
| `listFeatureStreamSessions` | `GET` | `/streaming/features/sessions` | List feature stream sessions |
| `listFederationSources` | `GET` | `/federation/sources` | List Federated Sources |
| `listFormPackages` | `GET` | `/forms/packages` | List Form Packages |
| `listFormPackageVersions` | `GET` | `/forms/packages/{formId}/versions` | List Form Package Versions |
| `listInvestigations` | `GET` | `/investigations` | List Investigations |
| `listMigrationPerformanceEvidenceHistory` | `GET` | `/migration/performance-evidence/history` | List Migration Performance Evidence History |
| `listMigrationRuns` | `GET` | `/migration/runs` | List Migration Runs |
| `listMultidimCoverages` | `GET` | `/multidim-coverages` | List Multidimensional Coverages |
| `listNetworkDatasets` | `GET` | `/network-datasets` | List Network Datasets |
| `listNetworkTopologyGenerations` | `GET` | `/network-datasets/{id}/generations` | List Topology Generations |
| `listNetworkTopologyPromotions` | `GET` | `/network-datasets/{id}/promotions` | List Topology Promotions |
| `listSceneDatasets` | `GET` | `/scenes` | List Scene Datasets |
| `listServiceReplicaConflicts` | `GET` | `/services/{serviceId}/replicas/{replicaId}/conflicts` | List Replica Conflicts |
| `listServiceReplicas` | `GET` | `/services/{serviceId}/replicas` | List Service Replicas |
| `listServices` | `GET` | `/services` | List Services |
| `listShareExportRuns` | `GET` | `/share/exports/{exportId}/runs` | List Share Export Runs |
| `listShareExports` | `GET` | `/share/exports` | List Share Export Definitions |
| `listZarrStores` | `GET` | `/zarr-stores` | List Zarr Stores |
| `logoutAdminAuthSession` | `POST` | `/auth/logout` | Logout Admin Auth Session |
| `pauseAlertChannel` | `POST` | `/alerts/channels/{channel}/pause` | Pause Alert Channel |
| `pauseShareExport` | `POST` | `/share/exports/{exportId}/pause` | Pause Share Export Definition |
| `planFederationSourceQuery` | `GET` | `/federation/sources/{id}/plan` | Plan Federated Query |
| `previewPackage` | `POST` | `/packages/preview` | Preview Package |
| `promoteNetworkTopologyGeneration` | `POST` | `/network-datasets/{id}/promote` | Promote Topology Generation |
| `queryMetadataEnvironmentBindings` | `POST` | `/metadata/environment-bindings/query` | Query Metadata Environment Bindings |
| `recordMigrationRunScorecard` | `POST` | `/migration/runs/{runId}/scorecard` | Record Migration Run Reconciliation Scorecard |
| `recordMigrationRunStarted` | `POST` | `/migration/runs` | Record Migration Run Started |
| `redriveAlertDeadLetters` | `POST` | `/alerts/dispatch/redrive` | Redrive Alert Dead-Letters |
| `refreshCloudRaster` | `POST` | `/cloud-rasters/{id}/refresh` | Refresh Cloud Raster Metadata |
| `refreshMultidimCoverage` | `POST` | `/multidim-coverages/{id}/refresh` | Refresh Multidimensional Coverage Metadata |
| `refreshZarrStore` | `POST` | `/zarr-stores/{id}/refresh` | Refresh Zarr Store Metadata |
| `registerCloudRaster` | `POST` | `/cloud-rasters` | Register Cloud Raster |
| `registerMultidimCoverage` | `POST` | `/multidim-coverages` | Register Multidimensional Coverage |
| `registerNetworkDataset` | `POST` | `/network-datasets` | Register Network Dataset |
| `registerSceneDataset` | `POST` | `/scenes` | Register Scene Dataset |
| `registerZarrStore` | `POST` | `/zarr-stores` | Register Zarr Store |
| `removeInvestigationLink` | `DELETE` | `/investigations/{investigationId}/links/{linkId}` | Remove Investigation Link |
| `removeInvestigationPin` | `DELETE` | `/investigations/{investigationId}/pins/{pinId}` | Remove Investigation Pin |
| `reopenFormPackageVersion` | `POST` | `/forms/packages/{formId}/versions/{packageVersion}/reopen` | Reopen Form Package Version |
| `replayFeatureChangeEvents` | `GET` | `/feature-events/replay` | Replay feature-change events |
| `requestAdminAuthToken` | `POST` | `/auth/providers/{providerKey}/token` | Request Admin Auth Token |
| `resetFeatureStreamConformanceSource` | `POST` | `/streaming/conformance/reset` | Reset the controlled-conformance source |
| `resolveSceneDataset` | `GET` | `/scenes/{id}/resolve` | Resolve Scene Dataset |
| `resolveServiceReplicaConflict` | `POST` | `/services/{serviceId}/replicas/{replicaId}/conflicts/{conflictId}/resolve` | Resolve Replica Conflict |
| `resumeAlertChannel` | `POST` | `/alerts/channels/{channel}/resume` | Resume Alert Channel |
| `resumeShareExport` | `POST` | `/share/exports/{exportId}/resume` | Resume Share Export Definition |
| `retryConsoleJob` | `POST` | `/jobs/{jobId}/retry` | Retry Console Job |
| `revokeEmbedKey` | `POST` | `/embed/keys/{id}/revoke` | Revoke Embed Key |
| `rotateComplianceEncryptionKey` | `POST` | `/compliance/encryption/rotate-key` | Advance Compliance Key-Version Posture |
| `rotateEmbedKey` | `POST` | `/embed/keys/{id}/rotate` | Rotate Embed Key |
| `scanEnhancedResourceLeaks` | `POST` | `/performance/enhanced/resources/scan-leaks` | Scan for resource leaks |
| `setAlertRuleEnabled` | `PUT` | `/alerts/rules/{ruleId}/enabled` | Set Alert Rule Enabled State |
| `submitNetworkTopologyRebuild` | `POST` | `/network-datasets/{id}/generations/{generation}/rebuild` | Submit Topology Rebuild |
| `testAlertRule` | `POST` | `/alerts/rules/test` | Test Alert Rule |
| `testIdentityProviderConnectivity` | `GET` | `/identity/providers/{providerType}/test` | Test Identity Provider Connectivity |
| `triggerShareExport` | `POST` | `/share/exports/{exportId}/trigger` | Trigger Share Export Run |
| `unregisterCloudRaster` | `DELETE` | `/cloud-rasters/{id}` | Unregister Cloud Raster |
| `unregisterMultidimCoverage` | `DELETE` | `/multidim-coverages/{id}` | Unregister Multidimensional Coverage |
| `unregisterZarrStore` | `DELETE` | `/zarr-stores/{id}` | Unregister Zarr Store |
| `updateAlertRule` | `PUT` | `/alerts/rules/{ruleId}` | Update Alert Rule |
| `updateAlertZone` | `PUT` | `/alerts/zones/{zoneId}` | Update Alert Zone |
| `updateFormPackageDraft` | `PUT` | `/forms/packages/{formId}/versions/{packageVersion}` | Update Form Package Draft |
| `updateInvestigation` | `PATCH` | `/investigations/{investigationId}` | Update Investigation |
| `updateNetworkDataset` | `PUT` | `/network-datasets/{id}` | Update Network Dataset |
| `updateSceneDataset` | `PUT` | `/scenes/{id}` | Update Scene Dataset |
| `updateServiceAccessPolicy` | `PUT` | `/services/{serviceName}/access-policy` | Update Service Access Policy |
| `updateServiceMapServer` | `PUT` | `/services/{serviceName}/mapserver` | Update MapServer Settings |
| `updateServiceProtocols` | `PUT` | `/services/{serviceName}/protocols` | Update Service Protocols |
| `updateServiceTimeInfo` | `PUT` | `/services/{serviceName}/timeinfo` | Update Service Time Info |
| `updateShareExport` | `PUT` | `/share/exports/{exportId}` | Replace Share Export Definition |
| `validateFormPackageVersion` | `POST` | `/forms/packages/{formId}/versions/{packageVersion}/validate` | Validate Form Package Version |
| `validatePackage` | `POST` | `/packages/validate` | Validate Package |

## secure

| Operation ID | Method | Path | Summary |
| --- | --- | --- | --- |
| `addClientCertificateRevocation` | `POST` | `/security/client-certificates/profiles/{profileId}/revocations` | Add Client Certificate Revocation |
| `createAdminApiKey` | `POST` | `/api-keys` | Create Admin API Key |
| `createClientCertificatePrincipalMapping` | `POST` | `/security/client-certificates/profiles/{profileId}/mappings` | Create Client Certificate Principal Mapping |
| `createClientCertificateTrustProfile` | `POST` | `/security/client-certificates/profiles` | Create Client Certificate Trust Profile |
| `createOidcProvider` | `POST` | `/oidc/providers` | Create OIDC Provider |
| `createRateLimitPolicy` | `POST` | `/rate-limits` | Create Rate Limit Policy |
| `createRlsPolicy` | `POST` | `/rls-policies` | Create RLS Policy |
| `createRole` | `POST` | `/roles` | Create Role |
| `createTenant` | `POST` | `/tenants` | Create Tenant |
| `defineOAuthScope` | `PUT` | `/oauth-scopes` | Define OAuth Scope |
| `deleteOAuthClient` | `DELETE` | `/oauth-clients/{id}` | Delete OAuth Client |
| `deleteOAuthScope` | `DELETE` | `/oauth-scopes/{scope}` | Delete OAuth Scope |
| `deleteOidcProvider` | `DELETE` | `/oidc/providers/{id}` | Delete OIDC Provider |
| `deleteRateLimitPolicy` | `DELETE` | `/rate-limits/{id}` | Delete Rate Limit Policy |
| `deleteRlsPolicy` | `DELETE` | `/rls-policies/{id}` | Delete RLS Policy |
| `deleteRole` | `DELETE` | `/roles/{id}` | Delete Role |
| `deleteTenant` | `DELETE` | `/tenants/{tenantId}` | Delete Tenant |
| `deprovisionManagedUser` | `DELETE` | `/users/{id}` | Deprovision User |
| `disableClientCertificatePrincipalMapping` | `DELETE` | `/security/client-certificates/profiles/{profileId}/mappings/{mappingId}` | Disable Client Certificate Principal Mapping |
| `disableClientCertificateTrustProfile` | `DELETE` | `/security/client-certificates/profiles/{profileId}` | Disable Client Certificate Trust Profile |
| `exportTenantUsage` | `GET` | `/tenants/usage` | Export Tenant Billing Usage |
| `getAdminApiKeyEffectivePermissions` | `GET` | `/api-keys/{id}/effective-permissions` | Get Admin API Key Effective Permissions |
| `getClientCertificateTrustProfile` | `GET` | `/security/client-certificates/profiles/{profileId}` | Get Client Certificate Trust Profile |
| `getManagedUser` | `GET` | `/users/{id}` | Get User |
| `getManagedUserEffectivePermissions` | `GET` | `/users/{id}/effective-permissions` | Get User Effective Permissions |
| `getOAuthClient` | `GET` | `/oauth-clients/{id}` | Get OAuth Client |
| `getOidcProvider` | `GET` | `/oidc/providers/{id}` | Get OIDC Provider |
| `getRateLimitPolicy` | `GET` | `/rate-limits/{id}` | Get Rate Limit Policy |
| `getRateLimitStatus` | `GET` | `/rate-limits/status` | Get Rate Limit Status |
| `getRlsPolicy` | `GET` | `/rls-policies/{id}` | Get RLS Policy |
| `getRole` | `GET` | `/roles/{id}` | Get Role |
| `getRolePermissions` | `GET` | `/roles/{id}/permissions` | Get Role Permissions |
| `getTenant` | `GET` | `/tenants/{tenantId}` | Get Tenant |
| `listAdminApiKeys` | `GET` | `/api-keys` | List Admin API Keys |
| `listClientCertificatePrincipalMappings` | `GET` | `/security/client-certificates/profiles/{profileId}/mappings` | List Client Certificate Principal Mappings |
| `listClientCertificateRevocations` | `GET` | `/security/client-certificates/profiles/{profileId}/revocations` | List Client Certificate Revocations |
| `listClientCertificateTrustProfiles` | `GET` | `/security/client-certificates/profiles` | List Client Certificate Trust Profiles |
| `listManagedUsers` | `GET` | `/users` | List Users |
| `listOAuthClients` | `GET` | `/oauth-clients` | List OAuth Clients |
| `listOAuthScopes` | `GET` | `/oauth-scopes` | List OAuth Scopes |
| `listOidcProviders` | `GET` | `/oidc/providers` | List OIDC Providers |
| `listRateLimitPolicies` | `GET` | `/rate-limits` | List Rate Limit Policies |
| `listRlsPolicies` | `GET` | `/rls-policies` | List RLS Policies |
| `listRoles` | `GET` | `/roles` | List Roles |
| `listTenants` | `GET` | `/tenants` | List Tenants |
| `registerOAuthClient` | `POST` | `/oauth-clients` | Register OAuth Client |
| `removeClientCertificateRevocation` | `DELETE` | `/security/client-certificates/profiles/{profileId}/revocations/{revocationId}` | Remove Client Certificate Revocation |
| `resumeTenant` | `POST` | `/tenants/{tenantId}/resume` | Resume Tenant |
| `revokeAdminApiKey` | `POST` | `/api-keys/{id}/revoke` | Revoke Admin API Key |
| `rotateAdminApiKey` | `POST` | `/api-keys/{id}/rotate` | Rotate Admin API Key |
| `setRolePermissions` | `PUT` | `/roles/{id}/permissions` | Set Role Permissions |
| `suspendTenant` | `POST` | `/tenants/{tenantId}/suspend` | Suspend Tenant |
| `testOidcProvider` | `POST` | `/oidc/providers/{id}/test` | Test OIDC Provider Connection |
| `updateClientCertificatePrincipalMapping` | `PUT` | `/security/client-certificates/profiles/{profileId}/mappings/{mappingId}` | Update Client Certificate Principal Mapping |
| `updateClientCertificateTrustProfile` | `PUT` | `/security/client-certificates/profiles/{profileId}` | Update Client Certificate Trust Profile |
| `updateManagedUserRoles` | `PUT` | `/users/{id}/roles` | Update User Roles |
| `updateOidcProvider` | `PUT` | `/oidc/providers/{id}` | Update OIDC Provider |
| `updateRateLimitPolicy` | `PUT` | `/rate-limits/{id}` | Update Rate Limit Policy |
| `updateRole` | `PUT` | `/roles/{id}` | Update Role |
| `validateClientCertificate` | `POST` | `/security/client-certificates/validate` | Validate Client Certificate |

## release

| Operation ID | Method | Path | Summary |
| --- | --- | --- | --- |
| `approveCoordinatedReleaseGate` | `POST` | `/metadata/coordinated-releases/operations/{operationId}/approve/{gate}` | Approve Coordinated Release Gate |
| `convergePlatformRelease` | `POST` | `/platform-release/converge` | Converge Platform Release |
| `createCoordinatedReleaseOperation` | `POST` | `/metadata/coordinated-releases/operations` | Create Coordinated Release Operation |
| `createDeployOperation` | `POST` | `/deploy/operations` | Create Deploy Operation |
| `createMetadataReleaseOperation` | `POST` | `/metadata/releases/operations` | Create Metadata Release Operation |
| `createMetadataReleasePackage` | `POST` | `/metadata/release-packages` | Create Metadata Release Package |
| `getCoordinatedReleaseOperation` | `GET` | `/metadata/coordinated-releases/{packageId}/operation` | Get Coordinated Release Operation |
| `getDeployOperation` | `GET` | `/deploy/operations/{operationId}` | Get Deploy Operation |
| `getDeployPreflight` | `GET` | `/deploy/preflight` | Get Deploy Preflight |
| `getMetadataReleaseGitOpsManifest` | `GET` | `/metadata/release-packages/{packageId}/gitops-manifest` | Get Metadata Release GitOps Manifest |
| `getMetadataReleaseOperationByPackageId` | `GET` | `/metadata/releases/{packageId}/operation` | Get Metadata Release Operation |
| `getMetadataReleasePackage` | `GET` | `/metadata/release-packages/{packageId}` | Get Metadata Release Package |
| `listDeployOperations` | `GET` | `/deploy/operations` | List Deploy Operations |
| `listMetadataReleasePackages` | `GET` | `/metadata/release-packages` | List Metadata Release Packages |
| `planDeployOperation` | `POST` | `/deploy/plan` | Plan Deploy Operation |
| `prevalidateMetadataReleasePackageCompatibility` | `POST` | `/metadata/prevalidate` | Prevalidate Metadata Release Package Compatibility |
| `promoteDeployOperation` | `POST` | `/deploy/operations/{operationId}/promote` | Promote Deploy Operation |
| `rollbackCoordinatedReleaseOperation` | `POST` | `/metadata/coordinated-releases/operations/{operationId}/rollback` | Roll Back Coordinated Release |
| `rollbackDeployOperation` | `POST` | `/deploy/operations/{operationId}/rollback` | Rollback Deploy Operation |
| `rollbackNetworkTopologyGeneration` | `POST` | `/network-datasets/{id}/rollback` | Roll Back Topology Generation |
| `submitDeployOperation` | `POST` | `/deploy/operations/{operationId}/submit` | Submit Deploy Operation |

## operate

| Operation ID | Method | Path | Summary |
| --- | --- | --- | --- |
| `acknowledgeObservabilityAlert` | `POST` | `/observability/alerts/{eventId}/acknowledge` | Acknowledge Observability Alert |
| `approveOperationProposal` | `POST` | `/proposals/{id}/approve` | Approve Operation Proposal |
| `cancelOperation` | `POST` | `/operations/{operationId}/cancel` | Cancel Operation |
| `cancelTileOperationJob` | `POST` | `/tile-operations/jobs/{jobId}/cancel` | Cancel Tile Operation Job |
| `disconnectOperationsStreamingSubscriber` | `DELETE` | `/operations/streaming/subscribers/{subscriberId}` | Disconnect Streaming Subscriber |
| `discoverConfiguration` | `GET` | `/configuration/discover` | Discover Configuration |
| `evictTileCache` | `POST` | `/tile-operations/evict` | Evict Tile Cache |
| `exportObservabilityAudit` | `GET` | `/observability/audit/export` | Export Audit Trail (SIEM) |
| `getAdminCacheStatus` | `GET` | `/cache/status` | Get cache health status |
| `getAlertRuleHealth` | `GET` | `/alerts/rules/{ruleId}/health` | Get Alert Rule Health |
| `getConfiguration` | `GET` | `/config` | Get Configuration Documentation |
| `getConfigurationAuditInfo` | `GET` | `/configuration/audit` | Get Configuration Audit Info |
| `getConfigurationAutoDocumentation` | `GET` | `/configuration/auto-documentation` | Get Configuration Auto-Documentation |
| `getConfigurationDiscoveryMetadata` | `GET` | `/configuration/metadata` | Get Configuration Metadata |
| `getConfigurationSummary` | `GET` | `/configuration/summary` | Get Configuration Summary |
| `getDatabaseQueryCacheStatistics` | `GET` | `/performance/database/query-cache/statistics` | Get prepared statement cache statistics |
| `getEnhancedCacheEffectiveness` | `GET` | `/performance/enhanced/cache/effectiveness` | Get cache effectiveness metrics |
| `getEnhancedCacheStatistics` | `GET` | `/performance/enhanced/cache/statistics` | Get query-result cache statistics |
| `getLicenseCapacityState` | `GET` | `/license/capacity` | Get License Capacity State |
| `getLicenseEntitlements` | `GET` | `/license/entitlements` | Get License Entitlements |
| `getLicenseFeatures` | `GET` | `/license/features` | Get License Feature Entitlements |
| `getLicenseStatus` | `GET` | `/license` | Get License Status |
| `getMigrationStatus` | `GET` | `/observability/migrations` | Get Migration Status |
| `getObservabilityAlert` | `GET` | `/observability/alerts/{eventId}` | Get Observability Alert |
| `getOperationProposal` | `GET` | `/proposals/{id}` | Get Operation Proposal |
| `getOperationsByType` | `GET` | `/operations/type/{operationType}` | Get Operations By Type |
| `getOperationsCacheHealth` | `GET` | `/operations/cache/health` | Get Cache Health |
| `getOperationsCacheRedisMetrics` | `GET` | `/operations/cache/redis` | Get Redis Connection Metrics |
| `getOperationsCacheStatistics` | `GET` | `/operations/cache/statistics` | Get Cache Statistics |
| `getOperationsGeocodingConfiguration` | `GET` | `/operations/geocoding/configuration` | Get Geocoding Configuration |
| `getOperationsGeocodingProviders` | `GET` | `/operations/geocoding/providers` | Get Geocoding Provider Status |
| `getOperationStatus` | `GET` | `/operations/{operationId}` | Get Operation Status |
| `getOpsAutonomyPolicy` | `GET` | `/observability/autonomy/policies/{rule}` | Get Ops Autonomy Policy |
| `getOpsAutonomySettings` | `GET` | `/observability/autonomy/settings` | Get Ops Autonomy Settings |
| `getOpsHealthHistory` | `GET` | `/observability/ops-health/history` | Get Ops Health History |
| `getOpsHealthSnapshot` | `GET` | `/observability/ops-health` | Get Ops Health Snapshot |
| `getPlatformLicenseStatus` | `GET` | `/license/status` | Get Platform License Status |
| `getRecentErrors` | `GET` | `/observability/errors` | Get Recent Errors |
| `getTelemetryStatus` | `GET` | `/observability/telemetry` | Get Telemetry Status |
| `getTileCacheInventory` | `GET` | `/tile-operations/cache/inventory` | Inventory Generated Tile Cache |
| `getTileOperationJob` | `GET` | `/tile-operations/jobs/{jobId}` | Get Tile Operation Job Status |
| `invalidateAdminCache` | `POST` | `/cache/invalidate` | Invalidate cached responses by scope |
| `invalidateEnhancedQueryResultCache` | `DELETE` | `/performance/enhanced/cache/invalidate` | Invalidate query-result cache entries |
| `invalidateOperationsCache` | `POST` | `/operations/cache/invalidate` | Invalidate Cache |
| `listActiveOperations` | `GET` | `/operations/active` | List Active Operations |
| `listObservabilityAlerts` | `GET` | `/observability/alerts` | List Observability Alerts |
| `listObservabilityAuditEntries` | `GET` | `/observability/audit` | List Audit Log Entries |
| `listOperateEvents` | `GET` | `/observability/events` | List Operate Events |
| `listOperateLogs` | `GET` | `/observability/logs` | List Recent Server Logs |
| `listOperationProposals` | `GET` | `/proposals` | List Operation Proposals |
| `listOperationsStreamingSubscribers` | `GET` | `/operations/streaming/subscribers` | List Streaming Subscribers |
| `listOpsAutonomyPolicies` | `GET` | `/observability/autonomy/policies` | List Ops Autonomy Policies |
| `listOpsFindings` | `GET` | `/observability/findings` | Get Ops Findings |
| `listTileOperationJobs` | `GET` | `/tile-operations/jobs` | List Tile Operation Jobs |
| `proposeOpsFinding` | `POST` | `/observability/findings/{findingId}/propose` | Propose Ops Finding Action |
| `rejectOperationProposal` | `POST` | `/proposals/{id}/reject` | Reject Operation Proposal |
| `resolveObservabilityAlert` | `POST` | `/observability/alerts/{eventId}/resolve` | Resolve Observability Alert |
| `retryTileOperationJob` | `POST` | `/tile-operations/jobs/{jobId}/retry` | Retry Tile Operation Job |
| `setLicenseCapacitySurgeMode` | `POST` | `/license/capacity/surge` | Set License Surge Mode |
| `setOpsAutonomyPolicy` | `PUT` | `/observability/autonomy/policies/{rule}` | Set Ops Autonomy Policy |
| `setOpsAutonomySettings` | `PUT` | `/observability/autonomy/settings` | Set Ops Autonomy Settings |
| `startTileOperationJob` | `POST` | `/tile-operations/jobs` | Start Tile Operation Job |
| `streamOperationsAlerts` | `GET` | `/operations/streaming/alerts` | Stream Alert Notifications |
| `suppressObservabilityAlert` | `POST` | `/observability/alerts/{eventId}/suppress` | Suppress Observability Alert |
| `uploadLicense` | `POST` | `/license` | Upload License |
| `uploadLicenseFile` | `POST` | `/license/upload` | Upload License File |
| `validateConfigurationSecrets` | `GET` | `/configuration/secrets/validate` | Validate Configuration Secrets |
| `verifyObservabilityAudit` | `GET` | `/observability/audit/verify` | Verify Audit Trail Integrity |
