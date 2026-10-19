import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
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
