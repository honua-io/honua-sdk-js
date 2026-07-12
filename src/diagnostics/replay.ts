import { createHash } from "node:crypto";

import { DIAGNOSTIC_MAX_BODY_BYTES, HonuaDiagnosticSafetyError, createDiagnosticBundle } from "./sanitize.js";
import { assertDiagnosticBundle } from "./schema.js";
import type { DiagnosticBodyPreview, DiagnosticBundleV1, DiagnosticReplayOptions } from "./types.js";

const REPLAY_METHODS = new Set(["GET", "HEAD"]);
const FORBIDDEN_PATH =
  /(?:^|\/)(?:applyedits|attachments|delete|edit|jobs|mutate|publish|stream|subscribe|update|upload)(?:\/|$)/i;
const SAFE_ARTIFACT_HEADERS = new Set([
  "accept",
  "content-length",
  "content-type",
  "traceparent",
  "x-correlation-id",
  "x-request-id",
]);
const SECRET_MATERIAL = /(?:\bBearer\s+|\bBasic\s+|AKIA[0-9A-Z]{16}|[?&](?:api[-_]?key|signature|token)=)/i;

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function verifyBodyIntegrity(body: DiagnosticBodyPreview | undefined): void {
  if (!body) return;
  if (!body.contentSha256 || !/^[a-f0-9]{64}$/.test(body.contentSha256)) {
    throw new HonuaDiagnosticSafetyError("hash-drift", "Replay requires a lowercase SHA-256 for every captured body.");
  }
  if (!body.redactionApplied && !body.truncated) {
    const previewBytes = new TextEncoder().encode(body.preview ?? "");
    const digest = createHash("sha256").update(previewBytes).digest("hex");
    if (previewBytes.byteLength !== body.originalByteSize || digest !== body.contentSha256) {
      throw new HonuaDiagnosticSafetyError(
        "hash-drift",
        "Captured body preview no longer matches its integrity metadata.",
      );
    }
  }
}

function assertArtifactSafe(bundle: DiagnosticBundleV1): void {
  if (SECRET_MATERIAL.test(JSON.stringify(bundle))) {
    throw new HonuaDiagnosticSafetyError(
      "credential-bearing-artifact",
      "Replay artifact contains credential material.",
    );
  }
  for (const envelope of bundle.envelopes) {
    verifyBodyIntegrity(envelope.requestBody);
    verifyBodyIntegrity(envelope.responseBody);
    for (const header of [...(envelope.requestHeaders ?? []), ...(envelope.responseHeaders ?? [])]) {
      if (!SAFE_ARTIFACT_HEADERS.has(header.name.toLowerCase())) {
        throw new HonuaDiagnosticSafetyError("unsafe-header", "Replay artifact contains a non-allowlisted header.");
      }
    }
  }
}

function safeBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HonuaDiagnosticSafetyError("unsafe-base-url", "Replay base URL is invalid.");
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new HonuaDiagnosticSafetyError(
      "unsafe-base-url",
      "Replay base URL must use HTTPS (HTTP is allowed only on localhost). ",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HonuaDiagnosticSafetyError(
      "unsafe-base-url",
      "Replay base URL must not contain credentials, query, or fragment.",
    );
  }
  return url;
}

function replayPath(normalizedPath: string): string {
  if (
    normalizedPath.length > 2048 ||
    !normalizedPath.startsWith("/") ||
    normalizedPath.startsWith("//") ||
    normalizedPath.includes("\\") ||
    hasUnsafeControl(normalizedPath)
  ) {
    throw new HonuaDiagnosticSafetyError("unsafe-path", "Replay path is malformed.");
  }
  const path = normalizedPath.split("?", 1)[0];
  if (path.includes("{") || path.includes("}")) {
    throw new HonuaDiagnosticSafetyError("unsafe-path", "Replay refuses placeholder path segments.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new HonuaDiagnosticSafetyError("unsafe-path", "Replay path encoding is invalid.");
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..") || FORBIDDEN_PATH.test(decoded)) {
    throw new HonuaDiagnosticSafetyError(
      "unsafe-path",
      "Replay path is mutation-, subscription-, or traversal-capable.",
    );
  }
  return path;
}

async function boundedResponseBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DIAGNOSTIC_MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new HonuaDiagnosticSafetyError(
      "response-over-budget",
      "Replay response exceeds the diagnostic body ceiling.",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Replay aborted.", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DIAGNOSTIC_MAX_BODY_BYTES) {
        await reader.cancel("Diagnostic response byte budget exceeded.");
        throw new HonuaDiagnosticSafetyError(
          "response-over-budget",
          "Replay response exceeds the diagnostic body ceiling.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function replayDiagnosticBundle(options: DiagnosticReplayOptions): Promise<DiagnosticBundleV1> {
  assertDiagnosticBundle(options.bundle);
  assertArtifactSafe(options.bundle);
  const index = options.envelopeIndex ?? options.bundle.envelopes.length - 1;
  if (!Number.isInteger(index) || index < 0 || index >= options.bundle.envelopes.length) {
    throw new HonuaDiagnosticSafetyError("invalid-envelope-index", "Replay envelope index is out of range.");
  }
  const envelope = options.bundle.envelopes[index];
  const method = envelope.method.toUpperCase();
  if (!REPLAY_METHODS.has(method)) {
    throw new HonuaDiagnosticSafetyError("unsafe-method", "Replay permits only GET and HEAD exchanges.");
  }
  const base = safeBaseUrl(options.baseUrl);
  const path = replayPath(envelope.normalizedPath);
  const target = new URL(path, `${base.toString().replace(/\/$/, "")}/`);
  if (target.origin !== base.origin) {
    throw new HonuaDiagnosticSafetyError("unsafe-origin", "Replay target escaped the configured server origin.");
  }

  const controller = new AbortController();
  const timeoutMs = Math.min(30_000, Math.max(1, Math.trunc(options.timeoutMs ?? 10_000)));
  const abort = () => controller.abort(options.signal?.reason ?? new DOMException("Replay aborted.", "AbortError"));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Replay timed out.", "TimeoutError")), timeoutMs);
  try {
    const response = await (options.fetchFn ?? fetch)(target, {
      method,
      headers: { accept: "application/json, application/problem+json, text/plain;q=0.5" },
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    const responseBody = method === "HEAD" ? undefined : await boundedResponseBody(response, controller.signal);
    return createDiagnosticBundle({
      contentClassification: options.bundle.contentClassification,
      consent: options.bundle.consent,
      previewBytes: options.previewBytes,
      exchanges: [
        {
          method,
          url: target.toString(),
          statusCode: response.status,
          mediaType: response.headers.get("content-type") ?? undefined,
          correlationId: response.headers.get("x-correlation-id") ?? response.headers.get("x-request-id") ?? undefined,
          traceId: response.headers.get("traceparent") ?? undefined,
          capturedAt: new Date().toISOString(),
          responseHeaders: response.headers,
          ...(responseBody ? { responseBody } : {}),
        },
      ],
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
