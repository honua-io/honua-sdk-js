import type { OvertureObjectManifest, OvertureRangeEvidence } from "./types.js";

const FOOTER_PROBE_BYTES = 65_536;

export async function probeAwsRanges(
  object: OvertureObjectManifest,
  options: { readonly fetchFn?: typeof fetch; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<OvertureRangeEvidence> {
  const fetchFn = options.fetchFn ?? fetch;
  const started = performance.now();
  const probes = [
    { start: 0, end: 0 },
    { start: Math.max(0, object.bytes - FOOTER_PROBE_BYTES), end: object.bytes - 1 },
  ];
  const responses = [];
  const controller = new AbortController();
  const externalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener("abort", externalAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 10_000);
  try {
    for (const probe of probes) {
      const range = `bytes=${probe.start}-${probe.end}`;
      let response: Response;
      try {
        response = await fetchFn(object.url, {
          headers: { range },
          cache: "default",
          credentials: "omit",
          signal: controller.signal,
        });
      } catch (cause) {
        if (timedOut) throw new Error(`AWS range probe exceeded the ${options.timeoutMs ?? 10_000} ms deadline.`);
        throw cause;
      }
      responses.push(response);
      const contentRange = parseContentRange(response.headers.get("content-range"));
      const observedEtag = normalizeEtag(response.headers.get("etag"));
      const identityMismatch = observedEtag !== object.etag || contentRange?.total !== object.bytes;
      const intervalMismatch = !contentRange || contentRange.start !== probe.start || contentRange.end !== probe.end;
      const expectedBytes = probe.end - probe.start + 1;
      const declaredBytes = parseContentLength(response.headers.get("content-length"));
      if (
        response.status !== 206 ||
        !contentRange ||
        identityMismatch ||
        intervalMismatch ||
        (declaredBytes !== null && declaredBytes !== expectedBytes)
      ) {
        await response.body?.cancel().catch(() => undefined);
        return unsupported(
          object,
          response,
          started,
          identityMismatch
            ? `Pinned object identity mismatch (expected ${object.etag} / ${object.bytes} bytes, observed ${observedEtag ?? "no ETag"} / ${contentRange?.total ?? "unknown"}). Live execution is blocked.`
            : `Expected exact HTTP 206 interval ${range} with ${expectedBytes} bytes; received ${response.status} / ${response.headers.get("content-range") ?? "no Content-Range"} / ${declaredBytes ?? "unknown-length"}. Live execution is blocked to prevent full materialization.`,
        );
      }
      if (!(await consumeExactBytes(response, expectedBytes, controller.signal))) {
        return unsupported(
          object,
          response,
          started,
          `Response body for ${range} exceeded or did not reach the exact ${expectedBytes}-byte probe budget. Live execution is blocked to prevent full materialization.`,
        );
      }
    }
  } catch (cause) {
    if (timedOut) throw new Error(`AWS range probe exceeded the ${options.timeoutMs ?? 10_000} ms deadline.`);
    throw cause;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", externalAbort);
  }
  const first = responses[0];
  return {
    status: "verified",
    observedAt: new Date().toISOString(),
    bytes: 1 + Math.min(FOOTER_PROBE_BYTES, object.bytes),
    ranges: probes.length,
    objectBytes: object.bytes,
    acceptRanges: first?.headers.get("accept-ranges")?.toLowerCase() === "bytes",
    etag: normalizeEtag(first?.headers.get("etag")),
    lastModified: first?.headers.get("last-modified") ?? null,
    cacheStatus: first?.headers.get("x-cache") ?? "not-reported",
    durationMs: performance.now() - started,
    limitation:
      "These are verified preflight ranges only. DuckDB-WASM performs additional engine reads whose byte/range telemetry is not exposed by the current driver.",
  };
}

interface ParsedContentRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function consumeExactBytes(response: Response, expectedBytes: number, signal: AbortSignal): Promise<boolean> {
  if (!response.body) return (await response.arrayBuffer()).byteLength === expectedBytes;
  const reader = response.body.getReader();
  let rejectAbort!: (cause: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    rejectAbort(signal.reason ?? new DOMException("Range probe aborted.", "AbortError"));
    void reader.cancel("Range probe aborted.").catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  let observedBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Range probe aborted.", "AbortError");
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return observedBytes === expectedBytes;
      observedBytes += value.byteLength;
      if (observedBytes > expectedBytes) {
        await reader.cancel("Range probe byte budget exceeded.");
        return false;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function unsupported(
  object: OvertureObjectManifest,
  response: Response,
  started: number,
  limitation: string,
): OvertureRangeEvidence {
  return {
    status: "unsupported",
    observedAt: new Date().toISOString(),
    bytes: 0,
    ranges: 0,
    objectBytes: object.bytes,
    acceptRanges: false,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    cacheStatus: response.headers.get("x-cache") ?? "not-reported",
    durationMs: performance.now() - started,
    limitation,
  };
}

export function fixtureRangeEvidence(bytes: number): OvertureRangeEvidence {
  return {
    status: "local-buffer",
    observedAt: new Date().toISOString(),
    bytes,
    ranges: 1,
    objectBytes: bytes,
    acceptRanges: false,
    etag: null,
    lastModified: null,
    cacheStatus: "in-memory fixture",
    durationMs: 0,
    limitation: "The 1.9 KB deterministic fixture is intentionally registered as one bounded in-memory buffer.",
  };
}

function normalizeEtag(value: string | null | undefined): string | null {
  return value?.replaceAll('"', "") ?? null;
}
