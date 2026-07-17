/**
 * `@honua/sdk-js/cog` — bounded direct COG inspection and pixel-window reads.
 *
 * This experimental subpath accepts only evidence-classified static STAC COG
 * candidates. A caller injects a structurally typed decoder; Honua supplies
 * its only byte reader and enforces partial HTTP ranges, transfer ceilings,
 * cancellation, lifecycle cleanup, and deterministic provenance evidence.
 * There is deliberately no root-barrel export or default GeoTIFF dependency.
 *
 * @experimental
 * @module
 */

export { HonuaCogError, type HonuaCogErrorCode } from "./errors.js";
export { DEFAULT_COG_TRANSFER_LIMITS, normalizeCogTransferLimits } from "./range-transport.js";
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
  CogSampleArray,
  CogStacProvenance,
  CogTransferLedger,
  CogTransferLimitOptions,
  CogTransferLimits,
  CogUnsupportedCrs,
  CogWindowRequest,
  CogWindowResult,
  OpenStacCogAssetOptions,
} from "./types.js";
