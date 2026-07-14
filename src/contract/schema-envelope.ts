/**
 * Lightweight SourceSchemaV2 envelope checks for generic consumers.
 *
 * This module intentionally does not validate schema contents or recompute the
 * fingerprint. Full validation belongs to the focused `/source-schema`
 * ingestion and cache boundaries. Generic discovery uses this only as a
 * bounded transport-envelope check; it does not establish trusted identity.
 *
 * @internal
 */

export const SOURCE_SCHEMA_V2_KIND = "honua.source-schema" as const;
export const SOURCE_SCHEMA_V2_VERSION = "2.0" as const;

const SOURCE_SCHEMA_V2_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export function sourceSchemaV2EnvelopeFingerprint(value: unknown): `sha256:${string}` {
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
  return record.fingerprint as `sha256:${string}`;
}
