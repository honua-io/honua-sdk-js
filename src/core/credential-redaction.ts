/**
 * Credential-recognition and redaction primitives shared by every Honua export
 * pipeline.
 *
 * These were extracted verbatim from `src/web-components/export-redaction.ts`
 * (issue #683) when the runtime's portable MapPackage export (#1426) needed the
 * same scanner. There must be exactly one credential recognizer in this SDK: a
 * second copy would drift, and the copy that drifts is the one that leaks. The
 * web-components module re-exports every symbol below so its published surface
 * is unchanged, and keeps the app-platform-specific state projection that
 * layers on top of these primitives.
 *
 * This module lives in `src/core` rather than `src/web-components` because
 * `src/runtime` ships in the stable-tier `@honua/sdk` split package while
 * `src/web-components` ships in `@honua/app-platform`; the runtime cannot
 * reach across that boundary (`scripts/prepare-split-packages.mjs`).
 *
 * Deliberately dependency-free apart from the SDK's shared error base: no
 * `node:crypto`, no DOM, no renderer. Safe in a browser, a worker, or an SSR
 * render pass.
 *
 * @module
 */

import { HonuaSdkError } from "./error-envelope.js";

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
 *
 * The `<qualifier>Key` family is enumerated rather than reduced to a bare
 * `key`: `key` alone would refuse `primaryKey`, `layerKey`, `sortKey`, and the
 * MapLibre style spec's own `*-key` properties, and an exporter that withholds
 * a table's primary key is not safer, only broken. The qualifiers listed here
 * have no innocent reading — `adminKey` in particular is the property name this
 * repository's own CLI configuration uses for the root administrator
 * credential (`profiles.<name>.adminKey`), so it must never ride out of an
 * export or a diagnostic bundle.
 */
const SENSITIVE_KEY =
  /(?:api[-_]?key|(?:access|admin|encryption|master|root|signing)[-_]?key|auth|bearer|cookie|credential|cred(?:s)?\b|jwt|nonce|pass(?:word|wd)?|private[-_]?key|pwd|secret|session|sig(?:nature)?|subscription[-_]?key|token)/i;

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
    /\b(access[-_]?key|admin[-_]?key|api[-_]?key|apikey|authorization|client[-_]?secret|cookie|credential|encryption[-_]?key|jwt|key|master[-_]?key|pass(?:password)?|password|pwd|root[-_]?key|se|secret|session|sig|signature|signing[-_]?key|st|subscription[-_]?key|sv|token|x-amz-[a-z-]{1,32}|x-goog-[a-z-]{1,32})\s*[:=]\s*(?:"[^"]{0,512}"|'[^']{0,512}'|[^\s&,;}"']{1,512})/gi,
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

/** Result of removing credential material from a URL while keeping it usable. */
export interface HonuaUrlCredentialStrip {
  /** The URL with credentials removed, or `undefined` when nothing is safe to emit. */
  readonly url: string | undefined;
  readonly reason?: HonuaExportRedactionReason;
}

/**
 * Removes credential material from a URL while leaving the URL *functional*.
 *
 * This is the counterpart to {@link projectExportEndpoint}, not a replacement
 * for it. `projectExportEndpoint` reduces a URL to origin+path for a
 * provenance/attribution block, where the query is never needed and dropping
 * all of it is right by construction. That rule cannot be used on a URL the
 * artifact still has to *fetch*: an OGC WMS `GetMap` request, an Esri
 * `?f=json` endpoint, and a tile template with `?format=pbf` all carry their
 * operation in the query string, and a portable map that lost it would import
 * as a map that no longer renders.
 *
 * So this function removes exactly what is credential-bearing — `user:pass@`
 * userinfo, and query parameters whose *name* reads as a secret or a
 * signature — and then re-scans the remainder, refusing to emit anything that
 * still looks like it carries a token. Non-HTTP(S) schemes are refused
 * outright; `data:` payloads are handled by the caller, which can bound and
 * scan the decoded bytes with {@link assertCredentialFreeExportBytes}.
 */
export function stripCredentialsFromUrl(url: string): HonuaUrlCredentialStrip {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 8192) {
    return { url: undefined, reason: "unsupported-value" };
  }

  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    // Relative or template locator: no host, so no userinfo, but it can still
    // carry a query string. Filter the query the same way and keep the rest.
    const hashIndex = trimmed.indexOf("#");
    const withoutHash = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
    const queryIndex = withoutHash.indexOf("?");
    const pathPart = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
    const queryPart = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);
    const { query, dropped } = filterCredentialQuery(queryPart);
    const rebuilt = query.length > 0 ? `${pathPart}?${query}` : pathPart;
    if (rebuilt.length === 0 || containsCredentialMaterial(rebuilt)) {
      return { url: undefined, reason: "credential-pattern" };
    }
    // Nothing was dropped: return the caller's exact string rather than a
    // reassembled one, so a safe URL round-trips byte-for-byte.
    return dropped ? { url: rebuilt, reason: "signed-url" } : { url: trimmed };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: undefined, reason: "unsupported-value" };
  }

  let dropped = false;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    parsed.username = "";
    parsed.password = "";
    dropped = true;
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SIGNED_QUERY_NAME.test(name) || SENSITIVE_KEY.test(name)) {
      parsed.searchParams.delete(name);
      dropped = true;
    }
  }

  // `URL` percent-encodes `{`/`}`, which would break a MapLibre tile template
  // (`{z}/{x}/{y}`, `{bbox-epsg-3857}`). Restore them; they are structural, not
  // credential material.
  const rebuilt = parsed.toString().replace(/%7B/g, "{").replace(/%7D/g, "}");
  if (containsCredentialMaterial(rebuilt)) {
    return { url: undefined, reason: "credential-pattern" };
  }
  // Nothing was dropped: return the caller's exact string. `URL.toString()`
  // normalizes (a bare origin gains a trailing `/`, reserved characters are
  // re-encoded), and a portable artifact should not have its endpoints
  // rewritten when there was nothing to remove.
  return dropped ? { url: rebuilt, reason: "signed-url" } : { url: trimmed };
}

function filterCredentialQuery(query: string): { query: string; dropped: boolean } {
  if (query.length === 0) return { query: "", dropped: false };
  const kept: string[] = [];
  let dropped = false;
  for (const pair of query.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (SIGNED_QUERY_NAME.test(name) || SENSITIVE_KEY.test(name)) {
      dropped = true;
      continue;
    }
    kept.push(pair);
  }
  return { query: kept.join("&"), dropped };
}

// ── header + key allowlists ──────────────────────────────────────────────

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
