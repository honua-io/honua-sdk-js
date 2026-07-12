import { createHash } from "node:crypto";

import { assertDiagnosticBundle } from "./schema.js";
import type {
  CreateDiagnosticBundleOptions,
  DiagnosticBodyPreview,
  DiagnosticBundleV1,
  DiagnosticContentClassification,
  DiagnosticEnvelope,
  DiagnosticExchangeInput,
  DiagnosticHeader,
} from "./types.js";

export const DIAGNOSTIC_MAX_BODY_BYTES = 25 * 1024 * 1024;
export const DIAGNOSTIC_MAX_ENVELOPES = 50;
export const DIAGNOSTIC_DEFAULT_PREVIEW_BYTES = 4096;
export const DIAGNOSTIC_MAX_PREVIEW_BYTES = 8192;

const CLASSIFICATIONS = new Set<DiagnosticContentClassification>([
  "unknown",
  "public",
  "internal",
  "customer-data",
  "secret-suspected",
]);

const SAFE_HEADERS = new Set([
  "accept",
  "content-length",
  "content-type",
  "traceparent",
  "x-correlation-id",
  "x-request-id",
]);

const SENSITIVE_NAME =
  /(?:api[-_]?key|authorization|cookie|credential|jwt|pass(?:word)?|proxy[-_]?authorization|secret|session|set[-_]?cookie|sig(?:nature)?|token)/i;

const SAFE_PATH_SEGMENTS = new Set([
  "api",
  "capabilities",
  "collections",
  "conformance",
  "features",
  "featureserver",
  "health",
  "healthz",
  "items",
  "layers",
  "mapserver",
  "maps",
  "ogc",
  "query",
  "readiness",
  "ready",
  "records",
  "search",
  "services",
  "stac",
  "tiles",
  "v1",
  "v2",
]);

const SAFE_QUERY_NAMES = new Set([
  "bbox",
  "collections",
  "datetime",
  "f",
  "fields",
  "filter",
  "format",
  "limit",
  "offset",
  "outfields",
  "q",
  "resultoffset",
  "resultrecordcount",
  "where",
]);

export class HonuaDiagnosticSafetyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HonuaDiagnosticSafetyError";
    this.code = code;
  }
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function decodeForRedaction(input: string): string {
  let value = input;
  for (let pass = 0; pass < 2 && /%[0-9a-f]{2}/i.test(value); pass += 1) {
    try {
      value = decodeURIComponent(value);
    } catch {
      break;
    }
  }
  return value;
}

function redactText(input: string): string {
  return decodeForRedaction(input)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_AUTH]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bsk_[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED_PROVIDER_TOKEN]")
    .replace(/\bghp_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_PROVIDER_TOKEN]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/gi, "[REDACTED_PROVIDER_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_PROVIDER_TOKEN]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, "[REDACTED_PROVIDER_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_PROVIDER_TOKEN]")
    .replace(/\bglpat-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_PROVIDER_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(
      /\b(access[-_]?key|api[-_]?key|authorization|aws[-_]?secret[-_]?access[-_]?key|bearer|client[-_]?secret|cookie|credential|pass(?:word)?|proxy[-_]?authorization|pwd|secret|session|set[-_]?cookie|signature|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;}]*)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b[A-Za-z0-9_+/=]{32,}\b/g, "[REDACTED_TOKEN]");
}

function redactStructured(value: unknown, budget = { nodes: 0 }, depth = 0): unknown {
  budget.nodes += 1;
  if (budget.nodes > 4096 || depth > 16) return "[REDACTED_COMPLEX_VALUE]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => redactStructured(item, budget, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 256)) {
    output[key] = SENSITIVE_NAME.test(key) ? "[REDACTED]" : redactStructured(child, budget, depth + 1);
  }
  return output;
}

function bytesForBody(body: unknown): Uint8Array | undefined {
  if (body === undefined) return undefined;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === "string") return new TextEncoder().encode(body);
  try {
    return new TextEncoder().encode(JSON.stringify(body));
  } catch {
    throw new HonuaDiagnosticSafetyError("unserializable-body", "Diagnostic body input must be serializable data.");
  }
}

function contentTypeIs(headers: DiagnosticExchangeInput["requestHeaders"], mediaType: string | undefined): string {
  if (mediaType) return mediaType.toLowerCase();
  if (headers instanceof Headers) return (headers.get("content-type") ?? "").toLowerCase();
  if (headers) {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
    const value = entry?.[1];
    if (typeof value === "string") return value.toLowerCase();
    if (Array.isArray(value)) return (value[0] ?? "").toLowerCase();
  }
  return "";
}

function sanitizeForm(text: string): string {
  const form = new URLSearchParams(text);
  const sanitized = new URLSearchParams();
  for (const [name, value] of form) {
    sanitized.append(name, SENSITIVE_NAME.test(name) ? "[REDACTED]" : redactText(value));
  }
  return sanitized.toString();
}

export function sanitizeDiagnosticBody(
  body: unknown,
  options: { mediaType?: string; previewBytes?: number } = {},
): DiagnosticBodyPreview | undefined {
  const bytes = bytesForBody(body);
  if (!bytes) return undefined;
  if (bytes.byteLength > DIAGNOSTIC_MAX_BODY_BYTES) {
    throw new HonuaDiagnosticSafetyError("body-over-budget", "Diagnostic body exceeds the 25 MiB intake ceiling.");
  }
  const previewBytes = Math.min(
    DIAGNOSTIC_MAX_PREVIEW_BYTES,
    Math.max(1, Math.trunc(options.previewBytes ?? DIAGNOSTIC_DEFAULT_PREVIEW_BYTES)),
  );
  const scanned = bytes.slice(0, Math.min(bytes.byteLength, previewBytes * 8));
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(scanned);
  } catch {
    return {
      preview: "[BINARY_BODY_OMITTED]",
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      originalByteSize: bytes.byteLength,
      redactionApplied: true,
      truncated: true,
    };
  }

  const mediaType = (options.mediaType ?? "").toLowerCase();
  let sanitized = decoded;
  if (mediaType.includes("json") || /^[\s\r\n]*[{[]/.test(decoded)) {
    try {
      sanitized = JSON.stringify(redactStructured(JSON.parse(decoded)));
    } catch {
      sanitized = redactText(decoded);
    }
  } else if (mediaType.includes("application/x-www-form-urlencoded")) {
    sanitized = sanitizeForm(decoded);
  } else {
    sanitized = redactText(decoded);
  }

  const sanitizedBytes = new TextEncoder().encode(sanitized);
  const bounded = sanitizedBytes.slice(0, previewBytes);
  const preview = new TextDecoder().decode(bounded);
  return {
    preview,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    originalByteSize: bytes.byteLength,
    redactionApplied: sanitized !== decoded,
    truncated: bytes.byteLength > previewBytes || sanitizedBytes.byteLength > previewBytes,
  };
}

function normalizeSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new HonuaDiagnosticSafetyError("unsafe-path", "Diagnostic URL contains invalid path encoding.");
  }
  if (decoded === "." || decoded === ".." || decoded.includes("\\") || hasUnsafeControl(decoded)) {
    throw new HonuaDiagnosticSafetyError("unsafe-path", "Diagnostic URL contains an unsafe path segment.");
  }
  return SAFE_PATH_SEGMENTS.has(decoded.toLowerCase()) ? encodeURIComponent(decoded) : "{value}";
}

export function normalizeDiagnosticPath(input: string): string {
  if (
    input.length > 8192 ||
    input.includes("\\") ||
    hasUnsafeControl(input) ||
    /(?:^|\/)(?:(?:%2e|\.){1,2})(?:\/|$)/i.test(input.split(/[?#]/, 1)[0])
  ) {
    throw new HonuaDiagnosticSafetyError("unsafe-url", "Diagnostic URL is malformed or over budget.");
  }
  let url: URL;
  try {
    url = new URL(input, "https://diagnostic.invalid");
  } catch {
    throw new HonuaDiagnosticSafetyError("unsafe-url", "Diagnostic URL is malformed.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new HonuaDiagnosticSafetyError("unsafe-url", "Diagnostic URL must use HTTP or HTTPS.");
  }
  const path = `/${url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(normalizeSegment)
    .join("/")}`;
  const query = [...url.searchParams]
    .filter(([name]) => !SENSITIVE_NAME.test(name))
    .map(([name]) => `${SAFE_QUERY_NAMES.has(name.toLowerCase()) ? encodeURIComponent(name) : "{parameter}"}={value}`)
    .sort();
  return query.length > 0 ? `${path}?${query.join("&")}` : path;
}

function headerEntries(headers: DiagnosticExchangeInput["requestHeaders"]): Array<[string, string]> {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") entries.push([name, value]);
    else if (Array.isArray(value)) for (const item of value) entries.push([name, item]);
  }
  return entries;
}

export function sanitizeDiagnosticHeaders(headers: DiagnosticExchangeInput["requestHeaders"]): DiagnosticHeader[] {
  const output: DiagnosticHeader[] = [];
  for (const [rawName, rawValue] of headerEntries(headers)) {
    const name = rawName.toLowerCase();
    if (!SAFE_HEADERS.has(name) || SENSITIVE_NAME.test(name)) continue;
    if (rawName.length > 128 || rawValue.length > 2048) {
      throw new HonuaDiagnosticSafetyError(
        "header-over-budget",
        "Allowlisted diagnostic header exceeds schema limits.",
      );
    }
    if (output.length >= 32) {
      throw new HonuaDiagnosticSafetyError("header-over-budget", "Diagnostic header count exceeds the schema limit.");
    }
    let value = redactText(rawValue).slice(0, 2048);
    if (name === "content-type") value = value.split(";", 1)[0].trim().toLowerCase();
    if (name === "content-length" && !/^\d{1,12}$/.test(value)) value = "[REDACTED_UNSAFE_VALUE]";
    if (name === "traceparent" && !/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i.test(value)) {
      value = "[REDACTED_UNSAFE_VALUE]";
    }
    if (name === "accept" && !/^[a-z0-9!#$&*+.^_`|~\s,;=/.-]{1,512}$/i.test(value)) {
      value = "[REDACTED_UNSAFE_VALUE]";
    }
    output.push({ name, value });
  }
  return output.sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
}

export function sanitizeDiagnosticExchange(
  input: DiagnosticExchangeInput,
  previewBytes = DIAGNOSTIC_DEFAULT_PREVIEW_BYTES,
): DiagnosticEnvelope {
  const method = input.method.trim().toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) {
    throw new HonuaDiagnosticSafetyError("invalid-method", "Diagnostic exchange method is invalid.");
  }
  const requestHeaders = sanitizeDiagnosticHeaders(input.requestHeaders);
  const responseHeaders = sanitizeDiagnosticHeaders(input.responseHeaders);
  const requestMediaType = contentTypeIs(input.requestHeaders, undefined);
  const responseMediaType = contentTypeIs(input.responseHeaders, input.mediaType);
  if (input.capturedAt && Number.isNaN(Date.parse(input.capturedAt))) {
    throw new HonuaDiagnosticSafetyError("invalid-captured-at", "Diagnostic capturedAt must be an ISO date-time.");
  }
  const mediaType = input.mediaType?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType && mediaType.length > 256) {
    throw new HonuaDiagnosticSafetyError("media-type-over-budget", "Diagnostic media type exceeds the schema limit.");
  }
  if (input.correlationId && input.correlationId.length > 200) {
    throw new HonuaDiagnosticSafetyError(
      "correlation-over-budget",
      "Diagnostic correlation id exceeds the schema limit.",
    );
  }
  if (input.traceId && input.traceId.length > 200) {
    throw new HonuaDiagnosticSafetyError("trace-over-budget", "Diagnostic trace id exceeds the schema limit.");
  }
  if (input.capturedAt && input.capturedAt.length > 40) {
    throw new HonuaDiagnosticSafetyError("captured-at-over-budget", "Diagnostic capturedAt exceeds the schema limit.");
  }
  return {
    method,
    normalizedPath: normalizeDiagnosticPath(input.url),
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(mediaType ? { mediaType } : {}),
    ...(input.correlationId ? { correlationId: redactText(input.correlationId) } : {}),
    ...(input.traceId ? { traceId: redactText(input.traceId) } : {}),
    ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
    ...(requestHeaders.length > 0 ? { requestHeaders } : {}),
    ...(responseHeaders.length > 0 ? { responseHeaders } : {}),
    ...(input.requestBody === undefined
      ? {}
      : { requestBody: sanitizeDiagnosticBody(input.requestBody, { mediaType: requestMediaType, previewBytes }) }),
    ...(input.responseBody === undefined
      ? {}
      : { responseBody: sanitizeDiagnosticBody(input.responseBody, { mediaType: responseMediaType, previewBytes }) }),
  };
}

export function createDiagnosticBundle(options: CreateDiagnosticBundleOptions): DiagnosticBundleV1 {
  if (!CLASSIFICATIONS.has(options.contentClassification)) {
    throw new HonuaDiagnosticSafetyError("classification-required", "A valid content classification is required.");
  }
  if (
    typeof options.consent?.redactionAcknowledged !== "boolean" ||
    typeof options.consent?.shareWithSupport !== "boolean"
  ) {
    throw new HonuaDiagnosticSafetyError(
      "consent-required",
      "Explicit redaction and sharing consent values are required.",
    );
  }
  if (options.exchanges.length < 1 || options.exchanges.length > DIAGNOSTIC_MAX_ENVELOPES) {
    throw new HonuaDiagnosticSafetyError("envelope-budget", "A diagnostic bundle requires 1 to 50 exchanges.");
  }
  if (options.bundleId && options.bundleId.length > 64) {
    throw new HonuaDiagnosticSafetyError("bundle-id-over-budget", "Diagnostic bundle id exceeds the schema limit.");
  }
  if (options.consent.grantedBy && options.consent.grantedBy.length > 256) {
    throw new HonuaDiagnosticSafetyError(
      "granted-by-over-budget",
      "Diagnostic consent identity exceeds the schema limit.",
    );
  }
  if (
    options.previewBytes !== undefined &&
    (!Number.isInteger(options.previewBytes) ||
      options.previewBytes < 1 ||
      options.previewBytes > DIAGNOSTIC_MAX_PREVIEW_BYTES)
  ) {
    throw new HonuaDiagnosticSafetyError(
      "preview-budget",
      "Diagnostic preview budget must be an integer from 1 to 8192.",
    );
  }
  const bundle: DiagnosticBundleV1 = {
    schemaVersion: "1.0",
    ...(options.bundleId ? { bundleId: options.bundleId } : {}),
    contentClassification: options.contentClassification,
    consent: {
      redactionAcknowledged: options.consent.redactionAcknowledged,
      shareWithSupport: options.consent.shareWithSupport,
      ...(options.consent.grantedBy ? { grantedBy: options.consent.grantedBy } : {}),
    },
    envelopes: options.exchanges.map((exchange) =>
      sanitizeDiagnosticExchange(exchange, options.previewBytes ?? DIAGNOSTIC_DEFAULT_PREVIEW_BYTES),
    ),
  };
  assertDiagnosticBundle(bundle);
  return bundle;
}
