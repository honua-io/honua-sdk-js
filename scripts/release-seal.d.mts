/**
 * Ambient types for scripts/release-seal.mjs.
 *
 * Only the surface TypeScript consumers actually import is declared. The seal
 * itself is plain JS; this exists so a test can assert on the sealed-artifact
 * inventory without falling back to `any`.
 */

/** Derived artifact that stamps the SDK release version, and the field that carries it. */
export interface SealedVersionStamp {
  path: string;
  field: string;
}

export const RELEASE_TAG_PREFIX: string;
export const SEALED_VERSION_STAMPS: readonly SealedVersionStamp[];
