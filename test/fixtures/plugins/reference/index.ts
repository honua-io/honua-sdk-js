/**
 * Minimal external-style reference plugins for every declared Honua plugin
 * kind. Each module is a tiny, certifiable, tested implementation that is not
 * imported by SDK core; together with `../external-style.ts` they cover all
 * nine `HONUA_PLUGIN_KINDS`. See `docs/plugin-manifest-certification.md`.
 */

export { REFERENCE_HOST, REFERENCE_ORIGIN, REFERENCE_CREDENTIAL_SCOPE } from "./shared.js";
export { referenceProtocolManifest, referenceProtocolPlugin } from "./protocol.js";
export type { ReferenceProtocolExtension } from "./protocol.js";
export { referenceSourceFormatManifest, referenceSourceFormatPlugin } from "./source-format.js";
export type { ReferenceSourceFormatExtension } from "./source-format.js";
export { referenceRendererManifest, referenceRendererPlugin } from "./renderer.js";
export type { ReferenceDrawCommand, ReferenceRendererExtension } from "./renderer.js";
export { referenceAuthManifest, referenceAuthPlugin } from "./auth.js";
export type { ReferenceAuthExtension } from "./auth.js";
export { referenceGeocoderManifest, referenceGeocoderPlugin } from "./geocoder-routing.js";
export type { ReferenceGeocoderExtension, ReferenceLngLat } from "./geocoder-routing.js";
export { referenceAnalysisManifest, referenceAnalysisPlugin } from "./analysis.js";
export type { ReferenceAnalysisExtension } from "./analysis.js";
export { referenceCacheManifest, referenceCachePlugin } from "./cache.js";
export type { ReferenceCacheExtension } from "./cache.js";
export { referenceRealtimeManifest, referenceRealtimePlugin } from "./realtime.js";
export type { ReferenceRealtimeExtension } from "./realtime.js";
export {
  REFERENCE_CONFORMANCE_MAX_ATTEMPTS,
  referenceConformanceManifest,
  referenceConformancePlugin,
  referenceConformanceProbe,
  referenceConformanceSpec,
} from "./conformance.js";
export type { ReferenceRetryingProtocolExtension } from "./conformance.js";
