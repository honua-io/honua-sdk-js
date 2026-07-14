/**
 * Lightweight SourceSchemaV2 envelope checks for generic consumers.
 *
 * This module intentionally does not validate schema contents or recompute the
 * fingerprint. Full validation belongs to the focused `/source-schema`
 * ingestion and cache boundaries. Generic discovery uses this only as a
 * bounded transport-envelope check; it does not establish trusted identity.
 *
 */

export const SOURCE_SCHEMA_V2_KIND = "honua.source-schema" as const;
export const SOURCE_SCHEMA_V2_VERSION = "2.0" as const;

/**
 * Stable, lightweight transport envelope for an opt-in source schema.
 *
 * The generic contract deliberately exposes only identity metadata. Consumers
 * that need fields, geometry, or other schema semantics must enter through the
 * focused `@honua/sdk-js/source-schema` subpath, which validates the complete
 * value and exposes {@link SourceSchemaV2} there.
 */
export interface SourceSchemaV2Envelope {
  readonly kind: typeof SOURCE_SCHEMA_V2_KIND;
  readonly version: typeof SOURCE_SCHEMA_V2_VERSION;
  readonly fingerprint: `sha256:${string}`;
}

const SOURCE_SCHEMA_V2_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export function sourceSchemaV2EnvelopeFingerprint(value: unknown): SourceSchemaV2Envelope["fingerprint"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SourceSchemaV2 must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== SOURCE_SCHEMA_V2_KIND || record.version !== SOURCE_SCHEMA_V2_VERSION) {
    throw new TypeError(`SourceSchemaV2 must use ${SOURCE_SCHEMA_V2_KIND}@${SOURCE_SCHEMA_V2_VERSION}`);
  }
  if (typeof record.fingerprint !== "string" || !SOURCE_SCHEMA_V2_FINGERPRINT.test(record.fingerprint)) {
    throw new TypeError("SourceSchemaV2 fingerprint must be a lowercase SHA-256 digest");
  }
  return record.fingerprint as SourceSchemaV2Envelope["fingerprint"];
}
