import fs from "node:fs";
import path from "node:path";

import {
  DIAGNOSTIC_SCHEMA_SHA256,
  DIAGNOSTIC_SCHEMA_URL,
  HonuaDiagnosticSafetyError,
  assertDiagnosticBundle,
  createDiagnosticBundle,
  replayDiagnosticBundle,
  validateDiagnosticBundle,
} from "../../diagnostics/index.js";
import type {
  DiagnosticBundleV1,
  DiagnosticContentClassification,
  DiagnosticExchangeInput,
} from "../../diagnostics/index.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getBoolean, getNumber, getString } from "../args.js";
import type { CommandContext } from "../command.js";
import { readConfig } from "../config.js";
import { printLine, renderJson } from "../output.js";

const MAX_INPUT_FILE_BYTES = 30 * 1024 * 1024;
const MAX_PROBE_BYTES = 256 * 1024;

interface CapturedExchangeFile {
  request?: { method?: unknown; url?: unknown; headers?: unknown; body?: unknown };
  response?: { status?: unknown; statusCode?: unknown; mediaType?: unknown; headers?: unknown; body?: unknown };
  correlationId?: unknown;
  traceId?: unknown;
  capturedAt?: unknown;
}

function readJsonFile(file: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ArgError("Diagnostic input file could not be read.");
  }
  if (!stat.isFile() || stat.size > MAX_INPUT_FILE_BYTES) {
    throw new ArgError("Diagnostic input file is not a regular file or exceeds 30 MiB.");
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ArgError("Diagnostic input file is not valid JSON.");
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function headersOrUndefined(value: unknown): Record<string, string | readonly string[] | undefined> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, string | readonly string[] | undefined> = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header === "string") output[name] = header;
    else if (Array.isArray(header) && header.every((item) => typeof item === "string")) output[name] = header;
  }
  return output;
}

function capturedExchange(value: unknown): DiagnosticExchangeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArgError("Captured exchange must be a JSON object.");
  }
  const capture = value as CapturedExchangeFile;
  const method = capture.request?.method;
  const url = capture.request?.url;
  if (typeof method !== "string" || typeof url !== "string") {
    throw new ArgError("Captured exchange requires request.method and request.url strings.");
  }
  const rawStatus = capture.response?.statusCode ?? capture.response?.status;
  return {
    method,
    url,
    ...(typeof rawStatus === "number" ? { statusCode: rawStatus } : {}),
    ...(typeof capture.response?.mediaType === "string" ? { mediaType: capture.response.mediaType } : {}),
    ...(typeof capture.correlationId === "string" ? { correlationId: capture.correlationId } : {}),
    ...(typeof capture.traceId === "string" ? { traceId: capture.traceId } : {}),
    ...(typeof capture.capturedAt === "string" ? { capturedAt: capture.capturedAt } : {}),
    requestHeaders: headersOrUndefined(capture.request?.headers),
    responseHeaders: headersOrUndefined(capture.response?.headers),
    ...(capture.request && Object.hasOwn(capture.request, "body") ? { requestBody: capture.request.body } : {}),
    ...(capture.response && Object.hasOwn(capture.response, "body") ? { responseBody: capture.response.body } : {}),
  };
}

function safeProbeBase(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ArgError("Doctor base URL is invalid.");
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new ArgError("Doctor base URL must be credential-free HTTPS (or localhost HTTP) without query or fragment.");
  }
  return url;
}

async function boundedProbeBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Probe aborted.", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROBE_BYTES) {
        await reader.cancel("Probe byte budget exceeded.");
        throw new HonuaDiagnosticSafetyError("probe-over-budget", "Capability probe response exceeded 256 KiB.");
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

async function capabilityProbe(baseUrl: string, timeoutMs: number): Promise<DiagnosticExchangeInput> {
  const base = safeProbeBase(baseUrl);
  const target = new URL(base);
  target.pathname = `${target.pathname.replace(/\/$/, "")}/api/v1/services`;
  target.search = "?limit=1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Probe timed out.", "TimeoutError")), timeoutMs);
  try {
    const response = await fetch(target, {
      method: "GET",
      headers: { accept: "application/json, application/problem+json" },
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await boundedProbeBody(response, controller.signal);
    return {
      method: "GET",
      url: target.toString(),
      statusCode: response.status,
      mediaType: response.headers.get("content-type") ?? undefined,
      correlationId: response.headers.get("x-correlation-id") ?? response.headers.get("x-request-id") ?? undefined,
      traceId: response.headers.get("traceparent") ?? undefined,
      capturedAt: new Date().toISOString(),
      responseHeaders: response.headers,
      responseBody: body,
    };
  } catch {
    return {
      method: "GET",
      url: target.toString(),
      capturedAt: new Date().toISOString(),
      responseHeaders: { "content-type": "application/problem+json" },
      responseBody: { error: "capability-probe-failed" },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function explicitBoolean(parsed: ParsedArgs, name: string): boolean {
  const value = getString(parsed, name);
  if (value !== "true" && value !== "false") throw new ArgError(`--${name} must be explicitly true or false.`);
  return value === "true";
}

function outputPath(parsed: ParsedArgs): string {
  const output = getString(parsed, "output");
  if (!output) throw new ArgError("honua doctor requires --output <bundle.json>; no diagnostic is uploaded.");
  return path.resolve(output);
}

function writeBundle(file: string, bundle: DiagnosticBundleV1): void {
  const validation = validateDiagnosticBundle(bundle);
  if (!validation.valid) throw new Error("Generated diagnostic bundle failed pinned-schema validation.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
}

function printResult(parsed: ParsedArgs, result: Record<string, unknown>): void {
  if (getBoolean(parsed, "json")) printLine(renderJson(result));
  else {
    printLine(`doctorOutcome=${String(result.outcome)}`);
    printLine("output=written");
    printLine(`schema=${DIAGNOSTIC_SCHEMA_URL}`);
    printLine(`schemaSha256=${DIAGNOSTIC_SCHEMA_SHA256}`);
  }
}

function configuredBaseUrl(ctx: CommandContext): string | undefined {
  return ctx.baseUrl ?? process.env.HONUA_BASE_URL ?? readConfig().baseUrl;
}

export async function doctorCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  if (parsed.positionals.length > 0) throw new ArgError("honua doctor does not accept positional arguments.");
  const destination = outputPath(parsed);
  const timeoutMs = Math.min(30_000, Math.max(1, Math.trunc(getNumber(parsed, "timeout-ms") ?? 10_000)));
  const replayFile = getString(parsed, "replay");
  if (replayFile) {
    const bundle = readJsonFile(replayFile);
    assertDiagnosticBundle(bundle);
    const baseUrl = configuredBaseUrl(ctx);
    if (!baseUrl) throw new ArgError("Replay requires --base-url or HONUA_BASE_URL.");
    const replayed = await replayDiagnosticBundle({ bundle, baseUrl, timeoutMs });
    writeBundle(destination, replayed);
    printResult(parsed, {
      format: "honua.doctor-result.v1",
      outcome: "replayed",
      outputWritten: true,
      envelopeCount: replayed.envelopes.length,
      schemaSha256: DIAGNOSTIC_SCHEMA_SHA256,
      uploaded: false,
    });
    return;
  }

  const classification = getString(parsed, "classification") as DiagnosticContentClassification | undefined;
  if (!classification) throw new ArgError("honua doctor requires --classification <value>.");
  const consent = {
    redactionAcknowledged: explicitBoolean(parsed, "redaction-acknowledged"),
    shareWithSupport: explicitBoolean(parsed, "share-with-support"),
    ...(getString(parsed, "granted-by") ? { grantedBy: getString(parsed, "granted-by") } : {}),
  };
  const exchanges: DiagnosticExchangeInput[] = [];
  const baseUrl = configuredBaseUrl(ctx);
  if (baseUrl) exchanges.push(await capabilityProbe(baseUrl, timeoutMs));
  const exchangeFile = getString(parsed, "exchange");
  if (exchangeFile) exchanges.push(capturedExchange(readJsonFile(exchangeFile)));
  if (exchanges.length === 0) {
    throw new ArgError("honua doctor requires --base-url/HONUA_BASE_URL or --exchange <captured.json>.");
  }
  const bundle = createDiagnosticBundle({
    bundleId: getString(parsed, "bundle-id"),
    contentClassification: classification,
    consent,
    exchanges,
    previewBytes: getNumber(parsed, "preview-bytes"),
  });
  writeBundle(destination, bundle);
  printResult(parsed, {
    format: "honua.doctor-result.v1",
    outcome: "emitted",
    outputWritten: true,
    envelopeCount: bundle.envelopes.length,
    capabilityProbe: baseUrl ? "attempted" : "not-configured",
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    sdk: { package: "@honua/sdk-js", cliVersion: "0.1.0" },
    schemaSha256: DIAGNOSTIC_SCHEMA_SHA256,
    uploaded: false,
  });
}
