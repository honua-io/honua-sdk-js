import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashDatasetImportFile } from "../src/control-plane/dataset-import/file-hash.js";

const expected = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("dataset import whole-file SHA-256", () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 65535, 65536, 65537, 131073])(
    "matches native SHA-256 across padding/read boundaries (%i bytes)",
    async (length) => {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 17) % 256);
      expect(await hashDatasetImportFile(new Blob([bytes]), { chunkBytes: 65536 })).toBe(expected(bytes));
    },
  );

  it("matches the published million-a SHA-256 vector", async () => {
    expect(await hashDatasetImportFile(new Blob(["a".repeat(1_000_000)]))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("reads bounded sequential slices without materializing the whole file", async () => {
    const bytes = new Uint8Array(3 * 65536 + 7).fill(29);
    let position = 0;
    let active = false;
    const reads: number[] = [];
    const progress: number[] = [];
    const file = {
      size: bytes.length,
      arrayBuffer: () => {
        throw new Error("Whole-file allocation is forbidden");
      },
      slice: (start: number, end: number) => {
        expect(start).toBe(position);
        expect(end - start).toBeLessThanOrEqual(65536);
        return {
          size: end - start,
          arrayBuffer: async () => {
            expect(active).toBe(false);
            active = true;
            await Promise.resolve();
            position = end;
            reads.push(end - start);
            active = false;
            return bytes.slice(start, end).buffer;
          },
        };
      },
    } as unknown as Blob;
    expect(
      await hashDatasetImportFile(file, {
        chunkBytes: 65536,
        onProgress: (done) => progress.push(done),
      }),
    ).toBe(expected(bytes));
    expect(reads).toEqual([65536, 65536, 65536, 7]);
    expect(progress).toEqual([0, 65536, 131072, 196608, 196615]);
  });

  it("rejects changed bytes even when file metadata and the first chunk match", async () => {
    const original = new Uint8Array(131072).fill(3);
    const changed = original.slice();
    changed[100000] = 4;
    const left = new File([original], "same.geojson", { lastModified: 17 });
    const right = new File([changed], "same.geojson", { lastModified: 17 });
    expect(left.size).toBe(right.size);
    expect(await hashDatasetImportFile(left)).not.toBe(await hashDatasetImportFile(right));
  });

  it.each([0, -1, 1.5, 65535, 8 * 1024 * 1024 + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an unbounded or invalid chunk size (%s)",
    async (chunkBytes) => {
      await expect(hashDatasetImportFile(new Blob(), { chunkBytes })).rejects.toThrow(RangeError);
    },
  );

  it("cancels before reading and after an in-flight read without returning a digest", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(hashDatasetImportFile(new Blob(), { signal: aborted.signal })).rejects.toThrow();
    const controller = new AbortController();
    let reads = 0;
    const file = {
      size: 131072,
      slice: () => ({
        size: 65536,
        arrayBuffer: async () => {
          reads++;
          controller.abort();
          return new ArrayBuffer(65536);
        },
      }),
    } as unknown as Blob;
    await expect(
      hashDatasetImportFile(file, {
        chunkBytes: 65536,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(reads).toBe(1);
  });

  it.each([0, 65535, 65537])("refuses truncated/oversized actual slice bodies (%i)", async (length) => {
    const file = {
      size: 65536,
      slice: () => ({
        size: 65536,
        arrayBuffer: async () => new ArrayBuffer(length),
      }),
    } as unknown as Blob;
    await expect(hashDatasetImportFile(file, { chunkBytes: 65536 })).rejects.toThrow("File read");
  });
});

afterEach(() => vi.unstubAllGlobals());

// Hashing must not allocate per 64-byte block; only padding may build a DataView.
it("allocates no DataView per block while hashing", async () => {
  let constructed = 0;
  vi.stubGlobal(
    "DataView",
    new Proxy(globalThis.DataView, {
      construct(target, args, newTarget) {
        constructed++;
        return Reflect.construct(target, args, newTarget);
      },
    }),
  );
  const bytes = new Uint8Array(1024 * 1024).fill(0x61);
  const digest = await hashDatasetImportFile(new Blob([bytes]));
  expect(digest).toBe(expected(bytes));
  expect(constructed).toBeLessThanOrEqual(1);
});

it("takes no per-block subarray views of aligned chunks", async () => {
  const subarray = vi.spyOn(Uint8Array.prototype, "subarray");
  try {
    const bytes = new Uint8Array(1024 * 1024).fill(0x62);
    expect(await hashDatasetImportFile(new Blob([bytes]))).toBe(expected(bytes));
    expect(subarray.mock.calls.length).toBeLessThanOrEqual(2);
  } finally {
    subarray.mockRestore();
  }
});

it("compresses blocks that start at unaligned chunk offsets", async () => {
  const bytes = Uint8Array.from({ length: 3 * 65537 + 5 }, (_, index) => (index * 7 + 3) % 256);
  expect(await hashDatasetImportFile(new Blob([bytes]), { chunkBytes: 65537 })).toBe(expected(bytes));
});

it("keeps concurrent hashes independent of the shared block schedule", async () => {
  const inputs = [0x11, 0x22, 0x33].map((seed) =>
    Uint8Array.from({ length: 200_003 }, (_, index) => (index * seed) % 256),
  );
  const digests = await Promise.all(
    inputs.map((bytes) => hashDatasetImportFile(new Blob([bytes]), { chunkBytes: 65536 })),
  );
  expect(digests).toEqual(inputs.map((bytes) => expected(bytes)));
});
