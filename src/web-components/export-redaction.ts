/**
 * Credential-safe redaction primitives for the Honua component kit's export
 * pipeline (issue #683, parent epic #678 "app-platform component production
 * readiness"; REQ-002).
 *
 * The export pipeline is **redact-by-default in two independent layers**, and
 * both layers run on every export regardless of who supplied the state:
 *
 * 1. **Allowlist projection.** {@link sanitizeHonuaExportState} never walks a
 *    caller's state object generically. It projects a fixed, enumerated set of
 *    presentation fields (viewport, layer identity/visibility/opacity, legend
 *    labels, filter text, selection identity, source identity + attribution)
 *    into a new object. Anything the projection does not name — arbitrary
 *    `metadata` bags, request headers, credential stores, feature attributes,
 *    locator query strings — simply has no path into the output. New fields
 *    added to `HonuaWebComponentState` upstream are therefore *excluded* until
 *    somebody deliberately allowlists them, which is the safe default
 *    direction for a security boundary.
 * 2. **Outbound scrub + assertion.** Every string that survives projection is
 *    passed through {@link redactHonuaExportText}, URLs are reduced to
 *    origin+path, and the finished payload is re-scanned by
 *    {@link assertCredentialFreeExportText}. A scan hit is a *hard failure*
 *    (`HonuaExportSafetyError`), not a silent scrub — a leak that reaches the
 *    assertion means the projection has a bug, and failing closed is the only
 *    honest response.
 *
 * The same primitives are applied to filenames ({@link
 * sanitizeHonuaExportFilename}) and to every human-readable message the export
 * pipeline puts on an event or a log line ({@link redactHonuaExportText}),
 * because REQ-002 covers "exported bytes, serialized state, logs, events, or
 * filenames" — a token leaked through a download filename or an error string
 * is exactly as disclosed as one leaked through the payload.
 *
 * This module is deliberately dependency-free apart from the SDK's shared
 * error base: no `node:crypto` (unlike `src/diagnostics/sanitize.ts`, which is
 * a Node-side bundle helper), no DOM, no renderer, no localization framework.
 * It is safe to import in a browser, a worker, or an SSR render pass, and
 * carries no weight that NFR-001 forbids in the component bundles.
 *
 * @module
 */

import { HonuaSdkError } from "../core/error-envelope.js";
import type { HonuaMapPackage, HonuaMapPackageSourceBinding } from "../runtime/index.js";
import type {
  HonuaFilterState,
  HonuaLayerModel,
  HonuaLegendItem,
  HonuaSelectionState,
  HonuaViewportState,
  HonuaWebComponentState,
} from "./types.js";

/** Schema id stamped on every sanitized state document. */
export const HONUA_EXPORT_STATE_SCHEMA = "honua.app-platform.export-state.v1";

/** Placeholder substituted for any value the export pipeline refuses to emit. */
export const HONUA_EXPORT_REDACTED = "[REDACTED]";

/** Why a value was withheld from an export. */
export type HonuaExportRedactionReason =
  /** The property name itself named a credential (`token`, `apiKey`, `cookie`, ...). */
  | "sensitive-key"
  /** A URL carried a signature, SAS, or token query parameter, or embedded userinfo. */
  | "signed-url"
  /** A free-text value matched a credential shape (bearer token, JWT, provider key, ...). */
  | "credential-pattern"
  /** A request-header map was dropped because it is not on the export allowlist. */
  | "private-header"
  /** OAuth/authorization scope, audience, tenant, or grant detail. */
  | "authorization-scope"
  /** A source explicitly marked as not exportable by the plan or the source itself. */
  | "non-exportable-source"
  /** A value could not be represented safely (unserializable, cyclic, over budget). */
  | "unsupported-value";

/** One withheld value, addressed by its path in the sanitized document. */
export interface HonuaExportRedaction {
  /** Dotted/bracketed path in the *sanitized* document, e.g. `sources[0].endpoint`. */
  readonly path: string;
  readonly reason: HonuaExportRedactionReason;
}

/** Thrown when the export pipeline cannot produce a provably credential-free artifact. */
export class HonuaExportSafetyError extends HonuaSdkError {
  public readonly reason: HonuaExportRedactionReason | "assertion";

  public constructor(message: string, reason: HonuaExportRedactionReason | "assertion" = "assertion") {
    super("app.export-unsafe", message);
    this.name = "HonuaExportSafetyError";
    this.reason = reason;
  }
}

// ── credential recognition ───────────────────────────────────────────────

/**
 * Property names that are never exported, whatever their value. Matched
 * case-insensitively against the whole key (substring match), so `apiKey`,
 * `X-API-KEY`, `refresh_token`, and `sessionCookie` are all caught.
 */
const SENSITIVE_KEY =
  /(?:api[-_]?key|auth|bearer|cookie|credential|cred(?:s)?\b|jwt|nonce|pass(?:word|wd)?|private[-_]?key|pwd|secret|session|sig(?:nature)?|subscription[-_]?key|token)/i;

/** Property names that leak *authorization scope* rather than the secret itself. */
const AUTHORIZATION_SCOPE_KEY =
  /(?:^|[-_.])(?:scope|scopes|audience|aud|tenant|tenant[-_]?id|client[-_]?id|grant|grant[-_]?type|roles|permissions|principal|subject|assume[-_]?role)(?:$|[-_.])/i;

/** Query-parameter names that make a URL a *signed* URL (presigned S3/GCS/SAS/Esri/CDN). */
const SIGNED_QUERY_NAME =
  /(?:^|[-_])(?:sig|signature|token|access[-_]?token|id[-_]?token|refresh[-_]?token|api[-_]?key|apikey|key|subscription[-_]?key|code|password|pwd|auth|jwt|hmac|policy|credential|se|sp|sv|st|srt|ss|skoid|sktid|sig)(?:$|[-_])/i;

/**
 * Free-text credential shapes. Every pattern is a linear scan over bounded
 * character classes — no nested quantifiers, no backtracking traps (the repo's
 * CodeQL ReDoS rule).
 */
const CREDENTIAL_PATTERNS: readonly [RegExp, string][] = [
  [/\b(?:Bearer|Basic|Digest|Negotiate)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED_AUTH]"],
  // `scheme://user:password@host` — basic-auth credentials embedded in a URL.
  // `projectExportEndpoint` refuses these structurally, but a URL can also reach
  // an export through an adapter's free-text error message, so the text scan has
  // to recognize the same shape.
  [/\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/@:]{1,128}:[^\s/@]{1,128}@/gi, "[REDACTED_URL_CREDENTIALS]@"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED_JWT]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_PROVIDER_TOKEN]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED_PROVIDER_TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{10,}/g, "[REDACTED_PROVIDER_TOKEN]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/gi, "[REDACTED_PROVIDER_TOKEN]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/gi, "[REDACTED_PROVIDER_TOKEN]"],
  [/\bsk-[A-Za-z0-9]{16,}/g, "[REDACTED_PROVIDER_TOKEN]"],
  // Labelled `name=value` / `name: value` pairs. The name alternation covers
  // the short, provider-specific parameter names real signed URLs use — Azure
  // SAS `sig`/`sv`/`se`/`st`, AWS/GCS `x-amz-signature`/`x-goog-signature`, and
  // the bare `key` that tile providers favour — because those values are
  // frequently *short* (a 24-character SAS signature is common) and so slip
  // under any entropy heuristic. `\b` before each name keeps `turnkey=` and
  // `monkey=` from matching.
  [
    /\b(access[-_]?key|api[-_]?key|apikey|authorization|client[-_]?secret|cookie|credential|jwt|key|pass(?:password)?|password|pwd|se|secret|session|sig|signature|st|subscription[-_]?key|sv|token|x-amz-[a-z-]{1,32}|x-goog-[a-z-]{1,32})\s*[:=]\s*(?:"[^"]{0,512}"|'[^']{0,512}'|[^\s&,;}"']{1,512})/gi,
    `$1=${HONUA_EXPORT_REDACTED}`,
  ],
];

/**
 * High-entropy blob heuristic, applied last so labelled matches win first.
 *
 * Deliberately excludes `/` and `-` from the character class. Including them
 * made ordinary URL paths match — `arcgis/rest/services/Roads/FeatureServer/0`
 * is 41 characters of `[A-Za-z0-9/]` and was being reported as a secret, which
 * would have thrown away the endpoint an attribution block legitimately needs.
 * Base64 blobs containing `/` still get caught: in practice they appear as a
 * labelled parameter value or an `Authorization` header, both of which the
 * patterns above match first.
 */
const OPAQUE_SECRET = /\b[A-Za-z0-9_+=]{40,}\b/g;

function decodePercentEncoding(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    if (!decoded.includes("%")) break;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

/**
 * Redacts credential material from arbitrary human-readable text: adapter
 * error messages, titles, status strings, log lines, event detail messages.
 *
 * Percent-encoded payloads are decoded (twice, bounded) before matching so a
 * `%42earer%20abc` style evasion cannot slip a token past the scan; the
 * returned string is the redacted *decoded* form when decoding changed
 * anything, because emitting the still-encoded original would defeat the
 * point.
 */
export function redactHonuaExportText(value: string): string {
  if (value.length === 0) return value;
  let redacted = decodePercentEncoding(value);
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.replace(OPAQUE_SECRET, "[REDACTED_TOKEN]");
}

/** Whether `value` still looks like it carries credential material. */
export function containsCredentialMaterial(value: string): boolean {
  return redactHonuaExportText(value) !== decodePercentEncoding(value);
}

/**
 * Fail-closed assertion for finished export payloads (REQ-002). Throws
 * {@link HonuaExportSafetyError} rather than scrubbing, because reaching this
 * point with credential material means an earlier layer is broken.
 */
export function assertCredentialFreeExportText(value: string, label: string): void {
  if (containsCredentialMaterial(value)) {
    throw new HonuaExportSafetyError(
      `${label} still contains credential material after redaction; refusing to emit the export.`,
      "assertion",
    );
  }
}

// ── binary artifact scanning ─────────────────────────────────────────────

/** Shortest printable run worth scanning. Below this it is structural noise, not text. */
const MIN_PRINTABLE_RUN = 4;

/** Printable text accumulated before a chunk is scanned and flushed. */
const PRINTABLE_CHUNK_BYTES = 1 << 20;

/**
 * Characters carried between chunks so a token straddling a flush boundary is
 * still matched. Comfortably longer than the longest pattern this module has.
 */
const PRINTABLE_CHUNK_OVERLAP = 512;

/**
 * Extracts runs of printable ASCII from a binary buffer, joined by newlines.
 *
 * This is the `strings(1)` idea, and it exists because "binary" is not a
 * security boundary. A PNG `tEXt`/`iTXt` chunk, a JPEG `COM` marker, PDF
 * metadata or an embedded XMP packet, an EXIF `UserComment`, a ZIP comment —
 * all carry plainly readable text inside a buffer that will never decode as
 * UTF-8 as a whole. Scanning only whole-buffer-decodable artifacts would let a
 * token ride out inside any of them.
 *
 * Runs shorter than {@link MIN_PRINTABLE_RUN} are dropped: they are the
 * incidental byte values that fall in the ASCII range inside compressed data,
 * and keeping them would produce noise without ever forming a credential.
 */
export function extractPrintableRuns(bytes: Uint8Array, start = 0, end = bytes.byteLength): string {
  const runs: string[] = [];
  let current = "";
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index];
    // Printable ASCII plus tab. Deliberately not the full latin-1 upper range:
    // every credential shape this module recognizes is ASCII, and admitting
    // 0x80-0xFF would turn arbitrary compressed data into "text".
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= MIN_PRINTABLE_RUN) runs.push(current);
    current = "";
  }
  if (current.length >= MIN_PRINTABLE_RUN) runs.push(current);
  return runs.join("\n");
}

/**
 * Fail-closed credential scan over a binary artifact (REQ-002).
 *
 * Scans in bounded chunks with an overlap, so an arbitrarily large artifact
 * costs bounded memory while a token that straddles a chunk boundary is still
 * caught. Throws {@link HonuaExportSafetyError} on a hit, like the text scan —
 * a credential surviving to this point means an earlier layer is broken, and
 * emitting the bytes anyway is the one outcome that cannot be walked back.
 */
export function assertCredentialFreeExportBytes(bytes: Uint8Array, label: string): void {
  let carry = "";
  for (let offset = 0; offset < bytes.byteLength; offset += PRINTABLE_CHUNK_BYTES) {
    const end = Math.min(bytes.byteLength, offset + PRINTABLE_CHUNK_BYTES);
    const printable = extractPrintableRuns(bytes, offset, end);
    if (printable.length === 0 && carry.length === 0) continue;
    assertCredentialFreeExportText(`${carry}${printable}`, label);
    carry = printable.slice(-PRINTABLE_CHUNK_OVERLAP);
  }
}

// ── URL handling ─────────────────────────────────────────────────────────

/** Result of reducing an endpoint URL to its exportable form. */
export interface HonuaExportEndpointProjection {
  /** `scheme://host[:port]/path` with query, fragment, and userinfo removed, or `undefined` when nothing is safe to emit. */
  readonly endpoint: string | undefined;
  readonly reason?: HonuaExportRedactionReason;
}

/**
 * Reduces a source URL to `origin + pathname`, always dropping the query
 * string and fragment.
 *
 * Query strings are where every practical map-service credential lives (Esri
 * `?token=`, Azure SAS `?sv=...&sig=`, S3/GCS presigned `?X-Amz-Signature=`,
 * tile-provider `?api_key=`), and a partial per-parameter allowlist has to be
 * right about every provider forever. Dropping the whole query is the only
 * rule that is right by construction; the origin+path that remains is what an
 * attribution/provenance block legitimately needs.
 *
 * Non-HTTP(S) schemes (`data:`, `blob:`, `file:`), URLs with embedded
 * `user:password@` userinfo, and unparseable strings yield no endpoint at all.
 */
export function projectExportEndpoint(url: string): HonuaExportEndpointProjection {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) {
    return { endpoint: undefined, reason: "unsupported-value" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Relative locators carry no host and therefore no credential context, but
    // they can still carry a query string; keep only the path portion.
    const [path] = trimmed.split(/[?#]/, 1);
    if (path.length === 0 || containsCredentialMaterial(path)) {
      return { endpoint: undefined, reason: "credential-pattern" };
    }
    return path === trimmed ? { endpoint: path } : { endpoint: path, reason: "signed-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { endpoint: undefined, reason: "unsupported-value" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { endpoint: undefined, reason: "signed-url" };
  }
  const hadSecretQuery = [...parsed.searchParams.keys()].some(
    (name) => SIGNED_QUERY_NAME.test(name) || SENSITIVE_KEY.test(name),
  );
  const endpoint = `${parsed.origin}${parsed.pathname}`;
  if (containsCredentialMaterial(endpoint)) {
    return { endpoint: undefined, reason: "credential-pattern" };
  }
  const droppedSomething = parsed.search.length > 0 || parsed.hash.length > 0;
  if (hadSecretQuery) return { endpoint, reason: "signed-url" };
  return droppedSomething ? { endpoint, reason: "unsupported-value" } : { endpoint };
}

// ── filenames ────────────────────────────────────────────────────────────

const FILENAME_FALLBACK = "honua-export";
const FILENAME_MAX_LENGTH = 96;

/** Extension chosen for a media type; unknown types get no extension. */
const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": "json",
  "application/geo+json": "geojson",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "text/html": "html",
  "text/plain": "txt",
};

export interface SanitizeHonuaExportFilenameOptions {
  /** Caller-supplied title (map title, package id, adapter hint). May be untrusted. */
  readonly title?: string;
  /** Media type used to pick the extension. */
  readonly mediaType?: string;
  /** Stable prefix, defaults to `honua`. */
  readonly prefix?: string;
}

/**
 * Produces a download filename that cannot disclose a credential (REQ-002
 * "…or filenames").
 *
 * A title that matches any credential shape is **discarded wholesale** rather
 * than partially redacted: emitting `map-REDACTED_TOKEN-tiles.png` still tells
 * an observer that a token was present and can preserve unmatched prefixes of
 * it. The result is always confined to `[A-Za-z0-9._-]`, never begins with a
 * dot, contains no path separators, and is length-bounded.
 */
export function sanitizeHonuaExportFilename(options: SanitizeHonuaExportFilenameOptions = {}): string {
  const prefix = slugifyFilenamePart(options.prefix ?? "honua") || "honua";
  const rawTitle = options.title ?? "";
  const titleSlug = containsCredentialMaterial(rawTitle) ? "" : slugifyFilenamePart(rawTitle);
  const stem = (titleSlug.length > 0 ? `${prefix}-${titleSlug}` : FILENAME_FALLBACK).slice(0, FILENAME_MAX_LENGTH);
  const extension = MEDIA_TYPE_EXTENSIONS[(options.mediaType ?? "").split(";", 1)[0].trim().toLowerCase()];
  const filename = extension ? `${stem}.${extension}` : stem;
  assertCredentialFreeExportText(filename, "Export filename");
  return filename;
}

function slugifyFilenamePart(value: string): string {
  let slug = "";
  let pendingSeparator = false;
  for (const character of value.slice(0, 512)) {
    const code = character.charCodeAt(0);
    const safe =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === "." ||
      character === "_";
    if (safe && !(character === "." && slug.length === 0)) {
      if (pendingSeparator && slug.length > 0) slug += "-";
      pendingSeparator = false;
      slug += character;
      continue;
    }
    pendingSeparator = slug.length > 0;
  }
  return slug.slice(0, FILENAME_MAX_LENGTH);
}

// ── sanitized state document ─────────────────────────────────────────────

/** Exportable projection of one layer. */
export interface HonuaSanitizedExportLayer {
  readonly id: string;
  readonly title: string;
  readonly visible: boolean;
  readonly opacity?: number;
  readonly sourceId?: string;
  readonly type?: string;
}

/** Exportable projection of one legend entry. */
export interface HonuaSanitizedExportLegendItem {
  readonly id: string;
  readonly label: string;
  readonly color?: string;
  readonly layerId?: string;
}

/** Exportable projection of one bound source: identity and attribution only. */
export interface HonuaSanitizedExportSource {
  readonly sourceId: string;
  readonly protocol?: string;
  /** `scheme://host[:port]/path` — never a query string. Omitted when nothing was safe. */
  readonly endpoint?: string;
  readonly attribution?: string;
  /** `true` when the source was withheld entirely (see `redactions`). */
  readonly omitted?: boolean;
}

/** Exportable projection of the active filter for one source. */
export interface HonuaSanitizedExportFilter {
  readonly sourceId?: string;
  readonly text?: string;
  readonly expression?: string;
}

/** Exportable projection of the current selection: identity, never attributes. */
export interface HonuaSanitizedExportSelection {
  readonly sourceId?: string;
  readonly sourceLayer?: string;
  readonly featureId?: string | number;
}

/**
 * The credential-free state document an export emits. Deliberately a *new*
 * shape rather than a `Partial<HonuaWebComponentState>`: an export document is
 * a published artifact with its own compatibility story, and reusing the
 * live-state type would silently widen the export whenever the live state
 * grows a field.
 */
export interface HonuaSanitizedExportState {
  readonly schema: typeof HONUA_EXPORT_STATE_SCHEMA;
  readonly packageId?: string;
  readonly viewport?: HonuaViewportState;
  readonly layers: readonly HonuaSanitizedExportLayer[];
  readonly legend: readonly HonuaSanitizedExportLegendItem[];
  readonly sources: readonly HonuaSanitizedExportSource[];
  readonly filters: readonly HonuaSanitizedExportFilter[];
  readonly selection?: HonuaSanitizedExportSelection;
  /** Data-freshness timestamp carried through from controller state (REQ-003). */
  readonly refreshedAt?: string;
  readonly stale?: boolean;
  /** Every value withheld from this document, with the reason. */
  readonly redactions: readonly HonuaExportRedaction[];
}

export interface SanitizeHonuaExportStateOptions {
  /**
   * Sources the accepted plan or the source itself marks non-exportable. Their
   * identity is preserved as `{ sourceId, omitted: true }` — an export that
   * silently dropped a layer would misrepresent the map — but no endpoint,
   * attribution, or filter detail is emitted, and every layer bound to them is
   * withheld too.
   */
  readonly nonExportableSourceIds?: readonly string[];
}

export interface HonuaExportStateSanitizationResult {
  readonly state: HonuaSanitizedExportState;
  readonly redactions: readonly HonuaExportRedaction[];
}

/** Binding metadata keys that mark a source non-exportable. */
const NON_EXPORTABLE_METADATA_KEYS = ["honua:exportable", "exportable"];

function isNonExportableBinding(binding: HonuaMapPackageSourceBinding): boolean {
  const metadata = binding.metadata;
  if (!metadata) return false;
  for (const key of NON_EXPORTABLE_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && ["false", "no", "0", "off"].includes(value.trim().toLowerCase())) return true;
  }
  const explicit = metadata["honua:export"] ?? metadata.export;
  return typeof explicit === "string" && explicit.trim().toLowerCase() === "forbidden";
}

/** Redacts a short label-ish string, recording a redaction when it changed. */
function projectText(
  value: string | undefined,
  path: string,
  redactions: HonuaExportRedaction[],
  reason: HonuaExportRedactionReason = "credential-pattern",
): string | undefined {
  if (value === undefined) return undefined;
  const redacted = redactHonuaExportText(value);
  if (redacted !== value) redactions.push({ path, reason });
  const bounded = redacted.slice(0, 512);
  return bounded.length > 0 ? bounded : undefined;
}

function projectViewport(viewport: HonuaViewportState | undefined): HonuaViewportState | undefined {
  if (!viewport) return undefined;
  const projected: {
    bbox?: readonly [number, number, number, number];
    center?: readonly [number, number];
    zoom?: number;
    pitch?: number;
    bearing?: number;
  } = {};
  const bbox = viewport.bbox;
  const center = viewport.center;
  if (bbox?.every((value) => Number.isFinite(value))) projected.bbox = [...bbox];
  if (center?.every((value) => Number.isFinite(value))) projected.center = [center[0], center[1]];
  for (const key of ["zoom", "pitch", "bearing"] as const) {
    const value = viewport[key];
    if (Number.isFinite(value)) projected[key] = Number(value);
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectSources(
  mapPackage: HonuaMapPackage | undefined,
  nonExportable: ReadonlySet<string>,
  redactions: HonuaExportRedaction[],
): HonuaSanitizedExportSource[] {
  const bindings = mapPackage?.sourceBindings ?? [];
  const sources: HonuaSanitizedExportSource[] = [];
  for (const [index, binding] of bindings.entries()) {
    const path = `sources[${index}]`;
    const sourceId = projectText(binding.sourceId, `${path}.sourceId`, redactions) ?? `source-${index}`;
    if (nonExportable.has(binding.sourceId) || isNonExportableBinding(binding)) {
      redactions.push({ path, reason: "non-exportable-source" });
      sources.push({ sourceId, omitted: true });
      continue;
    }
    const source: {
      sourceId: string;
      protocol?: string;
      endpoint?: string;
      attribution?: string;
    } = { sourceId };
    const protocol = projectText(
      typeof binding.protocol === "string" ? binding.protocol : undefined,
      `${path}.protocol`,
      redactions,
    );
    if (protocol) source.protocol = protocol;
    const rawUrl = typeof binding.locator?.url === "string" ? binding.locator.url : undefined;
    if (rawUrl) {
      const projection = projectExportEndpoint(rawUrl);
      if (projection.reason) redactions.push({ path: `${path}.endpoint`, reason: projection.reason });
      if (projection.endpoint) source.endpoint = projection.endpoint;
    }
    // `binding.metadata` and every other locator field are intentionally not
    // projected: they are free-form round-trip bags that routinely carry
    // service keys, and an export has no need for them.
    if (binding.metadata && Object.keys(binding.metadata).length > 0) {
      redactions.push({ path: `${path}.metadata`, reason: "private-header" });
    }
    const attribution = projectText(binding.attribution, `${path}.attribution`, redactions);
    if (attribution) source.attribution = attribution;
    sources.push(source);
  }
  return sources;
}

function projectLayers(
  layers: readonly HonuaLayerModel[],
  omittedSourceIds: ReadonlySet<string>,
  redactions: HonuaExportRedaction[],
): HonuaSanitizedExportLayer[] {
  const projected: HonuaSanitizedExportLayer[] = [];
  for (const [index, layer] of layers.entries()) {
    const path = `layers[${index}]`;
    if (layer.sourceId && omittedSourceIds.has(layer.sourceId)) {
      redactions.push({ path, reason: "non-exportable-source" });
      continue;
    }
    const entry: {
      id: string;
      title: string;
      visible: boolean;
      opacity?: number;
      sourceId?: string;
      type?: string;
    } = {
      id: projectText(layer.id, `${path}.id`, redactions) ?? `layer-${index}`,
      title: projectText(layer.title, `${path}.title`, redactions) ?? "",
      visible: layer.visible === true,
    };
    if (Number.isFinite(layer.opacity)) entry.opacity = Number(layer.opacity);
    const sourceId = projectText(layer.sourceId, `${path}.sourceId`, redactions);
    if (sourceId) entry.sourceId = sourceId;
    const type = projectText(layer.type, `${path}.type`, redactions);
    if (type) entry.type = type;
    // `layer.metadata` is an untyped bag; never projected.
    if (layer.metadata && Object.keys(layer.metadata).length > 0) {
      redactions.push({ path: `${path}.metadata`, reason: "private-header" });
    }
    projected.push(entry);
  }
  return projected;
}

function projectLegend(
  legend: readonly HonuaLegendItem[],
  redactions: HonuaExportRedaction[],
): HonuaSanitizedExportLegendItem[] {
  return legend.map((item, index) => {
    const path = `legend[${index}]`;
    const entry: { id: string; label: string; color?: string; layerId?: string } = {
      id: projectText(item.id, `${path}.id`, redactions) ?? `legend-${index}`,
      label: projectText(item.label, `${path}.label`, redactions) ?? "",
    };
    const color = projectText(item.color, `${path}.color`, redactions);
    if (color) entry.color = color;
    const layerId = projectText(item.layerId, `${path}.layerId`, redactions);
    if (layerId) entry.layerId = layerId;
    // `iconUrl` is deliberately dropped: legend icons are routinely signed
    // service URLs, and an export document has no way to re-sign them.
    if (item.iconUrl) redactions.push({ path: `${path}.iconUrl`, reason: "signed-url" });
    return entry;
  });
}

function projectFilters(
  filters: Readonly<Record<string, HonuaFilterState>> | undefined,
  omittedSourceIds: ReadonlySet<string>,
  redactions: HonuaExportRedaction[],
): HonuaSanitizedExportFilter[] {
  if (!filters) return [];
  const projected: HonuaSanitizedExportFilter[] = [];
  for (const [key, filter] of Object.entries(filters)) {
    if (!filter) continue;
    const path = `filters[${key}]`;
    const sourceId = projectText(filter.sourceId ?? key, `${path}.sourceId`, redactions);
    if (sourceId && omittedSourceIds.has(sourceId)) {
      redactions.push({ path, reason: "non-exportable-source" });
      continue;
    }
    const entry: { sourceId?: string; text?: string; expression?: string } = {};
    if (sourceId) entry.sourceId = sourceId;
    const text = projectText(filter.text, `${path}.text`, redactions);
    if (text) entry.text = text;
    const expression = projectText(filter.expression, `${path}.expression`, redactions);
    if (expression) entry.expression = expression;
    if (Object.keys(entry).length > 0) projected.push(entry);
  }
  return projected;
}

function projectSelection(
  selection: HonuaSelectionState<unknown> | undefined,
  redactions: HonuaExportRedaction[],
): HonuaSanitizedExportSelection | undefined {
  if (!selection) return undefined;
  const entry: { sourceId?: string; sourceLayer?: string; featureId?: string | number } = {};
  const sourceId = projectText(selection.sourceId, "selection.sourceId", redactions);
  if (sourceId) entry.sourceId = sourceId;
  const sourceLayer = projectText(selection.sourceLayer, "selection.sourceLayer", redactions);
  if (sourceLayer) entry.sourceLayer = sourceLayer;
  const featureId = selection.featureId;
  if (typeof featureId === "number" && Number.isFinite(featureId)) entry.featureId = featureId;
  else if (typeof featureId === "string") {
    const projectedId = projectText(featureId, "selection.featureId", redactions);
    if (projectedId) entry.featureId = projectedId;
  }
  // `selection.feature` (full attributes + geometry) is never projected: an
  // export of the *view state* has no business carrying customer records.
  if (selection.feature) redactions.push({ path: "selection.feature", reason: "unsupported-value" });
  return Object.keys(entry).length > 0 ? entry : undefined;
}

function projectTimestamp(value: unknown, path: string, redactions: HonuaExportRedaction[]): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    redactions.push({ path, reason: "unsupported-value" });
    return undefined;
  }
  return value;
}

/**
 * Projects live component state into the credential-free export document
 * (REQ-002). Never throws for hostile input — hostile values are withheld and
 * recorded — but the finished document is asserted credential-free by
 * {@link assertCredentialFreeExportText} in the export runner before any byte
 * reaches a caller.
 */
export function sanitizeHonuaExportState(
  state: HonuaWebComponentState<unknown> | undefined,
  options: SanitizeHonuaExportStateOptions = {},
): HonuaExportStateSanitizationResult {
  const redactions: HonuaExportRedaction[] = [];
  const nonExportable = new Set(options.nonExportableSourceIds ?? []);
  const sources = projectSources(state?.mapPackage, nonExportable, redactions);
  const omittedSourceIds = new Set(sources.filter((source) => source.omitted).map((source) => source.sourceId));
  const document: {
    schema: typeof HONUA_EXPORT_STATE_SCHEMA;
    packageId?: string;
    viewport?: HonuaViewportState;
    layers: readonly HonuaSanitizedExportLayer[];
    legend: readonly HonuaSanitizedExportLegendItem[];
    sources: readonly HonuaSanitizedExportSource[];
    filters: readonly HonuaSanitizedExportFilter[];
    selection?: HonuaSanitizedExportSelection;
    refreshedAt?: string;
    stale?: boolean;
    redactions: readonly HonuaExportRedaction[];
  } = {
    schema: HONUA_EXPORT_STATE_SCHEMA,
    layers: projectLayers(state?.layers ?? [], omittedSourceIds, redactions),
    legend: projectLegend(state?.legend ?? [], redactions),
    sources,
    filters: projectFilters(state?.filters, omittedSourceIds, redactions),
    redactions,
  };
  const packageId = projectText(state?.packageId, "packageId", redactions);
  if (packageId) document.packageId = packageId;
  const viewport = projectViewport(state?.viewport);
  if (viewport) document.viewport = viewport;
  const selection = projectSelection(state?.selection, redactions);
  if (selection) document.selection = selection;
  const refreshedAt = projectTimestamp(state?.refreshedAt, "refreshedAt", redactions);
  if (refreshedAt) document.refreshedAt = refreshedAt;
  if (typeof state?.stale === "boolean") document.stale = state.stale;
  return { state: document as HonuaSanitizedExportState, redactions };
}

/**
 * Header allowlist for adapters that make their own requests while producing an
 * export (a server-side renderer, a tile fetch for a print layout). Everything
 * outside this set is a private header for export purposes (REQ-002).
 */
const EXPORTABLE_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"]);

/**
 * Filters a header map down to the export allowlist, recording every drop.
 * Exposed so adapters can prove — in their own tests — that no `Authorization`,
 * `Cookie`, or provider-specific key header rides along with export metadata.
 */
export function sanitizeHonuaExportHeaders(headers: Readonly<Record<string, string>> | undefined): {
  headers: Readonly<Record<string, string>>;
  redactions: readonly HonuaExportRedaction[];
} {
  const redactions: HonuaExportRedaction[] = [];
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!EXPORTABLE_HEADERS.has(name)) {
      redactions.push({
        path: `headers[${name}]`,
        reason: SENSITIVE_KEY.test(name) || AUTHORIZATION_SCOPE_KEY.test(name) ? "sensitive-key" : "private-header",
      });
      continue;
    }
    const value = redactHonuaExportText(rawValue);
    if (value !== rawValue) {
      redactions.push({ path: `headers[${name}]`, reason: "credential-pattern" });
      continue;
    }
    output[name] = value.slice(0, 512);
  }
  return { headers: output, redactions };
}

/** Whether a property name is refused outright by the export pipeline. */
export function isSensitiveExportKey(name: string): boolean {
  return SENSITIVE_KEY.test(name) || AUTHORIZATION_SCOPE_KEY.test(name);
}
