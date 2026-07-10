import type { OvertureObjectManifest, OvertureRangeEvidence } from "./types.js";

const FOOTER_PROBE_BYTES = 65_536;

export async function probeAwsRanges(
  object: OvertureObjectManifest,
  options: { readonly fetchFn?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<OvertureRangeEvidence> {
  const fetchFn = options.fetchFn ?? fetch;
  const started = performance.now();
  const ranges = ["bytes=0-0", `bytes=${Math.max(0, object.bytes - FOOTER_PROBE_BYTES)}-${object.bytes - 1}`];
  const responses = [];
  for (const range of ranges) {
    const response = await fetchFn(object.url, {
      headers: { range },
      cache: "default",
      signal: options.signal,
    });
    responses.push(response);
    const contentRange = response.headers.get("content-range");
    const observedEtag = normalizeEtag(response.headers.get("etag"));
    const totalBytes = contentRange ? Number.parseInt(contentRange.split("/").at(-1) ?? "", 10) : Number.NaN;
    const identityMismatch = observedEtag !== object.etag || totalBytes !== object.bytes;
    if (response.status !== 206 || !contentRange || identityMismatch) {
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
        limitation: identityMismatch
          ? `Pinned object identity mismatch (expected ${object.etag} / ${object.bytes} bytes, observed ${observedEtag ?? "no ETag"} / ${Number.isFinite(totalBytes) ? totalBytes : "unknown"}). Live execution is blocked.`
          : `Expected HTTP 206 for ${range}; received ${response.status}. Live execution is blocked to prevent full materialization.`,
      };
    }
    await response.arrayBuffer();
  }
  const first = responses[0];
  return {
    status: "verified",
    observedAt: new Date().toISOString(),
    bytes: 1 + Math.min(FOOTER_PROBE_BYTES, object.bytes),
    ranges: ranges.length,
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
