import { createHash, randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import path from "node:path";

export const PARQUET_EXTENSION_PROVENANCE = Object.freeze({
  engineVersion: "v1.4.3",
  platform: "wasm_eh",
  fileName: "parquet.duckdb_extension.wasm",
  sourceUrl: "https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm",
  bytes: 3_045_039,
  sha256: "22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55",
  wasmMagic: Object.freeze([0x00, 0x61, 0x73, 0x6d]),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function notFound(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readBoundedResponseBody(response, maximumBytes) {
  if (typeof response.body?.getReader !== "function") {
    throw new Error(
      "Pinned DuckDB extension response requires a readable byte stream; unbounded whole-body readers are not allowed.",
    );
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Pinned DuckDB extension response emitted invalid bytes.");
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel("Pinned DuckDB extension response exceeded the exact byte limit.").catch(() => undefined);
        throw new Error(`Pinned DuckDB extension response exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function validatePinnedParquetExtension(bytes, provenance = PARQUET_EXTENSION_PROVENANCE) {
  if (!(bytes instanceof Uint8Array)) throw new Error("Pinned DuckDB extension must be a Uint8Array.");
  if (bytes.byteLength !== provenance.bytes) {
    throw new Error(
      `Pinned DuckDB extension size mismatch: expected ${provenance.bytes}, received ${bytes.byteLength}.`,
    );
  }
  for (const [index, expected] of provenance.wasmMagic.entries()) {
    if (bytes[index] !== expected) throw new Error("Pinned DuckDB extension does not have WebAssembly magic bytes.");
  }
  const digest = sha256(bytes);
  if (digest !== provenance.sha256) {
    throw new Error(`Pinned DuckDB extension SHA-256 mismatch: expected ${provenance.sha256}, received ${digest}.`);
  }
  return Object.freeze({ byteLength: bytes.byteLength, sha256: digest });
}

export function resolveParquetExtensionCachePath({ repoRoot, provenance = PARQUET_EXTENSION_PROVENANCE }) {
  if (!repoRoot) throw new Error("repoRoot is required to resolve the DuckDB extension cache.");
  const cacheRoot = path.join(repoRoot, "node_modules", ".cache", "honua-sdk-js", "duckdb-extensions");
  return path.join(cacheRoot, provenance.engineVersion, provenance.platform, provenance.fileName);
}

export async function readPinnedParquetExtension({
  cachePath,
  fsImpl = nodeFs,
  provenance = PARQUET_EXTENSION_PROVENANCE,
}) {
  if (!cachePath) throw new Error("cachePath is required to read the pinned DuckDB extension.");
  const bytes = new Uint8Array(await fsImpl.readFile(cachePath));
  const identity = validatePinnedParquetExtension(bytes, provenance);
  return Object.freeze({ cachePath, bytes, ...identity });
}

export async function ensurePinnedParquetExtension({
  cachePath,
  fsImpl = nodeFs,
  fetchImpl = globalThis.fetch,
  offline = false,
  timeoutMs = 30_000,
  provenance = PARQUET_EXTENSION_PROVENANCE,
}) {
  if (!cachePath) throw new Error("cachePath is required to prepare the pinned DuckDB extension.");
  let replacingCorruptCache = false;
  try {
    const cached = await readPinnedParquetExtension({ cachePath, fsImpl, provenance });
    return Object.freeze({ ...cached, status: "cache-hit" });
  } catch (cause) {
    if (!notFound(cause)) {
      replacingCorruptCache = true;
      if (offline) {
        throw new Error(`Offline DuckDB extension cache is invalid at ${cachePath}.`, { cause });
      }
    } else if (offline) {
      throw new Error(`Offline DuckDB extension cache is missing at ${cachePath}.`, { cause });
    }
  }

  if (typeof fetchImpl !== "function")
    throw new Error("No fetch implementation is available for extension preparation.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer.");

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("Pinned DuckDB extension download timed out.")), timeoutMs);
  let response;
  try {
    response = await fetchImpl(provenance.sourceUrl, {
      headers: { accept: "application/wasm" },
      redirect: "error",
      signal: abort.signal,
    });
  } catch (cause) {
    clearTimeout(timeout);
    throw new Error(`Failed to acquire pinned DuckDB extension from ${provenance.sourceUrl}.`, { cause });
  }
  let downloaded;
  try {
    if (!response.ok) {
      throw new Error(`Pinned DuckDB extension request failed with HTTP ${response.status}.`);
    }
    if (response.redirected || (response.url && response.url !== provenance.sourceUrl)) {
      throw new Error("Pinned DuckDB extension request changed origin or path; redirects are not allowed.");
    }
    const contentType = response.headers?.get?.("content-type");
    if (contentType && !contentType.toLowerCase().startsWith("application/wasm")) {
      throw new Error(`Pinned DuckDB extension response has unexpected content type ${contentType}.`);
    }
    downloaded = await readBoundedResponseBody(response, provenance.bytes);
    validatePinnedParquetExtension(downloaded, provenance);
  } finally {
    clearTimeout(timeout);
  }

  await fsImpl.mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsImpl.writeFile(temporaryPath, downloaded, { flag: "wx", mode: 0o600 });
    await fsImpl.rename(temporaryPath, cachePath);
  } finally {
    await fsImpl.unlink(temporaryPath).catch((error) => {
      if (!notFound(error)) throw error;
    });
  }
  const prepared = await readPinnedParquetExtension({ cachePath, fsImpl, provenance });
  return Object.freeze({ ...prepared, status: replacingCorruptCache ? "replaced" : "downloaded" });
}
