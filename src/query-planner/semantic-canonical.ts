import { type SourceSchemaV2, parseSourceSchemaV2 } from "../contract/schema.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import type { CanonicalSemanticQueryOptions } from "./semantic-types.js";
import { parseSemanticQuery } from "./semantic.js";
import { HonuaQueryPlanningError } from "./types.js";

export const SEMANTIC_QUERY_CANONICAL_KIND = "honua.semantic-query-canonical" as const;
export const SEMANTIC_QUERY_CANONICAL_VERSION = 1 as const;
export const SEMANTIC_QUERY_HASH_DOMAIN = "honua.semantic-query.hash.v1" as const;

const MAX_IDENTITY_VERSION_BYTES = 4096;
const TEXT_ENCODER = new TextEncoder();

/**
 * Serialize a validated semantic query plus its schema/CRS/policy identity.
 * Object keys are UTF-8 deterministically ordered; array order stays
 * significant. Volatile execution state is not accepted by the semantic AST.
 */
export function serializeCanonicalSemanticQuery(value: unknown, options: CanonicalSemanticQueryOptions = {}): string {
  const schema = verifiedSchema(options.schema);
  const query = parseSemanticQuery(value, {
    ...(schema ? { schema } : {}),
    ...(options.protocol ? { protocol: options.protocol } : {}),
  });
  const identity = {
    schemaFingerprint: schema?.fingerprint ?? null,
    crsVersion: identityVersion(options.crsVersion, "crsVersion"),
    policyVersion: identityVersion(options.policyVersion, "policyVersion"),
    protocol: options.protocol ?? null,
  };
  return canonicalStringify(
    toJsonValue({
      kind: SEMANTIC_QUERY_CANONICAL_KIND,
      version: SEMANTIC_QUERY_CANONICAL_VERSION,
      identity,
      query,
    }),
  );
}

/** Return a fresh UTF-8 byte copy of the canonical semantic-query envelope. */
export function canonicalSemanticQueryBytes(value: unknown, options: CanonicalSemanticQueryOptions = {}): Uint8Array {
  return TEXT_ENCODER.encode(serializeCanonicalSemanticQuery(value, options));
}

/** Domain-separated SHA-256 identity for a canonical semantic query. */
export function hashSemanticQuery(value: unknown, options: CanonicalSemanticQueryOptions = {}): `sha256:${string}` {
  return sha256(`${SEMANTIC_QUERY_HASH_DOMAIN}\n${serializeCanonicalSemanticQuery(value, options)}`);
}

function verifiedSchema(value: SourceSchemaV2 | undefined): SourceSchemaV2 | undefined {
  if (value === undefined) return undefined;
  try {
    return parseSourceSchemaV2(value);
  } catch {
    throw new HonuaQueryPlanningError("invalid-query", "Canonical semantic-query identity requires a valid schema");
  }
}

function identityVersion(value: string | undefined, name: "crsVersion" | "policyVersion"): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new HonuaQueryPlanningError("invalid-query", `${name} must be a non-empty string when supplied`);
  }
  if (TEXT_ENCODER.encode(value).byteLength > MAX_IDENTITY_VERSION_BYTES) {
    throw new HonuaQueryPlanningError("invalid-query", `${name} exceeds the ${MAX_IDENTITY_VERSION_BYTES}-byte bound`);
  }
  return value;
}
