/**
 * `@honua/sdk-js/pmtiles` - direct archive registration and Honua-managed PMTiles lifecycle.
 *
 * Direct archive discovery remains supported and server-optional. Archive and
 * publish jobs require a compatible Honua Server and remain experimental.
 *
 * @experimental
 * @module
 */

export {
  HonuaPmtilesJob,
  HonuaPmtilesLifecycle,
  HonuaPmtilesLifecycleError,
  PMTILES_LIFECYCLE_CAPABILITIES,
  assertPmtilesManualCleanupSupported,
  createHonuaPmtilesLifecycle,
  isPmtilesJobTerminal,
  pmtilesCleanupDisposition,
  registerPmtilesSource,
  requirePmtilesJobSuccess,
} from "./lifecycle.js";
export type {
  CreateHonuaPmtilesLifecycleOptions,
  HonuaPmtilesLifecycleErrorCode,
  PmtilesCleanupDisposition,
  PmtilesJobCancellation,
  PmtilesJobOperation,
  PmtilesJobProgress,
  PmtilesJobRequest,
  PmtilesJobStartReceipt,
  PmtilesJobStatus,
  PmtilesJobWaitOptions,
  PmtilesLifecycleCapabilityState,
  PmtilesProgressListener,
  PmtilesPublishedArtifact,
  PmtilesRendererSourceDescriptor,
  PmtilesRequestOptions,
  PmtilesSourceMaturity,
  PmtilesStorageProvider,
  PmtilesUrlStrategy,
  RegisterPmtilesSourceOptions,
} from "./lifecycle.js";
