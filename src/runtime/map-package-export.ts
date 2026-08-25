/**
 * Portable export / import for the canonical map artifact (honua-sdk-js#1426).
 *
 * `exportMapPackage` turns a {@link HonuaMapPackage} into a self-describing
 * envelope that can cross a client boundary — written to disk by the CLI,
 * returned by an MCP tool, handed to Studio — and `importMapPackage` reads one
 * back. The round trip is the mechanism the issue's "same fixture, every
 * client" acceptance criterion is built on, and it enforces the two properties
 * that make an artifact safe to move at all:
 *
 * 1. **No embedded credentials.** Every string is passed through the SDK's one
 *    credential recognizer (`src/core/credential-redaction.ts`, shared with the
 *    component kit's export pipeline). Property names that read as secrets are
 *    dropped, URLs lose their userinfo and their signature/token query
 *    parameters, and the finished envelope is re-scanned before it is
 *    returned. A scan hit at that point is a hard failure, never a silent
 *    emit. `credentials: "reject"` turns the first layer into a hard failure
 *    too, for callers that want to be told rather than quietly cleaned up.
 * 2. **No unbounded embedded data.** A map artifact is a *description* of
 *    sources, not a container for them. Inline `data:` payloads and inline
 *    GeoJSON bodies are measured and refused above an explicit budget, and the
 *    whole envelope is refused above a second one, so a package cannot become
 *    a de facto dataset that no client can afford to open.
 * 3. **No claim that the map is hosted, saved, or published.** A location
 *    pointer is withheld on export and refused on import, on the envelope as
 *    well as on the package. This exporter deliberately holds *no* lifecycle
 *    information (see below), so it cannot tell an ephemeral preview from an
 *    immutable saved version; an artifact that cannot know it was published
 *    must not carry a URL that says it was. #1426's "preview is never reported
 *    as persisted or published" is therefore enforced by absence, at the
 *    bytes, rather than by a client-minted lifecycle flag that a producer
 *    could set wrongly.
 *
 *    The rule is *name*-directed, not URL-shaped, and has two tiers.
 *    `publicationUrl`, `embedUrl`, `permalink` and their kin assert a
 *    publication whatever owns them, so they are refused at **any depth** —
 *    the wire format is `additionalProperties: true` everywhere, and a claim
 *    hidden under `mapPackage.metadata` is still a claim. The generic relation
 *    names — `links`, `self`, `href`, `url`, `uri` — assert one only at the
 *    **root** of the envelope or of the package, because below that they
 *    belong to whatever owns them: `mapSpec.sources.<id>.url` is a TileJSON
 *    endpoint, `mapSpec.sprite[i].url` is required by the schema,
 *    `locator.url` is where the *data* lives, `attribution[i].url` is a
 *    credit, and `legend[i].iconUrl` is a symbol. None of those says anything
 *    about this map having been saved or published, and all of them survive.
 *
 * The envelope stamps {@link mapPackageFingerprint} so an import can prove the
 * bytes it read are the bytes that were written. That fingerprint is a
 * transport integrity check and nothing more: it is deliberately NOT an
 * identity, a version, or a content-addressed name. Stable identity, content
 * hash, optimistic concurrency, and the map lifecycle (ephemeral preview →
 * draft → immutable saved version → proposal → publication) belong to the
 * canonical honua-server composition contract and reach the SDK through
 * honua-sdk-js#1397 / #1398. Minting them here would make this the eighth
 * competing map representation in a repository that already has seven, which
 * is the problem #1426 exists to end.
 *
 * @module
 */

import {
  type HonuaExportRedaction,
  HonuaExportSafetyError,
  assertCredentialFreeExportBytes,
  assertCredentialFreeExportText,
  containsCredentialMaterial,
  isSensitiveExportKey,
  stripCredentialsFromUrl,
} from "../core/credential-redaction.js";
import { HonuaMapPackageError } from "./errors.js";
import { mapPackageFingerprint } from "./map-package-fetch.js";
import type { HonuaMapPackageDiagnostic } from "./map-package-validation.js";
import { hasMapPackageDiagnosticErrors, validateMapPackage } from "./map-package-validation.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage, type HonuaMapPackageFormat } from "./map-package.js";

/** Envelope kind stamped on every exported map artifact. */
export const HONUA_MAP_PACKAGE_EXPORT_KIND_V1 = "honua.map-package.export.v1" as const;

/** Default per-value budget for inline data. 256 KiB. */
export const DEFAULT_MAX_EMBEDDED_BYTES = 256 * 1024;

/** Default budget for the whole serialized envelope. 4 MiB. */
export const DEFAULT_MAX_PACKAGE_BYTES = 4 * 1024 * 1024;

/**
 * A portable map artifact.
 *
 * Self-describing on purpose: a consumer that has never seen this SDK can read
 * `kind` and `format` and know what it is holding and which contract version
 * governs it.
 */
export interface HonuaMapPackageExport {
  readonly kind: typeof HONUA_MAP_PACKAGE_EXPORT_KIND_V1;
  /** Format of the enclosed package. Always the canonical v1 string. */
  readonly format: HonuaMapPackageFormat;
  /** ISO-8601 instant the envelope was produced. */
  readonly exportedAt: string;
  /**
   * `mapPackageFingerprint` of `mapPackage` exactly as emitted. A transport
   * integrity check — not an identity, a version, or a content address.
   */
  readonly fingerprint: string;
  /** The sanitized package. */
  readonly mapPackage: HonuaMapPackage;
  /** Every value withheld from the export, addressed by path. */
  readonly redactions: readonly HonuaExportRedaction[];
}

export interface ExportMapPackageOptions {
  /**
   * `"strip"` (default) removes credential material and records a redaction.
   * `"reject"` refuses the export instead, for callers who would rather be
   * told their package carries a secret than have it quietly cleaned.
   */
  readonly credentials?: "strip" | "reject";
  /** Per-value inline-data budget in bytes. Defaults to {@link DEFAULT_MAX_EMBEDDED_BYTES}. */
  readonly maxEmbeddedBytes?: number;
  /** Whole-envelope budget in bytes. Defaults to {@link DEFAULT_MAX_PACKAGE_BYTES}. */
  readonly maxPackageBytes?: number;
  /** Timestamp stamped on the envelope. Defaults to now. */
  readonly exportedAt?: string | Date;
  /**
   * Export a package that fails `validateMapPackage`. Off by default: an
   * artifact that does not satisfy its own schema is not portable, and
   * exporting one just moves the failure to whoever imports it.
   */
  readonly allowInvalid?: boolean;
}

export interface ImportMapPackageOptions {
  /** Per-value inline-data budget in bytes. Defaults to {@link DEFAULT_MAX_EMBEDDED_BYTES}. */
  readonly maxEmbeddedBytes?: number;
  /** Whole-envelope budget in bytes. Defaults to {@link DEFAULT_MAX_PACKAGE_BYTES}. */
  readonly maxPackageBytes?: number;
  /**
   * Skip the stamped-fingerprint comparison. Only for callers that knowingly
   * rewrote the package after export; the default is to fail closed.
   */
  readonly skipFingerprintCheck?: boolean;
  /** Accept a package that fails `validateMapPackage`. Off by default. */
  readonly allowInvalid?: boolean;
}

export interface ImportMapPackageResult {
  readonly mapPackage: HonuaMapPackage;
  /** Recomputed fingerprint of the imported package. */
  readonly fingerprint: string;
  /** Redactions recorded by the exporter, carried through for auditability. */
  readonly redactions: readonly HonuaExportRedaction[];
  /** Diagnostics from re-validating the imported package. */
  readonly diagnostics: readonly HonuaMapPackageDiagnostic[];
}

/**
 * Produces a portable, credential-free, size-bounded envelope for `pkg`.
 *
 * Throws {@link HonuaMapPackageError} when the package is invalid or exceeds a
 * data budget, and {@link HonuaExportSafetyError} when credential material
 * survives sanitization (or is present at all under `credentials: "reject"`).
 */
export function exportMapPackage(pkg: HonuaMapPackage, options: ExportMapPackageOptions = {}): HonuaMapPackageExport {
  const packageId = typeof pkg?.mapPackageId === "string" ? pkg.mapPackageId : undefined;
  const maxEmbeddedBytes = normalizeBudget(options.maxEmbeddedBytes, DEFAULT_MAX_EMBEDDED_BYTES);
  const maxPackageBytes = normalizeBudget(options.maxPackageBytes, DEFAULT_MAX_PACKAGE_BYTES);
  const rejectCredentials = options.credentials === "reject";

  if (options.allowInvalid !== true) {
    const validation = validateMapPackage(pkg);
    if (hasMapPackageDiagnosticErrors(validation.diagnostics)) {
      throw new HonuaMapPackageError("MapPackage does not validate; refusing to export a non-portable artifact.", {
        packageId,
        stage: "export",
        detail: { diagnostics: validation.diagnostics.filter((d) => d.severity === "error") },
      });
    }
  }

  const redactions: HonuaExportRedaction[] = [];
  const sanitizedOrMarker = sanitizeValue(pkg, "", {
    redactions,
    maxEmbeddedBytes,
    packageId,
    rejectCredentials,
  }) as HonuaMapPackage | undefined;

  if (sanitizedOrMarker === undefined || typeof sanitizedOrMarker !== "object") {
    throw new HonuaMapPackageError("MapPackage did not survive export sanitization.", {
      packageId,
      stage: "export",
      detail: { redactions },
    });
  }

  // Preview honesty (#1426). Runs on the sanitized body so its redactions are
  // addressed by paths that exist in the emitted document.
  const sanitized = withholdPublicationPointers(sanitizedOrMarker, redactions);

  // Sanitization *removes* values, so a package that validated on the way in
  // can be schema-invalid on the way out: a credential-shaped
  // `attribution[0].text` is withheld while its containing object remains, and
  // `text` is required. Validating the pre-sanitization package alone would let
  // the exporter emit an artifact its own `importMapPackage` rejects, which is
  // precisely the "not portable" case the pre-check exists to prevent.
  if (options.allowInvalid !== true) {
    const postSanitization = validateMapPackage(sanitized);
    if (hasMapPackageDiagnosticErrors(postSanitization.diagnostics)) {
      throw new HonuaMapPackageError(
        "Withholding credential material left a MapPackage that no longer satisfies its schema; refusing to export an artifact its own importer would reject.",
        {
          packageId,
          stage: "export",
          detail: {
            diagnostics: postSanitization.diagnostics.filter((d) => d.severity === "error"),
            redactions,
          },
        },
      );
    }
  }

  const exportedAt = normalizeTimestamp(options.exportedAt);
  const envelope: HonuaMapPackageExport = {
    kind: HONUA_MAP_PACKAGE_EXPORT_KIND_V1,
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    exportedAt,
    fingerprint: mapPackageFingerprint(sanitized),
    mapPackage: sanitized,
    redactions,
  };

  const serialized = JSON.stringify(envelope);
  assertWithinPackageBudget(serialized, maxPackageBytes, packageId, "export");
  // Layer two: the finished bytes are re-scanned. Reaching here with credential
  // material means the projection above has a bug, and failing closed is the
  // only honest response.
  assertCredentialFreeExportText(scrubDataUriPayloads(serialized), "Exported MapPackage");
  return envelope;
}

/**
 * Reads an envelope produced by {@link exportMapPackage} back into a package.
 *
 * Re-applies all three guarantees rather than trusting the envelope: the file
 * may have been hand-edited, produced by an older exporter, or supplied by
 * someone else entirely. A credential-bearing, over-budget, or
 * publication-asserting envelope is refused.
 */
export function importMapPackage(value: unknown, options: ImportMapPackageOptions = {}): ImportMapPackageResult {
  if (!isRecord(value)) {
    throw new HonuaMapPackageError("MapPackage export must be a JSON object.", { stage: "import" });
  }
  if (value.kind !== HONUA_MAP_PACKAGE_EXPORT_KIND_V1) {
    throw new HonuaMapPackageError(`MapPackage export kind must be "${HONUA_MAP_PACKAGE_EXPORT_KIND_V1}".`, {
      stage: "import",
      detail: { expected: HONUA_MAP_PACKAGE_EXPORT_KIND_V1, received: value.kind },
    });
  }
  if (value.format !== HONUA_MAP_PACKAGE_FORMAT_V1) {
    throw new HonuaMapPackageError(`MapPackage export format must be "${HONUA_MAP_PACKAGE_FORMAT_V1}".`, {
      stage: "import",
      detail: { expected: HONUA_MAP_PACKAGE_FORMAT_V1, received: value.format },
    });
  }
  if (!isRecord(value.mapPackage)) {
    throw new HonuaMapPackageError("MapPackage export is missing its mapPackage body.", { stage: "import" });
  }

  const mapPackage = value.mapPackage as unknown as HonuaMapPackage;
  const packageId = typeof mapPackage.mapPackageId === "string" ? mapPackage.mapPackageId : undefined;
  const maxEmbeddedBytes = normalizeBudget(options.maxEmbeddedBytes, DEFAULT_MAX_EMBEDDED_BYTES);
  const maxPackageBytes = normalizeBudget(options.maxPackageBytes, DEFAULT_MAX_PACKAGE_BYTES);

  const serialized = JSON.stringify(value);
  assertWithinPackageBudget(serialized, maxPackageBytes, packageId, "import");
  assertNoPublicationPointers(value, packageId);
  // The deep walk, not the shallow one: the top-level `mapPackage` object has
  // no `data`/`features` key of its own, so the shallow check passed an inline
  // body the exporter refuses. Both guards are load-bearing and independent --
  // one refuses a forged publication claim, the other an oversized payload.
  assertEmbeddedDataWithinBudgetDeep(mapPackage, "mapPackage", maxEmbeddedBytes, packageId);
  assertCredentialFreeExportText(scrubDataUriPayloads(serialized), "Imported MapPackage");

  const fingerprint = mapPackageFingerprint(mapPackage);
  if (options.skipFingerprintCheck !== true) {
    // A missing stamp is a failed integrity check, not an absent one.
    // `fingerprint` is required by `HonuaMapPackageExport`, so an envelope
    // without one was truncated, hand-edited, or written by something that is
    // not this exporter — and treating that as "nothing to compare" let a
    // mutated body through simply by deleting the field that would have caught
    // it. Callers that knowingly rewrote the package pass `skipFingerprintCheck`.
    if (typeof value.fingerprint !== "string" || value.fingerprint.length === 0) {
      throw new HonuaMapPackageError(
        "MapPackage export is missing its fingerprint stamp; pass skipFingerprintCheck to accept an unstamped envelope.",
        {
          packageId,
          stage: "import",
          detail: { stamped: value.fingerprint, recomputed: fingerprint },
        },
      );
    }
    if (value.fingerprint !== fingerprint) {
      throw new HonuaMapPackageError("MapPackage export fingerprint does not match its body.", {
        packageId,
        stage: "import",
        detail: { stamped: value.fingerprint, recomputed: fingerprint },
      });
    }
  }

  const validation = validateMapPackage(mapPackage);
  if (options.allowInvalid !== true && hasMapPackageDiagnosticErrors(validation.diagnostics)) {
    throw new HonuaMapPackageError("Imported MapPackage does not validate.", {
      packageId,
      stage: "import",
      detail: { diagnostics: validation.diagnostics.filter((d) => d.severity === "error") },
    });
  }

  return {
    mapPackage,
    fingerprint,
    redactions: Array.isArray(value.redactions) ? (value.redactions as HonuaExportRedaction[]) : [],
    diagnostics: validation.diagnostics,
  };
}

// ── preview honesty ──────────────────────────────────────────────────────

/**
 * Property names that assert a *publication of the artifact* wherever they
 * appear.
 *
 * These words have exactly one meaning: here is where this thing is hosted,
 * published, shared, or embedded. No part of a map *description* needs one —
 * not a source, not a sprite, not a legend swatch — so they are refused at any
 * depth, inside any container the open wire format permits. That is what
 * closes `mapPackage.metadata.publicationUrl` and every variation on it.
 */
const PUBLICATION_POINTER_KEYS_ANYWHERE: ReadonlySet<string> = new Set([
  "publicationurl",
  "publishedurl",
  "publishurl",
  "publicurl",
  "portalurl",
  "itemurl",
  "viewerurl",
  "shareurl",
  "embedurl",
  "permalink",
  "weburl",
  "selflink",
]);

/**
 * Generic relation names that assert a publication *only at the root of the
 * thing they describe*.
 *
 * `url` is the clearest case: at the root of a package it means "this map is
 * at ...", but `mapSpec.sources.<id>.url` is a TileJSON endpoint,
 * `mapSpec.sprite[i].url` is required by the schema, `locator.url` is where the
 * *data* lives, and `attribution[i].url` is a credit link. Position, not
 * spelling, is what makes these a claim about the artifact, so they are refused
 * at the package root and at the envelope root and left alone below.
 *
 * The consequence is deliberate: a generic pointer buried in an open container
 * (`widgets[i].config.links`) is not refused, because at that depth it belongs
 * to whatever owns it. Refusing it there would reject legitimate artifacts on
 * the strength of a word rather than a claim, and the names that *are* a claim
 * on their own are already handled above.
 */
const PUBLICATION_POINTER_KEYS_AT_ROOT: ReadonlySet<string> = new Set(["links", "link", "self", "href", "url", "uri"]);

/**
 * Comparison form: case-insensitive and separator-insensitive, so
 * `publicationUrl`, `publication_url`, and `PUBLICATION-URL` are one name.
 */
function publicationPointerName(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

function isPublicationPointerKey(key: string, atRoot: boolean): boolean {
  const name = publicationPointerName(key);
  return PUBLICATION_POINTER_KEYS_ANYWHERE.has(name) || (atRoot && PUBLICATION_POINTER_KEYS_AT_ROOT.has(name));
}

/**
 * Collect the paths of every location pointer in `value`.
 *
 * `atRoot` applies to the properties of `value` itself; everything reached
 * through them is below a root and is judged by the "anywhere" names alone. A
 * withheld subtree is not descended into: the whole claim is going, and naming
 * its interior would only add noise.
 *
 * Safe against cycles by construction at both call sites — the exporter walks a
 * tree `sanitizeValue` has already rebuilt, and the importer walks a value
 * `JSON.stringify` has already survived.
 */
function collectPublicationPointerPaths(value: unknown, path: string, atRoot: boolean, out: string[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectPublicationPointerPaths(value[i], `${path}[${i}]`, false, out);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (isPublicationPointerKey(key, atRoot)) {
      out.push(childPath);
      continue;
    }
    collectPublicationPointerPaths(child, childPath, false, out);
  }
}

/** Rebuild `value` with every location pointer removed. Mirrors the collector. */
function stripPublicationPointers(value: unknown, atRoot: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => stripPublicationPointers(item, false));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isPublicationPointerKey(key, atRoot)) continue;
    out[key] = stripPublicationPointers(child, false);
  }
  return out;
}

/**
 * Rebuild `pkg` without its location pointers, recording each withheld path on
 * `redactions`.
 *
 * Deliberately not routed through {@link ExportMapPackageOptions.credentials}
 * `"reject"`: a publication pointer is not a secret that leaked, it is a claim
 * the artifact is not entitled to make. Dropping it always — rather than
 * refusing the export — keeps a package that a server happened to stamp with a
 * self-link exportable, while making it impossible for those bytes to say the
 * map is published.
 *
 * The exporter withholds exactly what {@link importMapPackage} refuses. That
 * equality is load-bearing: an exporter that emitted an artifact its own
 * importer rejects would not be producing a portable artifact at all, which is
 * the same invariant the post-sanitization validation below exists to keep.
 */
function withholdPublicationPointers(pkg: HonuaMapPackage, redactions: HonuaExportRedaction[]): HonuaMapPackage {
  const withheld: string[] = [];
  collectPublicationPointerPaths(pkg, "", true, withheld);
  if (withheld.length === 0) return pkg;
  for (const path of withheld) redactions.push({ path, reason: "publication-pointer" });
  return stripPublicationPointers(pkg, true) as HonuaMapPackage;
}

/**
 * Refuse an envelope that asserts a publication anywhere.
 *
 * The envelope and the package it carries are each an artifact with its own
 * root, so both get the root treatment; everything below either one is judged
 * by the unambiguous names alone. `exportMapPackage` never emits any of them,
 * so reaching this means the file was hand-edited or written by something else
 * — exactly the case where a reader would otherwise believe a URL that nothing
 * in the artifact can substantiate.
 */
function assertNoPublicationPointers(envelope: Record<string, unknown>, packageId: string | undefined): void {
  const offending: string[] = [];
  // Split so that `mapPackage` is walked as a root in its own right rather
  // than as an ordinary property of the envelope.
  const { mapPackage, ...envelopeRest } = envelope;
  collectPublicationPointerPaths(envelopeRest, "", true, offending);
  collectPublicationPointerPaths(mapPackage, "mapPackage", true, offending);
  if (offending.length === 0) return;
  offending.sort();
  throw new HonuaMapPackageError(
    `MapPackage export carries location pointer(s): ${offending.join(", ")}. A portable map artifact describes a map; it cannot assert where that map is hosted or published, because nothing in it records whether the map was ever persisted.`,
    { packageId, stage: "import", detail: { properties: offending } },
  );
}

// ── sanitization ─────────────────────────────────────────────────────────

interface SanitizeContext {
  readonly redactions: HonuaExportRedaction[];
  readonly maxEmbeddedBytes: number;
  readonly packageId: string | undefined;
  readonly rejectCredentials: boolean;
}

const REDACTED_MARKER = Symbol("honua.export.redacted");

/**
 * Recursively rebuilds `value` without credential material.
 *
 * A rebuild rather than a mutation: the caller's package is never modified,
 * and prototype-polluting keys have no path into the output because only
 * own enumerable string keys are copied onto a null-prototype-free literal.
 */
function sanitizeValue(value: unknown, path: string, ctx: SanitizeContext): unknown {
  // `undefined` is not representable in JSON and is not a withheld value, so
  // it is dropped without a redaction entry — `JSON.stringify` would have
  // dropped it anyway, and recording it would make the audit trail noise.
  if (value === undefined) return REDACTED_MARKER;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value, path, ctx);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = sanitizeValue(value[i], `${path}[${i}]`, ctx);
      // A redacted array element becomes `null` rather than shifting every
      // later index: `sourceBindings[3]` must keep meaning the same binding.
      out.push(item === REDACTED_MARKER ? null : item);
    }
    return out;
  }
  if (typeof value !== "object") {
    // Functions, symbols, bigints: not representable in a portable artifact.
    record(ctx, path, "unsupported-value");
    return REDACTED_MARKER;
  }

  assertEmbeddedDataWithinBudget(value, path, ctx.maxEmbeddedBytes, ctx.packageId, "export");

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      record(ctx, `${path}.${key}`, "unsupported-value");
      continue;
    }
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (isSensitiveExportKey(key)) {
      failOrRecord(ctx, childPath, "sensitive-key", `Property "${key}" names a credential.`);
      continue;
    }
    const sanitizedChild = sanitizeValue(child, childPath, ctx);
    if (sanitizedChild === REDACTED_MARKER) continue;
    out[key] = sanitizedChild;
  }
  return out;
}

function sanitizeString(value: string, path: string, ctx: SanitizeContext): unknown {
  if (value.length === 0) return value;

  if (isDataUri(value)) {
    // Bounded and scanned rather than dropped: an inline sprite or legend icon
    // is legitimate content. The payload is decoded and scanned as bytes,
    // because a token hidden in a data: URI is exactly as disclosed as one in
    // plain text, and scanning the encoded form as *text* either produces a
    // false positive on every base64 icon or misses a percent-escaped secret.
    if (byteLength(value) > ctx.maxEmbeddedBytes) {
      throw new HonuaMapPackageError(
        `Inline data at ${path} exceeds the ${ctx.maxEmbeddedBytes}-byte export budget; a portable map package references data, it does not carry it.`,
        {
          packageId: ctx.packageId,
          stage: "export",
          detail: { path, bytes: byteLength(value), maxEmbeddedBytes: ctx.maxEmbeddedBytes },
        },
      );
    }
    const decoded = decodeDataUri(value);
    if (decoded === undefined) {
      // Unscannable, therefore not provably credential-free. Withholding it is
      // the fail-closed answer; emitting it would rely on a whole-envelope scan
      // that `scrubDataUriPayloads` has already blinded to this value.
      failOrRecord(ctx, path, "unsupported-value", `Inline data at ${path} has an undecodable payload.`);
      return REDACTED_MARKER;
    }
    assertCredentialFreeExportBytes(decoded, `Inline data at ${path}`);
    return value;
  }

  if (looksLikeUrl(value)) {
    const stripped = stripCredentialsFromUrl(value);
    if (stripped.url === undefined) {
      failOrRecord(ctx, path, stripped.reason ?? "credential-pattern", `URL at ${path} cannot be exported safely.`);
      return REDACTED_MARKER;
    }
    if (stripped.reason !== undefined) {
      failOrRecord(ctx, path, stripped.reason, `URL at ${path} carried credential material.`);
    }
    return stripped.url;
  }

  if (containsCredentialMaterial(value)) {
    failOrRecord(ctx, path, "credential-pattern", `Value at ${path} matches a credential shape.`);
    return REDACTED_MARKER;
  }
  return value;
}

function failOrRecord(
  ctx: SanitizeContext,
  path: string,
  reason: HonuaExportRedaction["reason"],
  message: string,
): void {
  if (ctx.rejectCredentials) {
    throw new HonuaExportSafetyError(`${message} Refusing to export (credentials: "reject").`, reason);
  }
  record(ctx, path, reason);
}

function record(ctx: SanitizeContext, path: string, reason: HonuaExportRedaction["reason"]): void {
  ctx.redactions.push({ path, reason });
}

// ── budgets ──────────────────────────────────────────────────────────────

/**
 * Refuses an inline body that has outgrown "a description of a source".
 *
 * The shapes checked are the ones that actually carry bulk in a MapLibre
 * style: a GeoJSON source's inline `data`, and any inline `features` array.
 * Everything else is bounded by the whole-envelope budget.
 */
function assertEmbeddedDataWithinBudget(
  value: object,
  path: string,
  maxEmbeddedBytes: number,
  packageId: string | undefined,
  stage: "export" | "import",
): void {
  const holder = value as Record<string, unknown>;
  for (const key of ["data", "features"]) {
    const inline = holder[key];
    if (inline === undefined || inline === null) continue;
    if (typeof inline === "string" && !isDataUri(inline)) continue;
    if (typeof inline !== "object" && typeof inline !== "string") continue;
    const bytes = jsonByteLength(inline);
    if (bytes <= maxEmbeddedBytes) continue;
    throw new HonuaMapPackageError(
      `Inline data at ${path}.${key} is ${bytes} bytes, over the ${maxEmbeddedBytes}-byte budget; a portable map package references data, it does not carry it.`,
      { packageId, stage, detail: { path: `${path}.${key}`, bytes, maxEmbeddedBytes } },
    );
  }
}

/**
 * The import-side per-value budget: {@link assertEmbeddedDataWithinBudget} at
 * every node, plus the inline `data:` URI ceiling.
 *
 * The export side gets this for free because `sanitizeValue` recurses and
 * checks each object as it descends. Import had no such walk and checked only
 * the top-level `mapPackage` holder — which has no `data` or `features` key of
 * its own, so the per-value budget was a no-op on the *reading* side, the one
 * that actually pays for an oversized payload. An artifact carrying a 3 MiB
 * inline GeoJSON body at `mapSpec.sources.*.data` was refused by the exporter
 * at 256 KiB and accepted verbatim by the importer.
 *
 * Iterative rather than recursive: the input is whatever bytes a caller was
 * handed, and a deeply nested document must fail on the budget rather than on
 * the call stack. The whole-envelope budget is asserted before this runs, so
 * the walk is bounded by that.
 */
function assertEmbeddedDataWithinBudgetDeep(
  root: object,
  rootPath: string,
  maxEmbeddedBytes: number,
  packageId: string | undefined,
): void {
  const stack: Array<[string, unknown]> = [[rootPath, root]];
  while (stack.length > 0) {
    const [path, node] = stack.pop() as [string, unknown];
    if (typeof node === "string") {
      if (isDataUri(node) && byteLength(node) > maxEmbeddedBytes) {
        throw new HonuaMapPackageError(
          `Inline data at ${path} is ${byteLength(node)} bytes, over the ${maxEmbeddedBytes}-byte budget; a portable map package references data, it does not carry it.`,
          {
            packageId,
            stage: "import",
            detail: { path, bytes: byteLength(node), maxEmbeddedBytes },
          },
        );
      }
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      node.forEach((child, index) => stack.push([`${path}[${index}]`, child]));
      continue;
    }
    assertEmbeddedDataWithinBudget(node, path, maxEmbeddedBytes, packageId, "import");
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      stack.push([`${path}.${key}`, child]);
    }
  }
}

function assertWithinPackageBudget(
  serialized: string,
  maxPackageBytes: number,
  packageId: string | undefined,
  stage: "export" | "import",
): void {
  const bytes = byteLength(serialized);
  if (bytes <= maxPackageBytes) return;
  throw new HonuaMapPackageError(`MapPackage export is ${bytes} bytes, over the ${maxPackageBytes}-byte budget.`, {
    packageId,
    stage,
    detail: { bytes, maxPackageBytes },
  });
}

// ── helpers ──────────────────────────────────────────────────────────────

const DATA_URI = /^data:[a-z0-9.+-]{0,128}\/[a-z0-9.+-]{0,128}(?:;[a-z0-9-]{0,64}=[^;,]{0,64})*(?:;base64)?,/i;
const URL_LIKE = /^[a-z][a-z0-9+.-]{1,31}:\/\//i;

function isDataUri(value: string): boolean {
  return DATA_URI.test(value);
}

function looksLikeUrl(value: string): boolean {
  return URL_LIKE.test(value) || value.startsWith("//");
}

/**
 * Decodes the payload of a `data:` URI to the bytes it actually represents.
 *
 * Both encodings are decoded, not just base64. `scrubDataUriPayloads` replaces
 * *every* data-URI payload before the whole-envelope text scan, so a payload
 * this function declines to decode is a payload that nothing scans at all:
 * `data:text/plain,token%3Ds3cr3t` was emitted verbatim, with the percent
 * escape hiding it from the scan that a plain `token=…` would have tripped.
 *
 * `undefined` means "cannot be decoded", never "safe" — a truncated data URI,
 * a malformed percent escape, or invalid base64. The caller withholds those
 * rather than letting an unscannable payload through.
 */
function decodeDataUri(value: string): Uint8Array | undefined {
  const comma = value.indexOf(",");
  if (comma === -1) return undefined;
  const payload = value.slice(comma + 1);
  if (/;base64$/i.test(value.slice(0, comma))) {
    try {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      return undefined;
    }
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    // A malformed percent escape. `decodeURIComponent` is the only decoder the
    // payload claims, so what it refuses cannot be scanned.
    return undefined;
  }
}

/**
 * Replaces `data:` URI payloads with a placeholder before the whole-envelope
 * text scan. The payloads are already bounded and scanned as decoded bytes;
 * scanning base64 as text would report every icon as a high-entropy secret and
 * make the fail-closed assertion useless.
 */
function scrubDataUriPayloads(serialized: string): string {
  return serialized.replace(/data:[a-z0-9.+/;=-]{0,256},[A-Za-z0-9+/=%_-]*/gi, "data:[payload]");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function jsonByteLength(value: unknown): number {
  if (typeof value === "string") return byteLength(value);
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    // Cyclic or otherwise unserializable: treat as unbounded and refuse.
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeBudget(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function normalizeTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
