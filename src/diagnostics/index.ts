/**
 * Schema-pinned, support-safe diagnostic bundle emission and bounded read replay.
 *
 * @experimental
 * @packageDocumentation
 */

export {
  DIAGNOSTIC_DEFAULT_PREVIEW_BYTES,
  DIAGNOSTIC_MAX_BODY_BYTES,
  DIAGNOSTIC_MAX_ENVELOPES,
  DIAGNOSTIC_MAX_PREVIEW_BYTES,
  HonuaDiagnosticSafetyError,
  createDiagnosticBundle,
  normalizeDiagnosticPath,
  sanitizeDiagnosticBody,
  sanitizeDiagnosticExchange,
  sanitizeDiagnosticHeaders,
} from "./sanitize.js";
export {
  DIAGNOSTIC_SCHEMA_BYTES,
  DIAGNOSTIC_SCHEMA_SHA256,
  DIAGNOSTIC_SCHEMA_SOURCE_COMMIT,
  DIAGNOSTIC_SCHEMA_URL,
  assertDiagnosticBundle,
  validateDiagnosticBundle,
  verifyDiagnosticSchemaBytes,
} from "./schema.js";
export { replayDiagnosticBundle } from "./replay.js";
export type {
  CreateDiagnosticBundleOptions,
  DiagnosticBodyPreview,
  DiagnosticBundleV1,
  DiagnosticConsent,
  DiagnosticContentClassification,
  DiagnosticEnvelope,
  DiagnosticExchangeInput,
  DiagnosticHeader,
  DiagnosticReplayOptions,
  DiagnosticValidationIssue,
  DiagnosticValidationResult,
} from "./types.js";
