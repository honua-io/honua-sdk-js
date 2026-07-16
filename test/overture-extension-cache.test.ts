import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ensurePinnedParquetExtension,
  readPinnedParquetExtension,
  resolveParquetExtensionCachePath,
  validatePinnedParquetExtension,
} from "../examples/overture-geoparquet/extension-cache.mjs";
import type {
  DuckDbExtensionProvenance,
  ExtensionCacheFileSystem,
  ExtensionFetch,
  ExtensionFetchResponse,
} from "../examples/overture-geoparquet/extension-cache.mjs";

const VALID_BYTES = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const TEST_PROVENANCE: DuckDbExtensionProvenance = {
  engineVersion: "v-test",
  platform: "wasm_eh",
  fileName: "parquet.duckdb_extension.wasm",
  sourceUrl: "https://extensions.example.test/v-test/wasm_eh/parquet.duckdb_extension.wasm",
  bytes: VALID_BYTES.byteLength,
  sha256: createHash("sha256").update(VALID_BYTES).digest("hex"),
  wasmMagic: [0x00, 0x61, 0x73, 0x6d],
};
const CACHE_PATH = "/cache/v-test/wasm_eh/parquet.duckdb_extension.wasm";

class MemoryFileSystem implements ExtensionCacheFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readCount = 0;

  constructor(entries: readonly (readonly [string, Uint8Array])[] = []) {
    for (const [file, bytes] of entries) this.files.set(file, Uint8Array.from(bytes));
  }

  async readFile(file: string): Promise<Uint8Array> {
    this.readCount += 1;
    const bytes = this.files.get(file);
    if (!bytes) throw Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" });
    return Uint8Array.from(bytes);
  }

  async mkdir(): Promise<void> {}

  async writeFile(file: string, bytes: Uint8Array, options: { flag: "wx"; mode: number }): Promise<void> {
    expect(options).toEqual({ flag: "wx", mode: 0o600 });
    if (this.files.has(file)) throw Object.assign(new Error(`Exists ${file}`), { code: "EEXIST" });
    this.files.set(file, Uint8Array.from(bytes));
  }

  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (!bytes) throw Object.assign(new Error(`Missing ${from}`), { code: "ENOENT" });
    this.files.set(to, bytes);
    this.files.delete(from);
  }

  async unlink(file: string): Promise<void> {
    if (!this.files.delete(file)) throw Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" });
  }
}

function response(bytes: Uint8Array, overrides: Partial<ExtensionFetchResponse> = {}): ExtensionFetchResponse {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: TEST_PROVENANCE.sourceUrl,
    headers: { get: () => "application/wasm" },
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
    ...overrides,
  };
}

describe("Overture DuckDB extension preparation", () => {
  it("acquires exactly one pinned URL and atomically validates the cache", async () => {
    const fsImpl = new MemoryFileSystem();
    const calls: Array<{ url: string; redirect: string; accept: string }> = [];
    const fetchImpl: ExtensionFetch = async (url, init) => {
      calls.push({ url, redirect: init.redirect, accept: init.headers.accept });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return response(VALID_BYTES);
    };

    const prepared = await ensurePinnedParquetExtension({
      cachePath: CACHE_PATH,
      fsImpl,
      fetchImpl,
      provenance: TEST_PROVENANCE,
    });

    expect(prepared.status).toBe("downloaded");
    expect(calls).toEqual([{ url: TEST_PROVENANCE.sourceUrl, redirect: "error", accept: "application/wasm" }]);
    expect(fsImpl.files.get(CACHE_PATH)).toEqual(VALID_BYTES);
    expect([...fsImpl.files.keys()]).toEqual([CACHE_PATH]);
    await expect(
      readPinnedParquetExtension({ cachePath: CACHE_PATH, fsImpl, provenance: TEST_PROVENANCE }),
    ).resolves.toMatchObject({ sha256: TEST_PROVENANCE.sha256, byteLength: VALID_BYTES.byteLength });
  });

  it("revalidates cached bytes on every use without fetching", async () => {
    const fsImpl = new MemoryFileSystem([[CACHE_PATH, VALID_BYTES]]);
    const fetchImpl = vi.fn<ExtensionFetch>();

    await expect(
      ensurePinnedParquetExtension({ cachePath: CACHE_PATH, fsImpl, fetchImpl, provenance: TEST_PROVENANCE }),
    ).resolves.toMatchObject({ status: "cache-hit" });
    fsImpl.files.set(CACHE_PATH, Uint8Array.from(VALID_BYTES));
    await expect(
      ensurePinnedParquetExtension({ cachePath: CACHE_PATH, fsImpl, fetchImpl, provenance: TEST_PROVENANCE }),
    ).resolves.toMatchObject({ status: "cache-hit" });

    expect(fsImpl.readCount).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("replaces a corrupt online cache only after the download validates", async () => {
    const corrupt = Uint8Array.from(VALID_BYTES);
    corrupt[7] = 1;
    const fsImpl = new MemoryFileSystem([[CACHE_PATH, corrupt]]);
    const fetchImpl: ExtensionFetch = async () => response(VALID_BYTES);

    await expect(
      ensurePinnedParquetExtension({ cachePath: CACHE_PATH, fsImpl, fetchImpl, provenance: TEST_PROVENANCE }),
    ).resolves.toMatchObject({ status: "replaced", sha256: TEST_PROVENANCE.sha256 });
    expect(fsImpl.files.get(CACHE_PATH)).toEqual(VALID_BYTES);
  });

  it("fails closed for missing or corrupt offline caches", async () => {
    const fetchImpl = vi.fn<ExtensionFetch>();
    await expect(
      ensurePinnedParquetExtension({
        cachePath: CACHE_PATH,
        fsImpl: new MemoryFileSystem(),
        fetchImpl,
        offline: true,
        provenance: TEST_PROVENANCE,
      }),
    ).rejects.toThrow("cache is missing");

    const corruptFs = new MemoryFileSystem([[CACHE_PATH, Uint8Array.from([0x00])]]);
    await expect(
      ensurePinnedParquetExtension({
        cachePath: CACHE_PATH,
        fsImpl: corruptFs,
        fetchImpl,
        offline: true,
        provenance: TEST_PROVENANCE,
      }),
    ).rejects.toThrow("cache is invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects redirects, invalid bytes, and fallback attempts without publishing a cache", async () => {
    const redirectedFs = new MemoryFileSystem();
    const redirectedFetch = vi.fn<ExtensionFetch>(async () =>
      response(VALID_BYTES, { redirected: true, url: "https://mirror.example.test/parquet.wasm" }),
    );
    await expect(
      ensurePinnedParquetExtension({
        cachePath: CACHE_PATH,
        fsImpl: redirectedFs,
        fetchImpl: redirectedFetch,
        provenance: TEST_PROVENANCE,
      }),
    ).rejects.toThrow("redirects are not allowed");
    expect(redirectedFetch).toHaveBeenCalledTimes(1);
    expect(redirectedFetch.mock.calls[0]?.[0]).toBe(TEST_PROVENANCE.sourceUrl);
    expect(redirectedFs.files.size).toBe(0);

    const invalidFs = new MemoryFileSystem();
    const invalidFetch: ExtensionFetch = async () => response(Uint8Array.from([0x00]));
    await expect(
      ensurePinnedParquetExtension({
        cachePath: CACHE_PATH,
        fsImpl: invalidFs,
        fetchImpl: invalidFetch,
        provenance: TEST_PROVENANCE,
      }),
    ).rejects.toThrow("size mismatch");
    expect(invalidFs.files.size).toBe(0);
  });

  it("caps a streamed response before publishing oversized bytes", async () => {
    const fsImpl = new MemoryFileSystem();
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    let emitted = false;
    const fetchImpl: ExtensionFetch = async () =>
      response(VALID_BYTES, {
        body: {
          getReader: () => ({
            async read() {
              if (emitted) return { done: true };
              emitted = true;
              return { done: false, value: new Uint8Array(TEST_PROVENANCE.bytes + 1) };
            },
            cancel,
            releaseLock,
          }),
        },
      });

    await expect(
      ensurePinnedParquetExtension({
        cachePath: CACHE_PATH,
        fsImpl,
        fetchImpl,
        provenance: TEST_PROVENANCE,
      }),
    ).rejects.toThrow(`exceeds ${TEST_PROVENANCE.bytes} bytes`);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(fsImpl.files.size).toBe(0);
  });

  it("validates size, WebAssembly magic, digest, and the documented cache path", () => {
    expect(() => validatePinnedParquetExtension(Uint8Array.from([0x00]), TEST_PROVENANCE)).toThrow("size mismatch");
    const wrongMagic = Uint8Array.from(VALID_BYTES);
    wrongMagic[0] = 1;
    expect(() => validatePinnedParquetExtension(wrongMagic, TEST_PROVENANCE)).toThrow("magic bytes");
    const wrongDigest = Uint8Array.from(VALID_BYTES);
    wrongDigest[7] = 1;
    expect(() => validatePinnedParquetExtension(wrongDigest, TEST_PROVENANCE)).toThrow("SHA-256 mismatch");
    expect(
      resolveParquetExtensionCachePath({
        repoRoot: "/repo",
        provenance: TEST_PROVENANCE,
      }),
    ).toBe("/repo/node_modules/.cache/honua-sdk-js/duckdb-extensions/v-test/wasm_eh/parquet.duckdb_extension.wasm");
  });
});
