/**
 * Canonical claimed/observed/effective source capability profiles.
 *
 * Adapters validate and cache a static {@link CapabilityEvidenceProfile} once,
 * then call {@link evaluateCapabilityProfile} with fresh dynamic context before
 * execution. The evaluator is intentionally separated from heavy CRS and
 * PROJJSON ingestion so named imports remain lightweight.
 *
 * @experimental
 * @module
 */

export {
  createCapabilityEvidenceProfile,
  parseCapabilityEvidenceProfile,
  serializeCapabilityEvidenceProfile,
  verifyCapabilityEvidenceProfileSource,
} from "./source-capability-evidence.js";
export { createCapabilitySourceEndpointFingerprint } from "./source-capability-endpoint.js";
export { evaluateCapabilityProfile } from "./source-capability-evaluation.js";
export { parseCapabilityProfile, serializeCapabilityProfile } from "./source-capability-transport.js";
export * from "./source-capability-types.js";
