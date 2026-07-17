/**
 * `@honua/sdk-js/cog` — bounded direct COG inspection, reads, and rendering.
 *
 * This experimental subpath accepts only evidence-classified static STAC COG
 * candidates. A caller injects a structurally typed decoder; Honua supplies
 * its only byte reader and enforces partial HTTP ranges, transfer ceilings,
 * cancellation, lifecycle cleanup, deterministic provenance evidence, and an
 * opt-in caller-owned MapLibre image-source bridge. There is deliberately no
 * root-barrel export or default GeoTIFF/MapLibre dependency.
 *
 * @experimental
 * @module
 */

export { HonuaCogError, type HonuaCogErrorCode } from "./errors.js";
export { DEFAULT_COG_TRANSFER_LIMITS, normalizeCogTransferLimits } from "./range-transport.js";
export {
  DEFAULT_COG_MAPLIBRE_RENDER_LIMITS,
  HonuaCogMapLibreError,
  mountStacCogAssetToMapLibre,
} from "./maplibre.js";
export type {
  CogMapLibreBandMapping,
  CogMapLibreBoundsLike,
  CogMapLibreCanvasLike,
  CogMapLibreCoordinates,
  CogMapLibreDiagnostic,
  CogMapLibreDiagnosticCode,
  CogMapLibreErrorCode,
  CogMapLibreImageSourceLike,
  CogMapLibreRenderEvidence,
  CogMapLibreRenderLimitOptions,
  CogMapLibreSnapshot,
  CogMapLibreState,
  CogMapLibreViewport,
  MountedStacCogAssetToMapLibre,
  MountStacCogAssetToMapLibreOptions,
  StacCogAssetToMapLibreMap,
} from "./maplibre.js";
export { StacCogAssetSession, openStacCogAsset } from "./session.js";
export type {
  CogBand,
  CogBandWindow,
  CogByteRangeRequest,
  CogCrs,
  CogDataType,
  CogDecodedBandWindow,
  CogDecodedCrs,
  CogDecodedMetadata,
  CogDecodedWindow,
  CogDecoder,
  CogDecoderFactory,
  CogDecoderFactoryContext,
  CogDecoderInspectContext,
  CogDecoderReadContext,
  CogFootprint,
  CogInspection,
  CogKnownCrs,
  CogNoDataValue,
  CogOperationOptions,
  CogPolygonCoordinates,
  CogPosition,
  CogProvenance,
  CogRangePurpose,
  CogRangeReader,
  CogRangeRecord,
  CogResolution,
  CogResampling,
  CogSampleArray,
  CogStacProvenance,
  CogTransferLedger,
  CogTransferLimitOptions,
  CogTransferLimits,
  CogUnsupportedCrs,
  CogWindowRequest,
  CogWindowResult,
  CogWindowSampling,
  OpenStacCogAssetOptions,
} from "./types.js";
