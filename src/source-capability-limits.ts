/** Full static cache/transport envelope bound. */
export const CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS = {
  depth: 49,
  nodes: 65_536,
  bytes: 2 * 1_024 * 1_024,
} as const;

/**
 * Caller-supplied entries reserve fixed capacity for the source-bound static
 * envelope, so every accepted creation result can pass the full-envelope cap.
 */
export const CAPABILITY_EVIDENCE_ENTRIES_JSON_LIMITS = {
  depth: CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.depth - 1,
  nodes: CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.nodes - 16,
  bytes: CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.bytes - 4 * 1_024,
} as const;

/** Bounds for dynamic policy, runtime, peer, and authorization input. */
export const CAPABILITY_EVALUATION_CONTEXT_JSON_LIMITS = {
  depth: 8,
  nodes: 8_192,
  bytes: 512 * 1_024,
} as const;

/**
 * Evaluated transport contains the static projection once, a reason projection
 * that can repeat bounded identifiers, and the normalized dynamic context.
 *
 * - nodes: the proven maximum is below 140,576; three static envelopes retain
 *   explicit headroom for reason arrays and normalized context
 * - bytes: static envelope + context + repeated identifiers/reasons is bounded
 *   below 6.5 MiB; four static envelopes provide a round 8 MiB ceiling
 */
export const CAPABILITY_EVALUATED_PROFILE_JSON_LIMITS = {
  depth: CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.depth + 1,
  nodes: CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.nodes * 3,
  bytes: CAPABILITY_EVIDENCE_PROFILE_JSON_LIMITS.bytes * 4,
} as const;
